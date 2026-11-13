import * as THREE from 'three';
import type { Game } from '../game';
import { Paint, PAINTS, PAINT_ORDER } from './types';

const MAX_GLOBS = 220;
const FIRE_INTERVAL = 0.065;
const GLOB_SPEED = 42;
const SPLAT_RADIUS = 0.5;
const BOMB_RADIUS = 1.55;
const BOMB_COOLDOWN = 2.4;

interface Glob { alive: boolean; p: THREE.Vector3; v: THREE.Vector3; type: Paint; age: number; size: number; big: boolean }

const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 0, 1);

/** The Reality Brush itself: viewmodel, paint stream, impacts, kinetic pulse. */
export class Gun {
  selected: Paint = Paint.Purple;
  private root = new THREE.Group();
  private model = new THREE.Group();
  private muzzle = new THREE.Object3D();
  private tintMats: THREE.MeshStandardMaterial[] = [];
  private liquid!: THREE.Mesh;
  private rings: THREE.Mesh[] = [];
  private light: THREE.PointLight;
  private globs: Glob[] = [];
  private globMesh: THREE.InstancedMesh;
  private cooldown = 0;
  private pulseCool = 0;
  private bombCool = 0;
  /** 0..1, 1 = paint bomb ready. */
  get bombReady() { return 1 - Math.max(0, this.bombCool) / BOMB_COOLDOWN; }
  private recoil = 0;
  private recoilV = 0;
  private swayX = 0;
  private swayY = 0;
  private switchSpin = 0;
  private bob = 0;
  private firing = false;
  private color = new THREE.Color();
  private heat = 0;
  shots = 0;

  constructor(private game: Game) {
    this.buildModel();
    game.stage.camera.add(this.root);
    this.root.add(this.model);
    this.light = new THREE.PointLight(0xffffff, 0, 7, 2);
    this.muzzle.add(this.light);

    const geo = new THREE.SphereGeometry(1, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.globMesh = new THREE.InstancedMesh(geo, mat, MAX_GLOBS);
    this.globMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.globMesh.frustumCulled = false;
    this.globMesh.count = 0;
    this.globMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    game.stage.scene.add(this.globMesh);
    for (let i = 0; i < MAX_GLOBS; i++) this.globs.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), type: Paint.None, age: 0, size: 0.07, big: false });
    this.applyColor(true);
  }

  private buildModel() {
    const body = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.34, metalness: 0.85 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 0.55, metalness: 0.15 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.65, metalness: 0.4 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.25, metalness: 1 });
    const tint = (k = 1) => { const m = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0xffffff, emissiveIntensity: 1.2, roughness: 0.35 }); m.userData.k = k; this.tintMats.push(m); return m; };
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz); this.model.add(mesh); return mesh;
    };
    const H = Math.PI / 2;
    // receiver
    add(new THREE.BoxGeometry(0.085, 0.1, 0.3), body, 0, 0, 0.02);
    add(new THREE.BoxGeometry(0.09, 0.018, 0.24), trim, 0, 0.056, 0.03);
    add(new THREE.BoxGeometry(0.092, 0.03, 0.1), trim, 0, -0.02, -0.07);
    add(new THREE.BoxGeometry(0.05, 0.13, 0.055), dark, 0, -0.105, 0.125, 0.4);
    add(new THREE.TorusGeometry(0.032, 0.006, 6, 14, Math.PI), dark, 0, -0.055, 0.035, 0, H, Math.PI);
    add(new THREE.BoxGeometry(0.004, 0.012, 0.2), tint(0.9), 0.0435, 0.02, 0.02);
    add(new THREE.BoxGeometry(0.004, 0.012, 0.2), tint(0.9), -0.0435, 0.02, 0.02);
    // barrel, emitter coils, nozzle
    add(new THREE.CylinderGeometry(0.024, 0.03, 0.3, 14), body, 0, 0.005, -0.27, H);
    for (let i = 0; i < 3; i++) this.rings.push(add(new THREE.TorusGeometry(0.04, 0.0065, 8, 22), tint(1.2), 0, 0.005, -0.2 - i * 0.07));
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.78; add(new THREE.BoxGeometry(0.006, 0.006, 0.2), steel, Math.cos(a) * 0.04, 0.005 + Math.sin(a) * 0.04, -0.27); }
    add(new THREE.CylinderGeometry(0.046, 0.034, 0.05, 16), body, 0, 0.005, -0.43, H);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 16), tint(1.6), 0, 0.005, -0.458, H);
    // pigment reservoir
    const glass = new THREE.MeshStandardMaterial({ color: 0xd8ecff, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false });
    this.liquid = add(new THREE.CylinderGeometry(0.03, 0.03, 0.13, 14), tint(0.75), 0, 0.105, 0.05, H);
    add(new THREE.CylinderGeometry(0.038, 0.038, 0.15, 16), glass, 0, 0.105, 0.05, H);
    add(new THREE.CylinderGeometry(0.041, 0.041, 0.016, 16), steel, 0, 0.105, 0.13, H);
    add(new THREE.CylinderGeometry(0.041, 0.041, 0.016, 16), steel, 0, 0.105, -0.03, H);
    add(new THREE.BoxGeometry(0.03, 0.03, 0.05), body, 0, 0.07, 0.05);
    add(new THREE.TorusGeometry(0.045, 0.006, 6, 14, Math.PI), steel, 0, 0.06, -0.075, H, 0, H);
    this.muzzle.position.set(0, 0.005, -0.47);
    this.model.add(this.muzzle);
    this.model.scale.setScalar(0.4);
    this.model.traverse((o) => { o.frustumCulled = false; });
    this.root.position.set(0.135, -0.125, -0.25);
    this.root.rotation.set(0.03, 0.09, 0);
  }

  select(p: Paint, silent = false) {
    if (p !== Paint.None && !this.game.unlocked.has(p)) { if (!silent) this.game.audio.deny(); return; }
    if (p === this.selected) return;
    this.selected = p;
    this.switchSpin = 1;
    this.applyColor();
    if (!silent) this.game.audio.select(p);
    this.game.hud.setSelected(p);
  }

  private applyColor(first = false) {
    this.color.copy(PAINTS[this.selected].color);
    for (const m of this.tintMats) m.emissive.copy(this.color);
    this.light.color.copy(this.color);
    if (!first) this.game.hud.setSelected(this.selected);
  }

  private cycle(dir: number) {
    const avail = PAINT_ORDER.filter((p) => this.game.unlocked.has(p));
    const list: Paint[] = [...avail, Paint.None];
    const i = list.indexOf(this.selected);
    this.select(list[(i + dir + list.length) % list.length]);
  }

  /** Per render frame: input, viewmodel animation. */
  frame(dt: number) {
    const game = this.game, inp = game.input, pl = game.player;
    const active = inp.locked && !pl.frozen;
    if (active) {
      const keys = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];
      keys.forEach((k, i) => { if (inp.hit(k)) this.select(PAINT_ORDER[i]); });
      if (inp.hit('KeyQ') || inp.hit('Digit6') || inp.hit('KeyX')) this.select(Paint.None);
      if (inp.wheel) this.cycle(inp.wheel > 0 ? 1 : -1);
      if ((inp.hit('Mouse2') || inp.hit('KeyF')) && this.pulseCool <= 0) this.pulse();
      if ((inp.hit('KeyE') || inp.hit('Mouse1')) && this.bombCool <= 0) this.bomb();
    }
    this.firing = active && inp.down('Mouse0');
    game.audio.spray(this.firing, this.selected);
    this.heat += ((this.firing ? 1 : 0) - this.heat) * Math.min(1, dt * 8);

    // viewmodel springs
    this.recoilV += (-this.recoil * 190 - this.recoilV * 16) * dt;
    this.recoil += this.recoilV * dt;
    this.swayX += (-inp.mouseDX * 0.00045 - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (inp.mouseDY * 0.00045 - this.swayY) * Math.min(1, dt * 9);
    const sp = Math.hypot(pl.vel.x, pl.vel.z);
    if (pl.grounded) this.bob += dt * sp * 1.25;
    const bobAmt = pl.grounded ? Math.min(1, sp / 6) : 0;
    this.switchSpin *= Math.exp(-dt * 7);
    const m = this.model;
    m.position.set(
      this.swayX + Math.cos(this.bob) * 0.006 * bobAmt,
      this.swayY + Math.abs(Math.sin(this.bob)) * 0.008 * bobAmt - pl.vel.y * 0.0018 - this.switchSpin * 0.06,
      this.recoil * 0.07,
    );
    m.rotation.set(this.recoil * 0.22 + this.swayY * 1.5 + this.switchSpin * 0.5, this.swayX * 2.2, -this.swayX * 1.4 + this.switchSpin * 0.9);
    this.root.visible = game.state !== 'menu' && game.state !== 'loading';
    // keep the brush in frame on narrow and portrait screens
    this.root.position.x = 0.135 * Math.max(0.42, Math.min(1, game.stage.camera.aspect / 1.6));
    const t = game.time;
    this.rings.forEach((r, i) => { const k = 1 + this.heat * 0.25 * Math.sin(t * 30 - i * 1.4); r.scale.set(k, k, 1); });
    const glow = 1.1 + this.heat * 2.2 + Math.sin(t * 3) * 0.12;
    for (const mat of this.tintMats) mat.emissiveIntensity = glow * (mat.userData.k ?? 1);
    this.light.intensity = this.heat * 2.2;
  }

  /** Fixed step: emit and simulate paint globs. */
  fixedUpdate(dt: number) {
    this.cooldown -= dt; this.pulseCool -= dt; this.bombCool -= dt;
    if (this.firing) {
      while (this.cooldown <= 0) { this.fire(); this.cooldown += FIRE_INTERVAL; }
    } else if (this.cooldown < 0) this.cooldown = 0;
    this.stepGlobs(dt);
  }

  private aim(outDir: THREE.Vector3, origin: THREE.Vector3) {
    const game = this.game, cam = game.stage.camera;
    game.player.forward(_d);
    const e = game.player.eye;
    this.muzzle.getWorldPosition(origin);
    // keep the muzzle origin from poking through walls
    const back = game.physics.castRay(e.x, e.y, e.z, origin.x - e.x, origin.y - e.y, origin.z - e.z, 1);
    if (back) origin.copy(e).addScaledVector(_d, 0.2);
    const h = game.physics.castRay(e.x, e.y, e.z, _d.x, _d.y, _d.z, 70);
    if (h && h.toi > 0.8) outDir.copy(h.point).sub(origin).normalize();
    else outDir.copy(_d);
    void cam;
  }

  private fire() {
    const game = this.game;
    const origin = _p, dir = _s;
    this.aim(dir, origin);
    const g = this.globs.find((x) => !x.alive);
    if (!g) return;
    const spread = 0.012;
    g.alive = true; g.type = this.selected; g.age = 0; g.size = 0.055 + Math.random() * 0.03; g.big = false;
    g.p.copy(origin);
    g.v.set(dir.x + (Math.random() - 0.5) * spread, dir.y + (Math.random() - 0.5) * spread, dir.z + (Math.random() - 0.5) * spread).multiplyScalar(GLOB_SPEED);
    g.v.addScaledVector(game.player.vel, 0.35);
    this.recoilV += 2.4;
    this.shots++;
    game.audio.shot(this.selected);
    const c = this.color;
    for (let i = 0; i < 3; i++) {
      game.glow.spawn(origin.x, origin.y, origin.z, dir.x * 6 + (Math.random() - 0.5) * 2.5, dir.y * 6 + (Math.random() - 0.5) * 2.5, dir.z * 6 + (Math.random() - 0.5) * 2.5, c.r, c.g, c.b, 0.05, 0.22, 0, 3, 0.7);
    }
  }

  /** Paint bomb: one heavy lobbed glob that bursts into a 1.5 m pool. Covers ground fast. */
  private bomb() {
    const game = this.game;
    const g = this.globs.find((x) => !x.alive);
    if (!g) return;
    const origin = _p, dir = _s;
    this.aim(dir, origin);
    this.bombCool = BOMB_COOLDOWN;
    g.alive = true; g.type = this.selected; g.age = 0; g.size = 0.17; g.big = true;
    g.p.copy(origin);
    g.v.copy(dir).multiplyScalar(30).addScaledVector(game.player.vel, 0.35);
    g.v.y += 1.5;
    this.recoilV += 7;
    game.audio.pulse();
    game.input.rumble(0.6, 0.3, 120);
    const c = this.color;
    for (let i = 0; i < 14; i++) game.glow.spawn(origin.x, origin.y, origin.z, dir.x * 5 + (Math.random() - 0.5) * 4, dir.y * 5 + (Math.random() - 0.5) * 4, dir.z * 5 + (Math.random() - 0.5) * 4, c.r, c.g, c.b, 0.07, 0.35, 0, 3, 0.8);
  }

  private stepGlobs(dt: number) {
    const game = this.game, ph = game.physics;
    let n = 0;
    for (const g of this.globs) {
      if (!g.alive) continue;
      g.age += dt;
      if (g.big) g.v.y -= 11 * dt;
      else if (g.age > 0.28) g.v.y -= 14 * dt; // flat trajectory at working range, arcs beyond it
      const sp = g.v.length();
      const step = sp * dt;
      const h = ph.castRay(g.p.x, g.p.y, g.p.z, g.v.x / sp, g.v.y / sp, g.v.z / sp, step + 0.02);
      if (h) {
        this.impact(g, h.collider, h.point, h.normal, g.v);
        g.alive = false;
        continue;
      }
      g.p.addScaledVector(g.v, dt);
      if (g.age > 2.4 || g.p.y < -30) { g.alive = false; continue; }
      const c = PAINTS[g.type].color;
      // elongate along velocity for a streaky stream
      _q.setFromUnitVectors(_up, _d.copy(g.v).normalize());
      _m.compose(g.p, _q, _s.set(g.size, g.size, g.size * (1 + Math.min(5, sp * 0.07))));
      this.globMesh.setMatrixAt(n, _m);
      this.globMesh.setColorAt(n, _col.copy(c).multiplyScalar(g.type === Paint.None ? 0.9 : 1.6));
      n++;
      if (Math.random() < 0.3) game.drops.spawn(g.p.x, g.p.y, g.p.z, (Math.random() - 0.5), -0.5, (Math.random() - 0.5), c.r, c.g, c.b, 0.03, 0.4, 9, 0, 0.9);
    }
    this.globMesh.count = n;
    this.globMesh.instanceMatrix.needsUpdate = true;
    if (this.globMesh.instanceColor) this.globMesh.instanceColor.needsUpdate = true;
  }

  private impact(g: Glob, collider: import('@dimforge/rapier3d-compat').Collider, point: THREE.Vector3, normal: THREE.Vector3, vel: THREE.Vector3) {
    const game = this.game;
    const p = game.paint.get(collider);
    const c = PAINTS[g.type].color;
    const pt = _hitP.copy(point), nm = _hitN.copy(normal);
    let stuck = false;
    if (p) stuck = game.paint.splat(p, pt, nm, g.type, g.big ? BOMB_RADIUS : SPLAT_RADIUS * (0.9 + Math.random() * 0.25));
    if (g.big) {
      game.audio.splat(g.type, 1.6);
      game.drops.burst(pt, nm, c, 40, 8, 0.08, 0.8, 12);
      game.glow.burst(pt, nm, c, 30, 6, 0.1, 0.6, 3, 1.8);
    }
    // paint has momentum: nudge whatever it hits
    const body = collider.parent();
    if (body && body.isDynamic()) {
      const k = (g.big ? 60 : 9) / GLOB_SPEED;
      body.applyImpulseAtPoint({ x: vel.x * k, y: vel.y * k, z: vel.z * k }, pt, true);
    }
    const dist = pt.distanceTo(game.player.eye);
    const vol = Math.max(0.15, 1 - dist / 30);
    if (Math.random() < 0.5) game.audio.splat(g.type, vol);
    if (stuck) {
      game.drops.burst(pt, nm, c, 7, 4.5, 0.06, 0.5, 12);
      // each pigment lands with its own character
      switch (g.type) {
        case Paint.Purple: game.glow.burst(pt, nm, c, 6, 1.6, 0.07, 0.9, -2.2, 1.6); break;             // motes that fall upward
        case Paint.Blue: game.glow.burst(pt, nm, _col.setRGB(0.75, 0.95, 1), 8, 5, 0.04, 0.3, 6, 2); break; // frost shards
        case Paint.Green: game.glow.burst(pt, nm, c, 5, 2, 0.06, 0.7, 1.5, 1.3); break;                    // drifting spores
        case Paint.Yellow: game.glow.burst(pt, nm, c, 7, 6.5, 0.05, 0.5, 14, 1.8); break;                  // hopping beads
        case Paint.Red: game.glow.burst(pt, nm, _col.setRGB(1, 0.6, 0.3), 10, 9, 0.035, 0.22, 4, 3); break; // sparks
        default: game.glow.burst(pt, nm, _col.setRGB(0.9, 0.95, 1), 6, 2, 0.08, 0.5, -0.5, 0.6);           // solvent vapour
      }
      // drips on walls
      if (Math.abs(nm.y) < 0.4 && Math.random() < 0.5) game.drops.spawn(pt.x + nm.x * 0.03, pt.y, pt.z + nm.z * 0.03, 0, -0.4, 0, c.r, c.g, c.b, 0.05, 1.2, 3, 0.5, 1);
    } else {
      // paint-resistant surface: it just beads off
      game.drops.burst(pt, nm, c, 5, 5, 0.04, 0.4, 14);
      game.glow.burst(pt, nm, _col.setRGB(0.8, 0.8, 0.8), 3, 3, 0.04, 0.2, 2);
    }
  }

  /** Kinetic pulse: a shove of compressed air. Moves objects, nudges you when airborne. */
  private pulse() {
    const game = this.game, pl = game.player;
    this.pulseCool = 0.65;
    this.recoilV += 9;
    game.audio.pulse();
    pl.forward(_d);
    const e = pl.eye;
    for (const p of game.paint.moving) {
      if (!p.dynamic || !p.body.isDynamic()) continue;
      const t = p.body.translation();
      _p.set(t.x - e.x, t.y - e.y, t.z - e.z);
      const dist = _p.length();
      const reach = 9 + Math.max(p.half.x, p.half.y, p.half.z);
      if (dist > reach) continue;
      _p.normalize();
      if (_p.dot(_d) < 0.72 && dist > 2.2) continue;
      const m = Math.min(p.body.mass(), 320);
      const k = m * 8.5 * (1 - (dist / reach) * 0.6);
      p.body.applyImpulse({ x: _d.x * k, y: _d.y * k + m * 0.8, z: _d.z * k }, true);
    }
    if (!pl.grounded) pl.vel.addScaledVector(_d, -3.2);
    const c = this.color;
    this.muzzle.getWorldPosition(_p);
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2, r = 2.2 + Math.random();
      _s.set(Math.cos(a) * r, Math.sin(a) * r, 0).applyQuaternion(game.stage.camera.quaternion).addScaledVector(_d, 13);
      game.glow.spawn(_p.x, _p.y, _p.z, _s.x, _s.y, _s.z, 0.8 + c.r * 0.4, 0.8 + c.g * 0.4, 0.8 + c.b * 0.4, 0.1, 0.4, 0, 2.5, 0.8);
    }
    game.emit('player:pulse');
  }
}
const _col = new THREE.Color();
const _hitP = new THREE.Vector3();
const _hitN = new THREE.Vector3();
