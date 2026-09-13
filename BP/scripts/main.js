import { world, system } from "@minecraft/server";
import { TICK_INTERVAL } from "./config.js";
import { loadRopePairs } from "./ropeManager.js";
import { runRopeTick } from "./ropePhysics.js";
import { registerTeleportHandler } from "./teleportHandler.js";
import { registerToggleItemHandler } from "./toggleItem.js";

let tickCount = 0;

// Load persisted rope pairs once the world is ready to be scripted against.
system.run(() => {
  loadRopePairs();
});

registerTeleportHandler();
registerToggleItemHandler();

system.runInterval(() => {
  tickCount += TICK_INTERVAL;
  runRopeTick(tickCount);
}, TICK_INTERVAL);
