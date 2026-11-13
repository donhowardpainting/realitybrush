import * as THREE from 'three';
import type { Game } from '../game';
import { Paint, PAINTS } from '../paint/types';

export interface Checkpoint { id: string; pos: THREE.Vector3; yaw: number; ring: THREE.Mesh; beam: THREE.Mesh; active: boolean; title: string }
interface Trigger { id: string; min: THREE.Vector3; max: THREE.Vector3; fired: boolean; fn?: () => void }
interface Shard { i: number; pos: THREE.Vector3; mesh: THREE.Mesh; taken: boolean }
interface Pickup { paint: Paint; pos: THREE.Vector3; group: THREE.Group; taken: boolean; halo: THREE.Mesh }

/** Checkpoints, pigment pickups, trigger volumes and kill volumes. */
export class Zones {
  checkpoints: Checkpoint[] = [];
  triggers: Trigger[] = [];
  pickups: Pickup[] = [];
  kills: { min: THREE.Vector3; max: THREE.Vector3 }[] = [];
  shards: Shard[] = [];
  private shardMat = new THREE.MeshStandardMaterial({ color: 0x101418, emissive: 0x7fffe8, emissiveIntensity: 2.4, roughness: 0.2, metalness: 0.4 });
  killY = -3.2;
  current: Checkpoint | null = null;

  constructor(private game: Game) {}

  addCheckpoint(id: string, x: number, y: number, z: number, yaw: number, title: string): Checkpoint {
    const mat = new THREE.MeshStandardMaterial({ color: 0x111316, emissive: 0x9fb4c0, emissiveIntensity: 0.5, roughness: 0.4, metalness: 0.6 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.07, 8, 40), mat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y + 0.06, z);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.2, 5, 24, 1, true),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0x9fb4c0) }, uA: { value: 0.05 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying vec2 vUv; uniform vec3 uColor; uniform float uA; void main(){ gl_FragColor = vec4(uColor * pow(clamp(1.0 - vUv.y, 0.0, 1.0), 2.2) * uA, 1.0); }',
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, fog: false,
      }),
    );
    beam.position.set(x, y + 2.5, z);
    this.game.stage.scene.add(ring, beam);
    const cp: Checkpoint = { id, pos: new THREE.Vector3(x, y, z), yaw, ring, beam, active: false, title };
    this.checkpoints.push(cp);
    return cp;
  }

  addTrigger(id: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, fn?: () => void) {
    this.triggers.push({ id, min: new THREE.Vector3(x0, y0, z0), max: new THREE.Vector3(x1, y1, z1), fired: false, fn });
  }

  addKill(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    this.kills.push({ min: new THREE.Vector3(x0, y0, z0), max: new THREE.Vector3(x1, y1, z1) });
  }

  addPickup(paint: Paint, x: number, y: number, z: number) {
    const info = PAINTS[paint];
    const g = new THREE.Group();
    const glow = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: info.hex, emissiveIntensity: 3, roughness: 0.3 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.35, metalness: 0.9 });
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.5, 16), glow);
    const capA = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.09, 16), metal); capA.position.y = 0.29;
    const capB = capA.clone(); capB.position.y = -0.29;
    const ringA = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.018, 6, 32), glow);
    const ringB = ringA.clone(); ringB.rotation.x = Math.PI / 2;
    g.add(core, capA, capB, ringA, ringB);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 16, 12),
      new THREE.MeshBasicMaterial({ color: info.hex, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    g.add(halo);
    g.position.set(x, y + 1.25, z);
    this.game.stage.scene.add(g);
    this.pickups.push({ paint, pos: new THREE.Vector3(x, y + 1.25, z), group: g, taken: false, halo });
  }

  /** Optional collectible, usually parked somewhere that takes a little paint to reach. */
  addShard(x: number, y: number, z: number) {
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), this.shardMat);
    mesh.position.set(x, y, z);
    mesh.scale.set(1, 1.7, 1);
    this.game.stage.scene.add(mesh);
    this.shards.push({ i: this.shards.length, pos: new THREE.Vector3(x, y, z), mesh, taken: false });
  }

  hideShard(i: number) { const s = this.shards[i]; if (s) { s.taken = true; s.mesh.visible = false; } }

  activate(cp: Checkpoint, silent = false) {
    if (this.current === cp) return;
    if (this.current) {
      (this.current.ring.material as THREE.MeshStandardMaterial).emissive.setHex(0x9fb4c0);
      (this.current.ring.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5;
      (this.current.beam.material as THREE.ShaderMaterial).uniforms.uA.value = 0.05;
    }
    this.current = cp;
    cp.active = true;
    (cp.ring.material as THREE.MeshStandardMaterial).emissive.setHex(0x52ffe0);
    (cp.ring.material as THREE.MeshStandardMaterial).emissiveIntensity = 3;
    (cp.beam.material as THREE.ShaderMaterial).uniforms.uColor.value.setHex(0x52ffe0);
    (cp.beam.material as THREE.ShaderMaterial).uniforms.uA.value = 0.3;
    if (!silent) {
      this.game.audio.checkpoint();
      this.game.glow.burst(cp.pos.clone().setY(cp.pos.y + 0.3), new THREE.Vector3(0, 1, 0), new THREE.Color(0x52ffe0), 40, 5, 0.08, 1, -1, 1.5);
      this.game.hud.toast('CHECKPOINT — ' + cp.title, '#52ffe0');
      this.game.onCheckpoint(cp);
    }
  }

  update(dt: number) {
    const game = this.game, p = game.player.pos, t = game.time;
    const fy = game.player.feetY;
    for (const cp of this.checkpoints) {
      // the beam is a marker to walk toward: fade it out as you arrive so it never veils the view
      const d = Math.hypot(p.x - cp.pos.x, p.z - cp.pos.z);
      const near = Math.min(1, Math.max(0, (d - 2.5) / 4));
      (cp.beam.material as THREE.ShaderMaterial).uniforms.uA.value = (cp === this.current ? 0.3 : 0.05) * near;
      cp.beam.visible = near > 0.01 && d < 90;
      if (cp !== this.current && Math.hypot(p.x - cp.pos.x, p.z - cp.pos.z) < 2.2 && Math.abs(fy - cp.pos.y) < 2.2) this.activate(cp);
    }
    for (const tr of this.triggers) {
      if (tr.fired) continue;
      if (p.x > tr.min.x && p.x < tr.max.x && p.y > tr.min.y && p.y < tr.max.y && p.z > tr.min.z && p.z < tr.max.z) {
        tr.fired = true;
        game.emit('zone:' + tr.id);
        tr.fn?.();
      }
    }
    for (const pk of this.pickups) {
      if (pk.taken) continue;
      pk.group.rotation.y = t * 1.2;
      pk.group.position.y = pk.pos.y + Math.sin(t * 2) * 0.12;
      pk.halo.scale.setScalar(1 + Math.sin(t * 3) * 0.12);
      if (Math.random() < 0.25) {
        const c = PAINTS[pk.paint].color;
        game.glow.spawn(pk.pos.x + (Math.random() - 0.5) * 0.8, pk.pos.y - 0.4, pk.pos.z + (Math.random() - 0.5) * 0.8, 0, 0.9, 0, c.r, c.g, c.b, 0.06, 1.2, -0.3, 0.5, 0.9);
      }
      if (Math.hypot(p.x - pk.pos.x, p.z - pk.pos.z) < 2.7 && Math.abs(p.y - pk.pos.y) < 2.2) {
        this.hide(pk);
        game.unlock(pk.paint);
      }
    }
    for (const sh of this.shards) {
      if (sh.taken) continue;
      sh.mesh.rotation.y = t * 1.6 + sh.i;
      sh.mesh.position.y = sh.pos.y + Math.sin(t * 2.2 + sh.i) * 0.1;
      if (Math.random() < 0.12) game.glow.spawn(sh.pos.x + (Math.random() - 0.5) * 0.5, sh.pos.y, sh.pos.z + (Math.random() - 0.5) * 0.5, 0, 0.6, 0, 0.5, 1, 0.9, 0.05, 1, -0.2, 0.5, 0.9);
      if (Math.abs(p.x - sh.pos.x) < 1.3 && Math.abs(p.z - sh.pos.z) < 1.3 && Math.abs(p.y - 0.2 - sh.pos.y) < 1.6) {
        this.hideShard(sh.i);
        game.collectShard(sh.i);
      }
    }
    if (p.y < this.killY) { game.respawn(); return; }
    for (const k of this.kills) {
      if (p.x > k.min.x && p.x < k.max.x && p.y > k.min.y && p.y < k.max.y && p.z > k.min.z && p.z < k.max.z) { game.respawn(); return; }
    }
    void dt;
  }

  removePickup(paint: Paint) {
    for (const pk of this.pickups) if (pk.paint === paint && !pk.taken) this.hide(pk);
  }

  /** Hide without removing the light (changing light counts would recompile every shader). */
  private hide(pk: Pickup) {
    pk.taken = true;
    pk.group.traverse((o) => { if ((o as THREE.PointLight).isLight) (o as THREE.PointLight).intensity = 0; else if (o !== pk.group) o.visible = false; });
  }
}
