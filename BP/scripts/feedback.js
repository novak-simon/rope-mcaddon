import { PARTICLE_EFFECT, PARTICLE_POINT_COUNT, TAUT_SOUND } from "./config.js";
import { lerpVec } from "./vecMath.js";

/** Spawns a light trail of particles between two points. Call this sparingly (see PARTICLE_INTERVAL_TICKS). */
export function drawRopeParticles(dimension, posA, posB) {
  for (let i = 1; i < PARTICLE_POINT_COUNT; i++) {
    const t = i / PARTICLE_POINT_COUNT;
    const point = lerpVec(posA, posB, t);
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
