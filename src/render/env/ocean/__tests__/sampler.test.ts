import { describe, expect, it } from 'vitest';
import {
  HeightGridSet, meshFootprint, ProbePoints, sampleGrid, STENCIL_NODES, STENCIL_SPACING,
  type GridView, type HeightSnapshot, type ProbeView,
} from '../sampler';

type Field = (x: number, z: number) => number;
type Slope = (x: number, z: number) => [number, number];

const CELLS = 9;
const STRIDE = CELLS * 2;
const ROWS = CELLS + STENCIL_NODES;
const HALF = ((STENCIL_NODES - 1) / 2) * STENCIL_SPACING;

function fill(g: GridView, h: Field, slope: Slope): GridView {
  for (let j = 0; j < g.cells; j++) {
    for (let i = 0; i < g.cells; i++) {
      const x = g.originX + i * g.spacing, z = g.originZ + j * g.spacing;
      const o = ((g.row + j) * g.stride + g.column + i) * 4;
      const [sx, sz] = slope(x, z);
      g.data[o] = h(x, z); g.data[o + 1] = sx; g.data[o + 2] = sz; g.data[o + 3] = 1;
    }
  }
  return g;
}

/**
 * What the GPU probe writes, emulated on the CPU: the fine and coarse grids from `grids`, and the
 * registered points' 5 × 5 stencils from `drawn` (the drawn surface, wake included).
 */
function snapshot(
  grids: { h: Field; slope: Slope },
  opts: { fine?: [number, number, number]; coarse?: [number, number, number]; time?: number; points?: Array<{ x: number; z: number }>; drawn?: { h: Field; slope: Slope } } = {},
): HeightSnapshot {
  const data = new Float32Array(STRIDE * ROWS * 4);
  const grid = (column: number, [originX, originZ, spacing]: [number, number, number]): GridView =>
    fill({ data, stride: STRIDE, column, row: 0, cells: CELLS, originX, originZ, spacing }, grids.h, grids.slope);
  const drawn = opts.drawn ?? grids;
  const points = (opts.points ?? []).map((p, k) => fill({
    data, stride: STRIDE, column: k * STENCIL_NODES, row: CELLS, cells: STENCIL_NODES,
    originX: p.x - HALF, originZ: p.z - HALF, spacing: STENCIL_SPACING,
  }, drawn.h, drawn.slope));
  return {
    fine: grid(0, opts.fine ?? [-4, -4, 1]),
    coarse: grid(CELLS, opts.coarse ?? [-80, -80, 20]),
    points,
    time: opts.time ?? 0,
  };
}

const plane = (a: number, b: number, c: number) => ({
  h: (x: number, z: number) => a * x + b * z + c,
  slope: (): [number, number] => [a, b],
});

describe('sampleGrid (bilinear lookup)', () => {
  const p = plane(0.3, -0.2, 1.5);
  const s = snapshot(p);
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
    const bump = snapshot({ h: (x, z) => (x === 0 && z === 0 ? 1 : 0), slope: () => [0, 0] });
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

  it('reads the other blocks of a shared readback through their column and row offsets', () => {
    expect(sampleGrid(s.coarse, 50, -30, out)).toBe(true);
    expect(out.h).toBeCloseTo(p.h(50, -30), 4);
    const withPoint = snapshot(p, { points: [{ x: 30, z: 12 }] });
    expect(sampleGrid(withPoint.points[0]!, 30.6, 11.4, out)).toBe(true);
    expect(out.h).toBeCloseTo(p.h(30.6, 11.4), 5);
  });

  it('refuses non-finite data', () => {
    const bad = snapshot({ h: () => Number.NaN, slope: () => [0, 0] });
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
    g.push(snapshot({ h: (x, z) => x + 10 * z, slope: () => [1, 10] }));
    expect(g.heightAt(2, 3, 0)).toBeCloseTo(2 - 30, 4);
  });

  it('uses the fine grid inside, the coarse grid outside, and blends continuously at the edge', () => {
    const g = new HeightGridSet();
    // Fine grid sees +1 m everywhere; the coarse grid sees 0 m.
    const fineUp = snapshot({ h: () => 0, slope: () => [0, 0] });
    for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) fineUp.fine.data[(j * STRIDE + i) * 4] = 1;
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
    const at = (t: number) => snapshot({ h: () => 0.5 + 0.2 * t, slope: () => [0, 0] }, { time: t });
    g.push(at(10));
    g.push(at(10 + 1 / 60));
    expect(g.heightAt(0, 0, 10 + 2 / 60)).toBeCloseTo(0.5 + 0.2 * (10 + 2 / 60), 6);
    // Never more than a few readback intervals (≥ 0.1 s) ahead: a stale readback must not run away.
    expect(g.heightAt(0, 0, 20)).toBeCloseTo(0.5 + 0.2 * (10 + 1 / 60 + 0.1), 6);
  });

  it('keeps extrapolating when time runs faster than the readbacks (time scale 4×)', () => {
    const g = new HeightGridSet();
    const at = (t: number) => snapshot({ h: () => 0.2 * t, slope: () => [0, 0] }, { time: t });
    g.push(at(0));
    g.push(at(0.13)); // two frames at 4×
    expect(g.heightAt(0, 0, 0.13 + 0.2)).toBeCloseTo(0.2 * 0.33, 6);
  });

  it('gives the unit normal of the sampled slope in the three.js frame, into `out` when given', () => {
    const g = new HeightGridSet();
    g.push(snapshot({ h: (x, z) => 0.1 * x - 0.3 * z, slope: () => [0.1, -0.3] }));
    const out = { x: 0, y: 0, z: 0 };
    const n = g.normalAt(0, 0, 0, out);
    expect(n).toBe(out);
    const l = Math.hypot(0.1, 1, 0.3);
    expect(n.x).toBeCloseTo(-0.1 / l, 6);
    expect(n.y).toBeCloseTo(1 / l, 6);
    expect(n.z).toBeCloseTo(0.3 / l, 6);
  });
});

describe('registered probe points (marks, camera)', () => {
  it('registers an uncovered query, covers the ±0.6 m slope queries around it, and expires unused points', () => {
    const r = new ProbePoints(4, 10);
    expect(r.request(30, -12)).toBe(true);
    expect(r.request(30.6, -12)).toBe(true);
    expect(r.request(30, -12.6)).toBe(true);
    expect(r.points).toHaveLength(1);
    expect(r.request(80, 5)).toBe(true);
    expect(r.points).toHaveLength(2);
    for (let i = 0; i < 11; i++) { r.advance(); r.request(80, 5); }
    expect(r.points.map((p) => p.x)).toEqual([80]);
  });

  it('recycles the least recently used point when full, but never one still in use', () => {
    const r = new ProbePoints(2, 100);
    r.request(0, 0); r.advance(); r.advance(); r.request(10, 0);
    expect(r.request(20, 0)).toBe(true); // replaces (0, 0), idle for 2 frames
    expect(r.points.map((p) => p.x).sort((a, b) => a - b)).toEqual([10, 20]);
    expect(r.request(30, 0)).toBe(false); // both used this frame
  });

  it('matches the drawn surface at 30 m and 80 m from the boat, where the coarse grid cannot', () => {
    // The drawn sea: 12.4 m wind waves (the 12 kn peak) on a 9 s swell, plus a Kelvin ripple from the
    // boat's wake — what the surface vertex shader displaces the mesh by.
    const swell = (x: number, z: number) => 0.15 * Math.sin(0.0497 * (0.8 * x + 0.6 * z) + 0.3);
    const drawnH: Field = (x, z) => swell(x, z) + 0.2 * Math.sin((2 * Math.PI / 12.4) * (0.6 * x - 0.8 * z) + 1.1) + 0.03 * Math.cos(0.9 * x);
    const drawnSlope: Slope = (x, z) => {
      const e = 1e-4;
      return [(drawnH(x + e, z) - drawnH(x - e, z)) / (2 * e), (drawnH(x, z + e) - drawnH(x, z - e)) / (2 * e)];
    };
    // The 25 m coarse grid filters the wind sea away: only the swell survives there.
    const coarse = { h: swell, slope: (x: number, z: number): [number, number] => [0.0497 * 0.8 * 0.15 * Math.cos(0.0497 * (0.8 * x + 0.6 * z) + 0.3), 0.0497 * 0.6 * 0.15 * Math.cos(0.0497 * (0.8 * x + 0.6 * z) + 0.3)] };
    const boat = { e: 0, n: 0 };
    const marks = [{ e: 30 * Math.sin(0.7), n: 30 * Math.cos(0.7) }, { e: 80 * Math.sin(2.1), n: 80 * Math.cos(2.1) }];
    const reg = new ProbePoints();
    const grids = new HeightGridSet();
    // Frame 1: the marks ask (as Marks.update does: centre, then ±0.6 m) — not probed yet, so the coarse grid answers.
    grids.push(snapshot(coarse, { coarse: [-800, -800, 200] }));
    for (const m of marks) {
      grids.heightAt(m.e, m.n, 0);
      if (!grids.lastPoint && Math.hypot(m.e - boat.e, m.n - boat.n) > 4.5) reg.request(m.e, -m.n);
      for (const [de, dn] of [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]] as const) reg.request(m.e + de, -(m.n + dn));
    }
    expect(reg.points).toHaveLength(2);
    // Frame 2: the probe renders the registered stencils from the drawn surface.
    grids.push(snapshot(coarse, { coarse: [-800, -800, 200], points: reg.points, drawn: { h: drawnH, slope: drawnSlope }, time: 1 / 60 }));
    for (const m of marks) {
      for (const [de, dn] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]] as const) {
        const e = m.e + de, n = m.n + dn;
        expect(Math.abs(grids.heightAt(e, n, 1 / 60) - drawnH(e, -n))).toBeLessThan(1e-4);
      }
      // The slope the buoy rocks to (Marks: ±0.6 m central difference) matches the drawn surface's.
      const slopeE = (grids.heightAt(m.e + 0.6, m.n, 1 / 60) - grids.heightAt(m.e - 0.6, m.n, 1 / 60)) / 1.2;
      const drawnE = (drawnH(m.e + 0.6, -m.n) - drawnH(m.e - 0.6, -m.n)) / 1.2;
      expect(slopeE).toBeCloseTo(drawnE, 5);
      // Without the point probes (the review's failure): the coarse grid misses the wind sea there.
      const coarseOnly = new HeightGridSet();
      coarseOnly.push(snapshot(coarse, { coarse: [-800, -800, 200] }));
      const errors = [0, 1.5, 3, 4.5, 6].map((d) => Math.abs(coarseOnly.heightAt(m.e + d, m.n, 0) - drawnH(m.e + d, -m.n)));
      expect(Math.max(...errors)).toBeGreaterThan(0.1);
    }
  });

  it('never mixes sources when extrapolating (a new point probe vs an older grid readback)', () => {
    const g = new HeightGridSet();
    g.push(snapshot({ h: () => 0, slope: () => [0, 0] }, { time: 0 }));
    g.push(snapshot({ h: () => 0, slope: () => [0, 0] }, { time: 0.016, points: [{ x: 3, z: 3 }], drawn: { h: () => 0.25, slope: () => [0, 0] } }));
    expect(g.heightAt(3, -3, 0.05)).toBeCloseTo(0.25, 6);
  });
});

describe('mesh level of detail at a probe point', () => {
  const view: ProbeView = { camX: 0, camY: 3.6, camZ: 0, rowAngle: 0.0021, colAngle: 0.0035 };
  it('matches the projected grid: centimetres under the camera, metres at a distance', () => {
    expect(meshFootprint(view, 0, 0)).toBeLessThan(0.05);
    expect(meshFootprint(view, 30, 0)).toBeGreaterThan(0.3);
    expect(meshFootprint(view, 80, 0)).toBeGreaterThan(meshFootprint(view, 30, 0));
    expect(meshFootprint(view, 80, 0)).toBeLessThan(5);
  });
});
