# Rope Addon — install & usage

## Install
1. Import `rope_addon.mcaddon` (double-tap it, or use "Import" from within
   Minecraft). It contains two packs — a Behavior Pack (the logic) and a
   Resource Pack (the item texture) — both need to end up applied to your
   world. If double-tap import doesn't work, copy the `BP` folder into your
   world's `behavior_packs` folder and the `RP` folder into `resource_packs`
   manually.
2. In the world settings, activate **both** "Rope Addon" (Behavior Packs)
   and "Rope Addon (Textures)" (Resource Packs).
3. Still in world settings, scroll to **Experiments** and enable
   **"Beta APIs"**. Required for the Script API to run at all — the addon
   will silently do nothing without it.
4. Start/re-enter the world.

If you already installed an earlier version: remove the old "Rope Addon"
pack(s) from the world first, then import this one, to avoid ending up with
two versions active at once.

## Adding your own texture
The item currently uses a placeholder icon (a simple brown line) so nothing
looks broken out of the box. To swap in your own art:
1. Make a 16×16 (or 32×32/64×64 — any power-of-two square works) PNG.
2. Replace `RP/textures/items/rope_tether_item.png` with your file, keeping
   the exact same filename.
3. Re-import/re-copy just that one file — nothing else needs to change,
   since the item JSON and texture mapping already point at it.

## Giving yourself the rope item
There's no crafting recipe (by design, per project scope). Give it with a
command in-game:

```
/give @s rope:tether_item
```

## Using it
- Point at another player (within ~6 blocks by default) and use the item
  (right-click / tap-to-use, same as drinking a potion or eating) to tie a
  rope between you and them. Use it again while looking at the same player
  to untie. You don't need to precisely tap the other player's model - just
  aim roughly at them and use the item.
- You can tie as many pairs as you like — any player can be tied to any
  number of others; each rope pair behaves independently.
- **Slack zone** (0–8 blocks by default): fully free, no effect at all.
- **Taut zone** (8–10 blocks): the rope actively resists — a gentle pull
  toward each other, stronger the closer you get to the hard limit.
- **Hard limit** (10 blocks): by default, **the rope drags, it doesn't
  stop** — whoever is actively walking away succeeds in pulling their
  partner along with them, since neither of you is bracing against it.
  **Sneak (shift) to brace yourself as an anchor**: a sneaking player never
  gets moved by the rope, and instead holds their partner at rope's length.
  This is how you hold someone from a bridge — stand near the edge, sneak,
  and if your partner walks/falls off, they're held at the limit instead of
  dragging you off too. If neither player sneaks, a player who gets stuck
  (e.g. boxed into a hole) can be dragged out of it by their partner walking
  away — sneak to avoid that if you want to stay put.
- A big sudden jump in position (ender pearl, commands, etc.) or a
  dimension change (portal, respawn anchor) pulls the tied partner along
  instead of being treated as a clamp.

## Tuning
All the numbers that matter live in one file: `BP/scripts/config.js` —
slack distance, max distance, pull strength, particle look, sound, etc.
Edit that file and reload the world; no other file needs to change.

Two values affect how the hard limit *feels*, worth knowing about if you
tune them:
- `CLAMP_BUFFER` — how far inside the max distance the hold-back point sits.
  Too small and it can feel jittery/grabby again; too large and the rope
  feels shorter than its stated max distance.
- `PULL_STRENGTH` — how hard the taut-zone pull is. Too strong and it'll
  feel like being yanked; too weak and you won't notice it before hitting
  the hard limit.
- `CLAMP_IMPULSE_STRENGTH` and `MAX_CLAMP_CORRECTION` — control how quickly
  a player is smoothly pulled back at the hard limit. The correction uses
  full 3D motion, so a player falling below a bridge is pulled upward too.

## Known limitations (accepted for this project's scope)
- Bedrock predicts player movement client-side, so rope impulses can still
  receive occasional server correction. The rope uses per-tick full-vector
  impulses instead of repeatedly teleporting the pulled player, which keeps
  the correction smoother while retaining the buffer at the hard limit.
- Clamp and follow destinations are checked against the player's occupied
  space and shifted to a nearby clear position when possible. Extremely
  enclosed spaces can still prevent a safe correction.
- Rope impulses are combined per player before being applied. If a player is
  already inside a block, rope movement is suspended until a clear recovery
  position exists; the rope never uses force to push their feet, body, or head
  through solid blocks. A sealed one-block hole therefore requires a
  separate teleport or manual escape.
- Same-dimension teleport detection is a "big position jump" heuristic —
  can misfire on legitimate very fast movement, but works for the common
  cases (ender pearls, commands).
- No physical rope model is rendered — the rope is a particle trail only.
- Not hardened against every edge case (e.g. clamp destinations aren't
  exhaustively safety-checked) — built for two people playing casually,
  not for adversarial use.
