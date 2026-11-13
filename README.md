# REALITY BRUSH — Rewrite the World

A first-person physics sandbox and puzzle-adventure for desktop browsers. You carry an
experimental paint gun whose pigments do not decorate the world — they change its rules.

| Pigment | Rule it rewrites |
| --- | --- |
| **Purple — Anti-Gravity** | Movable objects hover above whatever is beneath them. More coverage = more height. Purple ground projects a low-gravity column. |
| **Blue — Ice** | Painted texels lose friction for you and for objects. Momentum carries; slopes accelerate you. Paint an object blue and it slides anywhere. |
| **Green — Growth** | Fertile moss sprouts climbable ivy exactly where it is painted. Fertile soil raises a stalk; keep feeding it (or its cap) and it keeps growing. |
| **Yellow — Bounce** | Painted surfaces become springs. Fall further, fly further. Works on floors, walls, objects and grown platforms. |
| **Red — Energy** | Covering a receptor plate powers its machine: doors, mag-line conveyors, lifts, stampers, rotors. |
| **Solvent** | Strips paint, undoing any of the above. |

Paint is stored per texel on every paintable surface, so coverage is always where you aimed,
surfaces can be repainted, and the gameplay reads the same grid the renderer draws.

## Play

```bash
npm install
npm run dev        # http://localhost:5173
```

It plays with keyboard and mouse, a gamepad, or touch — the game switches prompts to whichever
you are using.

| | Keyboard + mouse | Gamepad | Touch |
| --- | --- | --- | --- |
| Move / look | `WASD` / mouse | left / right stick | left thumb / drag on the right |
| Sprint / jump | `Shift` / `Space` | `L3` / `A` | push the stick past its ring / `JUMP` |
| Spray | `LMB` | `RT` | hold `SPRAY` (drag it to keep aiming) |
| Paint bomb | `E` | `X` | `BOMB` |
| Kinetic pulse | `RMB` or `F` | `LT` | `PULSE` |
| Pigment / solvent | `1`–`5`, wheel / `Q` | `LB` `RB` / `B` | tap the hotbar |
| Pause | `Esc` | `Start` | pause button |

`R` returns to the last checkpoint (also in the pause menu). The paint bomb throws one large
splash of the selected pigment on a short cooldown. A diamond marker points at the current
objective.

There is plenty to find off the main path: sixteen echo shards, eleven field-note terminals that
fill in what happened here, and three sealed vaults. Each vault opens for one pigment — usually
one you only earn after you have walked past it — and holds a permanent brush upgrade (wider
splats, faster paint bombs, a stronger pulse). Everything found is listed in the pause menu.

The story runs through three connected districts — the Research Courtyard, the Machine Works and
the Gravity Tower — with checkpoints and automatic saving (localStorage). The **Sandbox** on the
main menu is a test range with every pigment unlocked (`C` spawns crates).

Saving records the checkpoint, pigments, objectives and the state of every machine. Paint itself
persists for the whole session and is repainted onto powered receptors when a save is loaded;
free-form paint on walls and floors is not written to disk.

Requires a desktop browser with WebGL2 and WebAssembly. If the frame rate stays low the game
switches itself to the Performance preset (also selectable in the menu).

## Build and deploy

```bash
npm run build      # type-check + production bundle in dist/
npm run preview    # serve the production bundle on :4173
```

The project is a static Vite site with no backend, accounts or paid services. `vercel.json`
declares the Vite preset, so importing the repository into Vercel (or running `vercel`) deploys it
as-is: build command `npm run build`, output directory `dist`.

## Tests

```bash
npm run build && npm test          # all gameplay tests
npm test -- ice                    # only tests whose name contains "ice"
```

`tests/run.mjs` drives the real game headlessly (Playwright + Chromium, software WebGL). Twenty-five
tests assert that each pigment changes behaviour, that combinations work (float + mag-line,
growth + bounce, float + pulse, stacking), that every gate of the story can be passed, and that
checkpoints, respawning, save/continue and restart function. Gamepad input is driven through a
mocked controller and touch through a phone-sized touch context. One test plays the opening with no
shortcuts — walking, jumping, aiming and spraying — to confirm the first set piece is reachable
inside a minute. Playwright is expected to be available in the
environment (`npm i -D playwright` otherwise).

## Architecture

```
src/
  game.ts              loop, state machine, events, objectives, save/restore
  core/                physics wrapper (Rapier), input, procedural WebAudio
  paint/
    paintable.ts       per-texel paint grid + box-projected paint shader
    gun.ts             viewmodel, paint stream, impacts, kinetic pulse
  player/player.ts     kinematic character: ice momentum, bounce, vines, platform riding
  systems/
    dynamics.ts        paint rules for every rigid body (hover / ice / bounce)
    growth.ts          ivy and stalks
    power.ts           receptors, movers, conveyors, rotors, sockets
    zones.ts           checkpoints, pickups, triggers, kill volumes
  render/              renderer, sky, post-processing, procedural PBR materials, particles
  world/               level construction kit, lighting bake, the three districts, the sandbox
```

Abilities are systems, not scripted puzzle solutions: any dynamic body, any paintable surface and
any machine obeys the same rules, which is what makes unplanned solutions possible.

Everything is procedural — geometry, textures, lighting bake (per-vertex ambient occlusion, sky
visibility and static lamps, computed at load) and audio — so the repository ships no binary
assets.
