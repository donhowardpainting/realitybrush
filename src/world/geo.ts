import * as THREE from 'three';

/** Ensure the attributes the world shader expects (vertex colour + baked light). */
export function prep(g: THREE.BufferGeometry, shade = 1): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  if (!g.attributes.color) {
    const c = new Float32Array(n * 3).fill(shade);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (!g.attributes.baked) g.setAttribute('baked', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  return g;
}

/**
 * Box with world-scaled UVs (so textures keep a constant texel density) and enough
 * subdivision for per-vertex baked lighting.
 */
export function boxGeo(w: number, h: number, d: number, uvScale = 3, seg = 2.6): THREE.BufferGeometry {
  const s = (x: number) => Math.max(1, Math.min(10, Math.round(x / seg)));
  const g = new THREE.BoxGeometry(w, h, d, s(w), s(h), s(d));
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (nx > 0.5) uv.setXY(i, z / uvScale, y / uvScale);
    else if (ny > 0.5) uv.setXY(i, x / uvScale, z / uvScale);
    else uv.setXY(i, x / uvScale, y / uvScale);
  }
  return prep(g);
}

/** Rounded-ish variant of a box face set scaled to fill 0..1 UVs per face (crates, cores). */
export function unitUvBox(w: number, h: number, d: number): THREE.BufferGeometry {
  return prep(new THREE.BoxGeometry(w, h, d));
}

export function bake(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  g.applyMatrix4(m);
  return g;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
export function xform(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return _m.clone().compose(new THREE.Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
}
