import { world } from "@minecraft/server";
import {
  SLACK_DISTANCE,
  MAX_DISTANCE,
  TELEPORT_JUMP_THRESHOLD,
  PARTICLE_INTERVAL_TICKS,
  MOVE_BUDGET_PER_TICK,
  CLAMP_BUFFER,
  PULL_STRENGTH,
  CLAMP_IMPULSE_STRENGTH,
  MAX_CLAMP_CORRECTION,
} from "./config.js";
import { getAllPairs } from "./ropeManager.js";
import { distance3D, clampToRadius } from "./vecMath.js";
import { drawRopeParticles, playTautSound } from "./feedback.js";

// Per-pair runtime state, keyed by "nameA::nameB" (sorted for stability).
// Not persisted - rebuilt naturally as players move.
const pairState = new Map();

function pairKey(nameA, nameB) {
  return [nameA, nameB].sort().join("::");
}

function getPlayerByName(name) {
  for (const p of world.getPlayers()) {
    if (p.name === name) return p;
  }
  return undefined;
}

/**
 * Teleports a player to a new position while explicitly preserving their
 * current look direction. teleport() resets facing unless rotation is passed
 * back in, which produced an unnatural "snap" whenever the rope corrected
 * someone's position while they were turning the camera.
 */
function teleportPreservingFacing(player, destination, dimension) {
  try {
    const rotation = player.getRotation();
    player.teleport(destination, { dimension, rotation });
  } catch {
    // Destination unsafe or similar - skip this tick's correction rather than
    // forcing it (acceptable per project scope, not fully idiot-proofed).
  }
}

function isSafePlayerPosition(dimension, position) {
  // Check the space occupied by the player's feet, body, and head. Using
  // several points also catches corners where a radial clamp enters a wall.
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
        if (!block || (!block.isAir && block.typeId !== "minecraft:water" && block.typeId !== "minecraft:lava")) {
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

function hasClearPath(dimension, fromPosition, toPosition) {
  const dx = toPosition.x - fromPosition.x;
  const dy = toPosition.y - fromPosition.y;
  const dz = toPosition.z - fromPosition.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const steps = Math.max(1, Math.ceil(distance / 0.25));

  for (let step = 1; step <= steps; step++) {
    const progress = step / steps;
    const position = {
      x: fromPosition.x + dx * progress,
      y: fromPosition.y + dy * progress,
      z: fromPosition.z + dz * progress,
    };
    if (!isSafePlayerPosition(dimension, position)) return false;
  }
  return true;
}

function queueImpulse(pendingImpulses, player, impulse) {
  const existing = pendingImpulses.get(player.id);
  if (existing) {
    existing.x += impulse.x;
    existing.y += impulse.y;
    existing.z += impulse.z;
    return;
  }
  pendingImpulses.set(player.id, { player, x: impulse.x, y: impulse.y, z: impulse.z });
}

function applyPendingImpulses(pendingImpulses) {
  for (const { player, x, y, z } of pendingImpulses.values()) {
    try {
      player.applyImpulse({ x, y, z });
    } catch {
      // Non-critical if a player becomes invalid during this tick.
    }
  }
}

/**
 * Teleports `follower` to just next to `target`'s position/dimension.
 * The destination is checked so a cross-dimension follow cannot place the
 * follower inside a wall or another solid block.
 */
function teleportFollowerTo(follower, target) {
  const targetPos = target.location;
  // Offset slightly so the follower doesn't land exactly inside the target.
  const requested = {
    x: targetPos.x + (Math.random() < 0.5 ? 1 : -1),
    y: targetPos.y,
    z: targetPos.z + (Math.random() < 0.5 ? 1 : -1),
  };
  const destination = findSafePlayerPosition(target.dimension, requested);
  if (!destination) return;
  teleportPreservingFacing(follower, destination, target.dimension);
}

/**
 * Nudges `player` toward `towardPos` with a full-vector impulse. Including the
 * vertical component makes a player falling below a bridge catch up promptly.
 */
function applyInwardPull(pendingImpulses, player, fromPos, towardPos, strength) {
  if (!isSafePlayerPosition(player.dimension, fromPos)) {
    const recoveryPosition = findSafePlayerPosition(player.dimension, fromPos);
    if (recoveryPosition) {
      pendingImpulses.delete(player.id);
      teleportPreservingFacing(player, recoveryPosition, player.dimension);
    }
    return;
  }
  const dx = towardPos.x - fromPos.x;
  const dy = towardPos.y - fromPos.y;
  const dz = towardPos.z - fromPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.001) return;
  const stepDistance = Math.min(strength, dist);
  const stepTarget = {
    x: fromPos.x + (dx / dist) * stepDistance,
    y: fromPos.y + (dy / dist) * stepDistance,
    z: fromPos.z + (dz / dist) * stepDistance,
  };
  if (!hasClearPath(player.dimension, fromPos, stepTarget)) return;
  queueImpulse(pendingImpulses, player, {
    x: (dx / dist) * strength,
    y: (dy / dist) * strength,
    z: (dz / dist) * strength,
  });
}

function applyClampCorrection(pendingImpulses, player, anchorPos, heldPos) {
  const requested = clampToRadius(anchorPos, heldPos, MAX_DISTANCE - CLAMP_BUFFER);
  const safeTarget = findSafePlayerPosition(player.dimension, requested);
  const target = safeTarget || requested;
  const dx = target.x - heldPos.x;
  const dy = target.y - heldPos.y;
  const dz = target.z - heldPos.z;
  const correctionDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (correctionDistance > 0.001 && hasClearPath(player.dimension, heldPos, target)) {
    const scale = Math.min(1, MAX_CLAMP_CORRECTION / correctionDistance);
    queueImpulse(pendingImpulses, player, {
      x: dx * scale * CLAMP_IMPULSE_STRENGTH,
      y: dy * scale * CLAMP_IMPULSE_STRENGTH,
      z: dz * scale * CLAMP_IMPULSE_STRENGTH,
    });
  }

  // Recover a player already embedded in a block without applying another
  // impulse. If no safe position exists, such as a sealed one-block hole,
  // leave them in place rather than forcing them through the enclosure.
  if (!isSafePlayerPosition(player.dimension, heldPos) && safeTarget) {
    pendingImpulses.delete(player.id);
    teleportPreservingFacing(player, safeTarget, player.dimension);
  }
}

/**
 * Decides who is "anchored" (bracing, via sneak) for this pair. An anchored
 * player never gets moved by the rope - the other player is held/dragged
 * toward them instead. This is what lets one player brace on a bridge and
 * hold the other at rope's length rather than getting dragged off too.
 *
 * Returns { anchor, other, anchorPos, otherPos } if exactly one player is
 * anchored, or null if the situation is symmetric (both or neither anchored)
 * and needs to be handled by the caller instead.
 */
function resolveAnchor(playerA, playerB, posA, posB) {
  const aAnchored = playerA.isSneaking;
  const bAnchored = playerB.isSneaking;
  if (aAnchored === bAnchored) return null;
  return aAnchored
    ? { anchor: playerA, other: playerB, anchorPos: posA, otherPos: posB }
    : { anchor: playerB, other: playerA, anchorPos: posB, otherPos: posA };
}

/** Called once per physics tick (see TICK_INTERVAL in main.js) for every active rope pair. */
export function runRopeTick(tickCount) {
  const pairs = getAllPairs();
  const moveBudget = new Map(); // name -> teleports caused this tick, safety cap for chains
  const pendingImpulses = new Map();

  for (const [nameA, nameB] of pairs) {
    const playerA = getPlayerByName(nameA);
    const playerB = getPlayerByName(nameB);
    if (!playerA || !playerB) continue; // one of them is offline

    const key = pairKey(nameA, nameB);
    let state = pairState.get(key);
    if (!state) {
      state = { lastPosA: playerA.location, lastPosB: playerB.location, taut: false };
      pairState.set(key, state);
    }

    // Dimension mismatch is normally caught by the playerDimensionChange event,
    // but if it happens for any other reason, treat it as a safety net here too.
    if (playerA.dimension.id !== playerB.dimension.id) {
      const budgetUsed = moveBudget.get(nameB) ?? 0;
      if (budgetUsed < MOVE_BUDGET_PER_TICK) {
        teleportFollowerTo(playerB, playerA);
        moveBudget.set(nameB, budgetUsed + 1);
      }
      state.lastPosA = playerA.location;
      state.lastPosB = playerB.location;
      continue;
    }

    const posA = playerA.location;
    const posB = playerB.location;

    const deltaA = distance3D(posA, state.lastPosA);
    const deltaB = distance3D(posB, state.lastPosB);
    const dist = distance3D(posA, posB);

    // Large single-tick jump for either player = treat as a teleport (ender pearl, /tp, etc),
    // not a clamp. The player who DIDN'T jump gets pulled to the one who did.
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
      // If both jumped in the same tick, leave them - most likely both got moved by
      // something external in the same tick (e.g. both entered a portal together).
      state.lastPosA = playerA.location;
      state.lastPosB = playerB.location;
      state.taut = false;
      continue;
    }

    if (dist > MAX_DISTANCE) {
      const anchorInfo = resolveAnchor(playerA, playerB, posA, posB);

      let held; // the player who gets clamped this tick
      let anchorPos;
      let heldPos;

      if (anchorInfo) {
        // Exactly one player is bracing (sneaking) - they never move; the
        // other one is held at rope's length from them. This is the
        // "hold someone from a bridge" case.
        held = anchorInfo.other;
        anchorPos = anchorInfo.anchorPos;
        heldPos = anchorInfo.otherPos;
      } else {
        // Neither is bracing: default is DRAG, not stop. Whoever is actively
        // moving away succeeds in pulling the other along - the passive
        // partner (who moved less this tick) is the one held/dragged toward
        // the active mover, not the other way around.
        const aIsActive = deltaA >= deltaB;
        held = aIsActive ? playerB : playerA;
        anchorPos = aIsActive ? posA : posB;
        heldPos = aIsActive ? posB : posA;
      }

      // Land slightly INSIDE the max radius (not exactly on it). Landing exactly
      // on the boundary means the very next tick's tiny movement/float jitter can
      // push distance back over MAX_DISTANCE, triggering another clamp - repeated
      // every tick, which is what produces an "invisible wall grabbing you"
      // feeling. The buffer creates a small dead zone so one clamp actually settles.
      applyClampCorrection(pendingImpulses, held, anchorPos, heldPos);

      if (!state.taut) {
        playTautSound(held);
        state.taut = true;
      }
    } else if (dist > SLACK_DISTANCE) {
      // Taut zone: no hard clamp yet, but the rope should feel like it's
      // resisting. Depth scales 0 (at SLACK_DISTANCE) to 1 (at MAX_DISTANCE).
      const depth = (dist - SLACK_DISTANCE) / (MAX_DISTANCE - SLACK_DISTANCE);
      const pull = PULL_STRENGTH * depth;

      const anchorInfo = resolveAnchor(playerA, playerB, posA, posB);
      if (anchorInfo) {
        // Only the non-anchored player feels the pull - the bracing player
        // holds firm and isn't nudged at all.
        applyInwardPull(pendingImpulses, anchorInfo.other, anchorInfo.otherPos, anchorInfo.anchorPos, pull);
      } else if (playerA.isSneaking && playerB.isSneaking) {
        // Both bracing - tension held, nobody nudged.
      } else {
        // Default: symmetric tug, both players feel a gentle pull toward each other.
        applyInwardPull(pendingImpulses, playerA, posA, posB, pull);
        applyInwardPull(pendingImpulses, playerB, posB, posA, pull);
      }

      if (!state.taut) {
        playTautSound(playerA);
        state.taut = true;
      }
    } else {
      state.taut = false;
    }

    // Particle trail, drawn only every PARTICLE_INTERVAL_TICKS to keep it subtle.
    if (tickCount % PARTICLE_INTERVAL_TICKS === 0) {
      drawRopeParticles(playerA.dimension, playerA.location, playerB.location);
    }

    state.lastPosA = playerA.location;
    state.lastPosB = playerB.location;
  }

  applyPendingImpulses(pendingImpulses);
}

/** Call when a rope pair is removed elsewhere, to drop its stale runtime state. */
export function clearPairState(nameA, nameB) {
  pairState.delete(pairKey(nameA, nameB));
}
