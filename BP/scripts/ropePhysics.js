import { world } from "@minecraft/server";
import {
  SLACK_DISTANCE,
  MAX_DISTANCE,
  TELEPORT_JUMP_THRESHOLD,
  PARTICLE_INTERVAL_TICKS,
  MOVE_BUDGET_PER_TICK,
  CLAMP_BUFFER,
  PULL_STRENGTH,
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

/**
 * Teleports `follower` to just next to `target`'s position/dimension.
 * Very small safety net only (not a full safe-spot search) per project scope.
 */
function teleportFollowerTo(follower, target) {
  const targetPos = target.location;
  // Offset slightly so the follower doesn't land exactly inside the target.
  const destination = {
    x: targetPos.x + (Math.random() < 0.5 ? 1 : -1),
    y: targetPos.y,
    z: targetPos.z + (Math.random() < 0.5 ? 1 : -1),
  };
  teleportPreservingFacing(follower, destination, target.dimension);
}

/**
 * Nudges `player` (standing at `fromPos`) gently toward `towardPos`, horizontally
 * only (no vertical impulse - avoids launching players into the air or messing
 * with fall state). `strength` should be small (see PULL_STRENGTH in config.js).
 */
function applyInwardPull(player, fromPos, towardPos, strength) {
  const dx = towardPos.x - fromPos.x;
  const dz = towardPos.z - fromPos.z;
  const horizDist = Math.sqrt(dx * dx + dz * dz);
  if (horizDist < 0.001) return; // already aligned horizontally, nothing to pull toward
  const dirX = (dx / horizDist) * strength;
  const dirZ = (dz / horizDist) * strength;
  try {
    player.applyKnockback({ x: dirX, z: dirZ }, 0);
  } catch {
    // Non-critical if it fails on a given tick.
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
      const clamped = clampToRadius(anchorPos, heldPos, MAX_DISTANCE - CLAMP_BUFFER);
      teleportPreservingFacing(held, clamped, held.dimension);
      held.clearVelocity?.(); // best-effort; may not affect Players, see README

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
        applyInwardPull(anchorInfo.other, anchorInfo.otherPos, anchorInfo.anchorPos, pull);
      } else if (playerA.isSneaking && playerB.isSneaking) {
        // Both bracing - tension held, nobody nudged.
      } else {
        // Default: symmetric tug, both players feel a gentle pull toward each other.
        applyInwardPull(playerA, posA, posB, pull);
        applyInwardPull(playerB, posB, posA, pull);
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
}

/** Call when a rope pair is removed elsewhere, to drop its stale runtime state. */
export function clearPairState(nameA, nameB) {
  pairState.delete(pairKey(nameA, nameB));
}
