// All tunable values live here. Edit these and nothing else needs to change.

export const MAX_DISTANCE = 10;       // maximum 3D distance between paired players
export const TELEPORT_JUMP_THRESHOLD = 16; // same-dimension position jump bigger than this = treat as teleport, not clamp
export const TICK_INTERVAL = 1;       // how often (in ticks) the constraint check runs. 1 = every tick.
export const PARTICLE_INTERVAL_TICKS = 4; // how often the rope particle trail is (re)drawn
export const PARTICLE_POINT_COUNT = 6;    // number of particle points sampled along the rope
export const PARTICLE_EFFECT = "minecraft:basic_flame_particle"; // swap for a subtler/different vanilla particle if desired
export const TAUT_SOUND = "mob.horse.jump"; // short creak-ish placeholder; swap for any vanilla sound id
export const MOVE_BUDGET_PER_TICK = 6; // safety cap: max number of rope-triggered teleports a single player can cause in one tick (guards against circular chains)
export const PARTICLE_ENDPOINT_OFFSET = 0.7; // keeps particles outside the player's hitbox
export const PARTICLE_BODY_HEIGHT = 0.9; // attach the visible rope near the player's torso, not feet/head

export const TETHER_MAX_TIE_DISTANCE = 6; // how far away a player can be and still be raycast-targeted to tie/untie
export const ROPE_ITEM_ID = "rope:tether_item";
export const DYNAMIC_PROPERTY_KEY = "rope:pairs"; // world dynamic property used to persist rope pairs
