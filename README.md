# Rope Addon — install & usage

## Install
1. Import `rope_1.0.mcaddon` (double-tap it, or use "Import" from within
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
- **Below the hard limit** (10 blocks by default): fully free. The rope does
  not pull players together, so inward, sideways, and ordinary falling
  movement are preserved.
- **At the hard limit**: the constraint reads both players' 3D velocities and
  removes only their relative outward velocity along the rope. Equal-mass
  players share that correction, so the rope resists stretching without
  snapping either player back or disturbing sideways movement.
- If a tick has already left the pair slightly beyond the limit, a capped
  stretch-based inward impulse pulls both players back toward each other. This
  makes the trailing player follow instead of allowing the rope to remain
  stretched indefinitely.
- When one player is clearly running away, the impulse is intentionally
  asymmetric: the runner receives a smaller opposing impulse and the passive
  player receives the larger pull. This approximates momentum transfer through
  a real rope while keeping the runner mobile.
- Rope response is deliberately damped and capped. Only a fraction of
  outward speed is corrected per tick, and diagonal ropes have a separate
  vertical impulse cap so tension cannot catapult players into the air.
- **Sneak (shift) to brace yourself**: a sneaking player remains part of the
  rope constraint but responds at 25% mobility. The remaining correction is
  transferred to the other player, so sneaking makes the player harder to
  pull without disconnecting the rope. Downward rope impulses are suppressed
  for the sneaking player, allowing them to brace on a block or ledge.
- The velocity constraint is the only normal distance correction: players are
  never teleported a small amount by rope physics. Large sudden jumps
  (movement greater than `TELEPORT_JUMP_THRESHOLD`, such as an ender pearl or
  command) and dimension changes still pull the tied partner along through
  the existing teleport-follow behavior.
- A big sudden jump in position (ender pearl, commands, etc.) or a
  dimension change (portal, respawn anchor) pulls the tied partner along
  instead of being treated as a clamp.

## Script debugging

This workspace includes a VS Code listen configuration at
`.vscode/launch.json`. To debug the behavior-pack script:

1. Run the Windows loopback exemption command once in PowerShell or Command
   Prompt (use the Bedrock Preview command instead if you use Preview):

   ```
   CheckNetIsolation.exe LoopbackExempt -a -p=S-1-15-2-1958404141-86561845-1752920682-3514627264-368642714-62675701-733520436
   ```
2. Open this repository in VS Code and press `F5`, selecting
   **Debug Rope Addon with Minecraft**.
3. Enter a world with this behavior pack active.
4. Run `/script debugger connect` in the world chat/console. The expected
   response is `Debugger connected to host`.
5. Set breakpoints in `BP/scripts/` and exercise the rope in-game.

The debugger listens on port `19144`. This project has no build step, so the
configuration maps the JavaScript source directly from `BP/`.

## Tuning
All the numbers that matter live in one file: `BP/scripts/config.js` —
maximum distance, rope response, particle look, sound, etc.
Edit that file and reload the world; no other file needs to change.

Two values affect how the hard limit *feels*, worth knowing about if you
tune them:
- `PARTICLE_ENDPOINT_OFFSET` and `PARTICLE_BODY_HEIGHT` — keep the visible
  particle rope away from player hitboxes and attach it around torso height.
- `ROPE_RADIAL_RESPONSE`, `MAX_ROPE_IMPULSE`, and
  `MAX_ROPE_VERTICAL_IMPULSE` — control taut-rope damping and safety caps.

## Adding your own texture
The item currently uses a placeholder icon (a simple brown line) so nothing
looks broken out of the box. To swap in your own art:
1. Make a 16×16 (or 32×32/64×64 — any power-of-two square works) PNG.
2. Replace `RP/textures/items/rope_tether_item.png` with your file, keeping
   the exact same filename.
3. Re-import/re-copy just that one file — nothing else needs to change,
   since the item JSON and texture mapping already point at it.

## Giving yourself the rope item
## Known limitations (accepted for this project's scope)
- Bedrock predicts player movement client-side, so rope impulses can still
  receive occasional server correction. The rope uses per-tick radial
  impulses and never performs small positional teleports, which keeps the
  correction smoother and lets the pair swing naturally.
- Follow destinations for dimension changes and large external teleports are
  checked against the player's occupied space and shifted to a nearby clear
  position when possible. Extremely enclosed spaces can still prevent a safe
  correction.
- Rope impulses are combined per player before being applied. If a player is
  already inside a block, rope movement is suspended until a clear recovery
  position exists; the rope never uses force to push their feet, body, or head
  through solid blocks. A sealed one-block hole therefore requires a
  separate teleport or manual escape.
- Normal rope movement is velocity-based in 3D. The solver predicts one tick
  ahead at the boundary, transfers radial tension between the endpoints, and
  leaves perpendicular movement and inward movement undamped.
- Same-dimension teleport detection is a "big position jump" heuristic —
  can misfire on legitimate very fast movement, but works for the common
  cases (ender pearls, commands).
- No physical rope model is rendered — the rope is a particle trail only.
- Not hardened against every edge case (e.g. clamp destinations aren't
  exhaustively safety-checked) — built for two people playing casually,
  not for adversarial use.
