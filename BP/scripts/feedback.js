import {
  PARTICLE_EFFECT,
  PARTICLE_POINT_COUNT,
  PARTICLE_ENDPOINT_OFFSET,
  PARTICLE_BODY_HEIGHT,
  TAUT_SOUND,
} from "./config.js";
import { lerpVec } from "./vecMath.js";

/** Spawns a light trail of particles between two points. Call this sparingly (see PARTICLE_INTERVAL_TICKS). */
export function drawRopeParticles(dimension, posA, posB) {
  const dx = posB.x - posA.x;
  const dy = posB.y - posA.y;
  const dz = posB.z - posA.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance < PARTICLE_ENDPOINT_OFFSET * 2) return;

  const direction = {
    x: dx / distance,
    y: dy / distance,
    z: dz / distance,
  };
  const start = {
    x: posA.x + direction.x * PARTICLE_ENDPOINT_OFFSET,
    y: posA.y + PARTICLE_BODY_HEIGHT + direction.y * PARTICLE_ENDPOINT_OFFSET,
    z: posA.z + direction.z * PARTICLE_ENDPOINT_OFFSET,
  };
  const end = {
    x: posB.x - direction.x * PARTICLE_ENDPOINT_OFFSET,
    y: posB.y + PARTICLE_BODY_HEIGHT - direction.y * PARTICLE_ENDPOINT_OFFSET,
    z: posB.z - direction.z * PARTICLE_ENDPOINT_OFFSET,
  };

  for (let i = 1; i < PARTICLE_POINT_COUNT; i++) {
    const t = i / PARTICLE_POINT_COUNT;
    const point = lerpVec(start, end, t);
    try {
      dimension.spawnParticle(PARTICLE_EFFECT, point);
    } catch {
      // Swallow errors from particle spawn (e.g. unloaded chunk) - purely cosmetic, not critical.
    }
  }
}

/** Plays the "rope just went taut" cue at a player's position. */
export function playTautSound(player) {
  try {
    player.playSound(TAUT_SOUND, { volume: 0.6, pitch: 1.0 });
  } catch {
    // Non-critical if it fails.
  }
}
