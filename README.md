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

Controls: `WASD` move · `Shift` sprint · `Space` jump · `LMB` spray · `RMB`/`F` kinetic pulse ·
`1`–`5`/wheel select pigment · `Q` solvent · `R` return to checkpoint · `Esc` pause.

The story runs through three connected districts — the Research Courtyard, the Machine Works and
the Gravity Tower — with checkpoints and automatic saving (localStorage). The **Sandbox** on the
main menu is a test range with every pigment unlocked (`C` spawns crates).

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

`tests/run.mjs` drives the real game headlessly (Playwright + Chromium, software WebGL) and
asserts that each pigment changes behaviour, that the combinations work, and that puzzles,
checkpoints, respawning and save/restore function. Playwright is expected to be available in the
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
