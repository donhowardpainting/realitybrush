import * as THREE from 'three';
import type { Game } from '../game';
import { Builder, rr, rnd } from './builder';
import { RAPIER } from '../core/physics';
import { Paint, PAINTS, PAINT_ORDER } from '../paint/types';
import { Receptor, Rotor, Socket, Conveyor } from '../systems/power';
import { prep } from './geo';
import { timeUniform } from '../paint/paintable';
import { buildSandbox } from './sandbox';

export interface LevelDef {
  objectives: { until: string; text: string; color?: string; hint?: string }[];
  restoreAt: Record<string, number>;
  titles: Record<string, [string, string]>;
  restoreState(seen: Set<string>): void;
  frame(dt: number, t: number): void;
  fixed?(dt: number): void;
  menuCam: { pos: THREE.Vector3; look: THREE.Vector3 };
  spawnCrate?(): void;
  resetProps?(): void;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const css = (p: Paint) => PAINTS[p].css;

/** Sloped paintable slab whose top surface runs from (zA, yA) to (zB, yB). */
export function ramp(b: Builder, x0: number, x1: number, zA: number, yA: number, zB: number, yB: number, mat: Parameters<Builder['slab']>[6], thick = 0.6) {
  if (zB < zA) { [zA, zB] = [zB, zA]; [yA, yB] = [yB, yA]; }
  const dz = zB - zA, dy = yB - yA, len = Math.hypot(dz, dy);
  const a = -Math.atan2(dy, dz);
  const ny = Math.cos(a), nz = Math.sin(a);
  return b.slab((x0 + x1) / 2, (yA + yB) / 2 - ny * thick / 2, (zA + zB) / 2 - nz * thick / 2, x1 - x0, thick, len, mat, { rx: a });
}

function gearGeo(r: number, depth: number, teeth: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const disc = new THREE.CylinderGeometry(r, r, depth, 28); disc.rotateX(Math.PI / 2); parts.push(disc);
  const hubg = new THREE.CylinderGeometry(r * 0.28, r * 0.28, depth * 1.6, 12); hubg.rotateX(Math.PI / 2); parts.push(hubg);
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const t = new THREE.BoxGeometry(r * 0.2, r * 0.22, depth);
    t.translate(0, r + r * 0.08, 0); t.rotateZ(a); parts.push(t);
  }
  const g = new THREE.BufferGeometry();
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  for (const p of parts) {
    const ni = p.toNonIndexed();
    pos.push(...(ni.attributes.position.array as any)); nor.push(...(ni.attributes.normal.array as any)); uv.push(...(ni.attributes.uv.array as any));
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return prep(g, 0.8);
}

export function buildWorld(game: Game, b: Builder): LevelDef {
  const { stage, zones, power, physics, mats } = game;
  const scene = stage.scene;
  const shaftDir = V(0.28, -1, -0.34);
  const frames: ((dt: number, t: number) => void)[] = [];

  /* =====================================================================
   *  0. PROTOTYPE LAB (spawn)
   * ===================================================================== */
  b.box(-5, 5, -1, 0, 10, 19.5, 'lab');
  b.box(-5.6, 5.6, 4, 4.6, 11.2, 20.1, 'concrete');
  b.box(-5.6, -5, 0, 4, 11.2, 19.5, 'lab');
  b.box(5, 5.6, 0, 4, 11.2, 19.5, 'lab');
  b.box(-5.6, 5.6, 0, 4, 19.5, 20.1, 'lab');
  b.dbox(-4.8, -2.2, 0, 0.95, 17.6, 19.3, 'steel', true);
  b.dbox(-4.6, -3.2, 0.95, 1.9, 18.9, 19.2, 'dark');
  b.dbox(-4.5, -3.3, 1.05, 1.8, 18.86, 18.9, b.glowKey(0x52ffe0, 1.4));
  b.dbox(2.6, 4.8, 0, 2.4, 18.4, 19.4, 'panel', true);
  b.dbox(3.2, 4.4, 0, 1.1, 12, 13.2, 'steel', true);
  b.cyl(3.8, 1.1, 1.5, 12.6, 0.3, 'copper', false);
  b.pipeRun([[-4.8, 3.6, 11.6], [-4.8, 3.6, 19.2], [4.8, 3.6, 19.2]], 0.1);
  b.dbox(-0.8, 0.8, 3.86, 4, 14.4, 15.6, 'dark');
  b.dbox(-0.7, 0.7, 3.84, 3.87, 14.5, 15.5, b.glowKey(0xfff0d8, 3));
  b.lamp(0, 3.6, 15, 0xffe8c8, 3.2, 10, 0);
  b.lamp(-3.9, 1.6, 18.4, 0x52ffe0, 1.2, 5, 0);
  b.sign(['PROJECT: REALITY BRUSH', 'PROTOTYPE 07 — FIELD UNIT', 'DO NOT REMOVE FROM SITE'], 4.98, 2.2, 15.5, 'x-', 3.6, 1.5, '#ffd21f');
  b.sign(['CALIBRATION WALL', 'HOLD LMB — PAINT IS PHYSICS'], -4.98, 2.4, 14.5, 'x+', 3.4, 1.1, '#a544ff');
  zones.addCheckpoint('start', 0, 0, 17, 0, 'Prototype Lab');
  zones.addTrigger('courtyard', -20, 20, 0, 8, -6, 9.6);

  /* =====================================================================
   *  1. THE RESEARCH COURTYARD
   * ===================================================================== */
  for (const [x0, x1] of [[-20, 0], [0, 20]]) for (const [z0, z1] of [[-30, -10], [-10, 10]]) b.box(x0, x1, -1, 0, z0, z1, 'pavers');
  b.wall(20, 21.5, 0, 15, -31.5, 11.2, 'brick', ['x-'], { lit: 0.08 });
  b.wall(-21.5, -20, 0, 15, -31.5, 11.2, 'brick', ['x+'], { lit: 0.08 });
  b.wall(-21.5, -1.6, 0, 15, 10, 11.2, 'brick', ['z-'], { lit: 0.1 });
  b.wall(1.6, 21.5, 0, 15, 10, 11.2, 'brick', ['z-'], { lit: 0.1 });
  b.box(-1.6, 1.6, 3.1, 15, 10, 11.2, 'brick');
  b.dbox(-1.9, -1.6, 0, 3.3, 9.8, 10, 'steel'); b.dbox(1.6, 1.9, 0, 3.3, 9.8, 10, 'steel'); b.dbox(-1.9, 1.9, 3.1, 3.4, 9.8, 10, 'steel');
  b.sign(['LAB 07'], 0, 3.9, 9.95, 'z-', 2.2, 0.7, '#e8e2d0', 0.6);
  // north side: arcade with the balcony on top, lab block behind
  b.wall(-21.5, -2.5, 0, 18, -31.5, -30, 'brick', ['z+'], { firstRow: 9.2, lit: 0.2 });
  b.wall(2.5, 21.5, 0, 18, -31.5, -30, 'brick', ['z+'], { firstRow: 9.2, lit: 0.2 });
  b.box(-2.5, 2.5, 0, 8, -31.5, -30, 'brick');
  b.box(-2.5, 2.5, 12.5, 18, -31.5, -30, 'brick');
  b.dbox(-2.9, -2.5, 8, 12.9, -30, -29.8, 'concrete'); b.dbox(2.5, 2.9, 8, 12.9, -30, -29.8, 'concrete'); b.dbox(-2.9, 2.9, 12.5, 12.9, -30, -29.8, 'concrete');
  b.sign(['SECTOR 7', 'APPLIED REALITY LABORATORY'], 0, 14.6, -29.92, 'z+', 9, 2, '#e8e2d0', 0.5);
  b.box(-20, 20, 7.4, 8, -30, -15.6, 'concrete');
  for (const x of [-16, -8, 8, 16]) {
    b.box(x - 0.5, x + 0.5, 0, 7.4, -16.7, -15.7, 'concrete');
    b.dbox(x - 0.7, x + 0.7, 6.9, 7.4, -16.9, -15.6, 'concrete');
    b.wallLamp(x, 5.6, -16.7, 'z-', 0xffb070, 1.6, 9);
  }
  b.railing(-20, -15.75, -4.2, -15.75, 8); b.railing(4.2, -15.75, 20, -15.75, 8);
  b.dbox(-20, 20, 7.1, 7.4, -15.9, -15.6, 'steel');
  for (let i = 0; i < 5; i++) b.dbox(-18 + i * 2.6, -16.4 + i * 2.6, 0, rr(1, 2.2), -28.6, -27.2, i % 2 ? 'rust' : 'panel', true);
  b.dbox(10, 13, 0, 2.6, -28.8, -26.4, 'panel', true);
  // balcony furniture
  b.dbox(-18, -15, 8, 9.1, -29.4, -28.2, 'panel', true); b.dbox(12, 17, 8, 8.9, -29.6, -28.4, 'rust', true);
  b.dbox(-10.2, -8.6, 8, 11, -29.95, -29.8, 'dark'); b.dbox(8.6, 10.2, 8, 11, -29.95, -29.8, 'dark');
  b.wallLamp(-6, 11.4, -30, 'z+', 0xffc890, 2.2, 10); b.wallLamp(6, 11.4, -30, 'z+', 0xffc890, 2.2, 10);

  // gantry crane + the suspended test mass (the first-minute set piece)
  for (const x of [-10.5, 10.5]) for (const z of [-14.8, -9]) b.column(x, z, 0, 14.2, 0.6);
  b.beamX(-11.2, 11.2, 14.5, -14.8, 0.7); b.beamX(-11.2, 11.2, 14.5, -9, 0.7);
  b.beamZ(-14.8, -9, 14.5, -10.5, 0.5); b.beamZ(-14.8, -9, 14.5, 10.5, 0.5);
  b.dbox(-3.6, 3.6, 13.6, 14.15, -15.3, -8.5, 'panel');
  b.dbox(-3.7, 3.7, 13.5, 13.62, -15.4, -8.4, 'hazard');
  b.dbox(-1.2, 1.2, 14.15, 15.2, -13, -10.8, 'rust');
  b.lamp(0, 13.3, -11.9, 0xc9a0ff, 2.2, 15, 0.16);
  b.sign(['GRAVIMETRIC TEST MASS', '4,000 KG — LOAD-LOCKED CLAMPS', 'RELEASES ONLY AT ZERO WEIGHT'], -10.5, 3.2, -8.6, 'z+', 3.8, 1.5, '#c9a0ff', 1.1);
  const mass = b.dyn(0, 0.75, -11.9, 6, 0.9, 6, 'mass', 4000, { maxHover: 7.1, fullAt: 0.075, lockTilt: true, tags: ['mass'] });
  mass.p.body.setLinearDamping(0.6);
  const ropeLen = 13.6 - 1.2;
  const anchors: [THREE.Vector3, THREE.Vector3][] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const local = V(sx * 2.6, 0.45, sz * 2.6), top = V(sx * 2.6, 13.6, -11.9 + sz * 2.6);
    physics.world.createImpulseJoint(RAPIER.JointData.rope(ropeLen, local, top), mass.p.body, physics.scenery, true);
    anchors.push([local, top]);
  }
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.5, metalness: 0.8 });
  const cables = anchors.map(() => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 6), cableMat);
    m.castShadow = true; scene.add(m); return m;
  });
  const _w = new THREE.Vector3(), _d = new THREE.Vector3(), _up = V(0, 1, 0);
  frames.push(() => {
    anchors.forEach(([local, top], i) => {
      mass.p.localToWorld(local, _w);
      _d.copy(top).sub(_w);
      const len = _d.length();
      cables[i].position.copy(_w).addScaledVector(_d, 0.5);
      cables[i].quaternion.setFromUnitVectors(_up, _d.normalize());
      cables[i].scale.set(1, len, 1);
    });
  });
  // clamps let go when the load vanishes
  game.on('mass:float', () => {
    game.audio.clang(1.2);
    for (const [, top] of anchors) game.glow.burst(top, V(0, -1, 0), new THREE.Color(1, 0.8, 0.4), 30, 6, 0.07, 0.8, 9, 2.5);
    stage.pulse(PAINTS[Paint.Purple].hex, 0.25);
  });
  b.box(-1.6, 1.6, 0, 0.6, -8.5, -7.3, 'rust');
  b.dbox(-3.4, 3.4, 0, 0.025, -8.75, -8.6, 'hazard'); b.dbox(-3.4, 3.4, 0, 0.025, -15.2, -15.05, 'hazard');
  b.dbox(-3.4, -3.25, 0, 0.025, -15.2, -8.6, 'hazard'); b.dbox(3.25, 3.4, 0, 0.025, -15.2, -8.6, 'hazard');
  stage.addShaft(V(-6, 22, 2), V(0.45, -0.62, -0.64), 30, 9, 0xcfe0e6, 0.1);
  stage.addShaft(V(4, 22, -2), V(0.45, -0.62, -0.64), 30, 7, 0xcfe0e6, 0.08);

  // courtyard dressing
  for (const [x, z, h] of [[-13, 4, 6.5], [12, 5, 7.5], [-15, -8, 5.5], [15, -6, 6], [14, -20, 5]] as const) {
    b.cyl(x, 0, 0.55, z, 1.3, 'concrete', true, 10);
    b.tree(x, 0.5, z, h);
    b.weeds(x - 1.1, x + 1.1, z - 1.1, z + 1.1, 0.55, 30);
  }
  b.cyl(-9, 0, 0.7, 0, 2.6, 'concrete', true, 16); b.cyl(-9, 0.7, 2.6, 0, 0.5, 'concrete', true, 8); b.cyl(-9, 2.6, 2.9, 0, 1.1, 'concrete', false, 12, 1.3);
  b.lampPost(-6, 0, 6, 5.2, 0xffc890, 0, -1); b.lampPost(7, 0, 4, 5.2, 0xffc890, -1, 0);
  b.lampPost(-17, 0, -18, 5.2, 0xffc890, 1, 0); b.lampPost(17.5, 0, -12, 5.2, 0xffc890, -1, 0);
  b.rubble(17, 0, 7, 9, 1.8); b.rubble(-17.5, 0, -24, 8, 1.6); b.rubble(6, 0, -27, 7, 2);
  b.dbox(8, 11, 0, 0.5, 8.2, 8.9, 'concrete', true); b.dbox(-12, -9, 0, 0.5, 8.2, 8.9, 'concrete', true);
  for (const [x, z] of [[18, 0], [18.6, 1.1], [17.6, 1.4], [-18.5, 6], [-18, -3]]) b.cyl(x, 0, 1.15, z, 0.42, 'rust', true, 10);
  b.weeds(-20, 20, -15, 10, 0, 420); b.weeds(-20, 20, -30, -16, 0, 120);
  b.weeds(19.2, 19.9, -30, 10, 0, 90, [0.25, 0.3, 0.14], 1.1); b.weeds(-19.9, -19.2, -30, 10, 0, 90, [0.25, 0.3, 0.14], 1.1);
  b.pipeRun([[19.7, 0, -4], [19.7, 6, -4], [19.7, 6, -22], [19.7, 12, -22]], 0.14);
  b.cable(V(-20, 12, 3), V(20, 11, -3), 2.5); b.cable(V(-20, 13, -20), V(-10.5, 14.5, -14.8), 1.2);
  zones.addCheckpoint('balcony', 0, 8, -19.5, 0, 'Upper Walkway');
  zones.addTrigger('balcony', -20, 20, 8.2, 13, -30, -15.9);
  zones.addPickup(Paint.Yellow, 0, 8, -27.5);

  /* ---- the breach: a collapsed street between the labs and the works ---- */
  for (const [x0, x1] of [[-14, 0], [0, 14]]) b.box(x0, x1, -1, 0, -60, -31.5, 'pavers');
  b.wall(-15.5, -14, 0, 20, -60, -31.5, 'concrete', ['x+'], { lit: 0.05 });
  b.wall(14, 15.5, 0, 20, -60, -31.5, 'concrete', ['x-'], { lit: 0.05 });
  b.box(-2.5, 2.5, 7.4, 8, -37, -31.5, 'concrete');
  b.railing(-2.4, -31.6, -2.4, -36.6, 8); b.railing(2.4, -31.6, 2.4, -36.6, 8);
  b.dbox(-2.2, -1.8, 5.5, 7.4, -33.5, -31.5, 'rust', false, [0.5, 0, 0]); b.dbox(1.8, 2.2, 5.5, 7.4, -33.5, -31.5, 'rust', false, [0.5, 0, 0]);
  for (let i = 0; i < 7; i++) b.pipe(V(-2 + i * 0.66, 7.7, -37), V(-2 + i * 0.66 + rr(-0.3, 0.3), 7.7 + rr(-0.6, 0.2), -37 - rr(0.5, 1.5)), 0.025, 'rust', false, 4);
  b.dbox(-3, 3.2, 0, 0.6, -39.2, -33.5, 'concrete', true, [0.12, 0.3, 0.05]);
  b.rubble(1, 0, -36, 12, 2.6, 'concrete', 0.6);
  b.box(-5, 5, 0, 3, -49.5, -40.5, 'brick');
  b.dbox(-5.2, 5.2, 2.8, 3, -49.7, -40.3, 'concrete');
  b.dbox(-1, 1, 0, 2.2, -40.45, -40.3, 'dark'); b.wallLamp(0, 2.5, -40.4, 'z+', 0xffd21f, 1.6, 7);
  b.sign(['SUBSTATION 4', 'ROOF RATED FOR IMPACT TESTING'], 3, 1.6, -40.4, 'z+', 2.6, 0.9, '#ffd21f');
  b.wall(-14, 14, 0, 6.5, -60, -51, 'concrete', ['z+'], { windows: false });
  b.sign(['PUMP HOUSE', 'SPILLWAY ACCESS ABOVE  ↑'], 0, 4.6, -50.9, 'z+', 5, 1.3, '#35c8ff');
  b.tank(-10.5, 6.5, -55.5, 1.8, 3.4); b.tank(10.5, 6.5, -55.5, 1.8, 3.4);
  b.pipeRun([[-10.5, 8.6, -53.5], [-10.5, 8.6, -52], [-6, 8.6, -52], [-6, 6.6, -52]], 0.16);
  b.cable(V(-14, 16, -38), V(14, 14, -44), 3); b.cable(V(-14, 12, -47), V(14, 15, -50), 2.2);
  b.wallLamp(-14, 6, -44, 'x+', 0xff9060, 2.2, 12); b.wallLamp(14, 6, -36, 'x-', 0xff9060, 2.2, 12);
  b.weeds(-14, 14, -51, -32, 0, 260); b.rubble(-10, 0, -42, 10, 2.5); b.rubble(9, 0, -47, 8, 2);
  zones.addCheckpoint('pumproof', 0, 6.5, -53.2, 0, 'Pump House Roof');
  zones.addTrigger('pumproof', -14, 14, 6.7, 11, -60, -51);
  zones.addPickup(Paint.Blue, 0, 6.5, -57.2);

  /* ---- the spillway chute and the canal ---- */
  b.box(-14, -3.6, -6, 11, -88, -60, 'concrete'); b.dress('x+', -3.6, -88, -60, 0, 11, { windows: false, bay: 7 });
  b.box(3.6, 14, -6, 11, -88, -60, 'concrete'); b.dress('x-', 3.6, -88, -60, 0, 11, { windows: false, bay: 7 });
  b.dress('z+', -60, -14, -3.6, 6.5, 11, { windows: false }); b.dress('z+', -60, 3.6, 14, 6.5, 11, { windows: false });
  b.box(-3.6, 3.6, -6, 0, -88, -60, 'concrete');
  ramp(b, -3.6, 3.6, -60, 6.5, -84, 0, 'concrete');
  ramp(b, -3.6, 3.6, -85, 0, -88, 1, 'panel');
  b.dbox(-3.6, 3.6, 0, 0.02, -85.1, -84.9, 'hazard');
  b.sign(['SPILLWAY', 'CAUTION: SURFACE SLIPPERY WHEN BLUE'], -3.55, 9, -62, 'x+', 3, 1, '#35c8ff');
  b.wallLamp(-3.6, 8, -70, 'x+', 0x8fd8ff, 2, 11); b.wallLamp(3.6, 6, -80, 'x-', 0x8fd8ff, 2, 11);
  b.box(-15.5, -14, -6, 20, -96, -88, 'concrete'); b.box(14, 15.5, -6, 20, -96, -88, 'concrete');
  const water = new THREE.Mesh(new THREE.PlaneGeometry(29, 8.5), new THREE.MeshStandardMaterial({ color: 0x0b2a30, roughness: 0.06, metalness: 0.7, transparent: true, opacity: 0.92 }));
  water.rotation.x = -Math.PI / 2; water.position.set(0, -2.4, -91.6); scene.add(water);
  b.lamp(0, -1.6, -91.5, 0x2fd0c0, 1.6, 9, 0);

  /* =====================================================================
   *  2. THE MACHINE WORKS
   * ===================================================================== */
  for (const [x0, x1] of [[-14, 0], [0, 14]]) b.box(x0, x1, -6, 0, -112, -95, 'pavers');
  b.box(-3, 3, -1, 0, -113.5, -112, 'steel');
  b.wall(-15.5, -14, 0, 20, -112, -96, 'concrete', ['x+']); b.wall(14, 15.5, 0, 20, -112, -96, 'concrete', ['x-']);
  b.wall(-21.5, -3, 0, 22, -113.5, -112, 'panel', ['z+'], { windows: false, trim: 'steel', skip: [[-30, -14], [14, 30]] });
  b.wall(3, 21.5, 0, 22, -113.5, -112, 'panel', ['z+'], { windows: false, trim: 'steel', skip: [[-30, -14], [14, 30]] });
  b.box(-3, 3, 5, 22, -113.5, -112, 'panel');
  b.dbox(-3.5, -3, 0, 5.4, -112, -111.7, 'hazard'); b.dbox(3, 3.5, 0, 5.4, -112, -111.7, 'hazard'); b.dbox(-3.5, 3.5, 5, 5.5, -112, -111.7, 'hazard');
  b.sign(['MACHINE WORKS 02', 'KINETIC ASSEMBLY HALL'], 0, 8, -111.9, 'z+', 9, 2.2, '#ff8a50', 0.9);
  const door = b.kin(0, 2.5, -112.75, 6, 5, 0.6, 'rust');
  b.attach(door, new THREE.BoxGeometry(5.6, 0.3, 0.75).translate(0, -1.2, 0), 'hazard');
  b.attach(door, new THREE.BoxGeometry(5.6, 0.3, 0.75).translate(0, 1.2, 0), 'hazard');
  const rDoor = b.receptor('door', 5.4, 1.7, -112, 'z+', 'BLAST DOOR');
  b.mover(door, V(0, 7.6, -112.75), 2.2, 'hold', () => rDoor.on, 0, true);
  b.pipeRun([[6.4, 1.7, -111.85], [8, 1.7, -111.85], [8, 6, -111.85], [0, 6, -111.85]], 0.08, 'copper');
  b.lampPost(-9, 0, -100, 5.5, 0xff9a60, 1, 0); b.lampPost(9, 0, -106, 5.5, 0xff9a60, -1, 0);
  for (const [x, z] of [[-12, -110], [-11, -108.8], [-12.6, -108.4], [11.5, -98], [12.4, -99.2]]) b.cyl(x, 0, 1.15, z, 0.42, 'rust', true, 10);
  b.dbox(9, 12.5, 0, 1.6, -111.4, -109.6, 'panel', true); b.rubble(-7, 0, -108, 8, 2.5);
  b.weeds(-14, 14, -112, -95.5, 0, 220);
  zones.addCheckpoint('plaza', 0, 0, -98.5, 0, 'Works Plaza');
  zones.addTrigger('plaza', -14, 14, 0, 7, -112, -95);
  zones.addPickup(Paint.Red, 0, 0, -103.5);

  // --- hall shell ---
  for (const [x0, x1] of [[-20, 0], [0, 20]]) for (const [z0, z1] of [[-141, -113.5], [-168, -141]]) b.box(x0, x1, -1, 0, z0, z1, 'concrete');
  b.wall(-21.5, -20, 0, 19, -169.5, -113.5, 'panel', ['x+'], { windows: false, trim: 'steel', bay: 7 });
  b.wall(20, 21.5, 0, 19, -136, -113.5, 'panel', ['x-'], { windows: false, trim: 'steel', bay: 7 });
  b.wall(20, 21.5, 0, 19, -169.5, -142, 'panel', ['x-'], { windows: false, trim: 'steel', bay: 7 });
  b.box(20, 21.5, 4.5, 19, -142, -136, 'panel');
  b.wall(-21.5, 21.5, 0, 22, -169.5, -168, 'panel', ['z+'], { windows: false, trim: 'steel', bay: 7 });
  b.box(-21.5, 21.5, 18, 19, -124, -113.5, 'concrete'); b.box(-21.5, 21.5, 18, 19, -148, -128, 'concrete'); b.box(-21.5, 21.5, 18, 19, -162.8, -152, 'concrete');
  for (const [z0, z1] of [[-128, -124], [-152, -148]]) {
    b.box(-21.5, -12, 18, 19, z0, z1, 'concrete'); b.box(12, 21.5, 18, 19, z0, z1, 'concrete');
    b.dbox(-12, 12, 18.6, 18.7, z0, z1, 'glass', true);
    for (let x = -12; x <= 12; x += 4) b.dbox(x - 0.08, x + 0.08, 18.4, 18.9, z0, z1, 'steel');
    for (const x of [-7, 0, 7]) stage.addShaft(V(x, 18.4, (z0 + z1) / 2), shaftDir, 21, 4.6, 0xffe6c0, 0.085);
  }
  b.box(-21.5, 14.9, 18, 19, -169.5, -162.8, 'concrete'); b.box(19.6, 21.5, 18, 19, -169.5, -162.8, 'concrete'); b.box(14.9, 19.6, 18, 19, -169.5, -167.6, 'concrete');
  for (const z of [-118, -132, -144, -158]) {
    b.beamX(-20, 20, 17.3, z, 0.7);
    for (let x = -18; x < 18; x += 4) b.pipe(V(x, 17.3, z), V(x + 2, 15.6, z), 0.06, 'rust', false, 5), b.pipe(V(x + 2, 15.6, z), V(x + 4, 17.3, z), 0.06, 'rust', false, 5);
    b.beamX(-20, 20, 15.6, z, 0.3);
  }
  for (const z of [-125, -139, -151, -164]) { b.column(-19.6, z, 0, 18, 0.6, 'rust', false); b.column(19.6, z, 0, 18, 0.6, 'rust', false); }
  // emergency lighting until the bus comes up
  for (const [x, z] of [[-19.9, -121], [-19.9, -134], [-19.9, -158], [19.9, -125], [19.9, -155], [19.9, -146]]) b.wallLamp(x, 4.5, z, x < 0 ? 'x+' : 'x-', 0xff4030, 4.5, 16);
  b.wallLamp(0, 6.5, -113.5, 'z-', 0xff4030, 4.5, 16);
  for (const [x, z] of [[-8, -160.1], [0, -160.1], [16, -160.1]]) b.wallLamp(x, 7, z, 'z+', 0xffb070, 3, 12);
  b.lamp(-11, 5.6, -158.6, 0xffa040, 3.5, 12, 0); b.lamp(-6.6, 3.4, -118.4, 0xff5040, 2.5, 9, 0); b.lamp(7, 6.6, -142.6, 0xffc890, 3, 12, 0.12);
  const hallLights = [V(-8, 14, -128), V(8, 14, -140), V(-6, 14, -156)].map((p) => {
    const l = new THREE.PointLight(0xffe2b8, 0, 46, 1.4); l.position.copy(p); scene.add(l);
    const fx = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.3, 0.5, 12), mats.glow(0xffe2b8, 0.05));
    fx.position.copy(p).setY(p.y + 0.6); scene.add(fx);
    return { l, fx: fx.material as THREE.MeshStandardMaterial };
  });
  zones.addCheckpoint('hall', 0, 0, -117, 0, 'Assembly Hall');
  zones.addTrigger('hall', -20, 20, 0, 8, -168, -114);

  // --- the kinetic line: two mag-line belts, a wreck across them, and the core socket ---
  const rBelts = b.receptor('belts', -6.6, 1.8, -118.9, 'z+', 'MAG-LINE A/B');
  b.box(-7.5, -5.7, 0, 3.1, -119.6, -118.9, 'panel');
  const beltsOn = () => rBelts.on;
  // line A's field reaches across the wreck so a hovering load is handed straight to line B
  b.conveyor(-13, -9, 1.5, -134, -120, -1, 2.3, beltsOn, 9).min.z = -137.6;
  b.conveyor(-13, -9, 1.5, -156.4, -137.2, -1, 2.3, beltsOn, 9);
  b.box(-13.7, -8.3, 0, 3.3, -137, -134.3, 'rust');
  b.dbox(-14.5, -7.5, 3.2, 3.7, -136.4, -135.2, 'rust', false, [0, 0.25, 0.12]);
  b.dbox(-12, -11.5, 0, 5.2, -136, -135.4, 'rust', false, [0.2, 0, 0.3]);
  b.rubble(-11, 3.3, -135.6, 6, 1.6, 'rust', 0.4);
  b.sign(['LINE OBSTRUCTED', 'CLEARANCE 1.8 m'], -8.2, 2.4, -134.25, 'z+', 2.4, 0.9, '#ffd21f');
  b.box(-13, -9, 0, 1, -160.6, -156.6, 'steel', { resist: true });
  for (const x of [-13.25, -8.75]) b.dbox(x - 0.25, x + 0.25, 0, 3.6, -160.6, -156.6, 'panel', true);
  b.dbox(-13.5, -8.5, 3.6, 4, -160.6, -160.1, 'panel');
  const socketGlow = mats.glow(0xffa040, 0.4);
  { const m = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.12, 3.6), socketGlow); m.position.set(-11, 1.03, -158.6); scene.add(m); }
  b.sign(['CORE SOCKET', 'MAIN BUS — OFFLINE'], -11, 4.6, -160.05, 'z+', 4, 1.1, '#ffa040', 1.2);
  const core = b.dyn(-11, 2.22, -123, 1.4, 1.4, 1.4, 'core', 600, { tags: ['core'] });
  const socket = new Socket('core', V(-13.4, 1, -160.6), V(-8.6, 11.5, -156.9), V(-11, 1.72, -158.6), 'core');
  power.sockets.push(socket);
  const busOn = () => socket.filled;
  b.dbox(-13.2, -8.8, 0, 0.02, -120.2, -119.8, 'hazard');
  b.sign(['POWER CORE  600 KG', 'DO NOT LIFT MANUALLY'], -13.9, 3.2, -123, 'x+', 2.6, 0.9, '#ffa040');
  b.dbox(-14.1, -13.9, 0, 4, -124.4, -121.6, 'panel', true);

  // loose props
  for (const [x, z, s, m] of [[6, -119, 1, 45], [7.3, -119.4, 1, 45], [6.6, -120.6, 1, 45], [8.4, -121.5, 1.5, 120], [4.5, -122.5, 1, 45]]) b.dyn(x, s / 2 + 0.02, z, s, s, s, 'crate', m, { ry: rr(0, 1) });
  b.dyn(6.6, 1.55, -119.6, 1, 1, 1, 'crate', 45);
  b.dyn(11, 0.2, -126, 2.6, 0.35, 2.6, 'slab', 120);

  // big machine block with gears (comes alive with the bus)
  b.box(3, 11, 0, 5.5, -151, -143, 'panel');
  b.dbox(3.4, 10.6, 5.5, 6.3, -150.6, -143.4, 'rust', true);
  b.tank(13.5, 0, -147, 1.5, 6.5, 'rust'); b.tank(16.8, 0, -147.8, 1.2, 5, 'copper');
  b.pipeRun([[11, 3, -147], [12, 3, -147]], 0.2); b.pipeRun([[13.5, 6.9, -147], [13.5, 9, -147], [7, 9, -147], [7, 6.3, -147]], 0.18);
  const gears = [[5, 3.2, 1.9, 14, 1], [8.3, 3.7, 1.25, 10, -1.52], [8.6, 1.6, 0.75, 7, 2.5]].map(([x, y, r, teeth, ratio]) => {
    const m = new THREE.Mesh(gearGeo(r, 0.4, teeth), ratio < 0 ? mats.m.copper : mats.m.steel);
    m.position.set(x, y, -142.7); m.castShadow = true; scene.add(m);
    return { m, ratio };
  });
  // furnace
  b.box(-20, -17, 0, 6, -152, -144, 'brick');
  const furnace = mats.glow(0xff5a18, 0.25);
  { const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.2, 3.4), furnace); m.position.set(-16.95, 1.8, -148); scene.add(m); }
  b.dbox(-17.1, -16.8, 0.5, 0.7, -150, -146, 'dark'); b.dbox(-17.1, -16.8, 3, 3.3, -150, -146, 'dark');
  b.cyl(-18.5, 6, 18, -148, 0.9, 'rust', false, 12);
  // misc hall dressing
  b.tank(-17, 0, -117.5, 1.7, 7); b.tank(-17.4, 0, -165, 1.5, 5.5, 'copper');
  b.pipeRun([[-19.6, 10, -114], [-19.6, 10, -168]], 0.22); b.pipeRun([[-19.6, 11, -114], [-19.6, 11, -168]], 0.12, 'copper');
  b.pipeRun([[19.6, 12, -114], [19.6, 12, -135], [19.6, 14, -135], [19.6, 14, -168]], 0.2);
  b.dbox(14, 18.5, 0, 1.1, -117, -115, 'steel', true); b.dbox(14.3, 15.6, 1.1, 1.9, -116.9, -116.6, 'dark'); b.dbox(14.4, 15.5, 1.2, 1.8, -116.6, -116.56, b.glowKey(0x52ffe0, 1.2));
  for (const [x, z] of [[17, -130], [17.9, -131], [16.8, -131.6], [-4, -165], [-3, -166.2]]) b.cyl(x, 0, 1.15, z, 0.42, 'rust', true, 10);
  for (const [x, z] of [[-4, -121], [5, -133], [-15, -140], [12, -158]]) b.cable(V(x, 17, z), V(x + rr(-2, 2), rr(9, 12), z + rr(-2, 2)), 0, 0.03);
  b.rubble(15, 0, -137, 6, 2, 'rust', 0.35); b.weeds(-20, 20, -168, -114, 0, 160, [0.22, 0.26, 0.14], 0.4);

  // --- upper deck, stampers, freight lift ---
  b.box(-20, 4, 7.4, 8, -168, -160, 'steel');
  for (const x of [-18, -12, -2, 3.6]) b.column(x, -160.4, 0, 7.4, 0.5, 'rust');
  b.railing(-20, -160.1, -10.2, -160.1, 8); b.railing(-3.8, -160.1, 4, -160.1, 8);
  b.box(-10, -4, 0, 8, -160.6, -160, 'moss', { fertile: 'vine' });
  b.sign(['FERTILE SUBSTRATE', 'RESPONDS TO GREEN'], -7, 9.2, -167.9, 'z+', 3.4, 1, '#4cff62');
  const hallBed = b.box(-2, 3.6, 0, 0.3, -158.6, -154, 'soil', { fertile: 'stalk' });
  hallBed.data.growMax = 6.7;
  b.dbox(-2.2, 3.8, 0, 0.42, -158.8, -158.6, 'concrete'); b.dbox(-2.2, 3.8, 0, 0.42, -154, -153.8, 'concrete');
  b.dbox(-2.2, -2, 0, 0.42, -158.6, -154, 'concrete'); b.dbox(3.6, 3.8, 0, 0.42, -158.6, -154, 'concrete');
  b.sign(['SEED BED 3', 'KEEP FEEDING TO GROW'], 0.8, 1.2, -153.7, 'z+', 2.6, 0.8, '#4cff62');
  const pistons = [5.75, 9, 12.25].map((x, i) => {
    const p = b.kin(x, 5.2, -164, 2.7, 0.6, 5.4, 'hazard');
    b.attach(p, new THREE.CylinderGeometry(0.45, 0.45, 9, 12).translate(0, -4.8, 0), 'steel');
    b.attach(p, new THREE.BoxGeometry(2.5, 0.5, 5.2).translate(0, -0.5, 0), 'steel');
    const m = b.mover(p, V(x, 8.7, -164), 1.5, 'loop', busOn, 1.1);
    m.setPhase([0, 0.6, 0.2][i], i === 1 ? -1 : 1);
    b.cyl(x, 0, 2.2, -164, 0.8, 'panel', true, 12);
    return m;
  });
  void pistons;
  b.box(14, 20, 7.4, 8, -163, -160, 'steel'); b.box(14, 15, 7.4, 8, -168, -163, 'steel'); b.box(19.5, 20, 7.4, 8, -168, -163, 'steel'); b.box(15, 19.5, 7.4, 8, -168, -167.5, 'steel');
  b.column(14.4, -160.4, 0, 7.4, 0.5, 'rust'); b.railing(14, -160.1, 20, -160.1, 8);
  const lift = b.kin(17.25, 7.7, -165.25, 4.4, 0.6, 4.4, 'hazard');
  b.attach(lift, new THREE.BoxGeometry(4.6, 0.25, 4.6).translate(0, -0.42, 0), 'steel');
  const rLift = b.receptor('elevator', 20, 9.8, -161.5, 'x-', 'FREIGHT LIFT');
  rLift.gate = () => (!socket.filled ? 'NO BUS POWER — SEAT THE CORE FIRST' : !game.unlocked.has(Paint.Green) ? 'PIGMENT INTERLOCK — GREEN REQUIRED' : null);
  b.mover(lift, V(17.25, 18.7, -165.25), 2.4, 'loop', () => rLift.on, 3, true);
  for (const [x, z] of [[15.05, -167.45], [19.45, -167.45], [15.05, -163.05], [19.45, -163.05]]) b.pipe(V(x, 8, z), V(x, 21.5, z), 0.07, 'steel', false, 6);
  b.dbox(14.9, 19.6, 21.3, 21.6, -167.6, -162.9, 'rust');
  b.sign(['FREIGHT LIFT', 'ROOF · TOWER ACCESS  ↑'], 17.25, 11.6, -167.9, 'z+', 3.6, 1, '#ff8a50');
  zones.addTrigger('deck', -20, 20, 8.2, 12, -168, -160);

  // --- greenhouse annex ---
  for (const [z0, z1] of [[-150, -139], [-139, -128]]) b.box(21.5, 36, -1, 0, z0, z1, 'pavers');
  b.box(21.5, 37.5, 0, 7, -151.5, -150, 'brick'); b.box(21.5, 37.5, 0, 7, -128, -126.5, 'brick'); b.box(36, 37.5, 0, 7, -150, -128, 'brick');
  b.dbox(21.5, 36, 7, 7.2, -150, -128, 'glass', true);
  for (let x = 21.5; x <= 36; x += 2.9) b.dbox(x - 0.07, x + 0.07, 6.85, 7.3, -150, -128, 'steel');
  for (let z = -150; z <= -128; z += 5.5) b.dbox(21.5, 36, 6.85, 7.3, z - 0.07, z + 0.07, 'steel');
  for (const [x, z] of [[26, -146], [31, -134], [28.5, -139]]) stage.addShaft(V(x, 7, z), shaftDir, 8.5, 3.6, 0xdfffd0, 0.1);
  b.box(20, 21.5, -1, 0, -142, -136, 'steel');
  const shutter = b.kin(20.75, 2.25, -139, 1.3, 4.5, 6, 'rust');
  b.mover(shutter, V(20.75, 6.9, -139), 1.8, 'hold', busOn, 0, true);
  b.sign(['GREENHOUSE', 'SHUTTER ON MAIN BUS'], 19.95, 5.4, -139, 'x-', 3.2, 0.9, '#4cff62');
  const ghBed = b.box(25, 31, 0, 0.35, -148, -143.5, 'soil', { fertile: 'stalk' });
  ghBed.data.growMax = 5;
  b.box(35.4, 36, 0, 6, -138, -131, 'moss', { fertile: 'vine' });
  b.box(33, 36, 5.6, 6, -131, -128.6, 'steel');
  b.sign(['SPECIMEN 12', 'HEDERA — REWRITTEN'], 34.5, 6.9, -128.1, 'z+', 2.4, 0.8, '#4cff62');
  for (const z of [-133, -137, -141]) { b.dbox(23, 24.6, 0, 0.7, z - 0.5, z + 0.5, 'concrete', true); b.weeds(23.1, 24.5, z - 0.4, z + 0.4, 0.7, 26, [0.36, 0.3, 0.14], 0.7); }
  b.tree(33, 0, -146, 4.2); b.tree(24, 0, -130.5, 3.6);
  b.weeds(21.5, 36, -150, -128, 0, 300, [0.34, 0.3, 0.13], 0.6);
  b.lamp(28, 6.2, -139, 0xc8ffb0, 2.4, 13, 0.12);
  zones.addCheckpoint('greenhouse', 23.5, 0, -139, -Math.PI / 2, 'Greenhouse');
  zones.addPickup(Paint.Green, 30, 0, -139);

  // --- roof + bridge ---
  b.box(-21.5, 21.5, 19, 20.1, -113.6, -113, 'concrete'); b.box(-21.5, -20.9, 19, 20.1, -169.5, -113.6, 'concrete'); b.box(20.9, 21.5, 19, 20.1, -169.5, -113.6, 'concrete');
  b.box(-20.9, -2.2, 19, 20.1, -169.5, -168.9, 'concrete'); b.box(2.2, 14.9, 19, 20.1, -169.5, -168.9, 'concrete');
  for (const x of [-14, -9]) { b.cyl(x, 19, 33, -119, 1.3, 'brick', true, 14, 1.0); b.lamp(x, 33.4, -119, 0xff3030, 2, 8, 0.2); }
  b.dbox(-18, -14, 19, 20.6, -160, -156, 'panel', true); b.dbox(6, 9, 19, 20.3, -120, -117, 'panel', true); b.dbox(-6, -3.5, 19, 20.8, -140, -137, 'rust', true);
  b.pipeRun([[-16, 19.4, -156], [-16, 19.4, -130], [-10, 19.4, -130]], 0.18);
  b.pipe(V(16, 19, -118), V(16, 27, -118), 0.06, 'dark', false, 5); b.lamp(16, 27.2, -118, 0xff3030, 1.2, 6, 0.1);
  b.box(-2, 2, 18.4, 19, -189, -169.5, 'steel');
  b.railing(-1.9, -169.4, -1.9, -188.9, 19); b.railing(1.9, -169.4, 1.9, -188.9, 19);
  for (const z of [-174, -180, -186]) b.dbox(-2.3, 2.3, 18.1, 18.4, z - 0.15, z + 0.15, 'rust');
  b.cable(V(-2, 19, -170), V(-2, 34, -187.5), -1, 0.05); b.cable(V(2, 19, -170), V(2, 34, -187.5), -1, 0.05);
  zones.addCheckpoint('roof', 12, 19, -161, Math.PI / 2, 'Works Roof');
  zones.addTrigger('roof', -21.5, 21.5, 19.2, 26, -169.5, -113);

  /* =====================================================================
   *  3. THE GRAVITY TOWER
   * ===================================================================== */
  const TZ = -200;
  for (const [y0, y1] of [[-10, 22], [22, 54], [54, 86]]) {
    b.box(-12.5, 12.5, y0, y1, -212.5, -211, 'alloy');
    b.box(-12.5, -11, y0, y1, -211, -189, 'alloy'); b.box(11, 12.5, y0, y1, -211, -189, 'alloy');
    if (y0 > 0) { b.box(-12.5, 12.5, y0, y1, -189, -187.5, 'alloy'); }
  }
  b.box(-12.5, -2.5, -10, 22, -189, -187.5, 'alloy'); b.box(2.5, 12.5, -10, 22, -189, -187.5, 'alloy');
  b.box(-2.5, 2.5, -10, 19, -189, -187.5, 'alloy');
  b.dbox(-3, -2.5, 19, 22.4, -187.5, -187.2, b.glowKey(0xa544ff, 2.5)); b.dbox(2.5, 3, 19, 22.4, -187.5, -187.2, b.glowKey(0xa544ff, 2.5)); b.dbox(-3, 3, 22, 22.4, -187.5, -187.2, b.glowKey(0xa544ff, 2.5));
  // exterior fins, bands and crown
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.dbox(sx * 12.2 - 0.9, sx * 12.2 + 0.9, -10, 92, TZ + sz * 12.2 - 0.9, TZ + sz * 12.2 + 0.9, 'alloy');
  for (const y of [30, 46, 62, 78]) {
    b.dbox(-12.9, 12.9, y, y + 0.5, -187.5, -187.1, b.glowKey(0xa544ff, 2.2)); b.dbox(-12.9, 12.9, y, y + 0.5, -212.9, -212.5, b.glowKey(0xa544ff, 2.2));
    b.dbox(-12.9, -12.5, y, y + 0.5, -212.5, -187.5, b.glowKey(0xa544ff, 2.2)); b.dbox(12.5, 12.9, y, y + 0.5, -212.5, -187.5, b.glowKey(0xa544ff, 2.2));
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.pipe(V(Math.cos(a) * 12, 86, TZ + Math.sin(a) * 12), V(Math.cos(a) * 5, 100, TZ + Math.sin(a) * 5), 0.4, 'alloy', false, 6);
  }
  { const g = new THREE.TorusGeometry(5, 0.5, 8, 24); g.rotateX(Math.PI / 2); g.translate(0, 100, TZ); b.deco(g, b.glowKey(0xa544ff, 3)); }
  // the beam
  const beamU = { uTime: timeUniform, uPower: { value: 0.35 } };
  const beamMat = new THREE.ShaderMaterial({
    uniforms: beamU,
    vertexShader: 'varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; uniform float uTime; uniform float uPower;
      float h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main(){ float rim = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
        float s = n(vec2(vUv.x * 12.0, vUv.y * 60.0 - uTime * 3.0)) * 0.6 + n(vec2(vUv.x * 30.0 + uTime, vUv.y * 140.0 - uTime * 6.0)) * 0.4;
        vec3 c = mix(vec3(0.45, 0.2, 1.0), vec3(0.75, 0.9, 1.0), s * rim);
        gl_FragColor = vec4(c * rim * (0.35 + s) * uPower, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, fog: false,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 300, 20, 1, true), beamMat);
  beam.position.set(0, 140, TZ); scene.add(beam);
  const halo = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 300, 20, 1, true), beamMat);
  halo.position.copy(beam.position); halo.scale.set(1, 1, 1); scene.add(halo);
  const coreLight = new THREE.PointLight(0xa070ff, 30, 40, 1.6); coreLight.position.set(0, 48, TZ); scene.add(coreLight);
  // the beam itself lights the shaft
  const beamLights = [23, 36, 62].map((y) => { const l = new THREE.PointLight(0xb9a0ff, 70, 36, 1.5); l.position.set(0, y, TZ); scene.add(l); return l; });
  // debris orbiting the beam
  const debris = new THREE.InstancedMesh(prep(new THREE.BoxGeometry(1, 1, 1)), mats.m.alloy, 70);
  const debrisData = Array.from({ length: 70 }, () => ({ r: rr(2.2, 5.2), y: rr(4, 84), a: rr(0, 6.28), w: rr(0.1, 0.5) * (rnd() < 0.5 ? -1 : 1), s: rr(0.12, 0.5), rise: rr(0.2, 1) }));
  debris.frustumCulled = false; scene.add(debris);
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();
  frames.push((dt, t) => {
    if (game.player.pos.z > -150 && game.state !== 'menu') return;
    debrisData.forEach((d, i) => {
      const a = d.a + t * d.w, y = ((d.y + t * d.rise) % 80) + 4;
      _q.setFromEuler(_e.set(t * d.w * 2, a, t * d.w));
      _m4.compose(_w.set(Math.cos(a) * d.r, y, TZ + Math.sin(a) * d.r), _q, _s.setScalar(d.s));
      debris.setMatrixAt(i, _m4);
    });
    debris.instanceMatrix.needsUpdate = true;
  });

  // interior: base gallery (no floor to the north — it is a long way down)
  b.box(-11, 11, 18.4, 19, -194, -189, 'alloy'); b.box(-11, -6, 18.4, 19, -206, -194, 'alloy'); b.box(6, 11, 18.4, 19, -206, -194, 'alloy');
  b.railing(-6, -194.1, 6, -194.1, 19, false);
  for (const y of [23, 31, 39, 47, 55, 63]) for (const [x, z, side] of [[-11, -200, 'x+'], [11, -200, 'x-'], [0, -211, 'z+'], [-6, -189, 'z-'], [6, -189, 'z-']] as const) b.wallLamp(x, y, z, side, 0xb48cff, 5, 15);
  b.pipeRun([[-10.7, 19, -190], [-10.7, 60, -190]], 0.15, 'copper'); b.pipeRun([[10.7, 19, -210], [10.7, 60, -210]], 0.15, 'copper');
  zones.addCheckpoint('tower', 0, 19, -191.5, 0, 'Tower Base');
  zones.addTrigger('tower', -11, 11, 19.2, 26, -211, -189);
  zones.addKill(-11, 11, -30, 9, -211, -189);
  b.sign(['STAGE 1', 'STACK WHAT FLOATS'], -10.95, 21.6, -192, 'x+', 3, 0.9, '#a544ff');

  // T1: debris stair up to the west gallery
  b.dyn(-8.6, 19.2, -191.6, 2.6, 0.35, 2.6, 'slab', 120);
  b.dyn(-4.9, 19.2, -191.7, 2.6, 0.35, 2.6, 'slab', 120, { ry: 0.3 });
  b.dyn(-4.9, 19.56, -191.6, 2.6, 0.35, 2.6, 'slab', 120, { ry: -0.2 });
  b.dyn(3.5, 19.52, -191.2, 1, 1, 1, 'crate', 45); b.dyn(5.2, 19.52, -192, 1, 1, 1, 'crate', 45, { ry: 0.5 });
  b.box(-11, -6, 26.9, 27.5, -211, -196, 'alloy');
  b.dbox(-6.1, -6, 26.9, 27.5, -211, -196, b.glowKey(0xa544ff, 1.5));
  zones.addTrigger('w1', -11, -6, 27.7, 32, -211, -196);

  // T2: mag-rail across the void
  b.dyn(-8.5, 27.7, -208.4, 2.6, 0.35, 2.6, 'slab', 120, { tags: ['rider'] });
  const rRail = b.receptor('rail', -11, 29.3, -202, 'x+', 'MAG-RAIL');
  const railGlow = mats.glow(0xff3030, 0.2);
  for (const y of [26.3, 31.6]) {
    b.dbox(-10.5, 4.5, y, y + 0.25, -210.95, -210.6, 'steel');
    for (let x = -9.5; x < 4.5; x += 1.5) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.2), railGlow); m.position.set(x, y + 0.12, -210.55); scene.add(m); }
  }
  power.conveyors.push(new Conveyor(null, V(1, 0, 0), 2.3, V(-10.6, 26.6, -211), V(4.4, 33, -206), () => rRail.on));
  b.box(3, 11, 26.9, 27.5, -211, -203, 'alloy');
  b.dbox(2.9, 3, 26.9, 27.5, -211, -203, b.glowKey(0xa544ff, 1.5));
  b.sign(['STAGE 2', 'THE RAIL DRAGS WHAT FLOATS'], -10.95, 31.3, -206.5, 'x+', 3.2, 0.9, '#ff3030');
  zones.addTrigger('n1', 3, 11, 27.7, 32, -211, -203);
  zones.addCheckpoint('n1', 5, 27.5, -204.6, -Math.PI / 2, 'North Gallery');

  // T3: moss buttress and seed bed
  b.box(5, 11, 27.5, 36, -211, -207.5, 'moss', { fertile: 'vine' });
  const towerBed = b.box(6, 10.4, 36, 36.2, -210.6, -208.2, 'soil', { fertile: 'stalk' });
  towerBed.data.growMax = 6.4; towerBed.data.maxStalks = 2;
  zones.addTrigger('n2', 5, 11, 36.2, 40, -211, -207.5);
  b.sign(['STAGE 3', 'GROW IT. THEN MAKE IT BOUNCE.'], 8, 39.6, -210.95, 'z+', 3.4, 0.9, '#4cff62');
  b.box(6.9, 11, 44.4, 45, -206.5, -192, 'alloy');
  b.dbox(6.8, 6.9, 44.4, 45, -206.5, -192, b.glowKey(0xa544ff, 1.5));
  zones.addTrigger('e1', 6.9, 11, 45.2, 49, -206.5, -192);
  zones.addCheckpoint('e1', 9, 45, -198, Math.PI / 2, 'East Gallery');

  // T4: the rotor and the core
  const rRotor = b.receptor('rotor', 11, 46.9, -194.4, 'x-', 'ROTOR DRIVE');
  const arms = [0, Math.PI].map((phase) => ({ p: b.kin(0, 44.8, TZ, 2.9, 0.4, 1.9, 'hazard'), radius: 5.15, phase }));
  const spinner = new THREE.Group(); spinner.position.set(0, 44.5, TZ); scene.add(spinner);
  { const ring = new THREE.Mesh(prep(new THREE.TorusGeometry(3.75, 0.16, 8, 42).rotateX(Math.PI / 2)), mats.m.steel); spinner.add(ring);
    for (const a of [0, Math.PI]) { const s = new THREE.Mesh(prep(new THREE.BoxGeometry(3.1, 0.2, 0.3)), mats.m.steel); s.position.set(Math.cos(a) * 5.15, -0.05, -Math.sin(a) * 5.15); s.rotation.y = a; spinner.add(s); } }
  power.rotors.push(new Rotor(V(0, 44.8, TZ), arms, 0.42, () => rRotor.on, Math.PI / 2, spinner));
  b.cyl(0, 44.4, 45, TZ, 3.5, 'alloy', true, 8);
  { const g = new THREE.TorusGeometry(3.5, 0.08, 6, 8); g.rotateX(Math.PI / 2); g.translate(0, 45.02, TZ); b.deco(g, b.glowKey(0xa544ff, 2)); }
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) b.pipe(V(sx * 2.4, 44.3, TZ + sz * 2.4), V(sx * 11, 39, TZ + sz * 11), 0.14, 'steel', false, 6);
  b.cyl(0, 45, 45.5, TZ, 1.25, 'steel', true, 10);
  const coreOrb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 2), mats.glow(0xb890ff, 1.5));
  coreOrb.position.set(0, 47.4, TZ); scene.add(coreOrb);
  const locks: Receptor[] = PAINT_ORDER.map((need, i) => {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const x = Math.sin(a) * 1.75, z = TZ + Math.cos(a) * 1.75;
    const plate = b.slab(x, 46.35, z, 1.25, 1.5, 0.16, 'lab', { ry: a, tags: ['lock'] });
    const lamp = mats.glow(PAINTS[need].hex, 0.3);
    const fr = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.75, 0.1), lamp);
    fr.position.set(Math.sin(a) * 1.66, 46.35, TZ + Math.cos(a) * 1.66); fr.rotation.y = a; scene.add(fr);
    const r = new Receptor('lock' + i, plate, need, lamp);
    power.receptors.push(r);
    return r;
  });
  zones.addTrigger('hub', -3.5, 3.5, 45.2, 50, TZ - 3.5, TZ + 3.5);
  b.sign(['STAGE 4', 'FIVE LOCKS · FIVE COLOURS'], 10.95, 49.4, -199, 'x-', 3.4, 0.9, '#e8e2d0');

  /* ---- distant skyline ---- */
  {
    const c = document.createElement('canvas'); c.width = 64; c.height = 128;
    const g = c.getContext('2d')!; g.fillStyle = '#000'; g.fillRect(0, 0, 64, 128);
    for (let y = 2; y < 126; y += 6) for (let x = 3; x < 62; x += 7) if (rnd() < 0.45) { g.fillStyle = rnd() < 0.7 ? '#ffb868' : '#9fd8ff'; g.fillRect(x, y, 4, 3); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter;
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.9, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.15 });
    stage.skylineMat = mat;
    const N = 150, sky = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), mat, N);
    for (let i = 0; i < N; i++) {
      const a = rnd() * Math.PI * 2, r = rr(75, 260);
      let x = Math.cos(a) * r, z = -100 + Math.sin(a) * r * 1.3;
      if (Math.abs(x) < 45 && z > -240 && z < 40) x = Math.sign(x || 1) * rr(50, 90);
      if (x > 240 && x < 360) x -= 140;
      _m4.compose(_w.set(x, -8, z), _q.identity(), _s.set(rr(10, 26), rr(22, 80) * (r > 150 ? 1.3 : 1), rr(10, 26)));
      sky.setMatrixAt(i, _m4);
    }
    sky.frustumCulled = false; scene.add(sky);
  }

  const sandbox = buildSandbox(game, b);

  /* ---- per-frame world animation ---- */
  let busLevel = 0;
  const frame = (dt: number, t: number) => {
    for (const f of frames) f(dt, t);
    const pp = game.player.pos;
    const inHall = pp.z < -113.5 && pp.z > -168 && Math.abs(pp.x) < 20 && pp.y < 18.5;
    const inTower = pp.z < -189 && pp.z > -211 && Math.abs(pp.x) < 11;
    const inLab = pp.z > 11.2 && pp.z < 19.5 && Math.abs(pp.x) < 5;
    stage.indoorTarget = game.state === 'menu' ? 0 : inHall || inTower || inLab ? 1 : 0;
    busLevel += ((socket.filled ? 1 : 0) - busLevel) * Math.min(1, dt * 0.8);
    const flick = busLevel < 0.98 && busLevel > 0.02 ? 0.6 + 0.4 * Math.sin(t * 40) * Math.sin(t * 7) : 1;
    for (const h of hallLights) { h.l.intensity = busLevel * 130 * flick; h.fx.emissiveIntensity = 0.05 + busLevel * 6 * flick; }
    socketGlow.emissiveIntensity = socket.filled ? 3 + Math.sin(t * 5) : 0.4 + Math.sin(t * 2) * 0.2;
    furnace.emissiveIntensity = 0.25 + busLevel * (3 + Math.sin(t * 9) * 0.5);
    for (const g of gears) g.m.rotation.z += dt * busLevel * 0.8 * g.ratio;
    railGlow.emissiveIntensity = rRail.on ? 2.5 + Math.sin(t * 12) : 0.2;
    const done = locks.filter((l) => l.on).length;
    beamU.uPower.value += ((0.3 + stage.restore * 0.5 + done * 0.12 + (game.ended ? 1.2 : 0)) - beamU.uPower.value) * Math.min(1, dt);
    coreOrb.rotation.y = t * 0.6; coreOrb.rotation.x = t * 0.37;
    coreOrb.scale.setScalar(1 + done * 0.06 + Math.sin(t * 3) * 0.04 + (game.ended ? 0.5 : 0));
    (coreOrb.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.5 + done * 0.8 + (game.ended ? 5 : 0);
    coreLight.intensity = 30 + done * 14 + (game.ended ? 60 : 0);
    for (const l of beamLights) l.intensity = 55 + stage.restore * 40 + done * 10 + Math.sin(t * 1.7 + l.position.y) * 6 + (game.ended ? 45 : 0);
    water.material.opacity = 0.9 + Math.sin(t) * 0.03;
    sandbox.frame(dt);
  };

  let finaleFired = false;
  const fixed = () => {
    if (!finaleFired && locks.every((l) => l.on)) { finaleFired = true; game.emit('finale'); }
  };

  // contextual teaching moments
  let missedRide = 0;
  game.on('mass:float', () => { missedRide = 1; });
  frames.push((dt) => {
    if (missedRide <= 0 || game.seen.has('zone:balcony') || game.mode !== 'story') return;
    missedRide += dt;
    const t = mass.p.body.translation();
    if (missedRide > 9 && t.y > 5 && game.player.pos.y < 3) {
      game.hud.hint('Missed your ride? <kbd>Q</kbd> selects SOLVENT — strip the purple and the mass comes back down.', 10);
      missedRide = -1;
    }
  });
  game.on('respawn', () => {
    const rider = game.dynamics.bodies.find((d) => d.p.tags.has('rider'));
    if (rider && !game.seen.has('zone:n1') && game.zones.current?.id === 'tower') game.dynamics.respawn(rider);
  });
  game.on('zone:hall', () => game.hud.hint('<kbd>RMB</kbd> fires a kinetic pulse — it shoves anything loose, especially things that float.', 9));
  game.on('power:belts', () => { if (!socket.filled) game.hud.hint('The mag-line drags whatever sits in its field… including anything hovering above it.', 9); });

  return {
    objectives: [
      { until: 'zone:courtyard', text: 'Leave the lab.', color: css(Paint.Purple) },
      { until: 'mass:float', text: 'Climb onto the suspended test mass — then paint it.', color: css(Paint.Purple), hint: 'Hold <kbd>LMB</kbd> to spray. PURPLE cancels the weight of whatever it covers.' },
      { until: 'zone:balcony', text: 'Ride the weightless mass up to the walkway.', color: css(Paint.Purple), hint: 'Stand on it and keep painting — more purple, more lift. <kbd>Q</kbd> SOLVENT strips paint.' },
      { until: 'pickup:yellow', text: 'Take the YELLOW pigment.', color: css(Paint.Yellow) },
      { until: 'zone:pumproof', text: 'Reach the pump-house roof across the breach.', color: css(Paint.Yellow), hint: '<kbd>4</kbd> YELLOW turns a surface into a spring. Paint the roof below, then drop onto it. Hold <kbd>Space</kbd> to bounce higher.' },
      { until: 'pickup:blue', text: 'Take the BLUE pigment.', color: css(Paint.Blue) },
      { until: 'zone:plaza', text: 'Clear the canal.', color: css(Paint.Blue), hint: '<kbd>2</kbd> BLUE removes friction. Ice the whole chute and the ramp at its end — then let gravity build your speed.' },
      { until: 'pickup:red', text: 'Take the RED pigment.', color: css(Paint.Red) },
      { until: 'power:door', text: 'Energise the blast door.', color: css(Paint.Red), hint: '<kbd>5</kbd> RED is raw energy. Cover a receptor plate to power its machine.' },
      { until: 'socket:core', text: 'Get the power core into its socket at the end of the line.', color: css(Paint.Red), hint: 'The core is far too heavy to push — and something is blocking the line.' },
      { until: 'pickup:green', text: 'The bus is live. Recover the GREEN pigment from the greenhouse.', color: css(Paint.Green) },
      { until: 'zone:deck', text: 'Reach the upper deck of the hall.', color: css(Paint.Green), hint: '<kbd>3</kbd> GREEN wakes fertile matter. Moss grows climbable ivy where you paint; soil raises a stalk — keep feeding it.' },
      { until: 'power:elevator', text: 'Cross the stampers and energise the freight lift.', color: css(Paint.Red) },
      { until: 'zone:roof', text: 'Ride the lift to the roof.', color: '#ffffff' },
      { until: 'zone:tower', text: 'Cross the bridge into the Gravity Tower.', color: css(Paint.Purple) },
      { until: 'zone:w1', text: 'Climb to the west gallery.', color: css(Paint.Purple), hint: 'A painted slab hovers above whatever is beneath it — including another slab. One alone will not reach.' },
      { until: 'zone:n1', text: 'Cross the void to the north gallery.', color: css(Paint.Red), hint: 'Float the rider plate, stand on it, then energise the mag-rail.' },
      { until: 'zone:n2', text: 'Scale the moss buttress.', color: css(Paint.Green) },
      { until: 'zone:e1', text: 'Reach the east gallery, high above.', color: css(Paint.Yellow), hint: 'A stalk will not reach on its own. Its cap takes paint like anything else.' },
      { until: 'zone:hub', text: 'Reach the core at the heart of the tower.', color: css(Paint.Red), hint: 'Energise the rotor and ride an arm across.' },
      { until: 'finale', text: 'Open the spectrum lock: paint each plate its own colour.', color: '#ffffff' },
    ],
    restoreAt: {
      'mass:float': 0.08, 'zone:balcony': 0.14, 'zone:pumproof': 0.2, 'zone:plaza': 0.28, 'power:door': 0.34, 'socket:core': 0.48, 'pickup:green': 0.54,
      'power:elevator': 0.6, 'zone:tower': 0.66, 'zone:n1': 0.72, 'zone:e1': 0.78, 'zone:hub': 0.84, finale: 1,
    },
    titles: {
      'zone:courtyard': ['THE RESEARCH COURTYARD', 'SECTOR 7 · ABANDONED'],
      'zone:plaza': ['THE MACHINE WORKS', 'KINETIC ASSEMBLY · OFFLINE'],
      'zone:roof': ['THE GRAVITY TOWER', 'IT IS STILL RUNNING'],
    },
    restoreState(seen) {
      const on = (id: string) => { const r = power.receptor(id); r.p.fill(r.need); r.powered = true; game.paint.markDirty(r.p); };
      if (seen.has('power:door')) on('door');
      if (seen.has('power:belts')) on('belts');
      if (seen.has('socket:core')) socket.force(game, core);
      if (seen.has('power:elevator')) on('elevator');
      if (seen.has('power:rail')) on('rail');
      if (seen.has('power:rotor')) on('rotor');
      if (seen.has('finale')) { finaleFired = true; for (let i = 0; i < 5; i++) on('lock' + i); }
    },
    frame,
    fixed,
    menuCam: { pos: V(9.5, 4.2, 5), look: V(-1, 5.5, -14) },
    spawnCrate: sandbox.spawnCrate,
  };
}
