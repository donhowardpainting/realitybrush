import * as THREE from 'three';
import type { Game } from '../game';
import type { Paintable, SplatEvent } from '../paint/paintable';
import { Paint, PAINTS } from '../paint/types';
import { prep } from '../world/geo';

const MAX_LEAVES = 7000;

interface Leaf { idx: number; pos: THREE.Vector3; q: THREE.Quaternion; scale: number; t: number; owner: Paintable; local: THREE.Vector3; dead: boolean }

export class Stalk {
  height = 0.3;
  target: number;
  cap: Paintable;
  trunk: THREE.Mesh;
  constructor(public base: THREE.Vector3, public bed: Paintable, cap: Paintable, trunk: THREE.Mesh, start: number, public max: number) {
    this.cap = cap; this.trunk = trunk; this.target = start;
  }
}

const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();
const _z = new THREE.Vector3(0, 0, 1), _y = new THREE.Vector3(0, 1, 0);

/**
 * Green paint brings fertile matter to life, exactly where it lands:
 *  - fertile walls sprout climbable ivy on the painted texels
 *  - fertile soil raises a stalk at the splat; more green makes it taller
 *  - anywhere else it leaves a dusting of sprouts (purely cosmetic)
 */
export class Growth {
  private leaves: Leaf[] = [];
  private growing: Leaf[] = [];
  private mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private count = 0;
  stalks: Stalk[] = [];
  private capGeo: THREE.BufferGeometry;
  private trunkGeo: THREE.BufferGeometry;

  constructor(private game: Game) {
    // a small rosette of leaves
    const pos: number[] = [], col: number[] = [], nor: number[] = [];
    const blades = 5;
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * Math.PI * 2 + 0.3, l = 0.34 + (i % 2) * 0.12, w = 0.13;
      const cx = Math.cos(a), cy = Math.sin(a);
      const tip = [cx * l, cy * l, 0.16], b1 = [-cy * w + cx * l * 0.4, cx * w + cy * l * 0.4, 0.1], b2 = [cy * w + cx * l * 0.4, -cx * w + cy * l * 0.4, 0.1];
      pos.push(0, 0, 0.02, ...b1, ...tip, 0, 0, 0.02, ...tip, ...b2);
      const g1 = 0.35 + (i % 3) * 0.12;
      for (let k = 0; k < 6; k++) { col.push(0.12, g1 + (k === 2 || k === 4 ? 0.35 : 0), 0.1); nor.push(0, 0, 1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.6, emissive: 0x1c6a2a, emissiveIntensity: 0.55 });
    this.mesh = new THREE.InstancedMesh(g, mat, MAX_LEAVES);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    game.stage.scene.add(this.mesh);

    this.capGeo = prep(new THREE.CylinderGeometry(1.12, 0.75, 0.3, 14, 1));
    const tg = new THREE.CylinderGeometry(0.2, 0.36, 1, 9, 6);
    tg.translate(0, -0.5, 0);
    const tp = tg.attributes.position;
    for (let i = 0; i < tp.count; i++) { const y = tp.getY(i); tp.setX(i, tp.getX(i) + Math.sin(y * 5) * 0.07); tp.setZ(i, tp.getZ(i) + Math.cos(y * 4) * 0.07); }
    tg.computeVertexNormals();
    this.trunkGeo = prep(tg);

    game.paint.listeners.push((e) => this.onSplat(e));
  }

  private addLeaf(owner: Paintable, world: THREE.Vector3, normal: THREE.Vector3, scale: number) {
    let idx: number;
    if (this.free.length) idx = this.free.pop()!;
    else if (this.count < MAX_LEAVES) idx = this.count++;
    else return;
    const q = new THREE.Quaternion().setFromUnitVectors(_z, normal);
    q.multiply(_q.setFromAxisAngle(_z, Math.random() * 6.28));
    const leaf: Leaf = { idx, pos: world.clone().addScaledVector(normal, 0.02), q, scale, t: 0, owner, local: owner.worldToLocal(world, new THREE.Vector3()), dead: false };
    this.leaves.push(leaf); this.growing.push(leaf);
    this.mesh.count = this.count;
  }

  private removeLeavesNear(owner: Paintable, local: THREE.Vector3, r: number) {
    for (const l of this.leaves) {
      if (l.dead || l.owner !== owner || l.local.distanceTo(local) > r) continue;
      l.dead = true; l.t = 1;
      if (!this.growing.includes(l)) this.growing.push(l);
    }
  }

  private onSplat(e: SplatEvent) {
    const game = this.game, p = e.p;
    // growing/shrinking a stalk by painting its cap
    if (p.tags.has('cap')) {
      const st = p.data.stalk as Stalk;
      if (e.type === Paint.Green) this.feed(st, 0.4);
      else if (e.type === Paint.None) st.target = Math.max(0.8, st.target - 0.4);
      return;
    }
    if (e.type !== Paint.Green) {
      if (p.fertile === 'vine' || p.data.sprouts) this.removeLeavesNear(p, e.local, e.radius * 1.1);
      return;
    }
    const n = e.normal;
    if (p.fertile === 'vine' && Math.abs(n.y) < 0.5) {
      this.scatter(p, e, 9, 0.75, 1.25);
      if (Math.random() < 0.25) game.audio.grow();
      game.emit('grow:vine');
    } else if (p.fertile === 'stalk' && n.y > 0.5) {
      let near: Stalk | null = null, nd = 1.9;
      for (const s of this.stalks) {
        const d = Math.hypot(s.base.x - e.point.x, s.base.z - e.point.z);
        if (s.bed === p && d < nd) { nd = d; near = s; }
      }
      if (near) this.feed(near, 0.45);
      else this.spawnStalk(p, e.point);
      this.scatter(p, e, 3, 0.5, 0.9);
    } else if (!p.dynamic && n.y > 0.6 && Math.random() < 0.6) {
      p.data.sprouts = true;
      this.scatter(p, e, 2, 0.3, 0.6);
    }
  }

  private scatter(p: Paintable, e: SplatEvent, count: number, s0: number, s1: number) {
    const n = e.normal;
    // tangent basis on the surface
    const t1 = _v.set(n.y, -n.x, 0);
    if (t1.lengthSq() < 0.01) t1.set(0, n.z, -n.y);
    t1.normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * e.radius * 0.85;
      const w = e.point.clone().addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r);
      const l = p.worldToLocal(w, _s);
      if (Math.abs(l.x) > p.half.x + 0.01 || Math.abs(l.y) > p.half.y + 0.01 || Math.abs(l.z) > p.half.z + 0.01) continue;
      this.addLeaf(p, w, n, s0 + Math.random() * (s1 - s0));
    }
  }

  private feed(s: Stalk, amount: number) {
    if (s.target >= s.max) return;
    s.target = Math.min(s.max, s.target + amount);
  }

  spawnStalk(bed: Paintable, at: THREE.Vector3): Stalk | null {
    const game = this.game;
    const maxCount = (bed.data.maxStalks as number) ?? 4;
    if (this.stalks.filter((s) => s.bed === bed).length >= maxCount) return null;
    // keep the cap inside the bed footprint
    const l = bed.worldToLocal(at, new THREE.Vector3());
    l.x = Math.max(-bed.half.x + 0.5, Math.min(bed.half.x - 0.5, l.x));
    l.z = Math.max(-bed.half.z + 0.5, Math.min(bed.half.z - 0.5, l.z));
    l.y = bed.half.y;
    const base = bed.localToWorld(l, new THREE.Vector3());
    const cap = game.paint.create({
      half: new THREE.Vector3(0.95, 0.15, 0.95),
      position: new THREE.Vector3(base.x, base.y + 0.15, base.z),
      bodyType: 'kinematic',
      geometry: this.capGeo,
      material: game.mats.m.cap,
      tags: ['cap'],
    });
    const trunk = new THREE.Mesh(this.trunkGeo, game.mats.m.cap);
    trunk.castShadow = true;
    trunk.position.y = -0.1;
    cap.group.add(trunk);
    const st = new Stalk(base, bed, cap, trunk, (bed.data.growStart as number) ?? 2.2, (bed.data.growMax as number) ?? 6.5);
    cap.data.stalk = st;
    this.stalks.push(st);
    game.audio.grow();
    game.glow.burst(base, _y, PAINTS[Paint.Green].color, 40, 5, 0.09, 0.9, -1, 1.6);
    game.emit('grow:stalk');
    return st;
  }

  fixedUpdate(dt: number) {
    const ph = this.game.physics;
    for (const s of this.stalks) {
      const prev = s.height;
      s.height += (s.target - s.height) * (1 - Math.exp(-dt * 3.2));
      if (Math.abs(s.target - s.height) < 0.002) s.height = s.target;
      const y = s.base.y + s.height - 0.15;
      s.cap.body.setNextKinematicTranslation({ x: s.base.x, y, z: s.base.z });
      ph.setKinVel(s.cap.body, 0, (s.height - prev) / dt, 0);
      s.trunk.scale.set(1, Math.max(0.05, s.height - 0.25), 1);
      if (s.height !== prev && Math.random() < 0.3) {
        this.game.glow.spawn(s.base.x + (Math.random() - 0.5), y, s.base.z + (Math.random() - 0.5), 0, 1, 0, 0.3, 1, 0.4, 0.07, 0.6, -0.5, 1);
      }
    }
  }

  /** Per-frame leaf grow/shrink animation. */
  frame(dt: number) {
    if (!this.growing.length) return;
    for (let i = this.growing.length - 1; i >= 0; i--) {
      const l = this.growing[i];
      l.t += (l.dead ? -1 : 1) * dt * (l.dead ? 4 : 1.6);
      let k: number;
      if (l.dead) { k = Math.max(0, l.t); }
      else { const t = Math.min(1, l.t); k = 1 - Math.pow(1 - t, 3) + Math.sin(t * Math.PI) * 0.25; }
      _m.compose(l.pos, l.q, _s.setScalar(Math.max(0.0001, l.scale * k)));
      this.mesh.setMatrixAt(l.idx, _m);
      if ((!l.dead && l.t >= 1) || (l.dead && l.t <= 0)) {
        this.growing.splice(i, 1);
        if (l.dead) { this.free.push(l.idx); this.leaves.splice(this.leaves.indexOf(l), 1); }
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
