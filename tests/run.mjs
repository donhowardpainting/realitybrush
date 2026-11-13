// Automated gameplay verification. Drives the real game (physics, paint, input) headlessly:
//   npm run build && npm test            (optionally: npm test -- <name-filter>)
// Each test boots a fresh world and asserts that paint actually changes how the world behaves.
import { serve, open } from './lib.mjs';

const HELPERS = `
  const g = window.__rb;
  const V = g.player.pos.constructor;
  const P = { none: 0, purple: 1, blue: 2, green: 3, yellow: 4, red: 5 };
  const up = new V(0, 1, 0);
  const dyn = (tag) => g.dynamics.bodies.find((d) => d.p.tags.has(tag));
  const at = (x, y, z, yaw = 0, pitch = 0) => { g.player.teleport(new V(x, y, z), yaw); g.player.pitch = pitch; };
  const hold = (key, s) => { g.input.press(key); g.simulate(s); g.input.release(key); };
  // splat through the same entry point the paint gun uses
  const splat = (x, y, z, type, n = up, r = 0.5) => {
    const h = g.physics.castRay(x + n.x * 0.5, y + n.y * 0.5, z + n.z * 0.5, -n.x, -n.y, -n.z, 2);
    if (!h) return false;
    const p = g.paint.get(h.collider);
    return p ? g.paint.splat(p, h.point.clone(), h.normal.clone(), type, r, true) : false;
  };
  const area = (x0, x1, z0, z1, y, type, step = 0.6) => { for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) splat(x, y, z, type); };
  const surfaceAt = (x, y, z, n = up) => { const h = g.physics.castRay(x + n.x * 0.5, y + n.y * 0.5, z + n.z * 0.5, -n.x, -n.y, -n.z, 2); return h ? g.paint.get(h.collider).typeAt(h.point, h.normal) : -1; };
  const power = (id) => { const r = g.power.receptor(id); const t = r.p.body.translation(); for (const f of [0, 1, 2, 3, 4, 5]) r.p.fill(r.need, f); g.simulate(0.1); return r; };
  const check = (cond, msg) => { if (!cond) throw new Error(msg); };
  const r2 = (v) => Math.round(v * 100) / 100;
`;

const tests = {
  async paint_is_localized_and_repaintable() {
    g.start('sandbox'); g.simulate(0.3);
    const p = g.paint.get(g.physics.castRay(290, 0.5, -4, 0, -1, 0, 2).collider);
    check(!p.dynamic, 'expected the yard floor');
    splat(290, 0, -4, P.purple);
    check(surfaceAt(290, 0, -4) === P.purple, 'spot should be purple');
    check(surfaceAt(294, 0, -4) === P.none, 'a spot 4 m away must stay unpainted');
    const cov = p.coverage(P.purple);
    check(cov > 0 && cov < 0.002, 'one splat must cover a tiny fraction of a 22x48 m floor, got ' + cov);
    splat(290, 0, -4, P.blue);
    check(surfaceAt(290, 0, -4) === P.blue, 'repaint should replace purple with blue');
    check(p.coverage(P.purple) < cov * 0.35, 'most purple should be overwritten');
    splat(290, 0, -4, P.none, up, 0.9);
    check(surfaceAt(290, 0, -4) === P.none, 'solvent should strip paint');
    return { oneSplatCoverage: cov };
  },

  async gun_paints_where_you_aim() {
    g.start('sandbox'); g.simulate(0.3);
    at(300, 0, 10, 0, -0.5); g.simulate(0.2);
    g.gun.select(P.red);
    const e = g.player.eye, f = g.player.forward(new V());
    hold('Mouse0', 0.5); g.simulate(0.6);
    const h = g.physics.castRay(e.x, e.y, e.z, f.x, f.y, f.z, 50);
    const hit = h.point.clone();
    check(surfaceAt(hit.x, hit.y, hit.z) === P.red, 'crosshair point should be red');
    check(surfaceAt(hit.x + 2.5, hit.y, hit.z) === P.none, 'paint must not spread 2.5 m sideways');
    check(g.gun.shots >= 5, 'stream should emit several globs, got ' + g.gun.shots);
    return { shots: g.gun.shots, aim: hit.toArray().map(r2) };
  },

  async purple_floats_mass_and_carries_player() {
    g.start('new'); g.simulate(1);
    const mass = dyn('mass');
    const rest = mass.p.body.translation().y;
    at(0, 1.25, -11.9); g.simulate(0.5);
    check(g.player.grounded && g.player.feetY > 1.1, 'player should stand on the hanging mass');
    area(-2.5, 2.5, -14.4, -9.4, 1.2, P.purple, 0.8);
    g.simulate(7);
    const top = mass.p.body.translation().y + 0.45;
    check(g.seen.has('mass:float'), 'mass:float event');
    check(top > 7.7 && top < 8.3, 'mass top should settle level with the 8 m walkway, got ' + top);
    check(Math.abs(g.player.feetY - top) < 0.15, 'player should ride the mass up, feet at ' + g.player.feetY);
    hold('KeyW', 2.2);
    check(g.seen.has('zone:balcony'), 'player should walk off onto the walkway');
    check(g.zones.current.id === 'balcony', 'walkway checkpoint should activate');
    mass.p.clear(); g.simulate(5);
    const back = mass.p.body.translation().y;
    check(Math.abs(back - rest) < 0.15, 'stripping the paint should drop the mass back onto its cables, y=' + back);
    return { rest: r2(rest), top: r2(top), afterSolvent: r2(back) };
  },

  async first_minute_with_the_real_gun() {
    // No test shortcuts here: walk, jump, aim and spray exactly as a player would.
    g.start('new'); g.simulate(0.3);
    const mass = dyn('mass');
    let t = 0; const step = (s) => { g.simulate(s); t += s; };
    g.input.press('KeyW');
    while (t < 20 && !(g.player.feetY > 1.1 && g.player.pos.z < -10.5)) {
      if (g.player.grounded && g.player.feetY < 1 && g.player.pos.z < -6.4) g.input.press('Space');
      step(1 / 30);
      g.input.release('Space');
    }
    g.input.release('KeyW'); step(1);
    check(g.player.feetY > 1.1 && g.player.grounded, 'player should hop onto the hanging mass, at ' + g.player.pos.toArray().map(r2));
    g.player.pitch = -1.15;
    g.input.press('Mouse0');
    // keep sweeping the spray around your feet until the mass stops gaining lift
    for (let i = 0; i < 420 && mass.lift < 1; i++) { g.player.yaw = Math.sin(i / 12) * 1.6 + i / 40; g.player.pitch = -1.05 + Math.cos(i / 7) * 0.3; step(1 / 30); }
    g.input.release('Mouse0');
    check(g.seen.has('mass:float') && mass.lift >= 1, 'spraying underfoot should fully lift the mass, lift=' + mass.lift);
    while (t < 45 && mass.p.body.translation().y < 7.3) step(0.25);
    check(Math.abs(g.player.feetY - 8) < 0.4, 'player rides up to walkway height, feet ' + g.player.feetY);
    g.player.yaw = 0; g.player.pitch = 0;
    g.input.press('KeyW');
    while (t < 58 && !g.seen.has('zone:balcony')) { if (g.player.grounded && g.player.pos.z < -14) g.input.press('Space'); step(1 / 30); g.input.release('Space'); }
    g.input.release('KeyW');
    check(g.seen.has('zone:balcony'), 'reach the impossible walkway, at ' + g.player.pos.toArray().map(r2));
    check(t < 60, 'the whole sequence fits inside the first minute, took ' + t);
    return { seconds: r2(t), shots: g.gun.shots, lift: r2(mass.lift) };
  },

  async purple_height_scales_with_coverage() {
    g.start('sandbox'); g.simulate(0.5);
    const crates = g.dynamics.bodies.filter((d) => d.p.tags.has('crate') && d.home.x > 250 && d.p.body.mass() === 45);
    const a = crates[0], b = crates[1];
    const ta = a.p.body.translation(), tb = b.p.body.translation();
    g.paint.splat(a.p, new V(ta.x, ta.y + 0.5, ta.z), up, P.purple, 0.3, true);
    b.p.fill(P.purple);
    g.simulate(6);
    const ca = a.clearance, cb = b.clearance;
    check(ca > 0.3, 'a dab of purple should lift the crate a little, got ' + ca);
    check(cb > 5.5, 'full coverage should hover near max height, got ' + cb);
    check(cb > ca * 1.8, 'more paint must mean more lift');
    b.p.clear(); g.simulate(3);
    check(b.clearance < 0.1, 'solvent should bring it back down');
    return { dab: r2(ca), full: r2(cb) };
  },

  async yellow_bounces_player_and_objects() {
    g.start('sandbox'); g.simulate(0.3);
    const drop = (paint) => {
      at(300, 6, -6); if (paint) area(298.5, 301.5, -7.5, -4.5, 0, P.yellow, 0.5);
      let max = 0, landed = false; const b0 = g.player.stats.bounces;
      for (let i = 0; i < 240; i++) { g.simulate(1 / 60); if (g.player.grounded || g.player.stats.bounces > b0) landed = true; if (landed) max = Math.max(max, g.player.feetY); }
      return max;
    };
    const plain = drop(false), bouncy = drop(true);
    check(plain < 0.2, 'no bounce on bare ground, got ' + plain);
    check(bouncy > 3, 'yellow floor should launch the player, apex ' + bouncy);
    // objects too
    const crate = g.dynamics.bodies.find((d) => d.p.tags.has('crate') && d.home.x > 250);
    crate.p.body.setTranslation({ x: 300, y: 5, z: -6 }, true); crate.p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    let cmax = 0, hit = false;
    for (let i = 0; i < 200; i++) { g.simulate(1 / 60); const y = crate.p.body.translation().y; if (y < 0.8) hit = true; if (hit) cmax = Math.max(cmax, y); }
    check(cmax > 2, 'crate should rebound off yellow paint, apex ' + cmax);
    return { playerApexPlain: r2(plain), playerApexYellow: r2(bouncy), crateApex: r2(cmax) };
  },

  async yellow_carries_the_player_across_the_breach() {
    g.start('new'); g.simulate(0.3);
    at(0, 8, -35.5, 0); hold('KeyW', 4);
    check(!g.seen.has('zone:pumproof') && g.player.feetY < 3.5, 'without yellow the pump house is out of reach');
    area(-4.5, 4.5, -49, -41, 3, P.yellow, 0.55);
    at(0, 8, -35.5, 0);
    g.input.press('KeyW');
    for (let i = 0; i < 600 && !g.seen.has('zone:pumproof'); i++) g.simulate(1 / 60);
    g.input.release('KeyW');
    check(g.seen.has('zone:pumproof'), 'dropping onto the yellow roof should bounce the player onto the pump house, at ' + g.player.pos.toArray().map(r2));
    return { bounces: g.player.stats.bounces };
  },

  async floating_objects_stack() {
    g.start('sandbox'); g.simulate(0.5);
    const slabs = g.dynamics.bodies.filter((d) => d.p.tags.has('slab') && d.home.x > 250 && d.p.body.mass() < 200);
    const [a, b] = slabs;
    a.p.fill(P.purple); g.simulate(6);
    const ya = a.p.body.translation().y;
    const ta = a.p.body.translation();
    b.p.body.setTranslation({ x: ta.x, y: ta.y + 1, z: ta.z }, true); b.p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    b.p.fill(P.purple); g.simulate(7);
    const yb = b.p.body.translation().y;
    check(ya > 6, 'first slab hovers ~6.5 m up, y=' + ya);
    check(yb > ya + 5.5, 'second slab hovers above the first (stacked lift), y=' + yb);
    at(ta.x, yb + 0.3, ta.z); g.simulate(0.5);
    check(g.player.grounded && g.player.feetY > 12, 'player can stand on the stack, feet ' + g.player.feetY);
    return { first: r2(ya), second: r2(yb) };
  },

  async tower_stalk_plus_bounce_reaches_the_east_gallery() {
    g.start('new'); g.simulate(0.3);
    splat(8, 36.2, -209.4, P.green); g.simulate(0.2);
    const st = g.growth.stalks[0];
    check(!!st, 'stalk sprouts on the tower seed bed');
    for (let i = 0; i < 14; i++) splat(8, 36.2, -209.4 + (i % 2) * 0.2, P.green);
    g.simulate(5);
    check(st.height > 6.2, 'fed stalk reaches full height, ' + st.height);
    at(st.base.x, st.base.y + st.height + 0.05, st.base.z + 0.5, Math.PI); g.simulate(0.4);
    hold('Space', 0.05); g.simulate(1.2);
    check(!g.seen.has('zone:e1'), 'a plain jump from the cap must not reach the gallery');
    at(st.base.x, st.base.y + st.height + 0.05, st.base.z + 0.5, Math.PI); g.simulate(0.3);
    st.cap.fill(P.yellow);
    g.input.press('KeyW');
    for (let i = 0; i < 300 && !g.seen.has('zone:e1'); i++) g.simulate(1 / 60);
    g.input.release('KeyW');
    check(g.seen.has('zone:e1'), 'bouncing off the yellow cap should reach the east gallery, at ' + g.player.pos.toArray().map(r2));
    return { stalk: r2(st.height) };
  },

  async blue_ice_builds_momentum_to_clear_the_canal() {
    g.start('new'); g.simulate(0.3);
    const run = (ice) => {
      at(0, 6.5, -58.5, 0); g.simulate(0.2);
      if (ice) { for (let z = -60.3; z >= -88; z -= 0.5) for (let x = -3; x <= 3; x += 0.6) { const y = z > -84 ? 6.5 * (z + 84) / 24 : z > -85 ? 0 : (-85 - z) / 3; splat(x, y + 0.05, z, P.blue); } }
      let vmax = 0;
      g.input.press('KeyW');
      for (let i = 0; i < 480; i++) { g.simulate(1 / 60); vmax = Math.max(vmax, Math.hypot(g.player.vel.x, g.player.vel.z)); if (g.player.pos.z < -96 && g.player.grounded) break; }
      g.input.release('KeyW');
      return { vmax, z: g.player.pos.z, y: g.player.feetY, crossed: g.seen.has('zone:plaza') };
    };
    const dry = run(false);
    check(!dry.crossed, 'walking the dry chute must not clear the canal');
    check(dry.vmax < 9.5, 'dry speed stays at walking pace, got ' + dry.vmax);
    const iced = run(true);
    check(iced.vmax > 13, 'ice should build real speed, got ' + iced.vmax);
    check(iced.crossed, 'iced chute should launch the player across the canal (z=' + iced.z + ')');
    return { dryMax: r2(dry.vmax), icedMax: r2(iced.vmax) };
  },

  async blue_ice_lets_heavy_objects_slide() {
    g.start('sandbox'); g.simulate(0.5);
    const slab = g.dynamics.bodies.find((d) => d.p.body.mass() > 350 && d.p.tags.has('slab'));
    const push = () => { const t = slab.p.body.translation(); at(t.x, 0, t.z + 3.2, 0); const z0 = t.z; hold('KeyW', 2.5); g.simulate(1); return z0 - slab.p.body.translation().z; };
    const rough = push();
    const t = slab.p.body.translation();
    area(t.x - 3, t.x + 3, t.z - 14, t.z + 3, 0, P.blue, 0.5);
    const iced = push();
    check(rough < 0.3, '400 kg slab should barely move on rough ground, moved ' + rough);
    check(iced > 2, 'the same push on ice should send it gliding, moved ' + iced);
    return { rough: r2(rough), iced: r2(iced) };
  },

  async green_grows_stalks_that_lift_and_take_paint() {
    g.start('sandbox'); g.simulate(0.3);
    check(g.growth.stalks.length === 0, 'no stalks yet');
    splat(305, 0.3, -20, P.green);
    check(g.growth.stalks.length === 1, 'green on soil should sprout a stalk');
    const st = g.growth.stalks[0];
    g.simulate(3);
    const h1 = st.height;
    check(h1 > 1.8, 'stalk should grow, height ' + h1);
    at(st.base.x, st.base.y + st.height + 0.05, st.base.z); g.simulate(0.3);
    check(g.player.grounded, 'player can stand on the cap');
    for (let i = 0; i < 8; i++) g.paint.splat(st.cap, new V(st.base.x + 0.3, st.base.y + st.height, st.base.z), up, P.green, 0.3, true);
    g.simulate(4);
    check(st.height > h1 + 2, 'feeding the cap should grow it taller: ' + st.height);
    check(Math.abs(g.player.feetY - (st.base.y + st.height)) < 0.2, 'player should be lifted with the cap, feet ' + g.player.feetY);
    // green on bare concrete must not grow platforms
    splat(296, 0, 6, P.green);
    check(g.growth.stalks.length === 1, 'only fertile soil grows stalks');
    // combo: bounce on a grown platform
    const b0 = g.player.stats.bounces;
    st.cap.fill(P.yellow); g.simulate(1.5);
    check(g.player.stats.bounces > b0, 'a yellow-painted cap should bounce the player');
    return { firstHeight: r2(h1), fedHeight: r2(st.height) };
  },

  async green_vines_are_climbable_only_where_painted() {
    g.start('sandbox'); g.simulate(0.3);
    const tryClimb = () => { at(296, 0, -21.3, 0); hold('KeyW', 4); return g.player.feetY; };
    const before = tryClimb();
    check(before < 0.5, 'bare moss is not climbable, feet ' + before);
    for (let y = 0.3; y <= 7; y += 0.45) for (const x of [295.6, 296.4]) splat(x, y, -22, P.green, new V(0, 0, 1));
    const after = tryClimb();
    check(after > 6.8, 'painted ivy should let the player climb onto the 7 m block, feet ' + after);
    return { before: r2(before), after: r2(after) };
  },

  async red_powers_door_and_the_line_carries_a_floating_core() {
    g.start('new'); g.simulate(0.3);
    const door = g.power.movers[0];
    at(0, 0, -108, 0); hold('KeyW', 2);
    check(g.player.pos.z > -112.3, 'blast door should block the way, z=' + g.player.pos.z);
    // a partial dab is not enough
    const r = g.power.receptor('door');
    splat(5.4, 1.7, -111.8, P.red, new V(0, 0, 1), 0.25); g.simulate(0.3);
    check(!r.on, 'a small dab must not power the receptor');
    for (const dx of [-0.35, 0.35]) for (const dy of [-0.35, 0.35]) splat(5.4 + dx, 1.7 + dy, -111.8, P.red, new V(0, 0, 1));
    g.simulate(4);
    check(r.on && door.t > 0.95, 'covering the plate should open the door');
    hold('KeyW', 2.5);
    check(g.seen.has('zone:hall'), 'player walks into the hall');
    // belts on, core still heavy: the wreck stops it
    const core = dyn('core'), socket = g.power.socket('core');
    power('belts'); g.simulate(14);
    const stuck = core.p.body.translation().z;
    check(!socket.filled && stuck > -135.2, 'a grounded core must be stopped by the wreck, z=' + stuck);
    check(stuck < -128, 'the belt should have carried the core up to the wreck, z=' + stuck);
    // make it weightless: the field drags it over and the socket swallows it
    core.p.fill(P.purple, 2); core.p.fill(P.purple, 0);
    g.simulate(22);
    check(socket.filled, 'floating core should ride the mag-line into the socket, z=' + core.p.body.translation().z);
    check(g.seen.has('socket:core'), 'socket event');
    g.simulate(4);
    check(g.power.movers.some((m) => m.mode === 'loop' && m.moving), 'stampers should start moving on bus power');
    return { stuckAt: r2(stuck) };
  },

  async interlocks_then_lift_to_roof() {
    g.start('new'); g.simulate(0.3);
    const lift = g.power.receptor('elevator');
    power('elevator'); g.simulate(0.5);
    check(!lift.on, 'lift must stay dead without bus power');
    g.power.socket('core').force(g, dyn('core'));
    g.simulate(0.5);
    check(!lift.on, 'lift must stay locked without the green pigment');
    at(30, 0, -137, 0); hold('KeyW', 0.6);
    check(g.unlocked.has(P.green), 'green pickup');
    g.simulate(1);
    check(lift.on, 'lift energises once bus + pigments are present');
    const liftBody = g.power.movers.find((m) => Math.abs(m.to.y - 18.7) < 0.01).p.body;
    at(17.25, liftBody.translation().y + 0.35, -165.25);
    let top = 0; for (let i = 0; i < 900; i++) { g.simulate(1 / 60); if (g.player.grounded) top = Math.max(top, g.player.feetY); }
    check(top > 18.9, 'lift should carry the player to the roof, max feet ' + top);
    hold('KeyD', 0.1);
    at(10, 19, -164); g.simulate(0.3);
    check(g.seen.has('zone:roof'), 'roof zone');
    return {};
  },

  async tower_rail_drags_a_floating_plate_across_the_void() {
    g.start('new'); g.simulate(0.3);
    const plate = dyn('rider');
    power('rail');
    let minY = 99; for (let i = 0; i < 480; i++) { g.simulate(1 / 60); minY = Math.min(minY, plate.p.body.translation().y); }
    check(minY < 20, 'an unpainted plate dragged off the ledge must fall into the void, minY=' + minY);
    g.simulate(6);
    g.dynamics.respawn(plate); g.power.receptor('rail').p.clear(); g.simulate(0.5);
    const t = plate.p.body.translation();
    g.paint.splat(plate.p, new V(t.x, t.y + 0.18, t.z), up, P.purple, 0.75, true);
    g.simulate(2.5);
    const pt = plate.p.body.translation();
    at(pt.x, pt.y + 0.2, pt.z, -Math.PI / 2); g.simulate(0.4);
    check(g.player.grounded, 'standing on the hovering plate');
    power('rail'); g.simulate(8);
    check(g.player.pos.x > 2.5, 'rail should carry plate + rider across, x=' + g.player.pos.x);
    hold('KeyW', 1.2);
    check(g.seen.has('zone:n1'), 'arrive on the north gallery');
    return { riderX: r2(g.player.pos.x) };
  },

  async rotor_and_spectrum_lock_finale() {
    g.start('new'); g.simulate(0.3);
    for (const p of [P.blue, P.green, P.yellow, P.red]) g.unlock(p);
    const rotor = g.power.rotors[0];
    at(9, 45, -198, Math.PI / 2); g.simulate(0.3);
    power('rotor'); g.simulate(3);
    check(rotor.w > 0.2, 'rotor spins up');
    // wait for an arm to sweep in front of the gallery, step on, ride, step off at the hub
    let rode = false;
    for (let i = 0; i < 1500 && !rode; i++) {
      g.simulate(1 / 60);
      const a = rotor.arms[0].p.body.translation(), b = rotor.arms[1].p.body.translation();
      for (const arm of [a, b]) if (arm.x > 4.9 && Math.abs(arm.z + 198) < 0.5) { at(arm.x, 45.05, arm.z, Math.PI / 2); rode = true; }
    }
    check(rode, 'an arm should sweep past the gallery');
    g.simulate(1.5);
    check(g.player.grounded && g.player.feetY > 44.8, 'riding the arm, feet ' + g.player.feetY);
    const p0 = g.player.pos.clone(); g.simulate(1);
    check(g.player.pos.distanceTo(p0) > 0.8, 'the arm should carry the player around');
    at(2.6, 45.05, -200); g.simulate(0.3);
    check(g.seen.has('zone:hub'), 'hub zone');
    // paint each lock with the gun's own splat path, wrong colour first
    const locks = g.power.receptors.filter((r) => r.id.startsWith('lock'));
    locks[0].p.fill(P.blue); g.simulate(0.3);
    check(!locks[0].on, 'a lock must reject the wrong colour');
    for (const l of locks) l.p.fill(l.need);
    g.simulate(1);
    check(g.seen.has('finale') && g.ended, 'finale should fire once all five locks match');
    check(g.player.gravScale < 0, 'gravity releases the player');
    for (let i = 0; i < 12; i++) g.frame(1);
    check(g.state === 'ending', 'ending screen should appear, state=' + g.state);
    return { restore: r2(g.stage.restoreTarget) };
  },

  async paint_bomb_covers_ground_fast() {
    g.start('sandbox'); g.simulate(0.3);
    at(300, 0, 10, 0, -0.45); g.simulate(0.2);
    g.gun.select(P.blue);
    const e = g.player.eye, f = g.player.forward(new V());
    const hit = g.physics.castRay(e.x, e.y, e.z, f.x, f.y, f.z, 50).point.clone();
    g.input.press('KeyE'); g.simulate(0.05); g.input.release('KeyE'); g.simulate(1.2);
    let n = 0; for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) if (surfaceAt(hit.x + dx, 0, hit.z + dz) === P.blue) n++;
    check(n >= 4, 'one bomb should paint a pool over a metre across, painted probes: ' + n);
    check(surfaceAt(hit.x + 3, 0, hit.z) === P.none, 'but it is still local');
    check(g.gun.bombReady < 1, 'bomb goes on cooldown');
    const before = g.paint.splatCount;
    g.input.press('KeyE'); g.simulate(0.05); g.input.release('KeyE'); g.simulate(0.8);
    check(g.paint.splatCount === before, 'cannot fire again during the cooldown');
    g.simulate(2.5);
    check(g.gun.bombReady >= 1, 'bomb recharges');
    return { probes: n };
  },

  async gamepad_plays_the_game() {
    g.start('sandbox'); g.simulate(0.3);
    const btn = () => Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    const pad = { connected: true, axes: [0, 0, 0, 0], buttons: btn() };
    navigator.getGamepads = () => [pad];
    const run = (s) => { for (let i = 0; i < Math.round(s * 60); i++) g.frame(1 / 60); };
    at(300, 0, 16, 0, 0); run(0.2);
    pad.axes = [0, -1, 0, 0]; run(1.5);
    check(g.input.device === 'pad', 'device switches to pad');
    check(g.player.pos.z < 10, 'left stick walks forward, z=' + g.player.pos.z);
    pad.axes = [0, -0.45, 0, 0]; const z0 = g.player.pos.z; run(1);
    const slow = z0 - g.player.pos.z;
    check(slow > 1 && slow < 4.5, 'a half-tilted stick walks slowly, moved ' + slow);
    pad.axes = [0, 0, 1, 0]; const yaw0 = g.player.yaw; run(0.5);
    check(g.player.yaw < yaw0 - 0.6, 'right stick turns the view, d=' + (g.player.yaw - yaw0));
    pad.axes = [0, 0, 0, 0];
    pad.buttons[7] = { pressed: true, value: 1 }; run(0.5); pad.buttons[7] = { pressed: false, value: 0 }; run(0.1);
    check(g.gun.shots >= 4, 'right trigger sprays, shots=' + g.gun.shots);
    const sel = g.gun.selected;
    pad.buttons[5] = { pressed: true, value: 1 }; run(0.05); pad.buttons[5] = { pressed: false, value: 0 }; run(0.05);
    check(g.gun.selected !== sel, 'RB cycles pigment');
    pad.buttons[0] = { pressed: true, value: 1 }; run(0.1); pad.buttons[0] = { pressed: false, value: 0 };
    check(!g.player.grounded && g.player.vel.y > 0, 'A jumps');
    run(1);
    pad.buttons[9] = { pressed: true, value: 1 }; run(0.05); pad.buttons[9] = { pressed: false, value: 0 }; run(0.05);
    check(g.state === 'paused', 'Start pauses, state=' + g.state);
    // drive the pause menu: A on the first button resumes
    pad.buttons[13] = { pressed: true, value: 1 }; run(0.05); pad.buttons[13] = { pressed: false, value: 0 }; run(0.05);
    check(document.activeElement && document.activeElement.textContent.includes('Resume'), 'd-pad moves menu focus: ' + document.activeElement?.textContent);
    pad.buttons[0] = { pressed: true, value: 1 }; run(0.05); pad.buttons[0] = { pressed: false, value: 0 }; run(0.05);
    check(g.state === 'playing' && g.input.locked, 'A resumes without needing the mouse');
    return { slowWalk: r2(slow) };
  },

  async shards_and_waypoint() {
    g.start('new'); g.simulate(0.3);
    g.frame(0.016);
    const wp = g.waypoint();
    check(wp && Math.abs(wp[2] - 6) < 0.1, 'waypoint points at the first objective');
    check(!document.getElementById('waypoint').classList.contains('hidden'), 'marker is shown');
    check(g.shardCount === 0, 'no shards yet');
    at(-17, 0, -28.4); g.simulate(0.3);
    check(g.shardCount === 1 && g.seen.has('shard:1'), 'walking into a shard collects it');
    at(0, 0, 5); g.simulate(0.3); g.frame(0.016);
    check(Math.abs(g.waypoint()[2] + 11.9) < 0.1 || g.seen.has('mass:float'), 'waypoint advances with the objective');
    return { shards: g.shardCount };
  },

  async secrets_vaults_notes_and_upgrades() {
    g.start('new'); g.simulate(0.3);
    at(-3.6, 0, 13.8); g.simulate(0.3);
    check(g.logCount === 1 && document.getElementById('log-card').classList.contains('show'), 'walking up to a terminal reads its note');
    for (const [id, x, y, z, up] of [['vaultA', 9.4, 0, -32.6, 'nozzle'], ['vaultB', 14.9, 0, -121.2, 'capacitor'], ['vaultC', -9.6, 19, -156.2, 'amplifier']]) {
      at(x, y, z, 0); hold('KeyW', 1.5);
      check(g.player.pos.z > z - 2.2 && !g.hasUpgrade(up), id + ' must be sealed, z=' + g.player.pos.z);
      const r = g.power.receptor(id);
      r.p.fill(r.need === P.red ? P.blue : P.red); g.simulate(0.3);
      check(!r.on, id + ' rejects the wrong pigment');
      power(id); g.simulate(3);
      at(x, y, z, 0); hold('KeyW', 2);
      check(g.hasUpgrade(up), id + ' opens for its pigment and gives up its upgrade, at ' + g.player.pos.toArray().map(r2));
    }
    at(17, 0, -125); g.simulate(0.3);
    check(g.upgradeCount === 3 && g.shardCount >= 1, 'three upgrades and the vault shard collected');
    check(g.zones.shards.length === 16 && g.zones.logs.length === 11, 'find totals');
    // the upgrades change the brush
    at(300, 0, 10, 0, -0.45); g.simulate(0.2);
    g.input.press('KeyE'); g.simulate(0.05); g.input.release('KeyE'); g.simulate(1.35);
    check(g.gun.bombReady >= 1, 'capacitor halves the bomb cooldown');
    g.pause();
    check(document.querySelector('.notes') && document.querySelector('.notes').textContent.includes('WIDE NOZZLE'), 'finds are listed in the pause menu');
    return { notes: g.logCount, upgrades: g.upgradeCount };
  },

  async combos_float_plus_ice_plus_pulse() {
    g.start('sandbox'); g.simulate(0.5);
    const c = g.dynamics.bodies.find((d) => d.p.tags.has('crate') && d.home.x > 250 && d.p.body.mass() === 45);
    // kinetic pulse on a grounded 45 kg crate vs the same crate floating
    const shove = () => { const t = c.p.body.translation(); at(t.x, 0, t.z + 2.6, 0, 0); g.simulate(0.2); g.player.pitch = Math.atan2(t.y - g.player.eye.y, 2.6); g.simulate(0.05); const z0 = t.z; g.input.press('Mouse2'); g.simulate(0.05); g.input.release('Mouse2'); g.simulate(3); return z0 - c.p.body.translation().z; };
    const grounded = shove();
    c.p.fill(P.purple, 2); g.simulate(3);
    const floating = shove();
    check(grounded > 0.3, 'pulse should shove a crate, moved ' + grounded);
    check(floating > grounded * 1.5, 'a floating crate should glide much further (' + floating + ' vs ' + grounded + ')');
    // floating objects carried by the mag-line
    const core = dyn('sbcore');
    core.p.fill(P.purple, 2); core.p.fill(P.purple, 0); g.simulate(2);
    const z0 = core.p.body.translation().z;
    power('sb-belt'); g.simulate(4);
    check(z0 - core.p.body.translation().z > 4, 'belt field should drag the hovering core');
    return { grounded: r2(grounded), floating: r2(floating) };
  },

  async checkpoint_respawn_and_fall_recovery() {
    g.start('new'); g.simulate(0.3);
    at(0, 8, -19.5); g.simulate(0.3);
    check(g.zones.current.id === 'balcony', 'checkpoint activates');
    at(0, 0, -91.5); g.simulate(3);
    check(g.zones.current.id === 'balcony' && Math.abs(g.player.pos.z + 19.5) < 1 && g.player.feetY > 7.5, 'falling in the canal respawns at the checkpoint: ' + g.player.pos.toArray());
    // tower void
    at(0, 19, -191.5); g.simulate(0.3);
    at(0, 18, -200); g.simulate(3);
    check(g.zones.current.id === 'tower' && Math.abs(g.player.pos.z + 191.5) < 1, 'tower void respawns at tower base');
    // lost props come home
    const plate = dyn('rider'), home = plate.home.clone();
    plate.p.body.setTranslation({ x: 0, y: 15, z: -200 }, true); g.simulate(6);
    check(plate.p.body.translation().y > 27 && Math.abs(plate.p.body.translation().x - home.x) < 0.5, 'props that fall out of the world respawn');
    g.input.press('KeyR'); g.frame(0.016); g.input.release('KeyR');
    return {};
  },
};

// save/restore needs a page reload, so it lives outside the in-page table
async function saveRestore(page, url) {
  await page.goto(`${url}/?test=1`);
  await page.waitForFunction(() => window.__rb && window.__rb.state === 'menu', null, { timeout: 180000 });
  await page.evaluate(`(async () => { ${HELPERS}
    window.__rbAllowSave = true; localStorage.clear();
    g.start('new'); g.simulate(0.3);
    at(0, 8, -26.5); g.simulate(0.5);              // yellow
    at(0, 6.5, -56.6); g.simulate(0.5);            // blue
    at(0, 0, -102.6); g.simulate(0.5);             // red
    at(0, 0, -98.5); g.simulate(0.5);              // plaza checkpoint
    power('door'); g.simulate(3);
    at(0, 0, -117); g.simulate(0.5);               // hall checkpoint
  })()`);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('reality-brush-save-v1')));
  if (!saved || saved.cp !== 'hall') throw new Error('save should record the hall checkpoint: ' + JSON.stringify(saved));
  await page.reload();
  await page.waitForFunction(() => window.__rb && window.__rb.state === 'menu', null, { timeout: 180000 });
  const res = await page.evaluate(`(async () => { ${HELPERS}
    check(g.hasSave(), 'save present after reload');
    g.start('continue'); g.simulate(3);
    check(Math.abs(g.player.pos.z + 117) < 1.5, 'continue should spawn at the saved checkpoint, z=' + g.player.pos.z);
    check([P.purple, P.yellow, P.blue, P.red].every((p) => g.unlocked.has(p)) && !g.unlocked.has(P.green), 'pigments restored');
    check(g.power.receptor('door').on && g.power.movers[0].t > 0.9, 'blast door state restored');
    check(g.currentObjective().includes('core'), 'objective restored: ' + g.currentObjective());
    return { summary: 'ok' };
  })()`);
  // restarting: "New Game" over an existing save wipes it and boots a fresh world
  await Promise.all([
    page.waitForNavigation({ timeout: 60000 }),
    page.evaluate(() => { setTimeout(() => window.__rb.start('new'), 30); }),
  ]);
  await page.waitForFunction(() => window.__rb && window.__rb.state === 'menu', null, { timeout: 180000 });
  const fresh = await page.evaluate(`(async () => { ${HELPERS}
    check(!g.hasSave(), 'restart must erase the save');
    check(g.seen.size === 0 && !g.power.receptor('door').on, 'restart must reset the world');
    document.querySelector('#menu button').click();
    g.simulate(0.5);
    check(g.state === 'playing' && Math.abs(g.player.pos.z - 17) < 1, 'restart begins in the lab, z=' + g.player.pos.z);
    check(g.unlocked.size === 1 && g.unlocked.has(P.purple), 'restart leaves only the first pigment');
    localStorage.clear();
    return 'restart ok';
  })()`);
  return { continue: res.summary, restart: fresh };
}

// phone-sized touch context: the on-screen controls must drive the real game
async function mobileTouch(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(`${url}/?test=1`);
    await page.waitForFunction(() => window.__rb && window.__rb.state === 'menu', null, { timeout: 180000 });
    await page.locator('#menu button', { hasText: 'Sandbox' }).tap();
    const res = await page.evaluate(`(async () => { ${HELPERS}
      check(g.input.touch && document.body.classList.contains('touch'), 'touch device detected');
      check(g.state === 'playing' && g.input.locked, 'tapping the menu starts the game with no pointer lock');
      check(g.settings.quality === 'low', 'phones start on the performance preset');
      const root = document.getElementById('touch');
      check(!root.classList.contains('hidden'), 'touch controls visible');
      const T = (id, x, y, target) => new Touch({ identifier: id, target, clientX: x, clientY: y });
      const send = (type, t, target) => target.dispatchEvent(new TouchEvent(type, { changedTouches: [t], touches: type === 'touchend' ? [] : [t], bubbles: true, cancelable: true }));
      at(300, 0, 16, 0, 0); g.simulate(0.2);
      // left thumb: push the floating stick forward
      send('touchstart', T(1, 120, 260, root), root); send('touchmove', T(1, 120, 190, root), root);
      g.simulate(1.5);
      check(g.player.pos.z < 9, 'left thumb walks forward, z=' + g.player.pos.z);
      send('touchend', T(1, 120, 190, root), root); g.simulate(0.5);
      const zStop = g.player.pos.z; g.simulate(0.5);
      check(Math.abs(g.player.pos.z - zStop) < 0.05, 'releasing the stick stops');
      // right thumb: drag to look
      const yaw0 = g.player.yaw;
      send('touchstart', T(2, 560, 150, root), root); send('touchmove', T(2, 660, 150, root), root); g.simulate(0.05);
      send('touchend', T(2, 660, 150, root), root);
      check(g.player.yaw < yaw0 - 0.3, 'dragging on the right turns the view, d=' + (g.player.yaw - yaw0));
      // hold SPRAY and drag: paints and keeps aiming
      const fire = root.querySelector('.t-fire'), yaw1 = g.player.yaw;
      send('touchstart', T(3, 780, 310, fire), fire); g.simulate(0.3);
      send('touchmove', T(3, 740, 310, fire), root); g.simulate(0.3);
      send('touchend', T(3, 740, 310, fire), root); g.simulate(0.2);
      check(g.gun.shots >= 5, 'SPRAY fires, shots=' + g.gun.shots);
      check(g.player.yaw > yaw1 + 0.1, 'dragging the SPRAY thumb still aims');
      check(!g.input.down('Mouse0'), 'releasing SPRAY stops firing');
      // jump + pigment tap + pause
      const jump = root.querySelector('.t-jump');
      send('touchstart', T(4, 700, 330, jump), jump); g.simulate(0.1); send('touchend', T(4, 700, 330, jump), root);
      check(!g.player.grounded, 'JUMP jumps');
      g.simulate(1);
      const slot = document.querySelectorAll('#hotbar .slot')[3];
      slot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      check(g.gun.selected === P.yellow, 'tapping a pigment selects it');
      const pause = root.querySelector('.t-pause');
      send('touchstart', T(5, 820, 30, pause), pause); g.frame(0.016); send('touchend', T(5, 820, 30, pause), root);
      check(g.state === 'paused' && root.classList.contains('hidden'), 'pause button pauses');
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      const hb = r('#hotbar');
      check(hb.right < window.innerWidth - 210 && hb.width < 320, 'hotbar must stay clear of the thumb buttons: ' + hb.right + ' / ' + hb.width);
      return { quality: g.settings.quality, fov: Math.round(g.stage.baseFov) };
    })()`);
    if (errors.length) throw new Error('page errors: ' + errors[0]);
    return res;
  } finally { await ctx.close(); }
}

const filter = process.argv[2];
const srv = await serve();
let failed = 0, passed = 0;
const { browser, page, errors } = await open(srv.url);
try {
  const names = Object.keys(tests).filter((n) => !filter || n.includes(filter));
  for (const name of names) {
    const body = tests[name].toString().replace(/^async \w+\(\) \{/, '').replace(/\}$/, '');
    const t0 = Date.now();
    try {
      await page.goto(`${srv.url}/?test=1`);
      await page.waitForFunction(() => window.__rb && window.__rb.state === 'menu', null, { timeout: 180000 });
      const res = await page.evaluate(`(async () => { ${HELPERS} ${body} })()`);
      passed++;
      console.log(`  PASS  ${name}  ${JSON.stringify(res)}  (${Date.now() - t0} ms)`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`);
    }
  }
  if (!filter || 'save_restore'.includes(filter)) {
    try { const res = await saveRestore(page, srv.url); passed++; console.log(`  PASS  save_restore_across_reload  ${JSON.stringify(res)}`); }
    catch (e) { failed++; console.log(`  FAIL  save_restore_across_reload\n        ${String(e.message).split('\n')[0]}`); }
  }
  if (!filter || 'mobile_touch'.includes(filter)) {
    await page.goto('about:blank'); // free the software renderer for the second context
    try { const res = await mobileTouch(browser, srv.url); passed++; console.log(`  PASS  mobile_touch_controls  ${JSON.stringify(res)}`); }
    catch (e) { failed++; console.log(`  FAIL  mobile_touch_controls\n        ${String(e.message).split('\n')[0]}`); }
  }
  const real = errors.filter((e) => !/favicon/.test(e));
  if (real.length) { failed++; console.log('  FAIL  console errors:\n        ' + [...new Set(real)].slice(0, 5).join('\n        ')); }
} finally { await browser.close(); srv.stop(); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
