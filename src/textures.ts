import * as THREE from "three";

/**
 * Procedural canvas textures. The OBJ models ship without any maps, so cloth,
 * wood and carpet surfaces are generated at startup (no assets to download).
 */

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function toTexture(
  canvas: HTMLCanvasElement,
  repeat: number,
  srgb = true,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tileable value noise sampled on a wrapped lattice. */
function tileNoise(size: number, cells: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const out = new Float32Array(size * size);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells;
    const y0 = Math.floor(fy);
    const ty = smooth(fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const x0 = Math.floor(fx);
      const tx = smooth(fx - x0);
      const a = lattice[(y0 % cells) * cells + (x0 % cells)];
      const b = lattice[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = lattice[((y0 + 1) % cells) * cells + (x0 % cells)];
      const d = lattice[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Worsted snooker baize: fine fibre grain plus faint cloudy variation and a
 * slight directional "nap" along the table length. Returns colour + bump.
 */
export function createClothTextures(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const size = 512;
  const [c, ctx] = makeCanvas(size, size);
  const [bc, bctx] = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const bimg = bctx.createImageData(size, size);
  const cloud = tileNoise(size, 6, 11);
  const mid = tileNoise(size, 32, 23);
  const rnd = mulberry32(7);
  // Base: WPBSA-style championship green (sRGB)
  const base = [22, 96, 48];
  for (let i = 0; i < size * size; i++) {
    const y = Math.floor(i / size);
    const fibre = rnd() - 0.5;
    const nap = Math.sin((y / size) * Math.PI * 2 * 90 + fibre * 2) * 0.5;
    const k = 1 + (cloud[i] - 0.5) * 0.1 + (mid[i] - 0.5) * 0.06 + fibre * 0.09 + nap * 0.015;
    img.data[i * 4] = Math.min(255, base[0] * k);
    img.data[i * 4 + 1] = Math.min(255, base[1] * k);
    img.data[i * 4 + 2] = Math.min(255, base[2] * k);
    img.data[i * 4 + 3] = 255;
    const h = 128 + fibre * 150 + (mid[i] - 0.5) * 40;
    bimg.data[i * 4] = bimg.data[i * 4 + 1] = bimg.data[i * 4 + 2] = h;
    bimg.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  bctx.putImageData(bimg, 0, 0);
  return { map: toTexture(c, 1), bump: toTexture(bc, 1, false) };
}

/**
 * Polished mahogany: long wavy grain lines, pores and a couple of darker
 * growth bands. Grain runs along the texture's U axis.
 */
export function createWoodTextures(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const w = 1024;
  const h = 256;
  const [c, ctx] = makeCanvas(w, h);
  const [rc, rctx] = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  const rimg = rctx.createImageData(w, h);
  const warp = tileNoise(256, 8, 5);
  const rnd = mulberry32(99);
  const base = [74, 30, 16];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const wv = warp[(y % 256) * 256 + Math.floor((x / w) * 256)];
      const ring = Math.sin((y / h) * Math.PI * 2 * 46 + wv * 5);
      const band = Math.pow(0.5 + 0.5 * ring, 4);
      const pore = rnd() < 0.015 ? 0.25 : 0;
      const k = 1.05 - band * 0.28 - pore + (rnd() - 0.5) * 0.06;
      img.data[i * 4] = Math.max(0, Math.min(255, base[0] * k));
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, base[1] * k));
      img.data[i * 4 + 2] = Math.max(0, Math.min(255, base[2] * k));
      img.data[i * 4 + 3] = 255;
      const r = 70 + band * 60 + pore * 300;
      rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = Math.min(255, r);
      rimg.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  return { map: toTexture(c, 1), rough: toTexture(rc, 1, false) };
}

/** Straight light ash grain for the cue shaft (wraps around a cylinder). */
export function createAshTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 1024;
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = "#e3c596";
  ctx.fillRect(0, 0, w, h);
  const rnd = mulberry32(3);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * w;
    ctx.strokeStyle = `rgba(120,78,36,${0.08 + rnd() * 0.2})`;
    ctx.lineWidth = 0.5 + rnd() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let y = 0; y <= h; y += 32) ctx.lineTo(x + Math.sin(y * 0.01 + i) * 3, y);
    ctx.stroke();
  }
  const tex = toTexture(c, 1);
  tex.repeat.set(1, 1);
  return tex;
}

/** Dense dark-red carpet for the room floor. */
export function createCarpetTexture(): THREE.CanvasTexture {
  const size = 256;
  const [c, ctx] = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const cloud = tileNoise(size, 8, 41);
  const rnd = mulberry32(17);
  const base = [40, 16, 18];
  for (let i = 0; i < size * size; i++) {
    const k = 0.85 + (cloud[i] - 0.5) * 0.25 + (rnd() - 0.5) * 0.35;
    img.data[i * 4] = base[0] * k;
    img.data[i * 4 + 1] = base[1] * k;
    img.data[i * 4 + 2] = base[2] * k;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, 1);
}

/**
 * Cue ball "measle" dots (as on TV-tournament cue balls) so spin and roll are
 * visible. Equirectangular map for a SphereGeometry.
 */
export function createCueBallTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = "#f6f2e6";
  ctx.fillRect(0, 0, w, h);
  // Six dots on the sphere axes: four around the equator + one cap per pole
  // (a thin strip along the top/bottom row of an equirect map is a pole cap).
  ctx.fillStyle = "#c81e3a";
  const r = 9;
  for (const u of [0, 0.25, 0.5, 0.75]) {
    for (const dx of [-w, 0, w]) {
      ctx.beginPath();
      ctx.arc(u * w + dx, h / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillRect(0, 0, w, r);
  ctx.fillRect(0, h - r, w, r);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Replace a mesh's UVs with world-scale box (tri-planar) mapping so procedural
 * textures keep a physical size regardless of how the OBJ was unwrapped.
 * `scale` = texture repeats per metre. `grainAlongLongest` rotates the mapping
 * on side faces so wood grain follows the longest horizontal extent.
 */
export function applyBoxUV(
  geo: THREE.BufferGeometry,
  scale: number,
  grainAlongLongest = false,
): void {
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  if (!pos || !nrm) return;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const longX = bb.max.x - bb.min.x >= bb.max.z - bb.min.z;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      // Top/bottom faces: grain along the longest horizontal axis
      if (grainAlongLongest && !longX) {
        u = z;
        v = x;
      } else {
        u = x;
        v = z;
      }
    } else if (ax >= az) {
      u = z;
      v = y;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}
