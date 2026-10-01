// Tileable noise for the volumetric clouds (own implementation; the Perlin–Worley recipe follows
// A. Schneider, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015).
//
// Everything is generated once on the CPU, deterministically, from integer lattice hashes that wrap at the
// tile size, so every field is exactly periodic. The same arrays feed the GPU textures and the CPU mirror of
// the density field (`cloudField.ts`), which is how the sun can dim exactly when a visible cloud covers it.
//
// Fields are computed on regular grids, which lets the inner loops stay tight: per-axis lattice tables for
// the gradient noise, and one gathered 27-point (9 in 2-D) neighbourhood per cell for the cellular noise.

/** A size³ volume with one byte per voxel, x fastest then y then z. */
export interface NoiseVolume {
  readonly size: number;
  readonly data: Uint8Array;
}

/** A size² RGBA map, x fastest then y. */
export interface NoiseMap {
  readonly size: number;
  readonly data: Uint8Array;
}

/** Everything the cloud field samples. */
export interface CloudNoise {
  /** R = coverage signal (histogram-equalised: uniform in 0…1), G = cloud-height factor, B = density/base variation. */
  readonly weather: NoiseMap;
  /** Low-frequency Perlin–Worley billows (1 = solid billow, 0 = gap). */
  readonly shape: NoiseVolume;
  /** High-frequency Worley fbm for edge erosion. */
  readonly detail: NoiseVolume;
}

export const WEATHER_SIZE = 512;
export const SHAPE_SIZE = 64;
export const DETAIL_SIZE = 32;

// ---------------------------------------------------------------------------------------------------------
// Hashing

/** 32-bit integer finaliser: "lowbias32" by Chris Wellons (hash-prospector; public domain, Unlicense). */
function hash32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Uniform 0…1 from an integer lattice point and a seed. */
export function latticeHash(x: number, y: number, z: number, seed: number): number {
  return hash32(hash32(hash32(x + Math.imul(seed, 0x9e3779b1)) ^ y) ^ z) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Per-axis lookup for gradient noise on a regular grid: lower/upper lattice index, fraction and fade. */
function axisTable(size: number, freq: number): { lo: Int32Array; hi: Int32Array; fr: Float32Array; fd: Float32Array } {
  const lo = new Int32Array(size);
  const hi = new Int32Array(size);
  const fr = new Float32Array(size);
  const fd = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = ((i + 0.5) * freq) / size;
    const c = Math.floor(x);
    lo[i] = c % freq;
    hi[i] = (c + 1) % freq;
    fr[i] = x - c;
    fd[i] = fade(x - c);
  }
  return { lo, hi, fr, fd };
}

// ---------------------------------------------------------------------------------------------------------
// 3-D fields

/** Add `amplitude` × periodic gradient noise (`freq` lattice cells per tile, range ≈ ±1) to a size³ field. */
export function addPerlin3(out: Float32Array, size: number, freq: number, seed: number, amplitude: number): void {
  const g = new Float32Array(freq * freq * freq * 3);
  for (let z = 0, n = 0; z < freq; z++) {
    for (let y = 0; y < freq; y++) {
      for (let x = 0; x < freq; x++, n += 3) {
        // Uniform direction on the sphere.
        const cz = latticeHash(x, y, z, seed) * 2 - 1;
        const a = latticeHash(x, y, z, seed + 1) * Math.PI * 2;
        const r = Math.sqrt(Math.max(0, 1 - cz * cz));
        g[n] = r * Math.cos(a);
        g[n + 1] = r * Math.sin(a);
        g[n + 2] = cz;
      }
    }
  }
  const t = axisTable(size, freq);
  const scale = amplitude * 1.55; // unit gradients peak near ±0.65
  let o = 0;
  for (let k = 0; k < size; k++) {
    const z0 = t.lo[k]! * freq * freq * 3;
    const z1 = t.hi[k]! * freq * freq * 3;
    const fz = t.fr[k]!;
    const wz = t.fd[k]!;
    for (let j = 0; j < size; j++) {
      const y0 = t.lo[j]! * freq * 3;
      const y1 = t.hi[j]! * freq * 3;
      const fy = t.fr[j]!;
      const wy = t.fd[j]!;
      const a00 = z0 + y0;
      const a10 = z0 + y1;
      const a01 = z1 + y0;
      const a11 = z1 + y1;
      for (let i = 0; i < size; i++, o++) {
        const x0 = t.lo[i]! * 3;
        const x1 = t.hi[i]! * 3;
        const fx = t.fr[i]!;
        const wx = t.fd[i]!;
        let p = a00 + x0;
        const d000 = g[p]! * fx + g[p + 1]! * fy + g[p + 2]! * fz;
        p = a00 + x1;
        const d100 = g[p]! * (fx - 1) + g[p + 1]! * fy + g[p + 2]! * fz;
        p = a10 + x0;
        const d010 = g[p]! * fx + g[p + 1]! * (fy - 1) + g[p + 2]! * fz;
        p = a10 + x1;
        const d110 = g[p]! * (fx - 1) + g[p + 1]! * (fy - 1) + g[p + 2]! * fz;
        p = a01 + x0;
        const d001 = g[p]! * fx + g[p + 1]! * fy + g[p + 2]! * (fz - 1);
        p = a01 + x1;
        const d101 = g[p]! * (fx - 1) + g[p + 1]! * fy + g[p + 2]! * (fz - 1);
        p = a11 + x0;
        const d011 = g[p]! * fx + g[p + 1]! * (fy - 1) + g[p + 2]! * (fz - 1);
        p = a11 + x1;
        const d111 = g[p]! * (fx - 1) + g[p + 1]! * (fy - 1) + g[p + 2]! * (fz - 1);
        const e00 = d000 + (d100 - d000) * wx;
        const e10 = d010 + (d110 - d010) * wx;
        const e01 = d001 + (d101 - d001) * wx;
        const e11 = d011 + (d111 - d011) * wx;
        const f0 = e00 + (e10 - e00) * wy;
        const f1 = e01 + (e11 - e01) * wy;
        out[o] = out[o]! + (f0 + (f1 - f0) * wz) * scale;
      }
    }
  }
}

/**
 * Add `amplitude` × inverted periodic cellular noise to a size³ field: 1 at a feature point, falling to 0 one
 * cell away (round "billows"). `size` must be a multiple of `freq`.
 */
export function addWorley3(out: Float32Array, size: number, freq: number, seed: number, amplitude: number): void {
  if (size % freq !== 0) throw new Error(`cloudNoise: size ${size} is not a multiple of the cell count ${freq}`);
  const n = size / freq;
  const pts = new Float32Array(freq * freq * freq * 3);
  for (let z = 0, p = 0; z < freq; z++) {
    for (let y = 0; y < freq; y++) {
      for (let x = 0; x < freq; x++, p += 3) {
        pts[p] = latticeHash(x, y, z, seed);
        pts[p + 1] = latticeHash(x, y, z, seed + 1);
        pts[p + 2] = latticeHash(x, y, z, seed + 2);
      }
    }
  }
  const local = new Float32Array(81);
  const near = new Float32Array(81);
  const half = n >> 1;
  // Voxel ranges and local-frame bounds of the two halves of a cell along one axis.
  const from = [0, half];
  const to = [half, n];
  const lo = [0, half / n];
  const hi = [half / n, 1];
  for (let cz = 0; cz < freq; cz++) {
    for (let cy = 0; cy < freq; cy++) {
      for (let cx = 0; cx < freq; cx++) {
        // The 27 neighbouring feature points, in this cell's local frame (cell = unit cube).
        let m = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const wz = (cz + dz + freq) % freq;
          for (let dy = -1; dy <= 1; dy++) {
            const wy = (cy + dy + freq) % freq;
            for (let dx = -1; dx <= 1; dx++, m += 3) {
              const p = ((wz * freq + wy) * freq + ((cx + dx + freq) % freq)) * 3;
              local[m] = dx + pts[p]!;
              local[m + 1] = dy + pts[p + 1]!;
              local[m + 2] = dz + pts[p + 2]!;
            }
          }
        }
        // Per octant of the cell, keep only the points that can be nearest to some voxel in it: a point
        // whose closest approach to the octant is farther than another point's farthest corner never wins.
        // (Exact: the same result as testing all 27, at about a third of the work.)
        for (let oct = 0; oct < 8; oct++) {
          const ax = oct & 1;
          const ay = (oct >> 1) & 1;
          const az = (oct >> 2) & 1;
          const x0 = lo[ax]!, x1 = hi[ax]!, y0 = lo[ay]!, y1 = hi[ay]!, z0 = lo[az]!, z1 = hi[az]!;
          let bound = Infinity;
          for (let q = 0; q < 81; q += 3) {
            const fx = Math.max(Math.abs(local[q]! - x0), Math.abs(local[q]! - x1));
            const fy = Math.max(Math.abs(local[q + 1]! - y0), Math.abs(local[q + 1]! - y1));
            const fz = Math.max(Math.abs(local[q + 2]! - z0), Math.abs(local[q + 2]! - z1));
            const far = fx * fx + fy * fy + fz * fz;
            if (far < bound) bound = far;
          }
          let count = 0;
          for (let q = 0; q < 81; q += 3) {
            const gx = Math.max(x0 - local[q]!, 0, local[q]! - x1);
            const gy = Math.max(y0 - local[q + 1]!, 0, local[q + 1]! - y1);
            const gz = Math.max(z0 - local[q + 2]!, 0, local[q + 2]! - z1);
            if (gx * gx + gy * gy + gz * gz <= bound) {
              near[count] = local[q]!;
              near[count + 1] = local[q + 1]!;
              near[count + 2] = local[q + 2]!;
              count += 3;
            }
          }
          for (let k = from[az]!; k < to[az]!; k++) {
            const lz = (k + 0.5) / n;
            for (let j = from[ay]!; j < to[ay]!; j++) {
              const ly = (j + 0.5) / n;
              let o = ((cz * n + k) * size + cy * n + j) * size + cx * n + from[ax]!;
              for (let i = from[ax]!; i < to[ax]!; i++, o++) {
                const lx = (i + 0.5) / n;
                let best = 4;
                for (let q = 0; q < count; q += 3) {
                  const ex = near[q]! - lx;
                  const ey = near[q + 1]! - ly;
                  const ez = near[q + 2]! - lz;
                  const d2 = ex * ex + ey * ey + ez * ez;
                  if (d2 < best) best = d2;
                }
                const f1 = Math.sqrt(best);
                out[o] = out[o]! + (f1 < 1 ? 1 - f1 : 0) * amplitude;
              }
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// 2-D fields

/** Add `amplitude` × periodic 2-D gradient noise (range ≈ ±1) to a size² field. */
export function addPerlin2(out: Float32Array, size: number, freq: number, seed: number, amplitude: number): void {
  const g = new Float32Array(freq * freq * 2);
  for (let y = 0, n = 0; y < freq; y++) {
    for (let x = 0; x < freq; x++, n += 2) {
      const a = latticeHash(x, y, 0, seed) * Math.PI * 2;
      g[n] = Math.cos(a);
      g[n + 1] = Math.sin(a);
    }
  }
  const t = axisTable(size, freq);
  const scale = amplitude * 1.6;
  let o = 0;
  for (let j = 0; j < size; j++) {
    const y0 = t.lo[j]! * freq * 2;
    const y1 = t.hi[j]! * freq * 2;
    const fy = t.fr[j]!;
    const wy = t.fd[j]!;
    for (let i = 0; i < size; i++, o++) {
      const x0 = t.lo[i]! * 2;
      const x1 = t.hi[i]! * 2;
      const fx = t.fr[i]!;
      const wx = t.fd[i]!;
      const d00 = g[y0 + x0]! * fx + g[y0 + x0 + 1]! * fy;
      const d10 = g[y0 + x1]! * (fx - 1) + g[y0 + x1 + 1]! * fy;
      const d01 = g[y1 + x0]! * fx + g[y1 + x0 + 1]! * (fy - 1);
      const d11 = g[y1 + x1]! * (fx - 1) + g[y1 + x1 + 1]! * (fy - 1);
      const e0 = d00 + (d10 - d00) * wx;
      const e1 = d01 + (d11 - d01) * wx;
      out[o] = out[o]! + (e0 + (e1 - e0) * wy) * scale;
    }
  }
}

/** Add `amplitude` × inverted periodic 2-D cellular noise (1 at a feature point → 0 one cell away). */
export function addWorley2(out: Float32Array, size: number, freq: number, seed: number, amplitude: number): void {
  if (size % freq !== 0) throw new Error(`cloudNoise: size ${size} is not a multiple of the cell count ${freq}`);
  const n = size / freq;
  const pts = new Float32Array(freq * freq * 2);
  for (let y = 0, p = 0; y < freq; y++) {
    for (let x = 0; x < freq; x++, p += 2) {
      pts[p] = latticeHash(x, y, 0, seed);
      pts[p + 1] = latticeHash(x, y, 0, seed + 1);
    }
  }
  const local = new Float32Array(18);
  for (let cy = 0; cy < freq; cy++) {
    for (let cx = 0; cx < freq; cx++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const wy = (cy + dy + freq) % freq;
        for (let dx = -1; dx <= 1; dx++, m += 2) {
          const p = (wy * freq + ((cx + dx + freq) % freq)) * 2;
          local[m] = dx + pts[p]!;
          local[m + 1] = dy + pts[p + 1]!;
        }
      }
      for (let j = 0; j < n; j++) {
        const ly = (j + 0.5) / n;
        let o = (cy * n + j) * size + cx * n;
        for (let i = 0; i < n; i++, o++) {
          const lx = (i + 0.5) / n;
          let best = 4;
          for (let q = 0; q < 18; q += 2) {
            const ex = local[q]! - lx;
            const ey = local[q + 1]! - ly;
            const d2 = ex * ex + ey * ey;
            if (d2 < best) best = d2;
          }
          const f1 = Math.sqrt(best);
          out[o] = out[o]! + (f1 < 1 ? 1 - f1 : 0) * amplitude;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Range helpers

/** Rescale a field linearly so its minimum is 0 and its maximum 1. */
function normalize(field: Float32Array): Float32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const v = field[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < field.length; i++) field[i] = (field[i]! - lo) * k;
  return field;
}

/**
 * Histogram-equalise a field in place: each value becomes its rank, 0…1. Afterwards "value > 1 − a" selects
 * exactly the fraction `a` of the area, which makes cloud cover a simple threshold.
 */
export function equalize(field: Float32Array): Float32Array {
  normalize(field);
  const bins = 4096;
  const hist = new Uint32Array(bins + 1);
  for (let i = 0; i < field.length; i++) hist[Math.min(bins - 1, Math.floor(field[i]! * bins)) + 1]!++;
  for (let b = 1; b <= bins; b++) hist[b] = hist[b]! + hist[b - 1]!;
  const total = field.length;
  for (let i = 0; i < field.length; i++) {
    const x = Math.min(bins - 1e-3, field[i]! * bins);
    const b = Math.floor(x);
    // Linear within the bin keeps neighbouring values ordered.
    field[i] = (hist[b]! + (x - b) * (hist[b + 1]! - hist[b]!)) / total;
  }
  return field;
}

/** Periodic bilinear upsampling of a smooth size² field by an integer factor (texel centres stay aligned). */
export function upsample2(src: Float32Array, size: number, factor: number): Float32Array {
  const big = size * factor;
  const out = new Float32Array(big * big);
  const i0 = new Int32Array(big);
  const i1 = new Int32Array(big);
  const w = new Float32Array(big);
  for (let i = 0; i < big; i++) {
    const x = (i + 0.5) / factor - 0.5;
    const f = Math.floor(x);
    i0[i] = ((f % size) + size) % size;
    i1[i] = (i0[i]! + 1) % size;
    w[i] = x - f;
  }
  for (let j = 0, o = 0; j < big; j++) {
    const r0 = i0[j]! * size;
    const r1 = i1[j]! * size;
    const wy = w[j]!;
    for (let i = 0; i < big; i++, o++) {
      const a = src[r0 + i0[i]!]! + (src[r0 + i1[i]!]! - src[r0 + i0[i]!]!) * w[i]!;
      const b = src[r1 + i0[i]!]! + (src[r1 + i1[i]!]! - src[r1 + i0[i]!]!) * w[i]!;
      out[o] = a + (b - a) * wy;
    }
  }
  return out;
}

/** Periodic trilinear upsampling of a smooth size³ field to (2·size)³ (texel centres stay aligned). */
export function upsample3(src: Float32Array, size: number): Float32Array {
  const big = size * 2;
  const out = new Float32Array(big * big * big);
  const i0 = new Int32Array(big);
  const i1 = new Int32Array(big);
  const w = new Float32Array(big);
  for (let i = 0; i < big; i++) {
    const x = (i + 0.5) / 2 - 0.5;
    const f = Math.floor(x);
    i0[i] = ((f % size) + size) % size;
    i1[i] = (i0[i]! + 1) % size;
    w[i] = x - f;
  }
  const plane = size * size;
  let o = 0;
  for (let k = 0; k < big; k++) {
    const z0 = i0[k]! * plane;
    const z1 = i1[k]! * plane;
    const wz = w[k]!;
    for (let j = 0; j < big; j++) {
      const y0 = i0[j]! * size;
      const y1 = i1[j]! * size;
      const wy = w[j]!;
      const a = z0 + y0, b = z0 + y1, c = z1 + y0, d = z1 + y1;
      for (let i = 0; i < big; i++, o++) {
        const x0 = i0[i]!;
        const x1 = i1[i]!;
        const wx = w[i]!;
        const e0 = src[a + x0]! + (src[a + x1]! - src[a + x0]!) * wx;
        const e1 = src[b + x0]! + (src[b + x1]! - src[b + x0]!) * wx;
        const e2 = src[c + x0]! + (src[c + x1]! - src[c + x0]!) * wx;
        const e3 = src[d + x0]! + (src[d + x1]! - src[d + x0]!) * wx;
        const f0 = e0 + (e1 - e0) * wy;
        const f1 = e2 + (e3 - e2) * wy;
        out[o] = f0 + (f1 - f0) * wz;
      }
    }
  }
  return out;
}

function toBytes(field: Float32Array, out: Uint8Array, stride: number, offset: number): void {
  for (let i = 0; i < field.length; i++) {
    const v = field[i]!;
    out[i * stride + offset] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The three textures

/**
 * Low-frequency Perlin–Worley billows. Perlin gives connected, wandering masses; dilating it with inverted
 * Worley rounds them into cauliflower lumps; a higher Worley fbm then carves the creases between the lumps.
 */
export function generateShapeNoise(size: number = SHAPE_SIZE, seed = 11): NoiseVolume {
  const count = size * size * size;
  // The two broadest layers (4 cells per tile) are smooth: half the resolution, upsampled, costs an eighth.
  const half = size / 2;
  const coarse = half >= 16 && Number.isInteger(half);
  const broad = (add: (out: Float32Array, n: number) => void): Float32Array => {
    if (!coarse) { const full = new Float32Array(count); add(full, size); return full; }
    const low = new Float32Array(half * half * half);
    add(low, half);
    return upsample3(low, half);
  };
  const perlin = broad((out, n) => addPerlin3(out, n, 4, seed, 0.55));
  addPerlin3(perlin, size, 8, seed + 10, 0.3);
  addPerlin3(perlin, size, 16, seed + 20, 0.15);
  const w4 = broad((out, n) => addWorley3(out, n, 4, seed + 30, 1));
  const w8 = new Float32Array(count);
  const w16 = new Float32Array(count);
  addWorley3(w8, size, 8, seed + 40, 1);
  addWorley3(w16, size, 16, seed + 50, 1);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = Math.min(1, Math.max(0, perlin[i]! * 0.5 + 0.5));
    // Flatter than the usual 0.625 / 0.25 / 0.125: the smaller billows must show on the cloud's surface.
    const low = w4[i]! * 0.5 + w8[i]! * 0.3 + w16[i]! * 0.2;
    const perlinWorley = low + p * (1 - low);
    const high = w8[i]! * 0.5 + w16[i]! * 0.5;
    // remap(perlinWorley, high − 1, 1, 0, 1)
    out[i] = (perlinWorley - (high - 1)) / (2 - high);
  }
  normalize(out);
  const data = new Uint8Array(count);
  toBytes(out, data, 1, 0);
  return { size, data };
}

/** High-frequency Worley fbm: three octaves of small billows for eroding cloud edges. */
export function generateDetailNoise(size: number = DETAIL_SIZE, seed = 71): NoiseVolume {
  const count = size * size * size;
  const out = new Float32Array(count);
  addWorley3(out, size, 2, seed, 0.625);
  addWorley3(out, size, 4, seed + 10, 0.25);
  addWorley3(out, size, 8, seed + 20, 0.125);
  normalize(out);
  const data = new Uint8Array(count);
  toBytes(out, data, 1, 0);
  return { size, data };
}

/**
 * The 2-D layout of the cloud field over one tile (tens of kilometres).
 *  R  where clouds are: cellular blobs (one cumulus per cell) modulated by larger Perlin masses so cells
 *     differ in size and cluster into groups with clear lanes between; histogram-equalised.
 *  G  how tall clouds may grow here (broad Perlin regions): a few areas of towers.
 *  B  an independent mid-scale signal (density / base variation).
 */
export function generateWeatherMap(size: number = WEATHER_SIZE, seed = 131): NoiseMap {
  const count = size * size;
  const cover = new Float32Array(count);
  addWorley2(cover, size, 32, seed, 0.5);
  addWorley2(cover, size, 64, seed + 10, 0.2);
  addPerlin2(cover, size, 4, seed + 20, 0.16);
  addPerlin2(cover, size, 8, seed + 30, 0.2);
  addPerlin2(cover, size, 16, seed + 40, 0.14);
  addPerlin2(cover, size, 32, seed + 50, 0.08);
  equalize(cover);

  // The two broad channels are smooth: a quarter of the resolution, upsampled, is indistinguishable.
  const coarse = size / 4;
  const heightLow = new Float32Array(coarse * coarse);
  addPerlin2(heightLow, coarse, 4, seed + 100, 0.55);
  addPerlin2(heightLow, coarse, 8, seed + 110, 0.3);
  addPerlin2(heightLow, coarse, 16, seed + 120, 0.15);
  const height = equalize(upsample2(heightLow, coarse, 4));

  const varyLow = new Float32Array(coarse * coarse);
  addPerlin2(varyLow, coarse, 8, seed + 200, 0.6);
  addPerlin2(varyLow, coarse, 16, seed + 210, 0.4);
  const vary = equalize(upsample2(varyLow, coarse, 4));

  const data = new Uint8Array(count * 4);
  toBytes(cover, data, 4, 0);
  toBytes(height, data, 4, 1);
  toBytes(vary, data, 4, 2);
  for (let i = 0; i < count; i++) data[i * 4 + 3] = 255;
  return { size, data };
}

let cached: CloudNoise | null = null;
let generationMs = 0;

/** The cloud noise set (generated on first use, ≈ 0.1 s; cached for the page's lifetime). */
export function cloudNoise(): CloudNoise {
  if (!cached) {
    const t0 = performance.now();
    cached = { weather: generateWeatherMap(), shape: generateShapeNoise(), detail: generateDetailNoise() };
    generationMs = performance.now() - t0;
  }
  return cached;
}

/** How long the one-off generation in `cloudNoise()` took on this machine (ms; 0 before it has run). */
export const cloudNoiseGenerationMs = (): number => generationMs;
