import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export { RAPIER };

export const GROUP_WORLD = 0x0001;
export const GROUP_PLAYER = 0x0002;
export const groups = (member: number, filter: number) => ((member << 16) | filter) >>> 0;
/** Collision groups of every world collider. */
export const WORLD_GROUPS = groups(GROUP_WORLD, 0xffff);
/** Query filter that only sees world colliders (never the player capsule). */
export const QUERY_WORLD = groups(0xffff, GROUP_WORLD);

export const WORLD_GRAVITY = 18;

export interface RayHit {
  collider: RAPIER.Collider;
  toi: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

const _hit: RayHit = { collider: null as any, toi: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };

export class Physics {
  world: RAPIER.World;
  /** Velocities of script-driven (kinematic) bodies, keyed by body handle. */
  kinVel = new Map<number, { lin: THREE.Vector3; ang: THREE.Vector3 }>();
  /** Conveyor-style surface velocities keyed by collider handle. */
  surfaceVel = new Map<number, THREE.Vector3>();
  /** Shared fixed body for non-paintable scenery colliders. */
  scenery: RAPIER.RigidBody;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -WORLD_GRAVITY, z: 0 });
    this.world.timestep = 1 / 60;
    this.scenery = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  }

  static async init() {
    await RAPIER.init();
  }

  /** Raycast against world geometry. The returned object is reused between calls. */
  castRay(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxToi: number,
    excludeBody?: RAPIER.RigidBody,
  ): RayHit | null {
    const r = this.ray;
    r.origin.x = ox; r.origin.y = oy; r.origin.z = oz;
    r.dir.x = dx; r.dir.y = dy; r.dir.z = dz;
    const h = this.world.castRayAndGetNormal(
      r, maxToi, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD, undefined, excludeBody,
    );
    if (!h) return null;
    _hit.collider = h.collider;
    _hit.toi = h.timeOfImpact;
    _hit.point.set(ox + dx * h.timeOfImpact, oy + dy * h.timeOfImpact, oz + dz * h.timeOfImpact);
    _hit.normal.set(h.normal.x, h.normal.y, h.normal.z);
    return _hit;
  }

  /** Cheap occlusion test (no normal). */
  occluded(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxToi: number): number {
    const r = this.ray;
    r.origin.x = ox; r.origin.y = oy; r.origin.z = oz;
    r.dir.x = dx; r.dir.y = dy; r.dir.z = dz;
    const h = this.world.castRay(r, maxToi, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD);
    return h ? h.timeOfImpact : -1;
  }

  /** Velocity of a point attached to `body` (handles scripted kinematic bodies). */
  pointVelocity(body: RAPIER.RigidBody, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (body.isFixed()) return out.set(0, 0, 0);
    let lx: number, ly: number, lz: number, ax: number, ay: number, az: number;
    const kv = this.kinVel.get(body.handle);
    if (kv) {
      lx = kv.lin.x; ly = kv.lin.y; lz = kv.lin.z; ax = kv.ang.x; ay = kv.ang.y; az = kv.ang.z;
    } else {
      const l = body.linvel(), a = body.angvel();
      lx = l.x; ly = l.y; lz = l.z; ax = a.x; ay = a.y; az = a.z;
    }
    const t = body.translation();
    const rx = p.x - t.x, ry = p.y - t.y, rz = p.z - t.z;
    return out.set(lx + ay * rz - az * ry, ly + az * rx - ax * rz, lz + ax * ry - ay * rx);
  }

  setKinVel(body: RAPIER.RigidBody, lx: number, ly: number, lz: number, ay = 0) {
    let kv = this.kinVel.get(body.handle);
    if (!kv) { kv = { lin: new THREE.Vector3(), ang: new THREE.Vector3() }; this.kinVel.set(body.handle, kv); }
    kv.lin.set(lx, ly, lz);
    kv.ang.set(0, ay, 0);
  }

  /** Static scenery collider (not paintable). */
  sceneryBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, q?: THREE.Quaternion) {
    const d = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setCollisionGroups(WORLD_GROUPS).setFriction(0.8);
    if (q) d.setRotation(q);
    return this.world.createCollider(d, this.scenery);
  }

  sceneryCylinder(cx: number, cy: number, cz: number, halfH: number, r: number, q?: THREE.Quaternion) {
    const d = RAPIER.ColliderDesc.cylinder(halfH, r).setTranslation(cx, cy, cz).setCollisionGroups(WORLD_GROUPS).setFriction(0.8);
    if (q) d.setRotation(q);
    return this.world.createCollider(d, this.scenery);
  }
}
