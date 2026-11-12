import * as THREE from 'three';

/** CPU-simulated point sprites. One draw call per system. */
export class Particles {
  points: THREE.Points;
  private n: number;
  private pos: Float32Array; private col: Float32Array; private size: Float32Array;
  private vel: Float32Array; private life: Float32Array; private maxLife: Float32Array;
  private grav: Float32Array; private drag: Float32Array; private baseSize: Float32Array;
  private cursor = 0;
  private alive = 0;

  constructor(capacity: number, additive: boolean) {
    this.n = capacity;
    this.pos = new Float32Array(capacity * 3); this.col = new Float32Array(capacity * 4); this.size = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3); this.life = new Float32Array(capacity); this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity); this.drag = new Float32Array(capacity); this.baseSize = new Float32Array(capacity);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */`
        attribute vec4 pcolor; attribute float psize; uniform float uScale; varying vec4 vC;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float d = -mv.z; vC = pcolor; vC.a *= smoothstep(0.25, 1.6, d); gl_PointSize = min(psize * uScale / max(d, 0.2), uScale * 0.05); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: additive
        ? 'varying vec4 vC; void main(){ float r = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, r); gl_FragColor = vec4(vC.rgb * a * vC.a, 1.0); }'
        : 'varying vec4 vC; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; float a = smoothstep(0.5, 0.35, r) * vC.a; gl_FragColor = vec4(vC.rgb * (1.0 - r * 0.6), a); }',
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false, transparent: true, fog: false,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number, gravity = 0, drag = 0, alpha = 1) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = alpha;
    this.baseSize[i] = size; this.size[i] = size;
    this.life[i] = life; this.maxLife[i] = life; this.grav[i] = gravity; this.drag[i] = drag;
  }

  /** Radial burst helper. */
  burst(p: THREE.Vector3, n: THREE.Vector3 | null, color: THREE.Color, count: number, speed: number, size: number, life: number, gravity = 6, boost = 1) {
    for (let k = 0; k < count; k++) {
      let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      if (n) { const d = dx * n.x + dy * n.y + dz * n.z; if (d < 0) { dx -= 2 * d * n.x; dy -= 2 * d * n.y; dz -= 2 * d * n.z; } dx += n.x * 0.6; dy += n.y * 0.6; dz += n.z * 0.6; }
      const s = speed * (0.3 + Math.random() * 0.9);
      this.spawn(p.x, p.y, p.z, dx * s, dy * s, dz * s, color.r * boost, color.g * boost, color.b * boost, size * (0.5 + Math.random()), life * (0.5 + Math.random() * 0.8), gravity, 1.5);
    }
  }

  update(dt: number, pixelScale: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = pixelScale;
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      alive++;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.size[i] = this.baseSize[i] * Math.min(1, t * 2.5);
    }
    if (alive || this.alive) {
      const g = this.points.geometry;
      g.attributes.position.needsUpdate = true; g.attributes.pcolor.needsUpdate = true; g.attributes.psize.needsUpdate = true;
    }
    this.alive = alive;
  }
}
