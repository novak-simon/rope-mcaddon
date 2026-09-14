import { world } from "@minecraft/server";
import {
  MAX_DISTANCE,
  TELEPORT_JUMP_THRESHOLD,
  PARTICLE_INTERVAL_TICKS,
  MOVE_BUDGET_PER_TICK,
  ROPE_STRETCH_STRENGTH,
  MAX_ROPE_STRETCH_IMPULSE,
  TRAILING_PLAYER_PULL_SHARE,
  TICK_INTERVAL,
  SNEAK_ROPE_MOBILITY,
  ROPE_BOUNDARY_LEAD_TICKS,
  ROPE_RADIAL_RESPONSE,
  MAX_ROPE_IMPULSE,
  MAX_ROPE_VERTICAL_IMPULSE,
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
function constrainOutwardVelocity(
  pendingImpulses,
  playerA,
  playerB,
  posA,
  posB,
  previousPosA,
  previousPosB
) {
  const dx = posB.x - posA.x;
  const dy = posB.y - posA.y;
  const dz = posB.z - posA.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance < 0.001) return;

  let velocityA = { x: 0, y: 0, z: 0 };
  let velocityB = { x: 0, y: 0, z: 0 };
  try {
    velocityA = playerA.getVelocity();
    velocityB = playerB.getVelocity();
  } catch {
    // Position deltas below still provide a usable motion estimate.
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
  const mobilityA = aAnchored ? SNEAK_ROPE_MOBILITY : 1;
  const mobilityB = bAnchored ? SNEAK_ROPE_MOBILITY : 1;
  const tickSeconds = TICK_INTERVAL / 20;
  const measuredVelocityA = {
    x: (posA.x - previousPosA.x) / tickSeconds,
    y: (posA.y - previousPosA.y) / tickSeconds,
    z: (posA.z - previousPosA.z) / tickSeconds,
  };
  const measuredVelocityB = {
    x: (posB.x - previousPosB.x) / tickSeconds,
    y: (posB.y - previousPosB.y) / tickSeconds,
    z: (posB.z - previousPosB.z) / tickSeconds,
  };
  const measuredRadialVelocity =
    (measuredVelocityB.x - measuredVelocityA.x) * direction.x +
    (measuredVelocityB.y - measuredVelocityA.y) * direction.y +
    (measuredVelocityB.z - measuredVelocityA.z) * direction.z;
  const effectiveRadialVelocity = Math.max(
    radialVelocity,
    measuredRadialVelocity
  );

  // Predict the next boundary crossing. This lets the constraint transfer
  // motion before a stationary partner is visibly left behind.
  const predictedExcess = Math.max(
    0,
    distance +
      Math.max(0, effectiveRadialVelocity) *
        tickSeconds *
        ROPE_BOUNDARY_LEAD_TICKS -
      MAX_DISTANCE
  );
  const currentStretch = Math.max(0, distance - MAX_DISTANCE);
  const stretchCorrection = Math.min(
    MAX_ROPE_STRETCH_IMPULSE,
    (currentStretch + predictedExcess) * ROPE_STRETCH_STRENGTH
  );
  const boundaryCorrection =
    distance >= MAX_DISTANCE || predictedExcess > 0
      ? Math.min(
          MAX_ROPE_IMPULSE,
          Math.max(0, effectiveRadialVelocity) * ROPE_RADIAL_RESPONSE +
            predictedExcess * ROPE_STRETCH_STRENGTH
        )
      : 0;
  const correction = Math.min(
    MAX_ROPE_IMPULSE,
    boundaryCorrection + stretchCorrection
  );
  if (correction <= 0) return;

  const velocityAlongA =
    velocityA.x * direction.x +
    velocityA.y * direction.y +
    velocityA.z * direction.z;
  const velocityAlongB =
    velocityB.x * direction.x +
    velocityB.y * direction.y +
    velocityB.z * direction.z;
  const aMovingAway = Math.max(0, -velocityAlongA);
  const bMovingAway = Math.max(0, velocityAlongB);

  let shareA = 0.5;
  let shareB = 0.5;
  if (aMovingAway > bMovingAway + 0.01) {
    shareB = TRAILING_PLAYER_PULL_SHARE;
    shareA = 1 - shareB;
  } else if (bMovingAway > aMovingAway + 0.01) {
    shareA = TRAILING_PLAYER_PULL_SHARE;
    shareB = 1 - shareA;
  }

  // Sneaking increases effective mass: reduce that player's response and
  // transfer the unused response to the other endpoint.
  const responseA = shareA * mobilityA;
  const responseB = shareB * mobilityB;
  const responseTotal = responseA + responseB;
  if (responseTotal <= 0) return;
  const effectiveShareA = responseA / responseTotal;
  const effectiveShareB = responseB / responseTotal;
  const impulseA = {
    x: direction.x * correction * effectiveShareA,
    y: direction.y * correction * effectiveShareA,
    z: direction.z * correction * effectiveShareA,
  };
  const impulseB = {
    x: -direction.x * correction * effectiveShareB,
    y: -direction.y * correction * effectiveShareB,
    z: -direction.z * correction * effectiveShareB,
  };

  if (aAnchored && impulseA.y < 0) impulseA.y = 0;
  if (bAnchored && impulseB.y < 0) impulseB.y = 0;
  impulseA.y = Math.max(
    -MAX_ROPE_VERTICAL_IMPULSE,
    Math.min(MAX_ROPE_VERTICAL_IMPULSE, impulseA.y)
  );
  impulseB.y = Math.max(
    -MAX_ROPE_VERTICAL_IMPULSE,
    Math.min(MAX_ROPE_VERTICAL_IMPULSE, impulseB.y)
  );
  if (responseA > 0 && isSafePlayerPosition(playerA.dimension, playerA.location)) {
    queueImpulse(pendingImpulses, playerA, impulseA);
  }
  if (responseB > 0 && isSafePlayerPosition(playerB.dimension, playerB.location)) {
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
        posB,
        state.lastPosA,
        state.lastPosB
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
