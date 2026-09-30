import { describe, expect, it } from 'vitest';
import { HeightGridSet, sampleGrid, type GridView, type HeightSnapshot } from '../sampler';

/** Two grids side by side in one readback, filled from h(x, z) with analytic slopes. */
function snapshot(
  h: (x: number, z: number) => number, slope: (x: number, z: number) => [number, number],
  opts: { cells?: number; fine?: [number, number, number]; coarse?: [number, number, number]; time?: number } = {},
): HeightSnapshot {
  const cells = opts.cells ?? 9;
  const data = new Float32Array(cells * cells * 2 * 4);
  const view = (column: number, [originX, originZ, spacing]: [number, number, number]): GridView => {
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const x = originX + i * spacing, z = originZ + j * spacing;
        const o = (j * cells * 2 + column + i) * 4;
        const [sx, sz] = slope(x, z);
        data[o] = h(x, z); data[o + 1] = sx; data[o + 2] = sz; data[o + 3] = 1;
      }
    }
    return { data, stride: cells * 2, column, cells, originX, originZ, spacing };
  };
  return {
    fine: view(0, opts.fine ?? [-4, -4, 1]),
    coarse: view(cells, opts.coarse ?? [-80, -80, 20]),
    time: opts.time ?? 0,
  };
}

const plane = (a: number, b: number, c: number) => ({
  h: (x: number, z: number) => a * x + b * z + c,
  s: (): [number, number] => [a, b],
});

describe('sampleGrid (bilinear lookup)', () => {
  const p = plane(0.3, -0.2, 1.5);
  const s = snapshot(p.h, p.s);
  const out = { h: 0, sx: 0, sz: 0 };

  it('reproduces a plane exactly anywhere inside the grid', () => {
    for (const [x, z] of [[0, 0], [1.25, -3.5], [-3.99, 3.99], [2.5, 0.75]] as const) {
      expect(sampleGrid(s.fine, x, z, out)).toBe(true);
      expect(out.h).toBeCloseTo(p.h(x, z), 5);
      expect(out.sx).toBeCloseTo(0.3, 6);
      expect(out.sz).toBeCloseTo(-0.2, 6);
    }
  });

  it('is exact on nodes and weights the four neighbours bilinearly between them', () => {
    const bump = snapshot((x, z) => (x === 0 && z === 0 ? 1 : 0), () => [0, 0]);
    expect(sampleGrid(bump.fine, 0, 0, out) && out.h).toBeCloseTo(1, 6);
    expect(sampleGrid(bump.fine, 0.5, 0, out) && out.h).toBeCloseTo(0.5, 6);
    expect(sampleGrid(bump.fine, 0.5, 0.5, out) && out.h).toBeCloseTo(0.25, 6);
    expect(sampleGrid(bump.fine, -0.25, 0.75, out) && out.h).toBeCloseTo(0.75 * 0.25, 6);
  });

  it('includes the far edge and rejects points outside', () => {
    expect(sampleGrid(s.fine, 4, 4, out)).toBe(true);
    expect(out.h).toBeCloseTo(p.h(4, 4), 5);
    expect(sampleGrid(s.fine, 4.01, 0, out)).toBe(false);
    expect(sampleGrid(s.fine, 0, -4.01, out)).toBe(false);
  });

  it('reads the second grid of a shared readback through its column offset', () => {
    expect(sampleGrid(s.coarse, 50, -30, out)).toBe(true);
    expect(out.h).toBeCloseTo(p.h(50, -30), 4);
  });

  it('refuses non-finite data', () => {
    const bad = snapshot(() => Number.NaN, () => [0, 0]);
    expect(sampleGrid(bad.fine, 0, 0, out)).toBe(false);
  });
});

describe('HeightGridSet (OceanSampler on the CPU)', () => {
  it('returns mean sea level and an up normal before the first readback', () => {
    const g = new HeightGridSet();
    expect(g.heightAt(1, 2, 0)).toBe(0);
    expect(g.normalAt(1, 2, 0)).toEqual({ x: -0, y: 1, z: -0 });
  });

  it('takes sim-world (east, north) and looks up three.js (x = e, z = −n)', () => {
    const g = new HeightGridSet();
    g.push(snapshot((x, z) => x + 10 * z, () => [1, 10]));
    expect(g.heightAt(2, 3, 0)).toBeCloseTo(2 - 30, 4);
  });

  it('uses the fine grid inside, the coarse grid outside, and blends continuously at the edge', () => {
    const g = new HeightGridSet();
    // Fine grid sees +1 m everywhere; the coarse grid sees 0 m.
    const fineUp = snapshot(() => 0, () => [0, 0]);
    for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) fineUp.fine.data[(j * 18 + i) * 4] = 1;
    g.push(fineUp);
    expect(g.heightAt(0, 0, 0)).toBeCloseTo(1, 6);
    expect(g.heightAt(30, 0, 0)).toBeCloseTo(0, 6);
    let prev = g.heightAt(2.9, 0, 0);
    for (let e = 3; e <= 4.001; e += 0.05) {
      const h = g.heightAt(e, 0, 0);
      expect(Math.abs(h - prev)).toBeLessThan(0.07);
      prev = h;
    }
    expect(g.heightAt(3.99, 0, 0)).toBeLessThan(0.1);
  });

  it('extrapolates one frame ahead with the change between the last two readbacks', () => {
    const g = new HeightGridSet();
    const at = (t: number) => snapshot(() => 0.5 + 0.2 * t, () => [0, 0], { time: t });
    g.push(at(10));
    g.push(at(10 + 1 / 60));
    expect(g.heightAt(0, 0, 10 + 2 / 60)).toBeCloseTo(0.5 + 0.2 * (10 + 2 / 60), 6);
    // Never more than 0.1 s ahead: a stale readback must not run away.
    expect(g.heightAt(0, 0, 20)).toBeCloseTo(0.5 + 0.2 * (10 + 1 / 60 + 0.1), 6);
  });

  it('gives the unit normal of the sampled slope in the three.js frame', () => {
    const g = new HeightGridSet();
    g.push(snapshot((x, z) => 0.1 * x - 0.3 * z, () => [0.1, -0.3]));
    const n = g.normalAt(0, 0, 0);
    const l = Math.hypot(0.1, 1, 0.3);
    expect(n.x).toBeCloseTo(-0.1 / l, 6);
    expect(n.y).toBeCloseTo(1 / l, 6);
    expect(n.z).toBeCloseTo(0.3 / l, 6);
  });
});
