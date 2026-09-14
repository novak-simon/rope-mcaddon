import { world } from "@minecraft/server";
import {
  MAX_DISTANCE,
  TELEPORT_JUMP_THRESHOLD,
  PARTICLE_INTERVAL_TICKS,
  MOVE_BUDGET_PER_TICK,
  ROPE_STRETCH_STRENGTH,
  MAX_ROPE_STRETCH_IMPULSE,
} from "./config.js";
import { getAllPairs } from "./ropeManager.js";
import { distance3D } from "./vecMath.js";
import { drawRopeParticles, playTautSound } from "./feedback.js";

// Per-pair runtime state, keyed by "nameA::nameB" (sorted for stability).
// This is deliberately not persisted; it is only used to recognize external
// movement between two physics ticks.
const pairState = new Map();

function pairKey(nameA, nameB) {
  return [nameA, nameB].sort().join("::");
}

function getPlayerByName(name) {
  for (const player of world.getPlayers()) {
    if (player.name === name) return player;
  }
  return undefined;
}

/**
 * teleport() resets facing unless rotation is passed back in. This helper is
 * used only for dimension changes, external teleports, and hard safety
 * corrections, not for normal rope motion.
 */
function teleportPreservingFacing(player, destination, dimension) {
  try {
    const rotation = player.getRotation();
    player.teleport(destination, { dimension, rotation });
    return true;
  } catch {
    // A destination can be temporarily invalid or unloaded. The next tick
    // will retry the safety handling without forcing the player through a block.
    return false;
  }
}

function isSafePlayerPosition(dimension, position) {
  const samples = [
    { x: position.x - 0.3, z: position.z - 0.3 },
    { x: position.x - 0.3, z: position.z + 0.3 },
    { x: position.x + 0.3, z: position.z - 0.3 },
    { x: position.x + 0.3, z: position.z + 0.3 },
  ];
  const heights = [0.1, 0.9, 1.7];

  try {
    for (const sample of samples) {
      for (const height of heights) {
        const block = dimension.getBlock({
          x: sample.x,
          y: position.y + height,
          z: sample.z,
        });
        if (
          !block ||
          (!block.isAir &&
            block.typeId !== "minecraft:water" &&
            block.typeId !== "minecraft:lava")
        ) {
          return false;
        }
      }
    }
  } catch {
    return false;
  }
  return true;
}

function findSafePlayerPosition(dimension, position) {
  const offsets = [
    [0, 0, 0],
    [0.45, 0, 0],
    [-0.45, 0, 0],
    [0, 0, 0.45],
    [0, 0, -0.45],
    [0.45, 0, 0.45],
    [0.45, 0, -0.45],
    [-0.45, 0, 0.45],
    [-0.45, 0, -0.45],
    [0, 0.5, 0],
    [0, -0.5, 0],
    [0, 1, 0],
    [0, -1, 0],
  ];

  for (const [xOffset, yOffset, zOffset] of offsets) {
    const candidate = {
      x: position.x + xOffset,
      y: position.y + yOffset,
      z: position.z + zOffset,
    };
    if (isSafePlayerPosition(dimension, candidate)) return candidate;
  }
  return undefined;
}

function queueImpulse(pendingImpulses, player, impulse) {
  const existing = pendingImpulses.get(player.id);
  if (existing) {
    existing.x += impulse.x;
    existing.y += impulse.y;
    existing.z += impulse.z;
    return;
  }
  pendingImpulses.set(player.id, { player, ...impulse });
}

function applyPendingImpulses(pendingImpulses) {
  for (const { player, x, y, z } of pendingImpulses.values()) {
    try {
      player.applyImpulse({ x, y, z });
    } catch {
      // A player can become invalid between collection and application.
    }
  }
}

/**
 * Moves a partner to the other dimension when the dimension-change event did
 * not catch the transition. This is not part of the normal rope constraint.
 */
function teleportFollowerTo(follower, target) {
  const targetPos = target.location;
  const requested = {
    x: targetPos.x + (Math.random() < 0.5 ? 1 : -1),
    y: targetPos.y,
    z: targetPos.z + (Math.random() < 0.5 ? 1 : -1),
  };
  const destination = findSafePlayerPosition(target.dimension, requested);
  if (destination) {
    teleportPreservingFacing(follower, destination, target.dimension);
  }
}

/**
 * Constrains only outward radial velocity. Tangential velocity and inward
 * velocity are left untouched, so walking around the rope and moving toward a
 * partner remain free. applyImpulse is the Bedrock API's velocity mutation;
 * for equal-mass players it provides the symmetric half impulse below.
 */
function constrainOutwardVelocity(pendingImpulses, playerA, playerB, posA, posB) {
  const dx = posB.x - posA.x;
  const dy = posB.y - posA.y;
  const dz = posB.z - posA.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance < 0.001) return;

  let velocityA;
  let velocityB;
  try {
    velocityA = playerA.getVelocity();
    velocityB = playerB.getVelocity();
  } catch {
    return;
  }

  const direction = {
    x: dx / distance,
    y: dy / distance,
    z: dz / distance,
  };
  const relativeVelocity = {
    x: velocityB.x - velocityA.x,
    y: velocityB.y - velocityA.y,
    z: velocityB.z - velocityA.z,
  };
  const radialVelocity =
    relativeVelocity.x * direction.x +
    relativeVelocity.y * direction.y +
    relativeVelocity.z * direction.z;

  const aAnchored = playerA.isSneaking;
  const bAnchored = playerB.isSneaking;
  if (aAnchored && bAnchored) return;

  // Removing outward relative velocity prevents further stretching. The
  // stretch bias supplies the actual tether pull when the pair is already
  // beyond its limit, including when the trailing player has little velocity.
  const outwardCorrection = Math.max(0, radialVelocity);
  const stretch = Math.max(0, distance - MAX_DISTANCE);
  const stretchCorrection = Math.min(
    MAX_ROPE_STRETCH_IMPULSE,
    stretch * ROPE_STRETCH_STRENGTH
  );
  if (outwardCorrection <= 0 && stretchCorrection <= 0) return;

  const correction = outwardCorrection + stretchCorrection;
  const share = aAnchored || bAnchored ? correction : correction / 2;
  const impulseA = {
    x: direction.x * share,
    y: direction.y * share,
    z: direction.z * share,
  };
  const impulseB = {
    x: -direction.x * share,
    y: -direction.y * share,
    z: -direction.z * share,
  };

  if (!aAnchored && isSafePlayerPosition(playerA.dimension, playerA.location)) {
    queueImpulse(pendingImpulses, playerA, impulseA);
  }
  if (!bAnchored && isSafePlayerPosition(playerB.dimension, playerB.location)) {
    queueImpulse(pendingImpulses, playerB, impulseB);
  }
}

/** Called once per physics tick for every active rope pair. */
export function runRopeTick(tickCount) {
  const moveBudget = new Map();
  const pendingImpulses = new Map();

  for (const [nameA, nameB] of getAllPairs()) {
    const playerA = getPlayerByName(nameA);
    const playerB = getPlayerByName(nameB);
    if (!playerA || !playerB) continue;

    const key = pairKey(nameA, nameB);
    let state = pairState.get(key);
    if (!state) {
      state = {
        lastPosA: playerA.location,
        lastPosB: playerB.location,
        taut: false,
      };
      pairState.set(key, state);
    }

    if (playerA.dimension.id !== playerB.dimension.id) {
      const used = moveBudget.get(nameB) ?? 0;
      if (used < MOVE_BUDGET_PER_TICK) {
        teleportFollowerTo(playerB, playerA);
        moveBudget.set(nameB, used + 1);
      }
      state.lastPosA = playerA.location;
      state.lastPosB = playerB.location;
      continue;
    }

    const posA = playerA.location;
    const posB = playerB.location;
    const deltaA = distance3D(posA, state.lastPosA);
    const deltaB = distance3D(posB, state.lastPosB);
    const aJumped = deltaA > TELEPORT_JUMP_THRESHOLD;
    const bJumped = deltaB > TELEPORT_JUMP_THRESHOLD;

    if (aJumped || bJumped) {
      if (aJumped && !bJumped) {
        const used = moveBudget.get(nameB) ?? 0;
        if (used < MOVE_BUDGET_PER_TICK) {
          teleportFollowerTo(playerB, playerA);
          moveBudget.set(nameB, used + 1);
        }
      } else if (bJumped && !aJumped) {
        const used = moveBudget.get(nameA) ?? 0;
        if (used < MOVE_BUDGET_PER_TICK) {
          teleportFollowerTo(playerA, playerB);
          moveBudget.set(nameA, used + 1);
        }
      }
      state.lastPosA = playerA.location;
      state.lastPosB = playerB.location;
      state.taut = false;
      continue;
    }

    const ropeDistance = distance3D(posA, posB);
    if (ropeDistance >= MAX_DISTANCE) {
      constrainOutwardVelocity(
        pendingImpulses,
        playerA,
        playerB,
        posA,
        posB
      );
      if (!state.taut) {
        playTautSound(playerA);
        state.taut = true;
      }
    } else {
      state.taut = false;
    }

    if (tickCount % PARTICLE_INTERVAL_TICKS === 0) {
      drawRopeParticles(playerA.dimension, playerA.location, playerB.location);
    }

    state.lastPosA = playerA.location;
    state.lastPosB = playerB.location;
  }

  applyPendingImpulses(pendingImpulses);
}

/** Call when a rope pair is removed elsewhere, to drop stale runtime state. */
export function clearPairState(nameA, nameB) {
  pairState.delete(pairKey(nameA, nameB));
}
