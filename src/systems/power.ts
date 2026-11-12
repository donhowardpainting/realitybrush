import * as THREE from 'three';
import { RAPIER } from '../core/physics';
import type { Game } from '../game';
import type { Paintable } from '../paint/paintable';
import { Paint, PAINTS } from '../paint/types';
import type { DynBody } from './dynamics';

/** A plate that switches on when enough of one face carries the required paint. */
export class Receptor {
  powered = false;
  coverage = 0;
  onChange: ((on: boolean) => void)[] = [];
  /** Returns a reason string while the receptor is locked out, else null. */
  gate: (() => string | null) | null = null;
  private denyT = 0;
  constructor(public id: string, public p: Paintable, public need: Paint, public lamp: THREE.MeshStandardMaterial, public label = '') {
    lamp.emissive.copy(PAINTS[need].color);
    lamp.emissiveIntensity = 0.25;
  }
  get on() { return this.powered; }

  update(game: Game, dt: number) {
    this.coverage = this.p.maxFaceCoverage(this.need);
    this.denyT -= dt;
    let want = this.powered ? this.coverage > 0.22 : this.coverage >= 0.35;
    if (want && this.gate) {
      const why = this.gate();
      if (why) {
        want = false;
        if (this.denyT <= 0) { this.denyT = 4; game.hud.toast(why, PAINTS[this.need].css); game.audio.deny(); }
      }
    }
    if (want !== this.powered) {
      this.powered = want;
      game.audio.power(want);
      if (want) {
        const t = this.p.body.translation();
        game.glow.burst(new THREE.Vector3(t.x, t.y, t.z), null, PAINTS[this.need].color, 50, 7, 0.1, 0.9, 2, 2.5);
        game.stage.pulse(PAINTS[this.need].hex, 0.12);
        game.emit('power:' + this.id);
      }
      for (const f of this.onChange) f(want);
    }
    const target = this.powered ? 3.2 + Math.sin(game.time * 6) * 0.6 : 0.25 + this.coverage * 1.2 + Math.max(0, Math.sin(game.time * 2.5)) * 0.25;
    this.lamp.emissiveIntensity += (target - this.lamp.emissiveIntensity) * Math.min(1, dt * 6);
  }
}

const ease = (t: number) => t * t * (3 - 2 * t);
const _p = new THREE.Vector3();

/** Kinematic platform/door that travels between two points. */
export class Mover {
  t = 0;
  dir = 1;
  wait = 0;
  moving = false;
  private dist: number;
  private last = new THREE.Vector3();
  constructor(
    public p: Paintable, public from: THREE.Vector3, public to: THREE.Vector3, public speed: number,
    public mode: 'hold' | 'loop', public active: () => boolean, public pause = 1.2, public sound = false,
  ) {
    this.dist = from.distanceTo(to);
    this.last.copy(from);
  }

  setPhase(t: number, dir: number) { this.t = t; this.dir = dir; this.last.lerpVectors(this.from, this.to, ease(t)); this.p.body.setTranslation(this.last, true); }

  update(game: Game, dt: number) {
    const rate = (this.speed / this.dist) * dt;
    const before = this.t;
    if (this.mode === 'hold') {
      const target = this.active() ? 1 : 0;
      this.t += Math.sign(target - this.t) * Math.min(Math.abs(target - this.t), rate);
    } else if (this.active()) {
      if (this.wait > 0) this.wait -= dt;
      else {
        this.t += this.dir * rate;
        if (this.t >= 1) { this.t = 1; this.dir = -1; this.wait = this.pause; }
        else if (this.t <= 0) { this.t = 0; this.dir = 1; this.wait = this.pause; }
      }
    }
    const started = !this.moving && this.t !== before;
    this.moving = this.t !== before;
    if (started && this.sound) game.audio.door();
    _p.lerpVectors(this.from, this.to, ease(this.t));
    game.physics.setKinVel(this.p.body, (_p.x - this.last.x) / dt, (_p.y - this.last.y) / dt, (_p.z - this.last.z) / dt);
    this.p.body.setNextKinematicTranslation(_p);
    this.last.copy(_p);
  }
}

/**
 * Mag-line conveyor: drags the player standing on its belt and any body inside its field,
 * including weightless ones hovering above it.
 */
export class Conveyor {
  level = 0;
  /** Metres of belt per texture repeat (sign flips scroll direction). */
  texScale = 3;
  private vel = new THREE.Vector3();
  private axis: 'x' | 'z';
  constructor(
    public belt: Paintable | null, public dirv: THREE.Vector3, public speed: number,
    public min: THREE.Vector3, public max: THREE.Vector3, public active: () => boolean, public tex: THREE.Texture | null = null,
  ) {
    this.axis = Math.abs(dirv.x) > Math.abs(dirv.z) ? 'x' : 'z';
  }

  update(game: Game, dt: number) {
    const on = this.active();
    this.level += ((on ? 1 : 0) - this.level) * Math.min(1, dt * 1.5);
    if (this.level < 0.01) { this.level = 0; if (this.belt) game.physics.surfaceVel.delete(this.belt.collider.handle); return; }
    const s = this.speed * this.level;
    this.vel.copy(this.dirv).multiplyScalar(s);
    if (this.belt) game.physics.surfaceVel.set(this.belt.collider.handle, this.vel);
    if (this.tex) this.tex.offset.y += (s * dt) / this.texScale;
    const lat = this.axis === 'x' ? 'z' : 'x';
    const centre = (this.min[lat] + this.max[lat]) / 2;
    for (const d of game.dynamics.bodies) {
      const b = d.p.body;
      if (d.captured || !b.isDynamic()) continue;
      const t = b.translation();
      if (t.x < this.min.x || t.x > this.max.x || t.y < this.min.y || t.y > this.max.y || t.z < this.min.z || t.z > this.max.z) continue;
      if (!d.hovering && d.clearance > 0.5) continue;
      const grip = d.icy && !d.hovering ? 0.1 : 1;
      const v = b.linvel();
      const k = Math.min(1, 4 * dt * grip);
      const kl = Math.min(1, 2 * dt * grip);
      const off = t[lat] - centre;
      if (this.axis === 'x') b.setLinvel({ x: v.x + (this.vel.x - v.x) * k, y: v.y, z: v.z + (-off * 1.5 - v.z) * kl }, true);
      else b.setLinvel({ x: v.x + (-off * 1.5 - v.x) * kl, y: v.y, z: v.z + (this.vel.z - v.z) * k }, true);
    }
  }
}

const _q = new THREE.Quaternion(), _y = new THREE.Vector3(0, 1, 0);

/** Arms orbiting a vertical axle. Each arm is its own kinematic paintable. */
export class Rotor {
  angle: number;
  w = 0;
  constructor(
    public centre: THREE.Vector3, public arms: { p: Paintable; radius: number; phase: number }[], public speed: number,
    public active: () => boolean, angle = 0, public spinner: THREE.Object3D | null = null,
  ) {
    this.angle = angle;
    this.place(0, null);
  }

  private place(dt: number, game: Game | null) {
    for (const a of this.arms) {
      const ang = this.angle + a.phase;
      const x = Math.cos(ang) * a.radius, z = -Math.sin(ang) * a.radius;
      _p.set(this.centre.x + x, this.centre.y, this.centre.z + z);
      _q.setFromAxisAngle(_y, ang);
      if (game) {
        a.p.body.setNextKinematicTranslation(_p);
        a.p.body.setNextKinematicRotation(_q);
        game.physics.setKinVel(a.p.body, this.w * z, 0, -this.w * x, this.w);
      } else {
        a.p.body.setTranslation(_p, true);
        a.p.body.setRotation(_q, true);
      }
    }
    if (this.spinner) this.spinner.rotation.y = this.angle;
    void dt;
  }

  update(game: Game, dt: number) {
    this.w += ((this.active() ? this.speed : 0) - this.w) * Math.min(1, dt * 0.9);
    if (Math.abs(this.w) < 1e-4) this.w = 0;
    this.angle += this.w * dt;
    this.place(dt, game);
  }
}

/** Cradle that swallows a tagged body (the power core) and locks it in. */
export class Socket {
  filled = false;
  private d: DynBody | null = null;
  private t = 0;
  private from = new THREE.Vector3();
  onFill: (() => void)[] = [];
  constructor(public id: string, public min: THREE.Vector3, public max: THREE.Vector3, public target: THREE.Vector3, public tag: string) {}

  /** Instantly seat a body (restoring a saved game). */
  force(game: Game, d: DynBody) {
    this.filled = true; d.captured = true;
    d.p.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    d.p.body.setTranslation(this.target, true);
    d.p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    void game;
  }

  update(game: Game, dt: number) {
    if (this.d) {
      this.t = Math.min(1, this.t + dt * 1.4);
      _p.lerpVectors(this.from, this.target, ease(this.t));
      this.d.p.body.setNextKinematicTranslation(_p);
      this.d.p.body.setNextKinematicRotation({ x: 0, y: 0, z: 0, w: 1 });
      if (this.t >= 1) {
        this.d.p.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
        this.d = null;
        this.filled = true;
        game.audio.socket();
        game.glow.burst(this.target, null, new THREE.Color(1, 0.6, 0.2), 90, 9, 0.12, 1.2, 3, 2.5);
        game.stage.pulse(0xffa040, 0.3);
        game.emit('socket:' + this.id);
        for (const f of this.onFill) f();
      }
      return;
    }
    if (this.filled) return;
    for (const d of game.dynamics.bodies) {
      if (d.captured || !d.p.tags.has(this.tag)) continue;
      const t = d.p.body.translation();
      if (t.x < this.min.x || t.x > this.max.x || t.y < this.min.y || t.y > this.max.y || t.z < this.min.z || t.z > this.max.z) continue;
      d.captured = true;
      d.p.clear();
      game.paint.markDirty(d.p);
      d.p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.from.set(t.x, t.y, t.z);
      this.d = d; this.t = 0;
      game.audio.clang();
      break;
    }
  }
}

export class PowerSys {
  receptors: Receptor[] = [];
  movers: Mover[] = [];
  conveyors: Conveyor[] = [];
  rotors: Rotor[] = [];
  sockets: Socket[] = [];
  constructor(private game: Game) {}
  receptor(id: string) { return this.receptors.find((r) => r.id === id)!; }
  socket(id: string) { return this.sockets.find((s) => s.id === id)!; }

  fixedUpdate(dt: number) {
    const g = this.game;
    for (const r of this.receptors) r.update(g, dt);
    for (const s of this.sockets) s.update(g, dt);
    for (const m of this.movers) m.update(g, dt);
    for (const c of this.conveyors) c.update(g, dt);
    for (const r of this.rotors) r.update(g, dt);
    let hum = 0;
    for (const r of this.receptors) if (r.powered) hum += 0.4;
    for (const s of this.sockets) if (s.filled) hum += 1;
    g.audio.humLevel = Math.min(2.5, hum);
  }
}
