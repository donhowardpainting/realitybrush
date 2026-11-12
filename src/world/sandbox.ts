import * as THREE from 'three';
import type { Game } from '../game';
import type { Builder } from './builder';
import { rr } from './builder';
import { RAPIER } from '../core/physics';
import { Rotor, Socket } from '../systems/power';
import { DynBody } from '../systems/dynamics';
import { prep } from './geo';
import { ramp } from './level';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** The Test Range: every mechanic in one yard, every pigment unlocked. */
export function buildSandbox(game: Game, b: Builder) {
  const { zones, power, stage, mats } = game;
  const X = 300;
  b.box(X - 22, X, -1, 0, -24, 24, 'pavers'); b.box(X, X + 22, -1, 0, -24, 24, 'pavers');
  b.wall(X - 23.5, X - 22, 0, 10, -25.5, 25.5, 'panel', ['x+'], { windows: false, trim: 'steel', bay: 8 });
  b.wall(X + 22, X + 23.5, 0, 10, -25.5, 25.5, 'panel', ['x-'], { windows: false, trim: 'steel', bay: 8 });
  b.wall(X - 22, X + 22, 0, 10, -25.5, -24, 'panel', ['z+'], { windows: false, trim: 'steel', bay: 8 });
  b.wall(X - 22, X + 22, 0, 10, 24, 25.5, 'panel', ['z-'], { windows: false, trim: 'steel', bay: 8 });
  b.sign(['TEST RANGE', 'EVERY PIGMENT UNLOCKED — BREAK THINGS'], X, 7.6, -23.9, 'z+', 14, 2.6, '#ffd21f', 1.1);
  for (const [x, z, tx, tz] of [[X - 12, 10, 1, 0], [X + 12, 10, -1, 0], [X - 8, -12, 1, 0], [X + 8, -6, -1, 0]] as const) b.lampPost(x, 0, z, 6, 0xffd9a8, tx, tz);
  b.weeds(X - 22, X + 22, -24, 24, 0, 300);
  zones.addCheckpoint('sandbox', X, 0, 20, 0, 'Test Range');

  // --- ice chute + kicker (west) ---
  b.box(X - 20, X - 14, 0, 5, 14, 22, 'concrete');
  ramp(b, X - 14, X - 11.4, 22, 5, 8, 0, 'steel');
  ramp(b, X - 20, X - 14, 14, 5, -2, 0, 'concrete');
  ramp(b, X - 20, X - 14, -3, 0, -6, 1.2, 'panel');
  b.sign(['FRICTION LAB', 'BLUE: ICE THE CHUTE'], X - 13.9, 3, 18, 'x+', 3.2, 1, '#35c8ff');
  b.railing(X - 20, 22, X - 14, 22, 5, false);

  // --- loose props (centre) ---
  const props: DynBody[] = [];
  for (const [x, z, s, m] of [[-4, 10, 1, 25], [-2.5, 10.5, 1, 45], [-3.4, 12, 1, 45], [-1, 12, 1.5, 120], [1.5, 11, 1, 45], [3, 12.5, 0.8, 20]]) props.push(b.dyn(X + x, s / 2 + 0.02, z, s, s, s, 'crate', m, { ry: rr(0, 1) }));
  props.push(b.dyn(X + 5, 0.2, 8, 2.6, 0.35, 2.6, 'slab', 120));
  props.push(b.dyn(X + 5.2, 0.56, 8.1, 2.6, 0.35, 2.6, 'slab', 120, { ry: 0.4 }));
  props.push(b.dyn(X - 6, 0.3, 4, 4, 0.5, 4, 'slab', 400, { lockTilt: true }));
  b.sign(['GRAVITY LAB', 'PURPLE: MORE PAINT, MORE LIFT'], X, 2.6, 23.9, 'z-', 4, 1.1, '#a544ff');

  // --- mag-line + socket (east) ---
  const rBelt = b.receptor('sb-belt', X + 9.4, 1.8, 19.4, 'z+', 'MAG-LINE');
  b.box(X + 8.5, X + 10.3, 0, 3.1, 19.4, 20.1, 'panel');
  b.conveyor(X + 12, X + 16, 1.2, 0, 18, -1, 2.4, () => rBelt.on);
  b.box(X + 12, X + 16, 0, 0.8, -4.2, -0.2, 'steel', { resist: true });
  const core = b.dyn(X + 14, 1.92, 16, 1.4, 1.4, 1.4, 'core', 600, { tags: ['sbcore'] });
  props.push(core);
  const socket = new Socket('sbcore', V(X + 11.6, 0.8, -4.2), V(X + 16.4, 8, -0.4), V(X + 14, 1.52, -2.2), 'sbcore');
  power.sockets.push(socket);
  let release = 0;
  socket.onFill.push(() => { release = 6; game.hud.toast('SOCKET SEATED — core returns in 6 s', '#ffa040'); });
  b.sign(['ENERGY LAB', 'RED POWERS · FIELD DRAGS FLOATERS'], X + 21.9, 4, 9, 'x-', 4.4, 1.1, '#ff3030');

  // --- growth (north) ---
  b.box(X - 8, X, 0, 7, -24, -22, 'moss', { fertile: 'vine' });
  const bed = b.box(X + 2, X + 8, 0, 0.3, -22.5, -17, 'soil', { fertile: 'stalk' });
  bed.data.growMax = 9; bed.data.maxStalks = 5;
  b.sign(['GROWTH LAB', 'GREEN: MOSS CLIMBS · SOIL RISES'], X + 5, 3, -23.9, 'z+', 4, 1, '#4cff62');

  // --- lift + drop tower (north-east) ---
  const lift = b.kin(X + 19.5, 0.25, -19, 3.4, 0.5, 3.4, 'hazard');
  const rLift = b.receptor('sb-lift', X + 15.5, 1.8, -24, 'z+', 'LIFT');
  b.mover(lift, V(X + 19.5, 9.05, -19), 2.4, 'loop', () => rLift.on, 2.5);
  b.box(X + 11, X + 17.8, 8.7, 9.3, -24, -15, 'steel');
  for (const [x, z] of [[11.4, -15.4], [17.4, -15.4]]) b.column(X + x, z, 0, 8.7, 0.5, 'rust');
  b.railing(X + 11, -15, X + 17.8, -15, 9.3, false);
  b.sign(['IMPACT LAB', 'YELLOW: FALL FAR, FLY FAR'], X + 14.4, 6.2, -14.9, 'z+', 3.6, 1, '#ffd21f');

  // --- rotor (west) ---
  const rRot = b.receptor('sb-rotor', X - 21.9, 1.8, -14, 'x+', 'ROTOR');
  const arms = [0, Math.PI].map((phase) => ({ p: b.kin(X, 1, 0, 4, 0.4, 1.8, 'hazard'), radius: 3.6, phase }));
  const spinner = new THREE.Group(); spinner.position.set(X - 13, 0.9, -14); stage.scene.add(spinner);
  spinner.add(new THREE.Mesh(prep(new THREE.CylinderGeometry(1.5, 1.5, 0.5, 16)), mats.m.steel));
  power.rotors.push(new Rotor(V(X - 13, 1, -14), arms, 0.9, () => rRot.on, 0, spinner));
  b.cyl(X - 13, 0, 1.2, -14, 1.5, 'panel', true, 16);

  const spawned: DynBody[] = [];
  const spawnCrate = () => {
    const pl = game.player, f = pl.forward(new THREE.Vector3());
    if (spawned.length >= 24) {
      const old = spawned.shift()!;
      game.dynamics.remove(old); game.paint.remove(old.p);
    }
    const s = [0.8, 1, 1, 1.5][Math.floor(Math.random() * 4)];
    const d = b.dyn(pl.pos.x + f.x * 3, pl.pos.y + 1.5 + f.y * 2, pl.pos.z + f.z * 3, s, s, s, 'crate', 45 * s * s * s);
    spawned.push(d);
    game.glow.burst(new THREE.Vector3(pl.pos.x + f.x * 3, pl.pos.y + 1.5, pl.pos.z + f.z * 3), null, new THREE.Color(1, 0.85, 0.4), 24, 4, 0.08, 0.5, 0, 1.5);
  };

  const frame = (dt: number) => {
    if (release > 0 && (release -= dt) <= 0) {
      socket.filled = false;
      core.captured = false;
      core.p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      game.dynamics.respawn(core);
    }
  };
  return { frame, spawnCrate, props };
}
