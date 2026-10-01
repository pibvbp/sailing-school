import { describe, expect, it } from 'vitest';
import {
  addPerlin2, addPerlin3, addWorley2, addWorley3, cloudNoise, equalize, generateDetailNoise, generateShapeNoise,
  generateWeatherMap, latticeHash, upsample2,
} from '../cloudNoise';

type Getter = (i: number, j: number, k: number) => number;

/**
 * How much larger the step across the wrap (last texel → first) is than the steps on either side of it, summed
 * over the whole seam along one axis of a size^dims field. A field that tiles is as smooth there as anywhere:
 * about 1. A field that does not wrap jumps between unrelated values: several.
 */
function seamExcess(get: Getter, size: number, axis: 0 | 1 | 2, dims: 2 | 3): number {
  const depth = dims === 3 ? size : 1;
  const at = (a: number, b: number, c: number): number => (axis === 0 ? get(a, b, c) : axis === 1 ? get(b, a, c) : get(b, c, a));
  let seam = 0;
  let beside = 0;
  for (let c = 0; c < depth; c++) {
    for (let b = 0; b < size; b++) {
      seam += Math.abs(at(0, b, c) - at(size - 1, b, c));
      beside += 0.5 * (Math.abs(at(size - 1, b, c) - at(size - 2, b, c)) + Math.abs(at(1, b, c) - at(0, b, c)));
    }
  }
  return seam / beside;
}

function expectSeamless(get: Getter, size: number, dims: 2 | 3): void {
  for (const axis of dims === 3 ? ([0, 1, 2] as const) : ([0, 1] as const)) {
    const excess = seamExcess(get, size, axis, dims);
    expect(excess).toBeGreaterThan(0.5);
    expect(excess).toBeLessThan(1.6);
  }
}

describe('cloud noise primitives', () => {
  it('hashes lattice points to 0…1, deterministically, differently per seed', () => {
    let sum = 0;
    for (let i = 0; i < 4000; i++) {
      const h = latticeHash(i % 17, (i * 7) % 23, (i * 13) % 29, 5);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      sum += h;
    }
    expect(sum / 4000).toBeGreaterThan(0.45);
    expect(sum / 4000).toBeLessThan(0.55);
    expect(latticeHash(3, 4, 5, 6)).toBe(latticeHash(3, 4, 5, 6));
    expect(latticeHash(3, 4, 5, 6)).not.toBe(latticeHash(3, 4, 5, 7));
  });

  it('the seam measure tells a tiling field from one that does not wrap', () => {
    // A field cut to three quarters of its period no longer wraps: the measure must say so.
    const n = 64;
    const f = new Float32Array(n * n);
    addPerlin2(f, n, 4, 1, 1);
    expect(seamExcess((i, j) => f[j * n + i]!, n, 0, 2)).toBeLessThan(1.6);
    const cut = 48;
    expect(seamExcess((i, j) => f[j * n + i]!, cut, 0, 2)).toBeGreaterThan(2.5);
    expect(seamExcess((i, j) => f[j * n + i]!, cut, 1, 2)).toBeGreaterThan(2.5);
  });

  it('gradient noise tiles in 3-D and in 2-D', () => {
    const n = 32;
    const f3 = new Float32Array(n * n * n);
    addPerlin3(f3, n, 4, 1, 1);
    expectSeamless((i, j, k) => f3[(k * n + j) * n + i]!, n, 3);
    const m = 64;
    const f2 = new Float32Array(m * m);
    addPerlin2(f2, m, 4, 1, 1);
    expectSeamless((i, j) => f2[j * m + i]!, m, 2);
  });

  it('cellular noise tiles, stays in 0…1 and peaks at its feature points', () => {
    const n = 32;
    const f3 = new Float32Array(n * n * n);
    addWorley3(f3, n, 4, 3, 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of f3) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi).toBeGreaterThan(0.85);
    expectSeamless((i, j, k) => f3[(k * n + j) * n + i]!, n, 3);
    const m = 64;
    const f2 = new Float32Array(m * m);
    addWorley2(f2, m, 4, 3, 1);
    expectSeamless((i, j) => f2[j * m + i]!, m, 2);
  });

  it('the pruned 3-D cellular noise equals the brute-force nearest feature point', () => {
    const n = 16;
    const freq = 4;
    const seed = 9;
    const fast = new Float32Array(n * n * n);
    addWorley3(fast, n, freq, seed, 1);
    let worst = 0;
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const px = ((i + 0.5) * freq) / n;
      const py = ((j + 0.5) * freq) / n;
      const pz = ((k + 0.5) * freq) / n;
      let best = Infinity;
      // Every cell of the tile, in every periodic image that could matter.
      for (let cz = -1; cz <= freq; cz++) for (let cy = -1; cy <= freq; cy++) for (let cx = -1; cx <= freq; cx++) {
        const wx = (cx + freq) % freq, wy = (cy + freq) % freq, wz = (cz + freq) % freq;
        const fx = cx + latticeHash(wx, wy, wz, seed) - px;
        const fy = cy + latticeHash(wx, wy, wz, seed + 1) - py;
        const fz = cz + latticeHash(wx, wy, wz, seed + 2) - pz;
        best = Math.min(best, fx * fx + fy * fy + fz * fz);
      }
      const expected = Math.max(0, 1 - Math.sqrt(best));
      worst = Math.max(worst, Math.abs(fast[(k * n + j) * n + i]! - expected));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it('rejects a grid that the cells do not divide', () => {
    expect(() => addWorley3(new Float32Array(27), 3, 2, 0, 1)).toThrow();
    expect(() => addWorley2(new Float32Array(9), 3, 2, 0, 1)).toThrow();
  });

  it('equalize turns any field into ranks: "above 1 − a" selects the fraction a', () => {
    const n = 64;
    const f = new Float32Array(n * n);
    addPerlin2(f, n, 4, 2, 1);
    addWorley2(f, n, 8, 3, 0.7);
    equalize(f);
    for (const a of [0.1, 0.35, 0.6, 0.9]) {
      let count = 0;
      for (const v of f) if (v > 1 - a) count++;
      expect(Math.abs(count / f.length - a)).toBeLessThan(0.01);
    }
  });

  it('upsample2 keeps the mean and the period', () => {
    const n = 16;
    const src = new Float32Array(n * n);
    addPerlin2(src, n, 2, 4, 1);
    const big = upsample2(src, n, 4);
    expect(big.length).toBe(64 * 64);
    const mean = (a: Float32Array): number => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(big)).toBeCloseTo(mean(src), 5);
    expectSeamless((i, j) => big[j * 64 + i]!, 64, 2);
  });
});

describe('cloud textures', () => {
  const set = cloudNoise();

  it('are deterministic', () => {
    const detail = generateDetailNoise(16, 71);
    expect(generateDetailNoise(16, 71).data).toEqual(detail.data);
    expect(generateDetailNoise(16, 72).data).not.toEqual(detail.data);
    expect(generateShapeNoise(16, 11).data).toEqual(generateShapeNoise(16, 11).data);
    expect(generateWeatherMap(64, 131).data).toEqual(generateWeatherMap(64, 131).data);
  });

  it('tile on every axis: no seam where a texture repeats', () => {
    const { weather, shape, detail } = set;
    const s = shape.size;
    expectSeamless((i, j, k) => shape.data[(k * s + j) * s + i]!, s, 3);
    const d = detail.size;
    expectSeamless((i, j, k) => detail.data[(k * d + j) * d + i]!, d, 3);
    const w = weather.size;
    for (const channel of [0, 1, 2]) expectSeamless((i, j) => weather.data[(j * w + i) * 4 + channel]!, w, 2);
  });

  it('use their whole range, and the weather coverage is uniform (so cover is a threshold)', () => {
    const { weather, shape, detail } = set;
    const range = (data: Uint8Array, stride: number, offset: number): [number, number] => {
      let lo = 255;
      let hi = 0;
      for (let i = offset; i < data.length; i += stride) { lo = Math.min(lo, data[i]!); hi = Math.max(hi, data[i]!); }
      return [lo, hi];
    };
    expect(range(shape.data, 1, 0)).toEqual([0, 255]);
    expect(range(detail.data, 1, 0)).toEqual([0, 255]);
    for (const a of [0.2, 0.35, 0.6, 0.9]) {
      let count = 0;
      for (let i = 0; i < weather.data.length; i += 4) if (weather.data[i]! / 255 > 1 - a) count++;
      expect(Math.abs(count / (weather.data.length / 4) - a)).toBeLessThan(0.01);
    }
    for (let i = 3; i < weather.data.length; i += 4) expect(weather.data[i]).toBe(255);
  });

  it('have the sizes the shaders expect and are cached', () => {
    expect(set.weather.data.length).toBe(set.weather.size * set.weather.size * 4);
    expect(set.shape.data.length).toBe(set.shape.size ** 3);
    expect(set.detail.data.length).toBe(set.detail.size ** 3);
    expect(cloudNoise()).toBe(set);
  });
});
