import { world } from "@minecraft/server";
import { ROPE_ITEM_ID, TETHER_MAX_TIE_DISTANCE } from "./config.js";
import { toggleRope } from "./ropeManager.js";
import { clearPairState } from "./ropePhysics.js";

/**
 * NOTE: we deliberately do NOT use world.afterEvents.playerInteractWithEntity
 * here. That event is unreliable when the target is another player (as
 * opposed to a mob/NPC) - tapping/right-clicking a player is ambiguous with
 * attacking on Bedrock, and the interact event often just doesn't fire.
 *
 * Instead: listen for the item being used at all (itemUse fires even when
 * swung at empty air), then raycast from the player's own view direction to
 * find the nearest player they're looking at. This sidesteps the
 * attack/interact ambiguity entirely.
 */
export function registerToggleItemHandler() {
  world.afterEvents.itemUse.subscribe((event) => {
    const { source: player, itemStack } = event;

    if (!itemStack || itemStack.typeId !== ROPE_ITEM_ID) return;

    const hits = player.getEntitiesFromViewDirection({
      maxDistance: TETHER_MAX_TIE_DISTANCE,
    });

    const targetHit = hits.find(
      (hit) => hit.entity.typeId === "minecraft:player" && hit.entity.id !== player.id
    );

    if (!targetHit) {
      player.sendMessage("No other player in view to tie the rope to.");
      return;
    }

    const target = targetHit.entity;
    const result = toggleRope(player.name, target.name);

    if (result === "untied") {
      clearPairState(player.name, target.name);
    }

    const message =
      result === "tied"
        ? `Rope tied between you and ${target.name}.`
        : `Rope removed between you and ${target.name}.`;
    player.sendMessage(message);
    if (target.sendMessage) target.sendMessage(message);
  });
}
