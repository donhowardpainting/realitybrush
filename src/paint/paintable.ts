import * as THREE from 'three';
import { Physics, RAPIER, WORLD_GROUPS, QUERY_WORLD } from '../core/physics';
import { Paint, PAINTS } from './types';

/** Shared animated time uniform used by every world shader. */
export const timeUniform = { value: 0 };

let blankTex: THREE.DataTexture | null = null;
function getBlank(): THREE.DataTexture {
  if (!blankTex) {
    blankTex = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    blankTex.needsUpdate = true;
  }
  return blankTex;
}

/**
 * Patches a MeshStandardMaterial with the world shader:
 *  - `baked` vertex attribute: pre-computed static lamp irradiance
 *  - optional localized paint layer looked up from a 3x2 box-projected atlas
 */
export function injectWorldShader(
  mat: THREE.MeshStandardMaterial,
  paint?: { tex: { value: THREE.Texture }; half: { value: THREE.Vector3 }; inset: { value: number } },
) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    if (paint) {
      shader.uniforms.uPaintTex = paint.tex;
      shader.uniforms.uPaintHalf = paint.half;
      shader.uniforms.uPaintInset = paint.inset;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 baked;
varying vec3 vBaked;
varying vec3 vPLocal;
varying vec3 vNLocal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vBaked = baked;
vPLocal = position;
vNLocal = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vBaked;
varying vec3 vPLocal;
varying vec3 vNLocal;
uniform float uTime;
${paint ? `uniform sampler2D uPaintTex;
uniform vec3 uPaintHalf;
uniform float uPaintInset;` : ''}
float gPaintM = 0.0;
vec3 gPaintC = vec3(0.0);
float rbHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rbNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rbHash(i), rbHash(i + vec3(1,0,0)), f.x), mix(rbHash(i + vec3(0,1,0)), rbHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rbHash(i + vec3(0,0,1)), rbHash(i + vec3(1,0,1)), f.x), mix(rbHash(i + vec3(0,1,1)), rbHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
${paint ? `{
  vec3 an = abs(vNLocal);
  vec2 fuv; float col; float row;
  if (an.x >= an.y && an.x >= an.z) { fuv = vPLocal.zy / (2.0 * uPaintHalf.zy) + 0.5; col = 0.0; row = vNLocal.x > 0.0 ? 0.0 : 1.0; }
  else if (an.y >= an.z) { fuv = vPLocal.xz / (2.0 * uPaintHalf.xz) + 0.5; col = 1.0; row = vNLocal.y > 0.0 ? 0.0 : 1.0; }
  else { fuv = vPLocal.xy / (2.0 * uPaintHalf.xy) + 0.5; col = 2.0; row = vNLocal.z > 0.0 ? 0.0 : 1.0; }
  fuv = clamp(fuv, vec2(uPaintInset), vec2(1.0 - uPaintInset));
  vec4 pt = texture2D(uPaintTex, (vec2(col, row) + fuv) / vec2(3.0, 2.0));
  float n1 = rbNoise(vPLocal * 9.0);
  float n2 = rbNoise(vPLocal * 2.3 + 7.0);
  gPaintM = smoothstep(0.36, 0.6, pt.a + (n1 - 0.5) * 0.5 + (n2 - 0.5) * 0.25);
  gPaintC = pt.rgb / max(pt.a, 0.004);
  float rim = smoothstep(0.0, 0.5, gPaintM) * (1.0 - smoothstep(0.5, 1.0, gPaintM));
  diffuseColor.rgb = mix(diffuseColor.rgb, gPaintC * (0.8 + 0.25 * n2) * (1.0 - 0.35 * rim), gPaintM);
}` : ''}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.16, gPaintM);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.0, gPaintM);`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
// baked occlusion also hides the sky from reflections, so interiors do not mirror daylight
#ifdef USE_COLOR
  float rbOcc = clamp(dot(vColor.rgb, vec3(0.45)), 0.0, 1.0);
  reflectedLight.indirectSpecular *= mix(rbOcc, 1.0, gPaintM * 0.6);
  #ifdef USE_CLEARCOAT
    clearcoatSpecularIndirect *= rbOcc;
  #endif
#endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vBaked;
totalEmissiveRadiance += gPaintC * gPaintM * (0.2 + 0.1 * sin(uTime * 2.2 + rbNoise(vPLocal * 1.3) * 12.0));`);
  };
  mat.customProgramCacheKey = () => (paint ? 'rb-paint' : 'rb-world');
}

export interface PaintableOpts {
  half: THREE.Vector3;
  position: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  bodyType?: 'fixed' | 'dynamic' | 'kinematic';
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  mass?: number;
  friction?: number;
  fertile?: 'vine' | 'stalk';
  tags?: string[];
  /** Surfaces that shrug paint off. */
  resist?: boolean;
  castShadow?: boolean;
}

export interface SplatEvent {
  p: Paintable;
  type: Paint;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  local: THREE.Vector3;
  radius: number;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const AX_U = [2, 0, 0];
const AX_V = [1, 2, 1];

/**
 * A box-shaped surface that stores paint per texel. Rendering looks the paint up through a
 * box-projected atlas; gameplay reads the very same grid, so what you see is what you get.
 */
export class Paintable {
  id = 0;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  half: THREE.Vector3;
  halfArr: [number, number, number];
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  moving: boolean;
  dynamic: boolean;
  fertile?: 'vine' | 'stalk';
  tags: Set<string>;
  resist: boolean;
  data: Record<string, any> = {};

  N: number;
  types: Uint8Array | null = null;
  private pixels: Uint8Array | null = null;
  private tex: THREE.DataTexture | null = null;
  private texUniform = { value: getBlank() as THREE.Texture };
  /** counts[face * 8 + type] */
  counts = new Int32Array(48);
  faceArea: number[];
  totalArea: number;
  /** Bumped whenever paint changes; systems poll it. */
  version = 0;
  private dirty = false;

  constructor(physics: Physics, o: PaintableOpts) {
    this.half = o.half.clone();
    this.halfArr = [o.half.x, o.half.y, o.half.z];
    this.fertile = o.fertile;
    this.tags = new Set(o.tags ?? []);
    this.resist = !!o.resist;
    const type = o.bodyType ?? 'fixed';
    this.dynamic = type === 'dynamic';
    this.moving = type !== 'fixed';

    const bd = type === 'dynamic' ? RAPIER.RigidBodyDesc.dynamic()
      : type === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.fixed();
    bd.setTranslation(o.position.x, o.position.y, o.position.z);
    if (o.quaternion) bd.setRotation(o.quaternion);
    if (type === 'dynamic') bd.setCcdEnabled(true);
    this.body = physics.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.cuboid(o.half.x, o.half.y, o.half.z)
      .setCollisionGroups(WORLD_GROUPS)
      // Friction is averaged between the two colliders in contact. Static surfaces carry none of
      // their own, so a body's coefficient alone decides how it grips: 1.7 -> 0.85, iced 0.03 -> 0.015.
      .setFriction(type === 'dynamic' ? (o.friction ?? 1.7) : 0)
      .setRestitution(0);
    if (o.mass) cd.setMass(o.mass);
    this.collider = physics.world.createCollider(cd, this.body);

    const maxDim = Math.max(o.half.x, o.half.y, o.half.z) * 2;
    this.N = Math.max(12, Math.min(224, Math.round(maxDim * 9)));
    const [hx, hy, hz] = this.halfArr;
    const ax = 4 * hy * hz, ay = 4 * hx * hz, az = 4 * hx * hy;
    this.faceArea = [ax, ax, ay, ay, az, az];
    this.totalArea = 2 * (ax + ay + az);
    for (let f = 0; f < 6; f++) this.counts[f * 8] = this.N * this.N;

    this.material = o.material.clone();
    injectWorldShader(this.material, {
      tex: this.texUniform,
      half: { value: this.half },
      inset: { value: 0.5 / this.N },
    });
    this.mesh = new THREE.Mesh(o.geometry, this.material);
    this.mesh.castShadow = o.castShadow ?? true;
    this.mesh.receiveShadow = true;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.position.copy(o.position);
    if (o.quaternion) this.group.quaternion.copy(o.quaternion);
    this.group.updateMatrixWorld(true);
    if (!this.moving) {
      this.group.matrixAutoUpdate = false;
      this.mesh.matrixAutoUpdate = false;
    }
  }

  private ensureGrid() {
    if (this.types) return;
    const N = this.N;
    this.types = new Uint8Array(6 * N * N);
    this.pixels = new Uint8Array(6 * N * N * 4);
    this.tex = new THREE.DataTexture(this.pixels, 3 * N, 2 * N, THREE.RGBAFormat);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.needsUpdate = true;
    this.texUniform.value = this.tex;
  }

  worldToLocal(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation(), r = this.body.rotation();
    _q.set(-r.x, -r.y, -r.z, r.w);
    return out.set(world.x - t.x, world.y - t.y, world.z - t.z).applyQuaternion(_q);
  }

  dirToLocal(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const r = this.body.rotation();
    _q.set(-r.x, -r.y, -r.z, r.w);
    return out.copy(world).applyQuaternion(_q);
  }

  localToWorld(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation(), r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    return out.copy(local).applyQuaternion(_q).add(_v.set(t.x, t.y, t.z));
  }

  /** Stamp an irregular blob of `type` centred on a local-space point. Wraps around edges. */
  stamp(lp: THREE.Vector3, r: number, type: Paint, seed = 0, facing?: THREE.Vector3): number {
    if (this.resist) return 0;
    this.ensureGrid();
    const N = this.N, W = 3 * N;
    const types = this.types!, px = this.pixels!;
    const rgb = PAINTS[type].rgb;
    const l = [lp.x, lp.y, lp.z];
    let changed = 0;
    for (let axis = 0; axis < 3; axis++) {
      const ua = AX_U[axis], va = AX_V[axis];
      const hu = this.halfArr[ua], hv = this.halfArr[va];
      const su = (2 * hu) / N, sv = (2 * hv) / N;
      for (let s = 0; s < 2; s++) {
        const d = Math.abs((s ? -1 : 1) * this.halfArr[axis] - l[axis]);
        if (d >= r) continue;
        // when spilling onto a neighbour, only faces that look the same way as the surface hit
        if (facing && (s ? -1 : 1) * (axis === 0 ? facing.x : axis === 1 ? facing.y : facing.z) < 0.5) continue;
        const rf = Math.sqrt(r * r - d * d);
        const cu = l[ua], cv = l[va];
        const ext = rf * 1.35;
        if (cu < -hu - ext || cu > hu + ext || cv < -hv - ext || cv > hv + ext) continue;
        const i0 = Math.max(0, Math.floor((cu - ext + hu) / su)), i1 = Math.min(N - 1, Math.floor((cu + ext + hu) / su));
        const j0 = Math.max(0, Math.floor((cv - ext + hv) / sv)), j1 = Math.min(N - 1, Math.floor((cv + ext + hv) / sv));
        const f = axis * 2 + s;
        const slack = Math.min(su, sv) * 0.35;
        for (let j = j0; j <= j1; j++) {
          const dy = -hv + (j + 0.5) * sv - cv;
          for (let i = i0; i <= i1; i++) {
            const dx = -hu + (i + 0.5) * su - cu;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > ext) continue;
            const ang = Math.atan2(dy, dx);
            const wob = 1 + 0.2 * Math.sin(ang * 3 + seed) + 0.12 * Math.sin(ang * 7 + seed * 2.3);
            if (dist > rf * wob + slack) continue;
            const idx = (s * N + j) * W + axis * N + i;
            const old = types[idx];
            if (old === type) continue;
            types[idx] = type;
            this.counts[f * 8 + old]--;
            this.counts[f * 8 + type]++;
            const k = idx * 4;
            if (type === Paint.None) { px[k] = px[k + 1] = px[k + 2] = px[k + 3] = 0; }
            else { px[k] = rgb[0]; px[k + 1] = rgb[1]; px[k + 2] = rgb[2]; px[k + 3] = 255; }
            changed++;
          }
        }
      }
    }
    if (changed) { this.version++; this.dirty = true; }
    return changed;
  }

  /** Flood every face (or one face) with a paint type. Used for restoring saved state. */
  fill(type: Paint, face = -1) {
    this.ensureGrid();
    const N = this.N, W = 3 * N, rgb = PAINTS[type].rgb;
    for (let f = 0; f < 6; f++) {
      if (face >= 0 && f !== face) continue;
      const axis = f >> 1, s = f & 1;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const idx = (s * N + j) * W + axis * N + i;
        const old = this.types![idx];
        if (old === type) continue;
        this.types![idx] = type;
        this.counts[f * 8 + old]--;
        this.counts[f * 8 + type]++;
        const k = idx * 4;
        if (type === Paint.None) this.pixels!.fill(0, k, k + 4);
        else { this.pixels![k] = rgb[0]; this.pixels![k + 1] = rgb[1]; this.pixels![k + 2] = rgb[2]; this.pixels![k + 3] = 255; }
      }
    }
    this.version++;
    this.dirty = true;
  }

  clear() { if (this.types) this.fill(Paint.None); }

  flush() {
    if (this.dirty && this.tex) { this.tex.needsUpdate = true; this.dirty = false; }
  }

  faceOf(lp: THREE.Vector3, ln?: THREE.Vector3): number {
    if (ln) {
      const ax = Math.abs(ln.x), ay = Math.abs(ln.y), az = Math.abs(ln.z);
      if (ax >= ay && ax >= az) return ln.x > 0 ? 0 : 1;
      if (ay >= az) return ln.y > 0 ? 2 : 3;
      return ln.z > 0 ? 4 : 5;
    }
    let best = 0, bd = Infinity;
    const l = [lp.x, lp.y, lp.z];
    for (let f = 0; f < 6; f++) {
      const d = Math.abs(((f & 1) ? -1 : 1) * this.halfArr[f >> 1] - l[f >> 1]);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  /** Paint type at a local-space point on the surface. */
  typeAtLocal(lp: THREE.Vector3, ln?: THREE.Vector3): Paint {
    if (!this.types) return Paint.None;
    const f = this.faceOf(lp, ln), axis = f >> 1, s = f & 1, N = this.N;
    const ua = AX_U[axis], va = AX_V[axis];
    const l = [lp.x, lp.y, lp.z];
    const i = Math.max(0, Math.min(N - 1, Math.floor(((l[ua] + this.halfArr[ua]) / (2 * this.halfArr[ua])) * N)));
    const j = Math.max(0, Math.min(N - 1, Math.floor(((l[va] + this.halfArr[va]) / (2 * this.halfArr[va])) * N)));
    return this.types[(s * N + j) * 3 * N + axis * N + i];
  }

  typeAt(world: THREE.Vector3, worldNormal?: THREE.Vector3): Paint {
    if (!this.types) return Paint.None;
    const lp = this.worldToLocal(world, _lp);
    return this.typeAtLocal(lp, worldNormal ? this.dirToLocal(worldNormal, _ln) : undefined);
  }

  /** Area-weighted fraction of the whole surface covered by `type`. */
  coverage(type: Paint): number {
    if (!this.types) return 0;
    const n2 = this.N * this.N;
    let a = 0;
    for (let f = 0; f < 6; f++) a += (this.counts[f * 8 + type] / n2) * this.faceArea[f];
    return a / this.totalArea;
  }

  faceCoverage(face: number, type: Paint): number {
    return this.types ? this.counts[face * 8 + type] / (this.N * this.N) : 0;
  }

  maxFaceCoverage(type: Paint): number {
    let m = 0;
    for (let f = 0; f < 6; f++) m = Math.max(m, this.faceCoverage(f, type));
    return m;
  }

  /** Total painted fraction of any colour. */
  painted(): number {
    if (!this.types) return 0;
    const n2 = this.N * this.N;
    let a = 0;
    for (let f = 0; f < 6; f++) a += (1 - this.counts[f * 8] / n2) * this.faceArea[f];
    return a / this.totalArea;
  }

  syncVisual() {
    const t = this.body.translation(), r = this.body.rotation();
    this.group.position.set(t.x, t.y, t.z);
    this.group.quaternion.set(r.x, r.y, r.z, r.w);
  }
}
const _lp = new THREE.Vector3();
const _ln = new THREE.Vector3();

const IDENT = { x: 0, y: 0, z: 0, w: 1 };
const _sl = new THREE.Vector3(), _sn = new THREE.Vector3();
interface Spread { p: Paintable; lp: THREE.Vector3; type: Paint; r: number; seed: number; t: number; stage: number }
const SPREAD_T = [0, 0.06, 0.15];
const SPREAD_R = [0.55, 0.82, 1.0];

/** Registry of all paintable surfaces + the splat pipeline. */
export class PaintWorld {
  all: Paintable[] = [];
  moving: Paintable[] = [];
  byCollider = new Map<number, Paintable>();
  listeners: ((e: SplatEvent) => void)[] = [];
  private spreads: Spread[] = [];
  private dirty = new Set<Paintable>();
  splatCount = 0;
  private ball = new RAPIER.Ball(0.5);

  constructor(private physics: Physics, private scene: THREE.Scene) {}

  create(o: PaintableOpts): Paintable {
    const p = new Paintable(this.physics, o);
    p.id = this.all.length;
    this.all.push(p);
    if (p.moving) this.moving.push(p);
    this.byCollider.set(p.collider.handle, p);
    this.scene.add(p.group);
    return p;
  }

  remove(p: Paintable) {
    this.byCollider.delete(p.collider.handle);
    this.physics.world.removeRigidBody(p.body);
    this.scene.remove(p.group);
    this.all.splice(this.all.indexOf(p), 1);
    const i = this.moving.indexOf(p);
    if (i >= 0) this.moving.splice(i, 1);
    this.spreads = this.spreads.filter((s) => s.p !== p);
  }

  get(collider: RAPIER.Collider | null | undefined): Paintable | undefined {
    return collider ? this.byCollider.get(collider.handle) : undefined;
  }

  /** Apply a paint splat at a world-space surface point. The blob spreads over a few frames. */
  splat(p: Paintable, point: THREE.Vector3, normal: THREE.Vector3, type: Paint, radius: number, instant = false) {
    if (p.resist) return false;
    const lp = p.worldToLocal(point, new THREE.Vector3());
    const seed = Math.random() * 100;
    if (instant) p.stamp(lp, radius, type, seed);
    else {
      p.stamp(lp, radius * SPREAD_R[0], type, seed);
      this.spreads.push({ p, lp, type, r: radius, seed, t: 0, stage: 1 });
    }
    this.dirty.add(p);
    this.splatCount++;
    // spill across seams: neighbouring surfaces within reach take their share of the same blob
    this.ball.radius = radius;
    this.physics.world.intersectionsWithShape(point, IDENT, this.ball, (c) => {
      const q = this.byCollider.get(c.handle);
      if (q && q !== p && !q.resist) {
        if (q.stamp(q.worldToLocal(point, _sl), radius, type, seed, q.dirToLocal(normal, _sn))) this.dirty.add(q);
      }
      return true;
    }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD);
    const ev: SplatEvent = { p, type, point, normal, local: lp, radius };
    for (const l of this.listeners) l(ev);
    return true;
  }

  update(dt: number) {
    for (let i = this.spreads.length - 1; i >= 0; i--) {
      const s = this.spreads[i];
      s.t += dt;
      while (s.stage < 3 && s.t >= SPREAD_T[s.stage]) {
        s.p.stamp(s.lp, s.r * SPREAD_R[s.stage], s.type, s.seed);
        this.dirty.add(s.p);
        s.stage++;
      }
      if (s.stage >= 3) this.spreads.splice(i, 1);
    }
    for (const p of this.dirty) p.flush();
    this.dirty.clear();
  }

  /** Finish every in-flight spread immediately (used by tests and state restore). */
  settle() { this.update(10); }

  markDirty(p: Paintable) { this.dirty.add(p); }

  syncVisuals() {
    for (const p of this.moving) p.syncVisual();
  }
}
