import { world } from "@minecraft/server";
import { getPartnersOf } from "./ropeManager.js";

function getPlayerByName(name) {
  for (const p of world.getPlayers()) {
    if (p.name === name) return p;
  }
  return undefined;
}

/**
 * When a player changes dimension (portal, respawn anchor, etc.), every player
 * tied to them follows into the new dimension. This only handles ONE hop -
 * if that partner is themselves tied to someone else, that second rope's own
 * tick-based mismatch check (see ropePhysics.js) picks it up on the next tick
 * and cascades naturally, per the agreed "let consequences come from
 * individual ropes" design.
 */
export function registerTeleportHandler() {
  world.afterEvents.playerDimensionChange.subscribe((event) => {
    const { player, toDimension, toLocation } = event;
    const partners = getPartnersOf(player.name);

    for (const partnerName of partners) {
      const partner = getPlayerByName(partnerName);
      if (!partner) continue; // offline
      if (partner.dimension.id === toDimension.id) continue; // already there

      const destination = {
        x: toLocation.x + (Math.random() < 0.5 ? 1 : -1),
        y: toLocation.y,
        z: toLocation.z + (Math.random() < 0.5 ? 1 : -1),
      };
      try {
        const rotation = partner.getRotation();
        partner.teleport(destination, { dimension: toDimension, rotation });
      } catch {
        // Best-effort only, per project scope.
      }
    }
  });
}
