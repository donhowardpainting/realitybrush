import * as THREE from 'three';
import { RAPIER } from '../core/physics';
import type { Game } from '../game';
import type { Paintable } from '../paint/paintable';
import { Paint, PAINTS } from '../paint/types';

export interface DynOpts {
  /** Hover clearance (m) reached at full anti-gravity coverage. */
  maxHover?: number;
  /** Purple coverage fraction that counts as "full". */
  fullAt?: number;
  /** Keep the body upright (big rideable platforms). */
  lockTilt?: boolean;
  /** Respawn here if it leaves the world. */
  home?: THREE.Vector3;
  friction?: number;
}

export class DynBody {
  lift = 0;
  cB = 0;
  cY = 0;
  hovering = false;
  icy = false;
  /** Height above whatever is below (m); large when over a void. */
  clearance = 0;
  captured = false;
  private ver = -1;
  phase = Math.random() * 6.28;
  home: THREE.Vector3;
  homeRot: THREE.Quaternion;
  maxHover: number;
  fullAt: number;
  baseFriction: number;
  holdY: number | null = null;
  private rest = -1;

  /**
   * Rapier caches friction/restitution inside persisting contact manifolds, so a material change
   * on a body at rest would otherwise be ignored. Re-assigning the shape invalidates them.
   */
  touch() { this.p.collider.setShape(this.p.collider.shape); }

  constructor(public p: Paintable, public o: DynOpts) {
    const t = p.body.translation(), r = p.body.rotation();
    this.home = o.home ?? new THREE.Vector3(t.x, t.y, t.z);
    this.homeRot = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    this.maxHover = o.maxHover ?? 6.5;
    this.fullAt = o.fullAt ?? 0.5;
    this.baseFriction = o.friction ?? 1.7;
    if (o.lockTilt) p.body.setEnabledRotations(false, false, false, true);
  }

  refresh() {
    if (this.ver === this.p.version) return;
    this.ver = this.p.version;
    const cP = this.p.coverage(Paint.Purple);
    this.lift = Math.max(0, Math.min(1, (cP - 0.015) / (this.fullAt - 0.015)));
    this.cB = this.p.coverage(Paint.Blue);
    this.cY = this.p.coverage(Paint.Yellow);
    // averaged against static surfaces (which have zero restitution)
    const rest = 0.1 + 1.55 * Math.min(1, this.cY / 0.2);
    if (Math.abs(rest - this.rest) > 0.02) { this.rest = rest; this.p.collider.setRestitution(rest); this.touch(); }
  }
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const RAYS = [[0, 0], [0.8, 0.8], [-0.8, 0.8], [0.8, -0.8], [-0.8, -0.8]];

/**
 * Paint-driven rigid body behaviour. Every dynamic paintable gets the same rules:
 *  purple  -> hovers above whatever is beneath it, higher with more coverage
 *  blue    -> frictionless (on the object, or on the ground it rests on)
 *  yellow  -> springy (on the object) / launches it (on the ground)
 */
export class Dynamics {
  bodies: DynBody[] = [];
  byPaintable = new Map<Paintable, DynBody>();
  killY = -12;

  constructor(private game: Game) {}

  add(p: Paintable, o: DynOpts = {}): DynBody {
    const d = new DynBody(p, o);
    this.bodies.push(d);
    this.byPaintable.set(p, d);
    return d;
  }

  remove(d: DynBody) {
    this.bodies.splice(this.bodies.indexOf(d), 1);
    this.byPaintable.delete(d.p);
  }

  respawn(d: DynBody) {
    const b = d.p.body;
    b.setTranslation(d.home, true);
    b.setRotation(d.homeRot, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    d.p.clear();
    this.game.paint.markDirty(d.p);
    d.holdY = null;
    this.game.glow.burst(d.home, null, PAINTS[Paint.Purple].color, 30, 4, 0.1, 0.7, 0, 1.5);
  }

  fixedUpdate(dt: number) {
    const game = this.game, ph = game.physics, time = game.time;
    for (const d of this.bodies) {
      const p = d.p, b = p.body;
      if (d.captured || !b.isDynamic()) continue;
      d.refresh();
      const t = b.translation();
      if (t.y < this.killY) { this.respawn(d); continue; }
      if (b.isSleeping() && d.lift === 0) continue;

      // world-space half extents (support along Y, footprint along X/Z)
      const r = b.rotation();
      _m.makeRotationFromQuaternion(_q.set(r.x, r.y, r.z, r.w));
      const e = _m.elements, h = p.halfArr;
      const ex = Math.abs(e[0]) * h[0] + Math.abs(e[4]) * h[1] + Math.abs(e[8]) * h[2];
      const ey = Math.abs(e[1]) * h[0] + Math.abs(e[5]) * h[1] + Math.abs(e[9]) * h[2];
      const ez = Math.abs(e[2]) * h[0] + Math.abs(e[6]) * h[1] + Math.abs(e[10]) * h[2];

      const target = d.lift * d.maxHover;
      const reach = ey + Math.max(target + 9, 3);
      let clearance = Infinity;
      let groundPaint = Paint.None, groundP: Paintable | undefined;
      const nRays = d.lift > 0 ? RAYS.length : 1;
      for (let i = 0; i < nRays; i++) {
        const hit = ph.castRay(t.x + RAYS[i][0] * ex, t.y, t.z + RAYS[i][1] * ez, 0, -1, 0, reach, b);
        if (!hit) continue;
        const c = hit.toi - ey;
        if (c < clearance) clearance = c;
        if (i === 0) { groundP = game.paint.get(hit.collider); groundPaint = groundP ? groundP.typeAt(hit.point, hit.normal) : Paint.None; }
      }
      d.clearance = clearance;
      const v = b.linvel();

      if (d.lift > 0) {
        if (!d.hovering) {
          d.hovering = true;
          b.setGravityScale(0, true);
          b.setLinearDamping(0.9);
          b.setAngularDamping(3);
          game.emit('float', p);
          if (p.tags.has('mass')) game.emit('mass:float');
        }
        let want: number;
        if (clearance === Infinity) {
          // nothing below within reach: hold altitude, so floaters can cross chasms
          if (d.holdY === null) d.holdY = t.y;
          want = Math.max(-2.6, Math.min(2.6, (d.holdY - t.y) * 2));
        } else {
          d.holdY = null;
          want = Math.max(-2.6, Math.min(2.6, (target - clearance) * 2));
        }
        want += Math.sin(time * 1.3 + d.phase) * 0.07;
        const k = Math.min(1, 5 * dt);
        b.setLinvel({ x: v.x, y: v.y + (want - v.y) * k, z: v.z }, true);
        // anti-gravity shimmer shedding from the underside
        if (Math.random() < 0.25 && Math.abs(t.x - game.player.pos.x) + Math.abs(t.z - game.player.pos.z) < 45) {
          const c = PAINTS[Paint.Purple].color;
          game.glow.spawn(t.x + (Math.random() * 2 - 1) * ex, t.y - ey, t.z + (Math.random() * 2 - 1) * ez, 0, -0.7, 0, c.r, c.g, c.b, 0.06, 1.1, 0.4, 0.2, 0.9);
        }
      } else {
        if (d.hovering) {
          d.hovering = false; d.holdY = null;
          b.setLinearDamping(0.05);
          b.setAngularDamping(0.3);
          b.wakeUp();
        }
        // anti-gravity field above purple-painted static ground
        const field = groundPaint === Paint.Purple && groundP && !groundP.dynamic && clearance < 7;
        b.setGravityScale(field ? 0.3 : 1, false);
        if (groundPaint === Paint.Yellow && clearance < 0.12 && v.y < -1.2) {
          const vy = Math.max(5, Math.min(17, -v.y * 0.92));
          b.setLinvel({ x: v.x, y: vy, z: v.z }, true);
          const pt = new THREE.Vector3(t.x, t.y - ey, t.z);
          game.glow.burst(pt, null, PAINTS[Paint.Yellow].color, 14, 4, 0.08, 0.5, 4, 2);
          if (pt.distanceTo(game.player.pos) < 25) game.audio.bounce(vy);
        }
      }

      const icy = d.cB > 0.1 || (groundPaint === Paint.Blue && clearance < 0.2);
      if (icy !== d.icy) {
        d.icy = icy;
        p.collider.setFriction(icy ? 0.03 : d.baseFriction);
        d.touch();
        b.wakeUp();
      }
    }
  }
}
