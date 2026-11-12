import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { timeUniform } from '../paint/paintable';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 0.0); gl_Position = projectionMatrix * vec4(p.xyz, 1.0); gl_Position.z = gl_Position.w; }`;
const SKY_FRAG = /* glsl */`
varying vec3 vDir;
uniform float uTime; uniform float uRestore; uniform vec3 uSun; uniform float uPulse;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for(int i=0;i<5;i++){ s += a*vn(p); p = p*2.03 + 11.7; a *= 0.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.2, 1.0);
  vec3 zenA = vec3(0.07, 0.10, 0.13), horA = vec3(0.34, 0.38, 0.36);
  vec3 zenB = vec3(0.07, 0.17, 0.42), horB = vec3(1.0, 0.56, 0.34);
  vec3 zen = mix(zenA, zenB, uRestore), hor = mix(horA, horB, uRestore);
  vec3 col = mix(hor, zen, pow(max(h, 0.0), 0.5));
  float sd = max(dot(d, normalize(uSun)), 0.0);
  vec3 sunC = mix(vec3(0.75, 0.82, 0.8), vec3(1.0, 0.72, 0.42), uRestore);
  col += sunC * (pow(sd, 6.0) * 0.25 + pow(sd, 48.0) * 0.6 + pow(sd, 900.0) * 6.0) * mix(0.55, 1.2, uRestore);
  // clouds
  vec2 cp = d.xz / (d.y + 0.25) * 1.4 + vec2(uTime * 0.008, uTime * 0.003);
  float c = fbm(cp); float c2 = fbm(cp * 2.3 - uTime * 0.01);
  float cover = mix(0.38, 0.52, uRestore);
  float cl = smoothstep(cover, cover + 0.3, c * 0.7 + c2 * 0.3) * smoothstep(-0.02, 0.25, d.y);
  vec3 cloudC = mix(vec3(0.2, 0.23, 0.24), vec3(1.0, 0.7, 0.55), uRestore) * (0.6 + 0.6 * pow(sd, 3.0)) + vec3(0.25, 0.2, 0.3) * uRestore * c2;
  col = mix(col, cloudC, cl * mix(0.85, 0.6, uRestore));
  // aurora ribbons once reality is being rewritten
  float au = smoothstep(0.15, 0.9, d.y) * uRestore;
  float band = sin(d.x * 9.0 + fbm(d.xz * 3.0 + uTime * 0.05) * 6.0 + uTime * 0.2) * 0.5 + 0.5;
  vec3 auC = mix(vec3(0.3, 1.0, 0.6), vec3(0.7, 0.3, 1.0), fbm(d.xz * 2.0 - uTime * 0.03));
  col += auC * pow(band, 6.0) * au * 0.35 * (1.0 - cl);
  col += vec3(0.65, 0.4, 1.0) * uPulse * (0.3 + 0.7 * pow(1.0 - abs(d.y), 3.0));
  col = mix(col, hor * 0.8, smoothstep(0.0, -0.15, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

const GRADE_FRAG = /* glsl */`
uniform sampler2D tDiffuse; uniform float uTime; uniform float uRestore; uniform float uFade; uniform float uFlash; uniform vec3 uFlashColor; uniform float uSpeed; uniform float uBars;
varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUv; vec2 c = uv - 0.5; float r2 = dot(c, c);
  float ca = 0.0016 + uSpeed * 0.004;
  vec3 col = vec3(texture2D(tDiffuse, uv + c * ca * (0.5 + r2 * 4.0)).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - c * ca * (0.5 + r2 * 4.0)).b);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // the world starts drained; vividly saturated colours (the paint) survive the drain
  float chroma = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
  float keep = smoothstep(0.25, 0.6, chroma);
  float satur = mix(mix(0.42, 1.05, keep), 1.14, uRestore);
  col = mix(vec3(l), col, satur);
  // split tone: cool shadows, warm highlights
  vec3 shadowTint = mix(vec3(0.92, 1.0, 1.06), vec3(0.94, 0.98, 1.1), uRestore);
  vec3 hiTint = mix(vec3(1.02, 1.0, 0.95), vec3(1.08, 1.0, 0.9), uRestore);
  col *= mix(shadowTint, hiTint, smoothstep(0.1, 0.8, l));
  col = (col - 0.5) * mix(1.06, 1.1, uRestore) + 0.5;
  col *= 1.0 - smoothstep(0.18, 0.75, r2) * 0.55;
  col += (h(uv * 800.0 + fract(uTime) * 91.0) - 0.5) * 0.028;
  col += uFlashColor * uFlash;
  col *= 1.0 - uFade;
  float bar = step(uv.y, uBars * 0.11) + step(1.0 - uBars * 0.11, uv.y);
  col *= 1.0 - min(bar, 1.0);
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

const SHAFT_FRAG = /* glsl */`
varying vec2 vUv; varying vec3 vW; uniform float uTime; uniform vec3 uColor; uniform float uStrength;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
void main(){
  float edge = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x);
  float fall = smoothstep(0.0, 0.12, vUv.y) * pow(vUv.y, 0.7);
  float n = vn(vec2(vUv.x * 5.0 + vW.x * 0.3, vUv.y * 1.5 - uTime * 0.04)) * 0.6 + 0.4;
  gl_FragColor = vec4(uColor * edge * fall * n * uStrength, 1.0);
}`;

export type Quality = 'high' | 'low';

export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sunDir = new THREE.Vector3(-0.45, 0.62, 0.64).normalize();
  private sky: THREE.Mesh;
  private skyU: Record<string, { value: any }>;
  private dust: THREE.Points;
  private shaftMat: THREE.ShaderMaterial[] = [];
  skylineMat: THREE.MeshStandardMaterial | null = null;
  restore = 0;
  restoreTarget = 0;
  fade = 1;
  fadeTarget = 0;
  flash = 0;
  flashColor = new THREE.Color(1, 1, 1);
  bars = 0;
  barsTarget = 0;
  speedFx = 0;
  skyPulse = 0;
  /** 0 outdoors, 1 deep inside a building: thins and darkens the fog. */
  indoor = 0;
  indoorTarget = 0;
  quality: Quality;
  private fog: THREE.FogExp2;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'low', powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.camera = new THREE.PerspectiveCamera(78, 1, 0.04, 900);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.fog = new THREE.FogExp2(0x59625f, 0.0105);
    this.scene.fog = this.fog;

    this.hemi = new THREE.HemisphereLight(0xa9c2cc, 0x4a4238, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xd9e2e0, 1.6);
    this.sun.castShadow = true;
    const sz = quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sz, sz);
    const sc = this.sun.shadow.camera;
    sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46; sc.near = 1; sc.far = 220;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.06;
    this.scene.add(this.sun, this.sun.target);

    this.skyU = { uTime: timeUniform, uRestore: { value: 0 }, uSun: { value: this.sunDir }, uPulse: { value: 0 } };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: this.skyU, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    // image-based lighting from the sky itself
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envSky = this.sky.clone();
    (envSky.material as THREE.ShaderMaterial) = (this.sky.material as THREE.ShaderMaterial).clone();
    (envSky.material as THREE.ShaderMaterial).uniforms.uRestore = { value: 0.55 };
    envSky.scale.setScalar(50);
    envScene.add(envSky);
    this.scene.environment = pm.fromScene(envScene, 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pm.dispose();

    this.dust = this.makeDust();
    this.scene.add(this.dust);
    this.setQuality(quality);
  }

  setQuality(q: Quality) {
    this.quality = q;
    const pr = Math.min(window.devicePixelRatio || 1, q === 'high' ? 1.5 : 1);
    this.renderer.setPixelRatio(pr);
    if (q === 'high') {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.4, 0.6, 0.9);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      this.grade = new ShaderPass({
        uniforms: {
          tDiffuse: { value: null }, uTime: timeUniform, uRestore: { value: 0 }, uFade: { value: 0 }, uFlash: { value: 0 },
          uFlashColor: { value: this.flashColor }, uSpeed: { value: 0 }, uBars: { value: 0 },
        },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: GRADE_FRAG,
      });
      this.composer.addPass(this.grade);
    } else {
      this.composer = null; this.bloom = null; this.grade = null;
    }
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
  }

  private makeDust(): THREE.Points {
    const n = 1400, box = 34;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) { pos[i * 3] = Math.random() * box; pos[i * 3 + 1] = Math.random() * box; pos[i * 3 + 2] = Math.random() * box; seed[i] = Math.random(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: timeUniform, uCam: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color(0xfff0d0) }, uScale: { value: 1 } },
      vertexShader: /* glsl */`
        attribute float seed; uniform float uTime; uniform vec3 uCam; uniform float uScale; varying float vA;
        void main(){
          vec3 p = position + vec3(sin(uTime * 0.11 + seed * 40.0) * 0.8 + uTime * 0.12, uTime * (0.05 + seed * 0.1), cos(uTime * 0.09 + seed * 30.0) * 0.8);
          p = mod(p - uCam, ${box.toFixed(1)}) - ${(box / 2).toFixed(1)} + uCam;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vA = smoothstep(${(box / 2).toFixed(1)}, 6.0, d) * smoothstep(0.3, 1.5, d) * (0.35 + 0.65 * sin(uTime * (0.6 + seed) + seed * 50.0) * 0.5 + 0.3);
          gl_PointSize = uScale * (1.5 + seed * 2.5) * 14.0 / max(d, 0.5);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying float vA;
        void main(){ float r = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, r); gl_FragColor = vec4(uColor * a * vA * 0.5, 1.0); }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    return pts;
  }

  /** Volumetric-looking light shaft: crossed additive quads hanging down from `top`. */
  addShaft(top: THREE.Vector3, dir: THREE.Vector3, length: number, width: number, color = 0xffe2b0, strength = 0.22) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: timeUniform, uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
      vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: SHAFT_FRAG,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, fog: false,
    });
    mat.userData.base = strength;
    this.shaftMat.push(mat);
    const g = new THREE.PlaneGeometry(width, length);
    g.translate(0, -length / 2, 0);
    const grp = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(g, mat);
      m.rotation.y = (i * Math.PI) / 3;
      grp.add(m);
    }
    grp.position.copy(top);
    grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
    this.scene.add(grp);
    return grp;
  }

  pulse(color: number, amount = 0.35) {
    this.flashColor.setHex(color);
    this.flash = Math.max(this.flash, amount);
  }

  update(dt: number, camPos: THREE.Vector3) {
    this.restore += (this.restoreTarget - this.restore) * (1 - Math.exp(-dt * 0.9));
    this.fade += Math.sign(this.fadeTarget - this.fade) * Math.min(Math.abs(this.fadeTarget - this.fade), dt * 2.2);
    this.flash *= Math.exp(-dt * 3.2);
    this.bars += (this.barsTarget - this.bars) * (1 - Math.exp(-dt * 4));
    this.skyPulse *= Math.exp(-dt * 0.8);
    const r = this.restore;
    this.skyU.uRestore.value = r;
    this.skyU.uPulse.value = this.skyPulse;
    this.sky.position.copy(camPos);
    this.sky.scale.setScalar(800);
    (this.dust.material as THREE.ShaderMaterial).uniforms.uCam.value.copy(camPos);
    (this.dust.material as THREE.ShaderMaterial).uniforms.uScale.value = this.renderer.getPixelRatio() * (window.innerHeight / 900);
    (this.dust.material as THREE.ShaderMaterial).uniforms.uColor.value.setRGB(1, 0.92 - r * 0.1, 0.78 - r * 0.25);
    this.indoor += (this.indoorTarget - this.indoor) * (1 - Math.exp(-dt * 1.6));
    const fk = 1 - this.indoor * 0.72;
    this.fog.color.setRGB((0.3 + r * 0.42) * fk, (0.34 + r * 0.14) * fk, (0.33 + r * 0.02) * fk);
    this.fog.density = (0.0115 - r * 0.0045) * (1 - this.indoor * 0.45);
    this.sun.color.setRGB(0.85 + r * 0.15, 0.89 - r * 0.1, 0.88 - r * 0.33);
    this.sun.intensity = 1.5 + r * 2.0;
    this.hemi.intensity = 0.75 + r * 0.45;
    this.hemi.color.setRGB(0.62 + r * 0.1, 0.74 - r * 0.04, 0.8 + r * 0.1);
    this.hemi.groundColor.setRGB(0.28 + r * 0.2, 0.25 + r * 0.08, 0.21);
    this.scene.environmentIntensity = 0.3 + r * 0.35;
    for (const m of this.shaftMat) m.uniforms.uStrength.value = m.userData.base * (0.75 + r * 0.9);
    if (this.skylineMat) this.skylineMat.emissiveIntensity = 0.15 + r * 2.2;
    // keep the shadow frustum around the player, snapped to texels to avoid shimmer
    const t = this.sun.target.position;
    const snap = 92 / this.sun.shadow.mapSize.x * 4;
    t.set(Math.round(camPos.x / snap) * snap, Math.round(camPos.y / snap) * snap, Math.round(camPos.z / snap) * snap);
    this.sun.position.copy(t).addScaledVector(this.sunDir, 110);
    if (this.grade) {
      const u = this.grade.uniforms;
      u.uRestore.value = r; u.uFade.value = this.fade; u.uFlash.value = this.flash; u.uSpeed.value = this.speedFx; u.uBars.value = this.bars;
    }
    if (this.bloom) this.bloom.strength = 0.38 + r * 0.2;
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
