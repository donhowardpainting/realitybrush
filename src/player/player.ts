import * as THREE from 'three';
import { RAPIER, GROUP_PLAYER, QUERY_WORLD, groups } from '../core/physics';
import type { Game } from '../game';
import { Paint, PAINTS } from '../paint/types';
import type { Paintable } from '../paint/paintable';

const HALF_H = 0.5, RADIUS = 0.35, FEET = HALF_H + RADIUS, EYE = 0.68;
const GRAVITY = 24, JUMP = 8.1, WALK = 6.2, SPRINT = 9.2;
const BOUNCE_MIN = 13, BOUNCE_MAX = 22;
const PUSH_FORCE = 1100;

interface Ground { collider: RAPIER.Collider; toi: number; point: THREE.Vector3; normal: THREE.Vector3; paintable?: Paintable; paint: Paint }

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const OFFS = [[0, 0], [0.24, 0], [-0.24, 0], [0, 0.24], [0, -0.24]];

/** First-person character: kinematic capsule with paint-aware movement. */
export class Player {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  private ctl: RAPIER.KinematicCharacterController;
  private inner: RAPIER.Capsule;
  private ignore = new Set<number>();
  private filter = (c: RAPIER.Collider) => !this.ignore.has(c.handle);
  pos = new THREE.Vector3();
  prevPos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  climbing = false;
  onIce = false;
  lowG = false;
  /** External gravity multiplier (used by the finale). */
  gravScale = 1;
  sensitivity = 1;
  frozen = false;
  groundPaint: Paint = Paint.None;
  groundCollider: RAPIER.Collider | null = null;
  private ground: Ground = { collider: null as any, toi: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), paint: Paint.None };
  private gNormal = new THREE.Vector3(0, 1, 0);
  private platVel = new THREE.Vector3();
  private jumpBuf = 0;
  private coyote = 0;
  private climbCool = 0;
  private bobT = 0;
  private landDip = 0;
  private camRoll = 0;
  private fovKick = 0;
  airTime = 0;
  stats = { bounces: 0, jumps: 0 };
  eye = new THREE.Vector3();

  constructor(private game: Game) {
    const w = game.physics.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 2, 0));
    this.collider = w.createCollider(
      // The solver never sees the player (solver groups = none): the character controller resolves
      // world collisions itself, and rigid bodies are moved by explicit pushes. This lets a floating
      // platform rise underneath the player instead of being pinned by an infinitely heavy capsule.
      RAPIER.ColliderDesc.capsule(HALF_H, RADIUS).setCollisionGroups(groups(GROUP_PLAYER, 0xffff)).setSolverGroups(groups(GROUP_PLAYER, 0)).setFriction(0),
      this.body,
    );
    this.ctl = w.createCharacterController(0.03);
    this.inner = new RAPIER.Capsule(HALF_H - 0.08, RADIUS - 0.08);
    this.ctl.setUp({ x: 0, y: 1, z: 0 });
    this.ctl.enableAutostep(0.42, 0.2, false);
    this.ctl.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    this.ctl.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.ctl.setSlideEnabled(true);
    this.ctl.setApplyImpulsesToDynamicBodies(false);
  }

  teleport(p: THREE.Vector3, yaw = this.yaw) {
    this.pos.set(p.x, p.y + FEET + 0.05, p.z);
    this.prevPos.copy(this.pos);
    this.body.setTranslation(this.pos, true);
    this.body.setNextKinematicTranslation(this.pos);
    this.vel.set(0, 0, 0);
    this.yaw = yaw; this.pitch = 0;
    this.grounded = false; this.climbing = false;
  }

  get feetY() { return this.pos.y - FEET; }

  /** Per-render-frame: mouse look + input edge capture. */
  frame(dt: number) {
    const inp = this.game.input;
    if (!this.frozen) {
      const s = 0.0022 * this.sensitivity;
      this.yaw -= inp.mouseDX * s;
      this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch - inp.mouseDY * s));
      if (inp.hit('Space')) this.jumpBuf = 0.14;
    }
  }

  private probe(p: THREE.Vector3, len: number): Ground | null {
    const ph = this.game.physics;
    let best: Ground | null = null;
    for (const o of OFFS) {
      const h = ph.castRay(p.x + o[0], p.y, p.z + o[1], 0, -1, 0, len);
      if (h && (!best || h.toi < best.toi)) {
        const g = this.ground;
        g.collider = h.collider; g.toi = h.toi; g.point.copy(h.point); g.normal.copy(h.normal);
        best = g;
        if (o[0] === 0 && o[1] === 0 && h.toi < FEET + 0.1) break;
      }
    }
    if (best) {
      best.paintable = this.game.paint.get(best.collider);
      best.paint = best.paintable ? best.paintable.typeAt(best.point, best.normal) : Paint.None;
    }
    return best;
  }

  fixedUpdate(dt: number) {
    const game = this.game, inp = game.input, ph = game.physics;
    const t = this.body.translation();
    this.pos.set(t.x, t.y, t.z);
    this.prevPos.copy(this.pos);
    if (this.frozen) return;
    this.jumpBuf -= dt; this.coyote -= dt; this.climbCool -= dt;

    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const iz = (inp.down('KeyW') || inp.down('ArrowUp') ? 1 : 0) - (inp.down('KeyS') || inp.down('ArrowDown') ? 1 : 0);
    const ix = (inp.down('KeyD') || inp.down('ArrowRight') ? 1 : 0) - (inp.down('KeyA') || inp.down('ArrowLeft') ? 1 : 0);
    let wx = fx * iz + rx * ix, wz = fz * iz + rz * ix;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    const maxSp = inp.down('ShiftLeft') || inp.down('ShiftRight') ? SPRINT : WALK;
    const v = this.vel;
    const wasGrounded = this.grounded;

    // --- what are we standing on? ---
    const g = this.probe(this.pos, FEET + 0.3);
    const contact = !!g && g.toi <= FEET + 0.1;
    this.platVel.set(0, 0, 0);
    if (wasGrounded && g && contact) {
      const b = g.collider.parent();
      if (b) ph.pointVelocity(b, g.point, this.platVel);
      const sv = ph.surfaceVel.get(g.collider.handle);
      if (sv) this.platVel.addScaledVector(sv, g.paint === Paint.Blue ? 0.15 : 1);
      this.gNormal.copy(g.normal);
      this.groundPaint = g.paint;
      this.groundCollider = g.collider;
    } else if (!wasGrounded) { this.gNormal.set(0, 1, 0); this.groundPaint = Paint.None; this.groundCollider = null; }
    this.onIce = wasGrounded && this.groundPaint === Paint.Blue;

    this.shoveOverlaps();

    // --- vines ---
    if (this.tryClimb(dt, fx, fz, rx, rz, iz, ix)) return;

    // anti-gravity field above purple-painted ground
    const col = ph.castRay(this.pos.x, this.pos.y, this.pos.z, 0, -1, 0, 9);
    this.lowG = false;
    if (col) { const p = game.paint.get(col.collider); if (p && p.typeAt(col.point, col.normal) === Paint.Purple) this.lowG = true; }

    let jumped = false;
    if (wasGrounded) {
      const sp = Math.hypot(v.x, v.z);
      const fr = this.onIce ? 0.1 : 9;
      if (sp > 0) { const drop = Math.max(sp, this.onIce ? 0 : 2.5) * fr * dt; const k = Math.max(0, sp - drop) / sp; v.x *= k; v.z *= k; }
      this.accelerate(wx, wz, maxSp, this.onIce ? 1.1 : 11, dt);
      if (this.onIce) { const n = this.gNormal; v.x += GRAVITY * n.x * n.y * dt; v.z += GRAVITY * n.z * n.y * dt; }
    } else {
      this.accelerate(wx, wz, Math.min(maxSp, WALK), 2.4, dt);
      v.y -= GRAVITY * this.gravScale * (this.lowG ? 0.4 : 1) * dt;
      if (v.y < -45) v.y = -45;
      if (this.gravScale < 0 && v.y > 3.2) v.y = 3.2;
    }
    if (this.jumpBuf > 0 && (wasGrounded || this.coyote > 0)) {
      v.y = JUMP + Math.max(0, this.platVel.y);
      if (wasGrounded) { v.x += this.platVel.x; v.z += this.platVel.z; }
      jumped = true; this.grounded = false; this.coyote = 0; this.jumpBuf = 0;
      this.stats.jumps++;
      game.audio.jump();
    }

    // --- move ---
    let slopeVy = 0;
    const d = _a;
    if (wasGrounded && !jumped) {
      const n = this.gNormal;
      if (n.y > 0.3) slopeVy = Math.max(-14, Math.min(14, -(n.x * v.x + n.z * v.z) / n.y));
      // stay glued to rising platforms: no downward bias while being lifted, and recover any sink-in
      const sink = g && g.toi < FEET + 0.012 ? FEET + 0.03 - g.toi : 0;
      const bias = this.platVel.y > 0.05 || sink > 0 ? 0 : 0.012;
      d.set((v.x + this.platVel.x) * dt, (slopeVy + this.platVel.y) * dt - bias + sink, (v.z + this.platVel.z) * dt);
      this.ctl.enableSnapToGround(0.35);
    } else {
      d.set(v.x * dt, v.y * dt, v.z * dt);
      this.ctl.disableSnapToGround();
    }
    this.ctl.computeColliderMovement(this.collider, d, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD, this.filter);
    const m = this.ctl.computedMovement();
    const vyBefore = v.y;
    if (!wasGrounded && v.y > 0 && m.y < d.y - 0.004) v.y = 0; // head bump
    this.resolveCollisions(dt, wx, wz, wl > 0);
    this.pos.set(this.pos.x + m.x, this.pos.y + m.y, this.pos.z + m.z);
    this.body.setNextKinematicTranslation(this.pos);

    // --- ground state / bounce ---
    let ng = this.ctl.computedGrounded() && !jumped;
    const g2 = this.probe(this.pos, FEET + 0.3);
    if (!ng && !jumped && g2 && g2.toi <= FEET + 0.05 && v.y <= 0 && g2.normal.y > 0.6) ng = true;
    if (ng && !wasGrounded && v.y > 0.5) ng = false;
    if (ng) {
      const impact = wasGrounded ? 0 : -vyBefore;
      if (g2) { this.gNormal.copy(g2.normal); this.groundPaint = g2.paint; this.groundCollider = g2.collider; }
      if (!wasGrounded) {
        if (impact > 3) { game.audio.land(impact); this.landDip = Math.min(0.22, impact * 0.012); }
        const b = g2?.collider.parent();
        if (b && g2) { ph.pointVelocity(b, g2.point, _b); v.x -= _b.x; v.z -= _b.z; }
      }
      v.y = 0;
      this.grounded = true;
      if (g2 && g2.paint === Paint.Yellow && g2.toi <= FEET + 0.12) this.bounce(impact, g2);
    } else {
      if (wasGrounded && !jumped) {
        v.y = slopeVy + this.platVel.y;
        v.x += this.platVel.x; v.z += this.platVel.z;
        this.coyote = 0.12;
      }
      this.grounded = false;
    }
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    game.audio.footsteps(dt, Math.hypot(v.x, v.z), this.grounded, this.groundPaint === Paint.Blue);
  }

  /**
   * Bodies that end up genuinely inside the player (thrown crates, a slab settling on your head)
   * are shoved clear and ignored by the controller for that step, so the player can never be trapped.
   */
  private shoveOverlaps() {
    this.ignore.clear();
    const w = this.game.physics.world;
    w.intersectionsWithShape(this.pos, { x: 0, y: 0, z: 0, w: 1 }, this.inner, (c) => {
      const b = c.parent();
      if (!b || !b.isDynamic()) return true;
      this.ignore.add(c.handle);
      const t = b.translation();
      let dx = t.x - this.pos.x, dz = t.z - this.pos.z;
      const l = Math.hypot(dx, dz);
      if (l < 0.05) { dx = -Math.sin(this.yaw); dz = -Math.cos(this.yaw); } else { dx /= l; dz /= l; }
      const m = Math.min(b.mass(), 400);
      b.applyImpulse({ x: dx * m * 0.25, y: 0, z: dz * m * 0.25 }, true);
      return true;
    }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD);
  }

  private bounce(impact: number, g: Ground) {
    const game = this.game;
    let sp = Math.max(BOUNCE_MIN, Math.min(impact * 0.9, BOUNCE_MAX));
    if (game.input.down('Space')) sp *= 1.15;
    const n = g.normal;
    this.vel.y = sp * n.y;
    this.vel.x += sp * n.x; this.vel.z += sp * n.z;
    this.grounded = false; this.coyote = 0; this.jumpBuf = 0;
    this.stats.bounces++;
    game.audio.bounce(sp);
    game.glow.burst(g.point, n, PAINTS[Paint.Yellow].color, 26, 5, 0.09, 0.6, 4, 2);
    game.emit('player:bounce');
  }

  private accelerate(wx: number, wz: number, wishSpeed: number, accel: number, dt: number) {
    const cur = this.vel.x * wx + this.vel.z * wz;
    const add = wishSpeed - cur;
    if (add <= 0) return;
    const a = Math.min(add, accel * wishSpeed * dt);
    this.vel.x += a * wx; this.vel.z += a * wz;
  }

  private resolveCollisions(dt: number, wx: number, wz: number, moving: boolean) {
    const game = this.game, v = this.vel;
    const nCol = this.ctl.numComputedCollisions();
    for (let i = 0; i < nCol; i++) {
      const c = this.ctl.computedCollision(i);
      if (!c || !c.collider) continue;
      let nx = c.normal2.x, ny = c.normal2.y, nz = c.normal2.z;
      if (Math.abs(ny) > 0.5) continue;
      const hl = Math.hypot(nx, nz);
      if (hl < 1e-4) continue;
      nx /= hl; nz /= hl;
      // orient the normal from the obstacle toward the player
      const cp = c.collider.parent();
      const into0 = v.x * nx + v.z * nz;
      if (into0 > 0) { nx = -nx; nz = -nz; }
      const into = v.x * nx + v.z * nz;
      if (into < 0) {
        let bounced = false;
        if (into < -3.2) {
          const h = game.physics.castRay(this.pos.x, this.pos.y - 0.2, this.pos.z, -nx, 0, -nz, RADIUS + 0.4);
          const p = h ? game.paint.get(h.collider) : undefined;
          if (h && p && p.typeAt(h.point, h.normal) === Paint.Yellow) {
            v.x -= 1.9 * into * nx; v.z -= 1.9 * into * nz;
            v.y = Math.max(v.y, 6.5);
            this.grounded = false;
            bounced = true;
            game.audio.bounce(-into);
            game.glow.burst(h.point, h.normal, PAINTS[Paint.Yellow].color, 18, 4, 0.08, 0.5, 4, 2);
          }
        }
        if (!bounced) { v.x -= into * nx; v.z -= into * nz; }
      }
      if (cp && cp.isDynamic() && moving) {
        const bt = cp.translation();
        if ((bt.x - this.pos.x) * wx + (bt.z - this.pos.z) * wz > 0) {
          const bv = cp.linvel();
          if (bv.x * wx + bv.z * wz < WALK) cp.applyImpulse({ x: wx * PUSH_FORCE * dt, y: 0, z: wz * PUSH_FORCE * dt }, true);
        }
      }
    }
  }

  private vineAt(y: number, fx: number, fz: number): THREE.Vector3 | null {
    const h = this.game.physics.castRay(this.pos.x, y, this.pos.z, fx, 0, fz, RADIUS + 0.5);
    if (!h || Math.abs(h.normal.y) > 0.4) return null;
    const p = this.game.paint.get(h.collider);
    if (!p || p.fertile !== 'vine' || p.typeAt(h.point, h.normal) !== Paint.Green) return null;
    return _c.copy(h.normal);
  }

  private tryClimb(dt: number, fx: number, fz: number, rx: number, rz: number, iz: number, ix: number): boolean {
    if (this.climbCool > 0) { this.climbing = false; return false; }
    const chest = this.vineAt(this.pos.y + 0.3, fx, fz);
    const n = chest ? _b.copy(chest) : null;
    const feet = this.vineAt(this.pos.y - 0.6, fx, fz);
    const wn = n ?? (feet ? _b.copy(feet) : null);
    if (!wn) {
      if (this.climbing) { // crested the top: hop onto the ledge
        this.climbing = false;
        this.vel.set(fx * 3.5, 3, fz * 3.5);
      }
      return false;
    }
    if (!this.climbing && !(iz > 0 || !this.grounded)) return false;
    if (this.grounded && iz < 0) { this.climbing = false; return false; }
    this.climbing = true;
    this.grounded = false;
    const v = this.vel;
    if (this.jumpBuf > 0) {
      v.set(wn.x * 4.5, 7.5, wn.z * 4.5);
      this.climbing = false; this.climbCool = 0.35; this.jumpBuf = 0;
      this.game.audio.jump();
      return false;
    }
    const tdot = rx * wn.x + rz * wn.z;
    const tx = rx - tdot * wn.x, tz = rz - tdot * wn.z;
    if (!chest && feet && iz >= 0) v.set(-wn.x * 2.4, 3.6, -wn.z * 2.4);
    else v.set(tx * ix * 2.6 - wn.x * 1.5, iz * 3.4, tz * ix * 2.6 - wn.z * 1.5);
    this.ctl.disableSnapToGround();
    this.ctl.computeColliderMovement(this.collider, _a.set(v.x * dt, v.y * dt, v.z * dt), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD, this.filter);
    const m = this.ctl.computedMovement();
    this.pos.set(this.pos.x + m.x, this.pos.y + m.y, this.pos.z + m.z);
    this.body.setNextKinematicTranslation(this.pos);
    if (iz < 0 && this.ctl.computedGrounded()) { this.climbing = false; this.grounded = true; v.set(0, 0, 0); }
    this.airTime = 0;
    return true;
  }

  /** Position the camera (interpolated between fixed steps). */
  updateCamera(cam: THREE.PerspectiveCamera, alpha: number, dt: number) {
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (this.grounded && sp > 1) this.bobT += dt * sp * 1.25;
    this.landDip *= Math.exp(-dt * 9);
    const bob = this.grounded && !this.onIce ? Math.sin(this.bobT * 2) * 0.035 * Math.min(1, sp / 6) : 0;
    this.eye.lerpVectors(this.prevPos, this.pos, alpha);
    this.eye.y += EYE + bob - this.landDip;
    cam.position.copy(this.eye);
    const side = (this.vel.x * Math.cos(this.yaw) - this.vel.z * Math.sin(this.yaw)) / 9;
    this.camRoll += (-side * 0.028 - this.camRoll) * Math.min(1, dt * 8);
    cam.rotation.set(this.pitch, this.yaw, this.camRoll);
    const targetKick = Math.min(1, Math.max(0, (sp - 7) / 12));
    this.fovKick += (targetKick - this.fovKick) * Math.min(1, dt * 5);
    const fov = 78 + this.fovKick * 14;
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = fov; cam.updateProjectionMatrix(); }
    this.game.stage.speedFx = this.fovKick;
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }
}
