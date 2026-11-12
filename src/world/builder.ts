import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Game } from '../game';
import { RAPIER, QUERY_WORLD } from '../core/physics';
import { injectWorldShader, Paintable } from '../paint/paintable';
import { Paint, PAINTS } from '../paint/types';
import { MatName, textTexture } from '../render/materials';
import { boxGeo, prep, unitUvBox } from './geo';
import { DynBody, DynOpts } from '../systems/dynamics';
import { Conveyor, Mover, Receptor } from '../systems/power';

export type Side = 'x+' | 'x-' | 'z+' | 'z-';
export interface DressOpts { windows?: boolean; lit?: number; bay?: number; trim?: string; firstRow?: number; skip?: number[][] }
interface Lamp { p: THREE.Vector3; c: THREE.Color; i: number; range: number }
interface BoxOpts { fertile?: 'vine' | 'stalk'; resist?: boolean; tags?: string[]; uv?: number; rx?: number; ry?: number; rz?: number; shadow?: boolean }

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
let rngState = 1234567;
/** Deterministic RNG so the hand-placed world is identical every run. */
export function rnd(): number { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 4294967296; }
export const rr = (a: number, b: number) => a + rnd() * (b - a);

/** Level construction kit: paintable solids, merged scenery, lamps and the lighting bake. */
export class Builder {
  private decos = new Map<string, THREE.BufferGeometry[]>();
  private glowMats = new Map<string, THREE.MeshStandardMaterial>();
  private lamps: Lamp[] = [];
  private bakeList: THREE.Mesh[] = [];
  private weedMat: THREE.MeshStandardMaterial;
  animators: ((dt: number, t: number) => void)[] = [];

  constructor(public game: Game) {
    this.weedMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
    injectWorldShader(this.weedMat);
  }

  /* ------------------------------------------------ paintable solids */

  /** Static, paintable, axis-aligned box given by its bounds. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: MatName, o: BoxOpts = {}): Paintable {
    return this.slab((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat, o);
  }

  /** Static paintable box given by centre/size, optionally rotated. */
  slab(cx: number, cy: number, cz: number, w: number, h: number, d: number, mat: MatName, o: BoxOpts = {}): Paintable {
    const rotated = o.rx || o.ry || o.rz;
    const p = this.game.paint.create({
      half: V(w / 2, h / 2, d / 2), position: V(cx, cy, cz),
      quaternion: rotated ? new THREE.Quaternion().setFromEuler(_e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0)) : undefined,
      geometry: boxGeo(w, h, d, o.uv ?? 3), material: this.game.mats.m[mat],
      fertile: o.fertile, resist: o.resist, tags: o.tags, castShadow: o.shadow,
    });
    this.bakeList.push(p.mesh);
    return p;
  }

  /** Script-driven (kinematic) paintable box. */
  kin(cx: number, cy: number, cz: number, w: number, h: number, d: number, mat: MatName, o: BoxOpts = {}): Paintable {
    return this.game.paint.create({
      half: V(w / 2, h / 2, d / 2), position: V(cx, cy, cz), bodyType: 'kinematic',
      geometry: boxGeo(w, h, d, o.uv ?? 3), material: this.game.mats.m[mat], tags: o.tags, resist: o.resist,
    });
  }

  /** Physics prop that obeys every paint rule. */
  dyn(cx: number, cy: number, cz: number, w: number, h: number, d: number, kind: 'crate' | 'slab' | 'core' | 'mass', mass: number, o: DynOpts & { tags?: string[]; ry?: number } = {}): DynBody {
    const mat: MatName = kind === 'slab' ? 'rust' : kind;
    const geo = kind === 'crate' || kind === 'core' ? unitUvBox(w, h, d) : boxGeo(w, h, d, kind === 'mass' ? 6 : 2.5);
    const p = this.game.paint.create({
      half: V(w / 2, h / 2, d / 2), position: V(cx, cy, cz), bodyType: 'dynamic',
      quaternion: o.ry ? new THREE.Quaternion().setFromEuler(_e.set(0, o.ry, 0)) : undefined,
      geometry: geo, material: this.game.mats.m[mat], mass, tags: [kind, ...(o.tags ?? [])],
    });
    return this.game.dynamics.add(p, o);
  }

  /* ------------------------------------------------ scenery */

  private matFor(key: string): THREE.Material {
    if (key === 'weed') return this.weedMat;
    if (key.startsWith('glow:')) return this.glowMats.get(key)!;
    return this.game.mats.m[key as MatName];
  }

  glowKey(hex: number, intensity = 2): string {
    const key = `glow:${hex}:${intensity}`;
    if (!this.glowMats.has(key)) this.glowMats.set(key, this.game.mats.glow(hex, intensity));
    return key;
  }

  /** Add a geometry (already in world space) to the merged scenery. */
  deco(g: THREE.BufferGeometry, mat: string) {
    g.computeBoundingBox();
    const cz = Math.floor(((g.boundingBox!.min.z + g.boundingBox!.max.z) / 2 + 400) / 64);
    const cx = Math.floor(((g.boundingBox!.min.x + g.boundingBox!.max.x) / 2 + 400) / 160);
    const key = `${mat}|${cx}|${cz}`;
    let list = this.decos.get(key);
    if (!list) this.decos.set(key, (list = []));
    const ng = g.index ? g.toNonIndexed() : g;
    prep(ng);
    for (const name of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv', 'color', 'baked'].includes(name)) ng.deleteAttribute(name);
    list.push(ng);
  }

  /** Scenery box by bounds. `collide` adds a (non-paintable) collider. */
  dbox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: string, collide = false, rot?: [number, number, number]) {
    const w = x1 - x0, h = y1 - y0, d = z1 - z0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const g = boxGeo(w, h, d, 3, 4);
    if (rot) { _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])); g.applyMatrix4(_m.compose(V(cx, cy, cz), _q, V(1, 1, 1))); }
    else g.translate(cx, cy, cz);
    this.deco(g, mat);
    if (collide) this.game.physics.sceneryBox(cx, cy, cz, w / 2, h / 2, d / 2, rot ? _q.clone() : undefined);
  }

  /** Cylinder between two points. */
  pipe(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: string, collide = false, segs = 10) {
    const dir = b.clone().sub(a), len = dir.length();
    const g = new THREE.CylinderGeometry(r, r, len, segs, Math.max(1, Math.round(len / 4)));
    _q.setFromUnitVectors(V(0, 1, 0), dir.normalize());
    const mid = a.clone().add(b).multiplyScalar(0.5);
    g.applyMatrix4(_m.compose(mid, _q, V(1, 1, 1)));
    this.deco(g, mat);
    if (collide) this.game.physics.sceneryCylinder(mid.x, mid.y, mid.z, len / 2, r, _q.clone());
  }

  /** Pipe run through several points, with flanges at the joints. */
  pipeRun(pts: [number, number, number][], r: number, mat = 'rust') {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = V(...pts[i]), b = V(...pts[i + 1]);
      this.pipe(a, b, r, mat);
      const g = new THREE.SphereGeometry(r * 1.25, 8, 6);
      g.translate(b.x, b.y, b.z);
      this.deco(g, 'steel');
    }
  }

  cyl(x: number, y0: number, y1: number, z: number, r: number, mat: string, collide = true, segs = 14, rTop = r) {
    const g = new THREE.CylinderGeometry(rTop, r, y1 - y0, segs, Math.max(1, Math.round((y1 - y0) / 3)));
    g.translate(x, (y0 + y1) / 2, z);
    this.deco(g, mat);
    if (collide) this.game.physics.sceneryCylinder(x, (y0 + y1) / 2, z, (y1 - y0) / 2, Math.max(r, rTop));
  }

  /** Static lamp: emissive bulb now, real light contribution baked into vertices. */
  lamp(x: number, y: number, z: number, hex: number, intensity: number, range: number, bulb = 0.14) {
    this.lamps.push({ p: V(x, y, z), c: new THREE.Color(hex), i: intensity, range });
    if (bulb > 0) {
      const g = new THREE.SphereGeometry(bulb, 10, 8);
      g.translate(x, y, z);
      this.deco(g, this.glowKey(hex, 5));
    }
  }

  lampPost(x: number, y: number, z: number, h: number, hex = 0xffc890, towardX = 0, towardZ = 1) {
    this.pipe(V(x, y, z), V(x, y + h, z), 0.07, 'dark', true, 6);
    this.pipe(V(x, y + h, z), V(x + towardX * 1.1, y + h + 0.25, z + towardZ * 1.1), 0.05, 'dark', false, 6);
    this.dbox(x + towardX * 1.1 - 0.22, x + towardX * 1.1 + 0.22, y + h + 0.12, y + h + 0.26, z + towardZ * 1.1 - 0.22, z + towardZ * 1.1 + 0.22, 'dark');
    this.lamp(x + towardX * 1.1, y + h, z + towardZ * 1.1, hex, 3.2, 13, 0.13);
  }

  /** Wall-mounted industrial light. */
  wallLamp(x: number, y: number, z: number, side: Side, hex = 0xffc890, intensity = 2.6, range = 11) {
    const [nx, nz] = side === 'x+' ? [1, 0] : side === 'x-' ? [-1, 0] : side === 'z+' ? [0, 1] : [0, -1];
    this.dbox(x - 0.18 + nx * 0.1, x + 0.18 + nx * 0.1, y - 0.1, y + 0.22, z - 0.18 + nz * 0.1, z + 0.18 + nz * 0.1, 'dark');
    this.lamp(x + nx * 0.3, y - 0.05, z + nz * 0.3, hex, intensity, range, 0.11);
  }

  /** Catenary cable. */
  cable(a: THREE.Vector3, b: THREE.Vector3, sag: number, r = 0.035, mat = 'dark') {
    const mid = a.clone().add(b).multiplyScalar(0.5); mid.y -= sag;
    const g = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 14, r, 5);
    this.deco(g, mat);
  }

  beamX(x0: number, x1: number, y: number, z: number, s = 0.35, mat = 'rust') {
    this.dbox(x0, x1, y - s / 2, y - s / 2 + s * 0.16, z - s / 2, z + s / 2, mat);
    this.dbox(x0, x1, y + s / 2 - s * 0.16, y + s / 2, z - s / 2, z + s / 2, mat);
    this.dbox(x0, x1, y - s / 2, y + s / 2, z - s * 0.08, z + s * 0.08, mat);
  }
  beamZ(z0: number, z1: number, y: number, x: number, s = 0.35, mat = 'rust') {
    this.dbox(x - s / 2, x + s / 2, y - s / 2, y - s / 2 + s * 0.16, z0, z1, mat);
    this.dbox(x - s / 2, x + s / 2, y + s / 2 - s * 0.16, y + s / 2, z0, z1, mat);
    this.dbox(x - s * 0.08, x + s * 0.08, y - s / 2, y + s / 2, z0, z1, mat);
  }
  column(x: number, z: number, y0: number, y1: number, s = 0.45, mat = 'rust', collide = true) {
    this.dbox(x - s / 2, x + s / 2, y0, y1, z - s * 0.08, z + s * 0.08, mat);
    this.dbox(x - s / 2, x + s / 2, y0, y1, z - s / 2, z - s / 2 + s * 0.16, mat);
    this.dbox(x - s / 2, x + s / 2, y0, y1, z + s / 2 - s * 0.16, z + s / 2, mat);
    if (collide) this.game.physics.sceneryBox(x, (y0 + y1) / 2, z, s / 2, (y1 - y0) / 2, s / 2);
  }

  /** Safety railing along a horizontal segment. */
  railing(x0: number, z0: number, x1: number, z1: number, y: number, collide = true) {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / 1.8));
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      this.pipe(V(x, y, z), V(x, y + 1.05, z), 0.035, 'steel', false, 5);
    }
    this.pipe(V(x0, y + 1.05, z0), V(x1, y + 1.05, z1), 0.04, 'steel', false, 5);
    this.pipe(V(x0, y + 0.55, z0), V(x1, y + 0.55, z1), 0.028, 'steel', false, 5);
    if (collide) {
      const ang = Math.atan2(x1 - x0, z1 - z0);
      this.game.physics.sceneryBox((x0 + x1) / 2, y + 0.55, (z0 + z1) / 2, 0.05, 0.55, len / 2, new THREE.Quaternion().setFromEuler(_e.set(0, ang, 0)));
    }
  }

  tank(x: number, y: number, z: number, r: number, h: number, mat = 'rust') {
    this.cyl(x, y, y + h, z, r, mat, true, 18);
    const cap = new THREE.SphereGeometry(r, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1, 0.35, 1); cap.translate(x, y + h, z);
    this.deco(cap, mat);
    for (const t of [0.15, 0.5, 0.85]) { const g = new THREE.TorusGeometry(r + 0.03, 0.05, 6, 24); g.rotateX(Math.PI / 2); g.translate(x, y + h * t, z); this.deco(g, 'steel'); }
  }

  /** Leafless tree. */
  tree(x: number, y: number, z: number, h: number) {
    const lean = rr(-0.12, 0.12);
    const top = V(x + lean * h, y + h, z + rr(-0.1, 0.1) * h);
    const g = new THREE.CylinderGeometry(0.07, 0.24, h, 7, 3);
    _q.setFromUnitVectors(V(0, 1, 0), top.clone().sub(V(x, y, z)).normalize());
    g.applyMatrix4(_m.compose(V(x, y, z).lerp(top, 0.5), _q, V(1, 1, 1)));
    this.deco(g, 'bark');
    this.game.physics.sceneryCylinder(x, y + h / 2, z, h / 2, 0.2);
    const branch = (from: THREE.Vector3, len: number, depth: number) => {
      const dir = V(rr(-1, 1), rr(0.3, 1.1), rr(-1, 1)).normalize();
      const to = from.clone().addScaledVector(dir, len);
      const bg = new THREE.CylinderGeometry(0.015 * depth, 0.04 * depth, len, 5, 1);
      _q.setFromUnitVectors(V(0, 1, 0), dir);
      bg.applyMatrix4(_m.compose(from.clone().lerp(to, 0.5), _q, V(1, 1, 1)));
      this.deco(bg, 'bark');
      if (depth > 1) for (let i = 0; i < 2; i++) branch(from.clone().lerp(to, rr(0.5, 1)), len * 0.62, depth - 1);
    };
    for (let i = 0; i < 6; i++) branch(V(x, y, z).lerp(top, rr(0.45, 1)), rr(1.2, 2.4), 3);
  }

  /** Scatter of weeds/leaf quads (dead vegetation). */
  weeds(x0: number, x1: number, z0: number, z1: number, y: number, count: number, tint: [number, number, number] = [0.3, 0.33, 0.16], hgt = 0.5) {
    const pos: number[] = [], col: number[] = [], nor: number[] = [], uv: number[] = [];
    for (let i = 0; i < count; i++) {
      const x = rr(x0, x1), z = rr(z0, z1);
      const blades = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < blades; k++) {
        const a = rnd() * Math.PI * 2, h = hgt * rr(0.35, 1.1), wd = rr(0.02, 0.045);
        const bx = x + rr(-0.08, 0.08), bz = z + rr(-0.08, 0.08);
        const dx = Math.cos(a) * wd, dz = Math.sin(a) * wd, lean = h * rr(0.1, 0.55);
        pos.push(bx - dx, y, bz - dz, bx + dx, y, bz + dz, bx - dz / wd * lean * 0.5, y + h, bz + dx / wd * lean * 0.5);
        const s = rr(0.6, 1.1);
        col.push(tint[0] * s * 0.35, tint[1] * s * 0.35, tint[2] * s * 0.35, tint[0] * s * 0.35, tint[1] * s * 0.35, tint[2] * s * 0.35, tint[0] * s, tint[1] * s, tint[2] * s * 0.9);
        for (let j = 0; j < 3; j++) { nor.push(0, 1, 0); uv.push(0, 0); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.deco(g, 'weed');
  }

  rubble(x: number, y: number, z: number, n: number, spread: number, mat = 'concrete', size = 0.5) {
    for (let i = 0; i < n; i++) {
      const s = size * rr(0.3, 1.2), px = x + rr(-spread, spread), pz = z + rr(-spread, spread);
      this.dbox(px - s, px + s, y - s * 0.3, y + s * rr(0.3, 0.9), pz - s * rr(0.5, 1), pz + s * rr(0.5, 1), mat, false, [rr(-0.3, 0.3), rr(0, 3), rr(-0.3, 0.3)]);
    }
  }

  /** Text panel. Emissive so it reads in the gloom. */
  sign(lines: string[], x: number, y: number, z: number, side: Side, w: number, h: number, fg = '#e8e2d0', glow = 0.9): THREE.Mesh {
    const tex = textTexture(lines, { w: 512, h: Math.round((512 * h) / w), fg });
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: glow, roughness: 0.6 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(x, y, z);
    m.rotation.y = side === 'z+' ? 0 : side === 'z-' ? Math.PI : side === 'x+' ? Math.PI / 2 : -Math.PI / 2;
    this.game.stage.scene.add(m);
    return m;
  }

  /* ------------------------------------------------ architecture kits */

  /** Map wall-face coordinates (u along the wall, depth out of it) to world bounds. */
  private face(side: Side, plane: number, u0: number, u1: number, y0: number, y1: number, d0: number, d1: number, mat: string, collide = false) {
    const s = side.endsWith('+') ? 1 : -1;
    const a = plane + s * d0, b = plane + s * d1;
    if (side.startsWith('z')) this.dbox(u0, u1, y0, y1, Math.min(a, b), Math.max(a, b), mat, collide);
    else this.dbox(Math.min(a, b), Math.max(a, b), y0, y1, u0, u1, mat, collide);
  }

  /**
   * Dress a wall face with pilasters, cornice, plinth, windows and service pipes.
   * `plane` is the coordinate of the face, `u0..u1` its extent along the wall.
   */
  dress(side: Side, plane: number, u0: number, u1: number, y0: number, y1: number, o: DressOpts = {}) {
    const trim = o.trim ?? 'concrete';
    const bay = o.bay ?? 5;
    this.face(side, plane, u0, u1, y0, y0 + 0.45, 0, 0.14, trim);
    this.face(side, plane, u0, u1, y1 - 0.5, y1, 0, 0.3, trim);
    this.face(side, plane, u0, u1, y1 - 0.8, y1 - 0.5, 0, 0.16, trim);
    const n = Math.max(1, Math.round((u1 - u0) / bay)), step = (u1 - u0) / n;
    for (let i = 0; i <= n; i++) {
      const u = u0 + i * step;
      this.face(side, plane, Math.max(u0, u - 0.32), Math.min(u1, u + 0.32), y0, y1 - 0.5, 0, 0.2, trim);
    }
    if (o.windows === false) return;
    const skipped = (u: number) => (o.skip ?? []).some((r) => u > r[0] && u < r[1]);
    for (let row = y0 + (o.firstRow ?? 3.4); row + 2.6 < y1 - 0.8; row += 3.7) {
      for (let i = 0; i < n; i++) {
        const c = u0 + (i + 0.5) * step;
        if (skipped(c)) continue;
        const ww = Math.min(2.4, step - 1.6), hh = 2.3;
        this.face(side, plane, c - ww / 2 - 0.1, c + ww / 2 + 0.1, row - 0.12, row, 0, 0.22, trim);
        this.face(side, plane, c - ww / 2 - 0.1, c + ww / 2 + 0.1, row + hh, row + hh + 0.12, 0, 0.14, 'dark');
        this.face(side, plane, c - 0.04, c + 0.04, row, row + hh, 0, 0.1, 'dark');
        this.face(side, plane, c - ww / 2, c + ww / 2, row + hh * 0.55, row + hh * 0.55 + 0.06, 0, 0.1, 'dark');
        const r = rnd();
        const pane = r < (o.lit ?? 0.12) ? this.glowKey(0xffb060, 1.6) : r < 0.55 ? this.glowKey(0x3a5560, 0.5) : 'dark';
        this.face(side, plane, c - ww / 2, c + ww / 2, row, row + hh, 0.01, 0.05, pane);
      }
    }
    // a service pipe and a vent or two per wall for irregularity
    if (u1 - u0 > 8) {
      const pu = u0 + step * (0.5 + Math.floor(rnd() * n)) + step * 0.42;
      if (!skipped(pu)) {
        const s = side.endsWith('+') ? 1 : -1, off = plane + s * 0.2;
        const a = side.startsWith('z') ? V(pu, y0, off) : V(off, y0, pu);
        const b = side.startsWith('z') ? V(pu, y1 - 0.9, off) : V(off, y1 - 0.9, pu);
        this.pipe(a, b, 0.09, 'rust', false, 7);
      }
    }
  }

  /** Paintable wall + dressing on one or more faces. */
  wall(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: MatName, sides: Side[] = [], o: DressOpts = {}): Paintable {
    const p = this.box(x0, x1, y0, y1, z0, z1, mat);
    for (const s of sides) {
      if (s === 'z+') this.dress(s, z1, x0, x1, y0, y1, o);
      else if (s === 'z-') this.dress(s, z0, x0, x1, y0, y1, o);
      else if (s === 'x+') this.dress(s, x1, z0, z1, y0, y1, o);
      else this.dress(s, x0, z0, z1, y0, y1, o);
    }
    return p;
  }

  /** Paint receptor plate with housing, status lamp and label. */
  receptor(id: string, x: number, y: number, z: number, side: Side, label: string, need: Paint = Paint.Red): Receptor {
    const zf = side.startsWith('z');
    const s = side.endsWith('+') ? 1 : -1;
    const w = 1.3, t = 0.18;
    const plate = zf
      ? this.slab(x, y, z + s * t / 2, w, w, t, 'lab', { tags: ['receptor'] })
      : this.slab(x + s * t / 2, y, z, t, w, w, 'lab', { tags: ['receptor'] });
    const lamp = this.game.mats.glow(PAINTS[need].hex, 0.3);
    const frame = (du0: number, du1: number, dy0: number, dy1: number, mat: THREE.Material | string, depth = 0.3) => {
      const g = zf ? boxGeo(du1 - du0, dy1 - dy0, depth) : boxGeo(depth, dy1 - dy0, du1 - du0);
      const cu = (du0 + du1) / 2, cy = (dy0 + dy1) / 2;
      if (zf) g.translate(x + cu, y + cy, z + s * depth / 2); else g.translate(x + s * depth / 2, y + cy, z + cu);
      if (typeof mat === 'string') this.deco(g, mat);
      else { const m = new THREE.Mesh(g, mat); this.game.stage.scene.add(m); }
    };
    frame(-0.95, -0.68, -0.95, 0.95, 'dark'); frame(0.68, 0.95, -0.95, 0.95, 'dark');
    frame(-0.95, 0.95, 0.68, 0.95, 'dark'); frame(-0.95, 0.95, -0.95, -0.68, 'dark');
    frame(-0.9, 0.9, 0.98, 1.06, lamp, 0.34); frame(-0.9, 0.9, -1.06, -0.98, lamp, 0.34);
    frame(-1.06, -0.98, -0.9, 0.9, lamp, 0.34); frame(0.98, 1.06, -0.9, 0.9, lamp, 0.34);
    const sx = zf ? x : x + s * 0.36, sz = zf ? z + s * 0.36 : z;
    this.sign([label, `PAINT ${PAINTS[need].key.toUpperCase()} TO ENERGISE`], sx, y + 1.55, sz, side, 2.3, 0.72, PAINTS[need].css, 1.3);
    const r = new Receptor(id, plate, need, lamp, label);
    this.game.power.receptors.push(r);
    return r;
  }

  /** Conveyor running along Z. Its field also drags hovering bodies. */
  conveyor(x0: number, x1: number, top: number, z0: number, z1: number, dirZ: 1 | -1, speed: number, active: () => boolean, fieldH = 5): Conveyor {
    const w = x1 - x0;
    const mat = this.game.mats.m.belt;
    const belt = this.game.paint.create({
      half: V(w / 2, 0.15, (z1 - z0) / 2), position: V((x0 + x1) / 2, top - 0.15, (z0 + z1) / 2),
      geometry: boxGeo(w, 0.3, z1 - z0, w), material: mat, tags: ['belt'],
    });
    const tex = mat.map!.clone(); tex.needsUpdate = true;
    const etex = mat.emissiveMap!.clone(); etex.needsUpdate = true;
    belt.material.map = tex; belt.material.emissiveMap = etex;
    belt.material.emissive = new THREE.Color(0xff5030);
    belt.material.emissiveIntensity = 0;
    this.bakeList.push(belt.mesh);
    // frame, legs, rollers
    this.dbox(x0 - 0.22, x0, top - 0.55, top + 0.18, z0, z1, 'panel', true);
    this.dbox(x1, x1 + 0.22, top - 0.55, top + 0.18, z0, z1, 'panel', true);
    for (let z = z0 + 0.6; z < z1; z += 1.6) this.pipe(V(x0, top - 0.42, z), V(x1, top - 0.42, z), 0.13, 'steel', false, 8);
    for (let z = z0 + 0.4; z <= z1; z += 3.2) {
      this.dbox(x0 - 0.2, x0 + 0.05, 0, top - 0.5, z - 0.12, z + 0.12, 'rust'); this.dbox(x1 - 0.05, x1 + 0.2, 0, top - 0.5, z - 0.12, z + 0.12, 'rust');
    }
    this.game.physics.sceneryBox((x0 + x1) / 2, (top - 0.3) / 2, (z0 + z1) / 2, w / 2, (top - 0.3) / 2, (z1 - z0) / 2);
    const c = new Conveyor(belt, V(0, 0, dirZ), speed, V(x0 - 0.3, top - 0.5, z0), V(x1 + 0.3, top + fieldH, z1), active, tex);
    c.texScale = w * dirZ;
    this.animators.push(() => {
      etex.offset.y = tex.offset.y;
      belt.material.emissiveIntensity = c.level * 1.6;
    });
    this.game.power.conveyors.push(c);
    return c;
  }

  mover(p: Paintable, to: THREE.Vector3, speed: number, mode: 'hold' | 'loop', active: () => boolean, pause = 1.2, sound = false): Mover {
    const t = p.body.translation();
    const m = new Mover(p, V(t.x, t.y, t.z), to, speed, mode, active, pause, sound);
    this.game.power.movers.push(m);
    return m;
  }

  /** Attach scenery to a moving paintable (geometry given in its local frame). */
  attach(p: Paintable, g: THREE.BufferGeometry, mat: string) {
    prep(g);
    const m = new THREE.Mesh(g, this.matFor(mat));
    m.castShadow = true; m.receiveShadow = true;
    p.group.add(m);
    return m;
  }

  /* ------------------------------------------------ finalize + lighting bake */

  async finalize(progress: (f: number) => void, doBake: boolean) {
    const scene = this.game.stage.scene;
    for (const [key, list] of this.decos) {
      const matKey = key.split('|')[0];
      const g = mergeGeometries(list, false);
      if (!g) { console.warn('merge failed', key); continue; }
      for (const l of list) l.dispose();
      const mesh = new THREE.Mesh(g, this.matFor(matKey));
      const glow = matKey.startsWith('glow:');
      mesh.castShadow = !glow && matKey !== 'weed' && matKey !== 'glass';
      mesh.receiveShadow = !glow;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      if (!glow && matKey !== 'glass') this.bakeList.push(mesh);
    }
    this.decos.clear();
    if (!doBake) return;
    this.game.physics.world.step();
    const total = this.bakeList.reduce((s, m) => s + m.geometry.attributes.position.count, 0);
    let done = 0, last = performance.now();
    for (const mesh of this.bakeList) {
      this.bakeMesh(mesh);
      done += mesh.geometry.attributes.position.count;
      if (performance.now() - last > 60) { progress(done / total); await new Promise((r) => setTimeout(r, 0)); last = performance.now(); }
    }
    this.bakeList.length = 0;
  }

  /** Per-vertex ambient occlusion, sky visibility and static lamp irradiance. */
  private bakeMesh(mesh: THREE.Mesh) {
    const g = mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal;
    const col = g.attributes.color as THREE.BufferAttribute, bk = g.attributes.baked as THREE.BufferAttribute;
    mesh.updateMatrixWorld(true);
    const mw = mesh.matrixWorld, nm = new THREE.Matrix3().getNormalMatrix(mw);
    const world = this.game.physics.world;
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    const cast = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) => {
      ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz; ray.dir.x = dx; ray.dir.y = dy; ray.dir.z = dz;
      const h = world.castRay(ray, max, true, flags, QUERY_WORLD);
      return h ? h.timeOfImpact : -1;
    };
    const p = new THREE.Vector3(), n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), d = new THREE.Vector3();
    const sun = this.game.stage.sunDir;
    // nearby lamps only
    g.computeBoundingSphere();
    const bs = g.boundingSphere!.clone().applyMatrix4(mw);
    const lamps = this.lamps.filter((l) => l.p.distanceTo(bs.center) < l.range + bs.radius);
    const AO_R = 2.6;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mw);
      n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      const ox = p.x + n.x * 0.07, oy = p.y + n.y * 0.07, oz = p.z + n.z * 0.07;
      t1.set(n.y, -n.x, 0); if (t1.lengthSq() < 0.01) t1.set(0, n.z, -n.y); t1.normalize();
      t2.crossVectors(n, t1);
      let occ = 0;
      for (let k = 0; k < 4; k++) {
        const a = k * 1.5708 + 0.6;
        d.copy(n).multiplyScalar(0.55).addScaledVector(t1, Math.cos(a) * 0.83).addScaledVector(t2, Math.sin(a) * 0.83);
        const h = cast(ox, oy, oz, d.x, d.y, d.z, AO_R);
        if (h >= 0) occ += 1 - h / AO_R;
      }
      const ao = 1 - (occ / 4) * 0.85;
      // sky visibility: straight up and toward the sun
      let sky = 0;
      if (cast(ox, oy, oz, 0, 1, 0, 90) < 0) sky += 0.5;
      if (cast(ox, oy, oz, sun.x * 0.6, 0.8, sun.z * 0.6, 90) < 0) sky += 0.5;
      const f = ao * (0.2 + 0.8 * sky);
      col.setXYZ(i, col.getX(i) * f, col.getY(i) * f, col.getZ(i) * f);
      let lr = 0, lg = 0, lb = 0;
      for (const l of lamps) {
        d.copy(l.p).sub(p);
        const dist = d.length();
        if (dist > l.range) continue;
        d.multiplyScalar(1 / dist);
        const ndl = Math.max(0, n.dot(d) * 0.85 + 0.15);
        if (ndl <= 0) continue;
        if (dist > 0.4 && cast(ox, oy, oz, d.x, d.y, d.z, dist - 0.25) >= 0) continue;
        const fall = 1 - dist / l.range;
        const k = (l.i * ndl * fall * fall) / (1 + dist * dist * 0.06);
        lr += l.c.r * k; lg += l.c.g * k; lb += l.c.b * k;
      }
      bk.setXYZ(i, lr, lg, lb);
    }
    col.needsUpdate = true; bk.needsUpdate = true;
  }
}
