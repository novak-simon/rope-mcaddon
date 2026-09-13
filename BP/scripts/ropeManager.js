import { world } from "@minecraft/server";
import { DYNAMIC_PROPERTY_KEY } from "./config.js";

// Pairs are stored by player NAME (not runtime id) so they survive a world
// reload / relog. At runtime we resolve names back to live Player objects
// each tick via world.getPlayers().
//
// Internal shape: Array<[nameA, nameB]>
// A pair is unordered for lookup purposes but we keep the array order stable.

let pairs = [];

function save() {
  world.setDynamicProperty(DYNAMIC_PROPERTY_KEY, JSON.stringify(pairs));
}

export function loadRopePairs() {
  const raw = world.getDynamicProperty(DYNAMIC_PROPERTY_KEY);
  if (typeof raw === "string") {
    try {
      pairs = JSON.parse(raw);
    } catch {
      pairs = [];
    }
  } else {
    pairs = [];
  }
}

function findPairIndex(nameA, nameB) {
  return pairs.findIndex(
    ([a, b]) =>
      (a === nameA && b === nameB) || (a === nameB && b === nameA)
  );
}

/**
 * Toggles a rope between two player names.
 * Returns "tied" or "untied" depending on the resulting state.
 */
export function toggleRope(nameA, nameB) {
  const idx = findPairIndex(nameA, nameB);
  if (idx >= 0) {
    pairs.splice(idx, 1);
    save();
    return "untied";
  }
  pairs.push([nameA, nameB]);
  save();
  return "tied";
}

/** Returns all pairs as [nameA, nameB] tuples. */
export function getAllPairs() {
  return pairs;
}

/** Returns all rope partner names for a given player name. */
export function getPartnersOf(name) {
  const partners = [];
  for (const [a, b] of pairs) {
    if (a === name) partners.push(b);
    else if (b === name) partners.push(a);
  }
  return partners;
}

/** Removes every rope involving this player name (e.g. on leave, if desired). */
export function removeAllRopesFor(name) {
  const before = pairs.length;
  pairs = pairs.filter(([a, b]) => a !== name && b !== name);
  if (pairs.length !== before) save();
}
