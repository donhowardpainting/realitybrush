import * as THREE from 'three';
import { injectWorldShader } from '../paint/paintable';

/* ---------- tileable noise ---------- */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
function pnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const m = (v: number) => ((v % period) + period) % period;
  const a = hash2(m(xi), m(yi), seed), b = hash2(m(xi + 1), m(yi), seed);
  const c = hash2(m(xi), m(yi + 1), seed), d = hash2(m(xi + 1), m(yi + 1), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** Tileable fbm, u,v in 0..1 */
function fbm(u: number, v: number, freq: number, oct: number, seed: number): number {
  let s = 0, amp = 0.5, f = freq, n = 0;
  for (let i = 0; i < oct; i++) { s += amp * pnoise(u * f, v * f, f, seed + i * 17); n += amp; amp *= 0.5; f *= 2; }
  return s / n;
}

interface Texel { r: number; g: number; b: number; h: number; rough: number; metal?: number; e?: number }
type TexFn = (u: number, v: number) => Texel;

interface TexSet { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture; emissiveMap?: THREE.Texture }

function build(size: number, fn: TexFn, normalStrength = 2.5, withEmissive = false): TexSet {
  const col = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const emi = withEmissive ? new Uint8ClampedArray(size * size * 4) : null;
  const hgt = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const t = fn((x + 0.5) / size, (y + 0.5) / size);
    const i = (y * size + x) * 4;
    col[i] = t.r * 255; col[i + 1] = t.g * 255; col[i + 2] = t.b * 255; col[i + 3] = 255;
    orm[i] = 255; orm[i + 1] = t.rough * 255; orm[i + 2] = (t.metal ?? 0) * 255; orm[i + 3] = 255;
    if (emi) { const e = (t.e ?? 0) * 255; emi[i] = e; emi[i + 1] = e; emi[i + 2] = e; emi[i + 3] = 255; }
    hgt[y * size + x] = t.h;
  }
  const nrm = new Uint8ClampedArray(size * size * 4);
  const H = (x: number, y: number) => hgt[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * normalStrength;
    const dy = (H(x, y + 1) - H(x, y - 1)) * normalStrength;
    const l = Math.hypot(dx, dy, 1);
    const i = (y * size + x) * 4;
    nrm[i] = (-dx / l * 0.5 + 0.5) * 255; nrm[i + 1] = (-dy / l * 0.5 + 0.5) * 255; nrm[i + 2] = (1 / l * 0.5 + 0.5) * 255; nrm[i + 3] = 255;
  }
  const mk = (data: Uint8ClampedArray, srgb: boolean) => {
    const t = new THREE.DataTexture(new Uint8Array(data.buffer), size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(col, true), normalMap: mk(nrm, false), roughnessMap: mk(orm, false), emissiveMap: emi ? mk(emi, true) : undefined };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sat = (x: number) => Math.max(0, Math.min(1, x));
const sstep = (a: number, b: number, x: number) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** distance to nearest grid line, cells per tile */
const gridLine = (u: number, cells: number) => { const f = (u * cells) % 1; return Math.min(f, 1 - f) / cells; };

export type MatName =
  | 'concrete' | 'pavers' | 'rust' | 'panel' | 'brick' | 'steel' | 'moss' | 'soil' | 'belt' | 'hazard'
  | 'lab' | 'alloy' | 'crate' | 'core' | 'mass' | 'dark' | 'glass' | 'bark' | 'cap' | 'copper';

export class Materials {
  m = {} as Record<MatName, THREE.MeshStandardMaterial>;
  /** Shared (non-paintable) world materials need the baked-light shader too. */
  constructor() {
    const S = 256;
    const mk = (name: MatName, tex: TexSet | null, p: THREE.MeshStandardMaterialParameters, world = true) => {
      const mat = new THREE.MeshStandardMaterial({
        ...(tex ? { map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap, metalnessMap: tex.roughnessMap } : {}),
        vertexColors: true,
        ...p,
      });
      if (tex?.emissiveMap) mat.emissiveMap = tex.emissiveMap;
      mat.name = name;
      if (world) injectWorldShader(mat);
      this.m[name] = mat;
    };

    mk('concrete', build(S, (u, v) => {
      const n = fbm(u, v, 4, 5, 1), fine = fbm(u, v, 32, 3, 2);
      const streak = fbm(u * 6, v * 0.6, 4, 3, 3);
      const seam = Math.min(gridLine(v, 2), gridLine(u, 1));
      const sm = sstep(0.004, 0.012, seam);
      const pit = sstep(0.72, 0.8, fbm(u, v, 40, 2, 9));
      let c = 0.46 + (n - 0.5) * 0.28 + (fine - 0.5) * 0.12 - sstep(0.55, 0.8, streak) * 0.12;
      c *= lerp(0.6, 1, sm) * (1 - pit * 0.25);
      return { r: c * 1.0, g: c * 1.0, b: c * 0.96, h: (n * 0.4 + fine * 0.3) * sm - pit * 0.4, rough: 0.82 + fine * 0.15 };
    }), { metalness: 0 });

    mk('pavers', build(S, (u, v) => {
      const cells = 4;
      const row = Math.floor(v * cells);
      const uo = u + (row % 2) * 0.125;
      const g = Math.min(gridLine(uo, cells), gridLine(v, cells));
      const gap = 1 - sstep(0.004, 0.014, g);
      const id = hash2(Math.floor(uo * cells) % cells, row, 5);
      const n = fbm(u, v, 8, 4, 11), fine = fbm(u, v, 48, 2, 12);
      let c = 0.4 + (id - 0.5) * 0.12 + (n - 0.5) * 0.2 + (fine - 0.5) * 0.1;
      const mossy = sstep(0.5, 0.75, fbm(u, v, 6, 4, 13)) * 0.8;
      const moss = gap * 0.9 + sstep(0.012, 0.03, 0.03 - g + 0.012) * mossy * 0.6;
      const r = lerp(c * 1.02, 0.16, moss), gg = lerp(c, 0.23, moss), b = lerp(c * 0.95, 0.12, moss);
      return { r, g: gg, b, h: (1 - gap) * (0.6 + n * 0.3), rough: 0.88 };
    }), { metalness: 0 });

    mk('rust', build(S, (u, v) => {
      const n = fbm(u, v, 5, 5, 21), fine = fbm(u, v, 40, 3, 22);
      const rust = sstep(0.42, 0.62, n + (fine - 0.5) * 0.3);
      const seam = Math.min(gridLine(u, 2), gridLine(v, 2));
      const sm = sstep(0.003, 0.01, seam);
      const rv = Math.hypot(((u * 8) % 1) - 0.5, ((v * 8) % 1) - 0.5);
      const rivet = (seam < 0.07 && seam > 0.02) ? 1 - sstep(0.1, 0.16, rv) : 0;
      const steel = 0.27 + fine * 0.08;
      const r = lerp(steel, 0.42 + fine * 0.14, rust), g = lerp(steel * 1.02, 0.22 + fine * 0.07, rust), b = lerp(steel * 1.08, 0.13, rust);
      const k = lerp(0.5, 1, sm) + rivet * 0.15;
      return { r: r * k, g: g * k, b: b * k, h: sm * 0.5 + rivet * 0.6 + rust * fine * 0.25, rough: lerp(0.45, 0.92, rust), metal: lerp(0.85, 0.15, rust) };
    }), { metalness: 1 });

    mk('panel', build(S, (u, v) => {
      const n = fbm(u, v, 6, 5, 31), fine = fbm(u, v, 48, 2, 32);
      const chip = sstep(0.6, 0.66, n + (fine - 0.5) * 0.25);
      const seam = Math.min(gridLine(u, 2), gridLine(v, 1));
      const sm = sstep(0.003, 0.012, seam);
      const drip = sstep(0.6, 0.9, fbm(u * 8, v * 0.5, 4, 3, 33)) * 0.14;
      const pr = 0.2 - drip, pg = 0.36 - drip, pb = 0.37 - drip;
      const r = lerp(pr, 0.36 + fine * 0.1, chip), g = lerp(pg, 0.2, chip), b = lerp(pb, 0.12, chip);
      const k = lerp(0.45, 1, sm);
      return { r: r * k, g: g * k, b: b * k, h: sm * 0.6 - chip * 0.15 + fine * 0.05, rough: lerp(0.5, 0.9, chip), metal: lerp(0.35, 0.2, chip) };
    }), { metalness: 1 });

    mk('brick', build(S, (u, v) => {
      const rows = 8, cols = 4;
      const row = Math.floor(v * rows);
      const uo = u + (row % 2) * (0.5 / cols);
      const g = Math.min(gridLine(uo, cols) * cols / rows * 2, gridLine(v, rows));
      const mortar = 1 - sstep(0.004, 0.012, g);
      const id = hash2(Math.floor(uo * cols) % cols, row, 41);
      const n = fbm(u, v, 24, 3, 42);
      const soot = sstep(0.45, 0.8, fbm(u, v, 3, 4, 43)) * 0.25;
      const br = 0.42 + (id - 0.5) * 0.16 + (n - 0.5) * 0.1 - soot, bg = 0.25 + (id - 0.5) * 0.08 + (n - 0.5) * 0.08 - soot * 0.8, bb = 0.2 + (n - 0.5) * 0.06 - soot * 0.6;
      return { r: lerp(br, 0.42, mortar), g: lerp(bg, 0.41, mortar), b: lerp(bb, 0.38, mortar), h: (1 - mortar) * (0.7 + n * 0.3), rough: 0.9 };
    }, 3), { metalness: 0 });

    mk('steel', build(S, (u, v) => {
      const brush = fbm(u * 0.5, v * 24, 4, 3, 51), n = fbm(u, v, 6, 4, 52);
      const c = 0.2 + brush * 0.08 + (n - 0.5) * 0.08;
      const seam = sstep(0.004, 0.012, Math.min(gridLine(u, 1), gridLine(v, 2)));
      return { r: c * seam, g: c * 1.03 * seam, b: c * 1.1 * seam, h: brush * 0.2 + seam * 0.4, rough: 0.42 + n * 0.2, metal: 0.9 };
    }), { metalness: 1 });

    mk('dark', build(64, (u, v) => {
      const n = fbm(u, v, 8, 3, 55);
      const c = 0.07 + n * 0.04;
      return { r: c, g: c, b: c * 1.1, h: n * 0.2, rough: 0.6, metal: 0.6 };
    }), { metalness: 1 });

    mk('copper', build(64, (u, v) => {
      const n = fbm(u, v, 6, 4, 57);
      const pat = sstep(0.5, 0.7, n);
      return { r: lerp(0.55, 0.25, pat), g: lerp(0.3, 0.42, pat), b: lerp(0.18, 0.36, pat), h: n * 0.3, rough: lerp(0.35, 0.8, pat), metal: lerp(1, 0.3, pat) };
    }), { metalness: 1 });

    // Fertile surfaces: unmistakable living texture so players can read "this will grow".
    const mossFn = (soilBias: number): TexFn => (u, v) => {
      const n = fbm(u, v, 5, 5, 61), fine = fbm(u, v, 40, 3, 62);
      const m = sstep(0.38 + soilBias, 0.6 + soilBias, n + (fine - 0.5) * 0.4);
      const spore = sstep(0.83, 0.88, fbm(u, v, 28, 2, 63));
      const r = lerp(0.17 + fine * 0.08, 0.2 + fine * 0.1, m), g = lerp(0.12 + fine * 0.05, 0.36 + fine * 0.2, m), b = lerp(0.08, 0.13, m);
      return { r: r + spore * 0.3, g: g + spore * 0.5, b: b + spore * 0.2, h: m * 0.5 + fine * 0.5, rough: 0.95, e: spore };
    };
    mk('moss', build(S, mossFn(0), 3.5, true), { metalness: 0, emissive: 0x7dffa0, emissiveIntensity: 0.9 });
    mk('soil', build(S, mossFn(0.12), 3.5, true), { metalness: 0, emissive: 0x7dffa0, emissiveIntensity: 0.9 });

    mk('belt', build(128, (u, v) => {
      const vv = (v * 4) % 1;
      const chev = Math.abs(((vv + Math.abs(u - 0.5) * 0.8) % 1) - 0.5);
      const line = 1 - sstep(0.03, 0.08, chev);
      const n = fbm(u, v, 24, 2, 71);
      const edge = sstep(0.06, 0.08, Math.min(u, 1 - u));
      const c = 0.07 + n * 0.04 + line * 0.07;
      return { r: lerp(0.35, c, edge), g: lerp(0.3, c, edge), b: lerp(0.1, c * 1.1, edge), h: line * 0.5 + n * 0.2, rough: 0.8, e: line * edge * 0.6 };
    }, 2.5, true), { metalness: 0, emissive: 0x000000, emissiveIntensity: 1 });

    mk('hazard', build(128, (u, v) => {
      const s = ((u + v) * 4) % 1 < 0.5 ? 1 : 0;
      const n = fbm(u, v, 16, 3, 81);
      const wear = sstep(0.55, 0.75, n);
      const r = lerp(lerp(0.08, 0.75, s), 0.3, wear), g = lerp(lerp(0.08, 0.58, s), 0.24, wear), b = lerp(0.08, 0.2, wear);
      return { r, g, b, h: n * 0.2, rough: 0.7, metal: 0.3 };
    }), { metalness: 1 });

    mk('lab', build(S, (u, v) => {
      const seam = Math.min(gridLine(u, 2), gridLine(v, 2));
      const sm = sstep(0.003, 0.01, seam);
      const n = fbm(u, v, 5, 4, 91), fine = fbm(u, v, 40, 2, 92);
      const grime = sstep(0.5, 0.85, fbm(u * 4, v * 0.7, 4, 4, 93)) * 0.2 + sstep(0.6, 0.8, n) * 0.1;
      const c = (0.62 - grime + fine * 0.05) * lerp(0.5, 1, sm);
      return { r: c * 0.97, g: c, b: c * 1.02, h: sm * 0.5, rough: 0.35 + grime + fine * 0.1, metal: 0.1 };
    }), { metalness: 1 });

    mk('alloy', build(S, (u, v) => {
      const seam = Math.min(gridLine(u, 2), gridLine(v, 4));
      const sm = sstep(0.004, 0.012, seam);
      const n = fbm(u, v, 5, 4, 101), fine = fbm(u, v, 36, 2, 102);
      const plate = hash2(Math.floor(u * 2), Math.floor(v * 4), 104);
      const node = (1 - sstep(0.02, 0.035, Math.hypot(((u * 2) % 1) - 0.5, ((v * 4) % 1) - 0.5) * 0.5)) * (plate > 0.72 ? 1 : 0);
      const c = (0.15 + n * 0.07 + fine * 0.03 + (plate - 0.5) * 0.05) * lerp(0.45, 1, sm);
      return { r: c * 0.93, g: c * 0.96, b: c * 1.22, h: sm * 0.6 + fine * 0.08, rough: 0.4 + n * 0.22, metal: 0.8, e: node };
    }, 2.5, true), { metalness: 1, emissive: 0x8a6cff, emissiveIntensity: 1.2 });

    mk('crate', build(S, (u, v) => {
      const edge = Math.min(u, 1 - u, v, 1 - v);
      const frame = 1 - sstep(0.085, 0.095, edge);
      const diag = Math.abs(u - v) < 0.045 || Math.abs(u + v - 1) < 0.045 ? 1 : 0;
      const n = fbm(u, v, 6, 4, 111), fine = fbm(u, v, 40, 2, 112);
      const wear = sstep(0.55, 0.7, n + (fine - 0.5) * 0.3);
      const raised = Math.max(frame, diag * (1 - frame));
      const baseR = lerp(0.55, 0.3, wear), baseG = lerp(0.47, 0.22, wear), baseB = lerp(0.3, 0.16, wear);
      const k = raised ? 0.5 + fine * 0.1 : 1;
      return { r: baseR * k, g: baseG * k, b: baseB * k * (raised ? 1.3 : 1), h: raised * 0.8 + fine * 0.1, rough: lerp(0.5, 0.85, wear), metal: raised ? 0.8 : 0.3 };
    }), { metalness: 1 });

    mk('core', build(S, (u, v) => {
      const cu = Math.abs(u - 0.5), cv = Math.abs(v - 0.5);
      const ring = Math.abs(Math.max(cu, cv) - 0.3);
      const glow = 1 - sstep(0.015, 0.045, ring);
      const cross = (cu < 0.03 || cv < 0.03) && Math.max(cu, cv) < 0.3 ? 1 : 0;
      const edge = 1 - sstep(0.05, 0.07, Math.min(u, 1 - u, v, 1 - v));
      const n = fbm(u, v, 20, 3, 121);
      const c = 0.14 + n * 0.06 + edge * 0.12;
      const e = Math.max(glow, cross * 0.7);
      return { r: c + e * 0.3, g: c + e * 0.2, b: c * 1.15, h: edge * 0.8 - e * 0.4, rough: 0.35, metal: 0.9, e };
    }, 2.5, true), { metalness: 1, emissive: 0xffa040, emissiveIntensity: 2.2 });

    mk('mass', build(S, (u, v) => {
      const seam = Math.min(gridLine(u, 3), gridLine(v, 3));
      const sm = sstep(0.004, 0.014, seam);
      const n = fbm(u, v, 5, 4, 131), fine = fbm(u, v, 40, 2, 132);
      const band = Math.abs(v - 0.5) < 0.06 ? 1 : 0;
      const stripe = ((u * 12 + v * 12) % 1) < 0.5 ? 1 : 0;
      let r = 0.3 + n * 0.1 + fine * 0.05, g = 0.31 + n * 0.1 + fine * 0.05, b = 0.34 + n * 0.1;
      if (band) { r = stripe ? 0.72 : 0.09; g = stripe ? 0.55 : 0.09; b = 0.1; }
      const k = lerp(0.4, 1, sm);
      return { r: r * k, g: g * k, b: b * k, h: sm * 0.7 + fine * 0.1, rough: 0.5 + n * 0.3, metal: 0.75, e: (1 - sm) * 0.5 };
    }, 2.5, true), { metalness: 1, emissive: 0xa544ff, emissiveIntensity: 0.9 });

    mk('bark', build(64, (u, v) => {
      const n = fbm(u * 6, v * 0.8, 4, 4, 141);
      const c = 0.13 + n * 0.12;
      return { r: c * 1.1, g: c, b: c * 0.85, h: n, rough: 0.95 };
    }, 4), { metalness: 0 });

    mk('cap', build(128, (u, v) => {
      const n = fbm(u, v, 6, 4, 151);
      const d = Math.hypot(u - 0.5, v - 0.5);
      const vein = 1 - sstep(0.0, 0.05, Math.abs(((Math.atan2(v - 0.5, u - 0.5) / 6.2832 + 1) * 10) % 1 - 0.5) * (0.4 + d));
      return { r: 0.1 + n * 0.08 + vein * 0.1, g: 0.42 + n * 0.2 + vein * 0.2, b: 0.16 + n * 0.06, h: n * 0.4 + vein * 0.4, rough: 0.7, e: vein * 0.5 };
    }, 2.5, true), { metalness: 0, emissive: 0x58ff7a, emissiveIntensity: 0.5 });

    this.m.glass = new THREE.MeshStandardMaterial({
      color: 0x8fb4c0, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  /** Emissive, unlit colour (lamps, strips, signs). */
  glow(hex: number, intensity = 2): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color: 0x050505, emissive: hex, emissiveIntensity: intensity, roughness: 0.4 });
  }
}

/** Canvas text sign texture. */
export function textTexture(lines: string[], opts: { w?: number; h?: number; fg?: string; bg?: string; size?: number; border?: string } = {}): THREE.CanvasTexture {
  const w = opts.w ?? 512, h = opts.h ?? 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = opts.bg ?? 'rgba(8,10,14,0.92)';
  g.fillRect(0, 0, w, h);
  if (opts.border !== 'none') {
    g.strokeStyle = opts.border ?? opts.fg ?? '#e8e2d0';
    g.lineWidth = Math.max(4, w / 90);
    g.strokeRect(g.lineWidth * 1.5, g.lineWidth * 1.5, w - g.lineWidth * 3, h - g.lineWidth * 3);
  }
  g.fillStyle = opts.fg ?? '#e8e2d0';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const size = opts.size ?? Math.floor(h / (lines.length + 1.2));
  lines.forEach((ln, i) => {
    const s = i === 0 ? size : size * 0.62;
    g.font = `700 ${s}px "Trebuchet MS", "Segoe UI", sans-serif`;
    const y = lines.length === 1 ? h / 2 : h * 0.18 + ((h * 0.7) / Math.max(1, lines.length - 1)) * i * (lines.length > 1 ? 1 : 0) + (i === 0 ? h * 0.08 : 0);
    g.fillText(ln, w / 2, y, w * 0.88);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
