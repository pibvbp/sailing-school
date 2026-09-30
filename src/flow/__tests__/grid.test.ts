// VelocityGrid: the precomputed field the particle systems read every frame.
import { describe, expect, it } from 'vitest';
import { DEG } from '../../shared/math';
import type { Vec2 } from '../../shared/math';
import { VelocityGrid } from '../grid';
import { scaleToLift, solveSlice, velocityAt } from '../vortexLattice';
import type { SliceSolution } from '../vortexLattice';
import { camberLine } from '../slices';

// ---------------------------------------------------------------------------------------- helpers

/** Best mean cost (ms) of `fn` over several batches — immune to scheduler noise on a busy dev machine. */
function bestMeanMs(fn: () => void, iterations = 20, batches = 15): number {
  for (let i = 0; i < iterations; i++) fn(); // warm-up: let the JIT settle
  let best = Number.POSITIVE_INFINITY;
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    best = Math.min(best, (performance.now() - t0) / iterations);
  }
  return best;
}

const STREAM: Vec2 = { x: 6, y: 0 };
const BOUNDS = { x0: -4, y0: -2.5, x1: 3, y1: 2.5 };

/** Jib + main slice, 2 × 20 panels, flow frame (stream along +x, bellies toward +y). */
function sloopSolution(): SliceSolution {
  const dir = (deg: number): Vec2 => ({ x: Math.cos(deg * DEG), y: -Math.sin(deg * DEG) });
  const jibDir = dir(14);
  const main = camberLine({ le: { x: 0, y: 0 }, dir: dir(12), chord: 2.5, camber: 0.11, draft: 0.48 });
  const jib = camberLine({
    le: { x: 0.18 - 2.4 * jibDir.x, y: -0.45 - 2.4 * jibDir.y },
    dir: jibDir,
    chord: 2.4,
    camber: 0.12,
    draft: 0.42,
  });
  return scaleToLift(solveSlice([jib, main], STREAM), [1.4, 0.9], [2.4, 2.5]);
}

/** A 5 × 4 grid over [0,4] × [0,3] (unit spacing) holding u = 2x + 3y + 1 and v = x·y — both exactly bilinear. */
function bilinearGrid(): VelocityGrid {
  const g = new VelocityGrid({ x0: 0, y0: 0, x1: 4, y1: 3 }, 5, 4);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 5; i++) {
      g.data[2 * (j * 5 + i)] = 2 * i + 3 * j + 1;
      g.data[2 * (j * 5 + i) + 1] = i * j;
    }
  }
  return g;
}

// ---------------------------------------------------------------------------------------- contract

describe('VelocityGrid layout', () => {
  it('spans the bounds with nodes on both edges and interleaved (u, v) pairs, x fastest', () => {
    const g = new VelocityGrid({ x0: 1, y0: -2, x1: 5, y1: 4 }, 5, 4);
    expect([g.nx, g.ny, g.dx, g.dy]).toEqual([5, 4, 1, 2]);
    expect(g.bounds).toEqual({ x0: 1, y0: -2, x1: 5, y1: 4 });
    expect(g.data).toBeInstanceOf(Float32Array);
    expect(g.data).toHaveLength(2 * 5 * 4);
  });

  it('rejects grids that cannot be interpolated', () => {
    const b = { x0: 0, y0: 0, x1: 1, y1: 1 };
    expect(() => new VelocityGrid(b, 1, 4)).toThrow(RangeError);
    expect(() => new VelocityGrid(b, 4, 1)).toThrow(RangeError);
    expect(() => new VelocityGrid(b, 3.5, 4)).toThrow(RangeError);
    expect(() => new VelocityGrid({ x0: 1, y0: 0, x1: 1, y1: 1 }, 4, 4)).toThrow(RangeError);
    expect(() => new VelocityGrid({ x0: 0, y0: 2, x1: 1, y1: 1 }, 4, 4)).toThrow(RangeError);
    expect(() => new VelocityGrid({ x0: 0, y0: 0, x1: Number.NaN, y1: 1 }, 4, 4)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------- filling

describe('VelocityGrid.fill', () => {
  it('holds the free stream everywhere when there is nothing to disturb it', () => {
    const g = new VelocityGrid(BOUNDS, 7, 5);
    g.fill(solveSlice([], { x: 3, y: -1 }));
    expect(g.uInf).toEqual({ x: 3, y: -1 });
    for (let k = 0; k < 7 * 5; k++) {
      expect(g.data[2 * k]).toBe(3);
      expect(g.data[2 * k + 1]).toBe(-1);
    }
  });

  it('stores at node (i, j) the velocity velocityAt gives at that position', () => {
    const sol = sloopSolution();
    const [nx, ny] = [33, 25];
    const g = new VelocityGrid(BOUNDS, nx, ny);
    g.fill(sol);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = velocityAt(sol, BOUNDS.x0 + i * g.dx, BOUNDS.y0 + j * g.dy);
        const k = 2 * (j * nx + i);
        expect(Math.abs(g.data[k] - v.x)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(v.x)));
        expect(Math.abs(g.data[k + 1] - v.y)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(v.y)));
      }
    }
  });

  it('forwards an explicit core radius to the field', () => {
    const sol = sloopSolution();
    const g = new VelocityGrid(BOUNDS, 9, 7);
    g.fill(sol, 0.4);
    for (let j = 0; j < 7; j++) {
      for (let i = 0; i < 9; i++) {
        const v = velocityAt(sol, BOUNDS.x0 + i * g.dx, BOUNDS.y0 + j * g.dy, 0.4);
        expect(g.data[2 * (j * 9 + i)]).toBeCloseTo(v.x, 5);
        expect(g.data[2 * (j * 9 + i) + 1]).toBeCloseTo(v.y, 5);
      }
    }
  });

  it('overwrites every node on refill: a reused grid equals a fresh one', () => {
    const a = sloopSolution();
    const b = scaleToLift(a, [0.3, 0.2], [2.4, 2.5]);
    const reused = new VelocityGrid(BOUNDS, 16, 12);
    reused.fill(a);
    reused.fill(b);
    const fresh = new VelocityGrid(BOUNDS, 16, 12);
    fresh.fill(b);
    expect(Array.from(reused.data)).toEqual(Array.from(fresh.data));
    expect(reused.uInf).toEqual(b.uInf);
  });

  it('keeps its own copy of the free stream', () => {
    const sol = sloopSolution();
    const g = new VelocityGrid(BOUNDS, 4, 4);
    g.fill(sol);
    expect(g.uInf).toEqual(sol.uInf);
    expect(g.uInf).not.toBe(sol.uInf);
  });
});

// -------------------------------------------------------------------------------------- sampling

describe('VelocityGrid.sample', () => {
  it('interpolates bilinearly: exact for a bilinear field, at nodes and between them', () => {
    const g = bilinearGrid();
    for (const [x, y] of [[0, 0], [4, 3], [2, 1], [0.5, 0.5], [3.25, 2.75], [1.9, 0.1], [0.999, 1.001]] as const) {
      const v = g.sample(x, y);
      expect(v.x).toBeCloseTo(2 * x + 3 * y + 1, 12);
      expect(v.y).toBeCloseTo(x * y, 12);
    }
  });

  it('clamps to the edge outside the bounds', () => {
    const g = bilinearGrid();
    expect({ ...g.sample(-5, 1.5) }).toEqual({ x: 2 * 0 + 3 * 1.5 + 1, y: 0 });
    expect({ ...g.sample(9, 1.5) }).toEqual({ x: 2 * 4 + 3 * 1.5 + 1, y: 4 * 1.5 });
    expect({ ...g.sample(1, -7) }).toEqual({ x: 2 * 1 + 1, y: 0 });
    expect({ ...g.sample(1, 12) }).toEqual({ x: 2 * 1 + 3 * 3 + 1, y: 1 * 3 });
    expect({ ...g.sample(99, 99) }).toEqual({ x: 18, y: 12 });
  });

  it('does not allocate: without an out object it returns the same shared result every call', () => {
    const g = bilinearGrid();
    const first = g.sample(1, 1);
    expect(g.sample(2, 1)).toBe(first);
    expect(first).toEqual({ x: 2 * 2 + 3 * 1 + 1, y: 2 }); // holds the latest sample: valid until the next call
  });

  it('writes into a supplied out object and leaves the shared result alone', () => {
    const g = bilinearGrid();
    const shared = g.sample(1, 1);
    const snapshot = { x: shared.x, y: shared.y };
    const mine = { x: -1, y: -1 };
    expect(g.sample(3, 2, mine)).toBe(mine);
    expect(mine).toEqual({ x: 2 * 3 + 3 * 2 + 1, y: 6 });
    expect(shared).toEqual(snapshot);
  });

  it('reads the field it was filled with: sampling a node returns velocityAt there', () => {
    const sol = sloopSolution();
    const g = new VelocityGrid(BOUNDS, 33, 25);
    g.fill(sol);
    const [x, y] = [BOUNDS.x0 + 20 * g.dx, BOUNDS.y0 + 9 * g.dy];
    const [s, v] = [g.sample(x, y), velocityAt(sol, x, y)];
    expect(s.x).toBeCloseTo(v.x, 5);
    expect(s.y).toBeCloseTo(v.y, 5);
  });
});

// ------------------------------------------------------------------------------------- performance

describe('fill budget', () => {
  it('fills 64 × 48 nodes from 2 × 20 panels in under 5 ms (best mean of 15 batches of 20)', () => {
    const sol = sloopSolution();
    const g = new VelocityGrid(BOUNDS, 64, 48);
    expect(bestMeanMs(() => g.fill(sol))).toBeLessThan(5);
  });
});
