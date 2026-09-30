// Jib + main in one coupled solve: upwash on the jib, downwash on the main (the "slot" interaction),
// tack symmetry in the boat frame, and the solve-time budget.
import { describe, expect, it } from 'vitest';
import { DEG } from '../../shared/math';
import type { Vec2 } from '../../shared/math';
import { scaleToLift, solveSlice, velocityAt } from '../vortexLattice';
import type { Element2D } from '../vortexLattice';
import { camberLine } from '../slices';
import * as flow from '../slices';

// ---------------------------------------------------------------------------------------- helpers

const sum = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0);
const relErr = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

/** Best mean cost (ms) of `fn` over several batches — immune to scheduler noise on a busy dev machine. */
function bestMeanMs(fn: () => void, iterations = 200, batches = 15): number {
  for (let i = 0; i < iterations; i++) fn(); // warm-up: let the JIT settle
  let best = Number.POSITIVE_INFINITY;
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    best = Math.min(best, (performance.now() - t0) / iterations);
  }
  return best;
}

/** Chord direction of a section at incidence α to a stream along +x, lift toward +y: nose up, so the TE sits lower. */
const chordAtIncidence = (alphaDeg: number): Vec2 => ({ x: Math.cos(alphaDeg * DEG), y: -Math.sin(alphaDeg * DEG) });

/**
 * A horizontal slice through a sloop in the flow frame (stream along +x, both bellies toward +y):
 * main luff at the origin; jib ahead of it with its trailing edge at `jibTe`
 * (negative y = to windward, x > 0 = overlapping aft of the main's luff).
 */
function flowFrameSloop(jibTe: Vec2 = { x: 0.18, y: -0.45 }): { main: Element2D; jib: Element2D } {
  const jibDir = chordAtIncidence(14);
  return {
    main: camberLine({ le: { x: 0, y: 0 }, dir: chordAtIncidence(12), chord: 2.5, camber: 0.11, draft: 0.5 }),
    jib: camberLine({
      le: { x: jibTe.x - 2.4 * jibDir.x, y: jibTe.y - 2.4 * jibDir.y },
      dir: jibDir,
      chord: 2.4,
      camber: 0.12,
      draft: 0.5,
    }),
  };
}
const STREAM: Vec2 = { x: 1, y: 0 };

/**
 * The same kind of slice in the boat frame the simulation uses (x forward, y to starboard), wind from 25° off the
 * starboard bow (the air moves aft and to port). Sails belly to leeward: to port on starboard tack.
 */
function boatFrameSloop(tack: 'starboard' | 'port'): { main: Element2D; jib: Element2D; air: Vec2 } {
  const m = tack === 'starboard' ? 1 : -1; // mirror factor for y
  const toLee = { x: 0, y: -m }; // leeward side
  const dir = (deg: number): Vec2 => ({ x: -Math.cos(deg * DEG), y: -m * Math.sin(deg * DEG) }); // aft, toward lee
  return {
    main: camberLine({ le: { x: 1.05, y: 0 }, dir: dir(12), chord: 2.5, camber: 0.11, draft: 0.5, bellyToward: toLee }),
    jib: camberLine({ le: { x: 3.4, y: 0 }, dir: dir(15), chord: 2.4, camber: 0.12, draft: 0.5, bellyToward: toLee }),
    air: { x: -6 * Math.cos(25 * DEG), y: -m * 6 * Math.sin(25 * DEG) },
  };
}

// ---------------------------------------------------------------------------------- coupled solve

describe('two elements in one solve', () => {
  it('two collinear flat plates, one panel each: upstream gains 25 %, downstream loses 25 % (hand-derived)', () => {
    const a = 5 * DEG;
    const plates = [
      { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
      { points: [{ x: 2, y: 0 }, { x: 3, y: 0 }] },
    ];
    const sol = solveSlice(plates, { x: Math.cos(a), y: Math.sin(a) }, { panels: 1 });
    const isolated = Math.PI * Math.sin(a); // Γ of a lone plate
    expect(sol.gammas[0][0]).toBeCloseTo(1.25 * isolated, 9);
    expect(sol.gammas[1][0]).toBeCloseTo(0.75 * isolated, 9);
    expect(sol.cl[0]).toBeCloseTo(2.5 * Math.PI * Math.sin(a), 9);
    expect(sol.cl[1]).toBeCloseTo(1.5 * Math.PI * Math.sin(a), 9);
  });

  it('jib ahead of and to windward of the main, overlapping: main loses lift, jib gains lift', () => {
    const { main, jib } = flowFrameSloop();
    const isolatedJib = solveSlice([jib], STREAM).cl[0];
    const isolatedMain = solveSlice([main], STREAM).cl[0];
    const both = solveSlice([jib, main], STREAM);
    expect(both.cl[1]).toBeLessThan(isolatedMain);
    expect(both.cl[0]).toBeGreaterThan(isolatedJib);
    // Potential flow at this gap is strong, but not absurd: main down by tens of percent, jib up by tens.
    expect(both.cl[1] / isolatedMain).toBeGreaterThan(0.1);
    expect(both.cl[1] / isolatedMain).toBeLessThan(0.97);
    expect(both.cl[0] / isolatedJib).toBeGreaterThan(1.01);
    expect(both.cl[0] / isolatedJib).toBeLessThan(1.6);
  });

  it('matches an independent numpy solution of the same slice', () => {
    const { main, jib } = flowFrameSloop();
    expect(relErr(solveSlice([jib], STREAM).cl[0], 2.946525044)).toBeLessThan(2e-4);
    expect(relErr(solveSlice([main], STREAM).cl[0], 2.629321809)).toBeLessThan(2e-4);
    const both = solveSlice([jib, main], STREAM);
    expect(relErr(both.cl[0], 3.740439545)).toBeLessThan(2e-4);
    expect(relErr(both.cl[1], 1.028843063)).toBeLessThan(2e-4);
  });

  it('keeps that sign pattern for every jib position in a sweep of windward offsets and overlaps', () => {
    const { main } = flowFrameSloop();
    const isolatedMain = solveSlice([main], STREAM).cl[0];
    for (const x of [-0.6, -0.2, 0.18]) {
      for (const y of [-1.0, -0.7, -0.45, -0.2]) {
        const { jib } = flowFrameSloop({ x, y });
        const isolatedJib = solveSlice([jib], STREAM).cl[0];
        const both = solveSlice([jib, main], STREAM);
        expect(both.cl[1], `main, jib TE at (${x}, ${y})`).toBeLessThan(isolatedMain);
        expect(both.cl[0], `jib, jib TE at (${x}, ${y})`).toBeGreaterThan(isolatedJib);
      }
    }
  });

  it('shows why: the main induces upwash where the jib sits, the jib induces downwash at the main luff', () => {
    const { main, jib } = flowFrameSloop();
    const mainOnly = solveSlice([main], STREAM);
    const jibOnly = solveSlice([jib], STREAM);
    const jibMid = { x: (jib.points[0].x + jib.points[jib.points.length - 1].x) / 2, y: (jib.points[0].y + jib.points[jib.points.length - 1].y) / 2 };
    const upwash = velocityAt(mainOnly, jibMid.x, jibMid.y).y - STREAM.y; // lift is toward +y
    const downwash = velocityAt(jibOnly, 0.3, 0).y - STREAM.y;
    expect(upwash).toBeGreaterThan(0.05);
    expect(downwash).toBeLessThan(-0.05);
  });

  it('does not depend on the order of the elements', () => {
    const { main, jib } = flowFrameSloop();
    const ab = solveSlice([jib, main], STREAM);
    const ba = solveSlice([main, jib], STREAM);
    expect(ba.cl[0]).toBeCloseTo(ab.cl[1], 9);
    expect(ba.cl[1]).toBeCloseTo(ab.cl[0], 9);
    for (const [x, y] of [[0.3, -0.2], [-1, 0.3], [2, 1.5]] as const) {
      const [va, vb] = [velocityAt(ab, x, y), velocityAt(ba, x, y)];
      expect(vb.x).toBeCloseTo(va.x, 9);
      expect(vb.y).toBeCloseTo(va.y, 9);
    }
  });

  it('interference fades with distance: a jib 5 km upstream leaves the main as isolated', () => {
    const { main, jib } = flowFrameSloop();
    const far = { points: jib.points.map((p) => ({ x: p.x - 5000, y: p.y })) };
    const isolated = solveSlice([main], STREAM).cl[0];
    expect(relErr(solveSlice([far, main], STREAM).cl[1], isolated)).toBeLessThan(1e-3);
  });

  it('is stable up to 60 panels per element and changes little with the panel count', () => {
    const { main, jib } = flowFrameSloop();
    const s20 = solveSlice([jib, main], STREAM);
    const s60 = solveSlice([jib, main], STREAM, { panels: 60 });
    for (const e of [0, 1]) expect(relErr(s60.cl[e], s20.cl[e])).toBeLessThan(0.03);
    expect(s60.gammas.every((g) => g.every(Number.isFinite))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------- tack symmetry

describe('boat-frame slice (x forward, y starboard): both tacks give the same physics', () => {
  const NUMPY = { jibAlone: 2.538562318, mainAlone: 2.731331688, jibWith: 3.596718364, mainWith: 1.320992715 };

  it.each(['starboard', 'port'] as const)('%s tack reproduces the independent numpy solution', (tack) => {
    const { main, jib, air } = boatFrameSloop(tack);
    expect(relErr(solveSlice([jib], air).cl[0], NUMPY.jibAlone)).toBeLessThan(2e-4);
    expect(relErr(solveSlice([main], air).cl[0], NUMPY.mainAlone)).toBeLessThan(2e-4);
    const both = solveSlice([jib, main], air);
    expect(relErr(both.cl[0], NUMPY.jibWith)).toBeLessThan(2e-4);
    expect(relErr(both.cl[1], NUMPY.mainWith)).toBeLessThan(2e-4);
  });

  it('port tack is the exact mirror image of starboard tack, field included', () => {
    const [s, p] = [boatFrameSloop('starboard'), boatFrameSloop('port')];
    const a = solveSlice([s.jib, s.main], s.air);
    const b = solveSlice([p.jib, p.main], p.air);
    a.cl.forEach((c, e) => expect(b.cl[e]).toBeCloseTo(c, 9));
    for (const [x, y] of [[2.0, -0.5], [0.5, 0.8], [3.5, -1.2], [1.0, -0.1]] as const) {
      const [va, vb] = [velocityAt(a, x, y), velocityAt(b, x, -y)];
      expect(vb.x).toBeCloseTo(va.x, 9);
      expect(vb.y).toBeCloseTo(-va.y, 9);
    }
  });

  it('the physics-model lift (positive toward the belly on either tack) can be passed straight in', () => {
    for (const tack of ['starboard', 'port'] as const) {
      const { main, jib, air } = boatFrameSloop(tack);
      const scaled = scaleToLift(solveSlice([jib, main], air), [1.4, 0.9], [2.4, 2.5]);
      expect(scaled.cl[0]).toBeCloseTo(1.4, 12);
      expect(scaled.cl[1]).toBeCloseTo(0.9, 12);
    }
  });
});

// ------------------------------------------------------------------------------ scaling per element

describe('scaleToLift on two elements', () => {
  it('rescales each element by its own factor and keeps each element’s distribution', () => {
    const { main, jib } = flowFrameSloop();
    const sol = solveSlice([jib, main], STREAM);
    const scaled = scaleToLift(sol, [1.4, 0.9], [2.4, 2.5]);
    expect(scaled.cl[0]).toBeCloseTo(1.4, 12);
    expect(scaled.cl[1]).toBeCloseTo(0.9, 12);
    for (const e of [0, 1]) {
      const share = (g: number[]) => g.map((v) => v / sum(g));
      share(scaled.gammas[e]).forEach((v, j) => expect(v).toBeCloseTo(share(sol.gammas[e])[j], 12));
    }
  });
});

// -------------------------------------------------------------------------------------- entry point

describe('entry point (src/flow/slices)', () => {
  it('runs the documented per-slice pipeline using nothing but that one import', () => {
    const jibDir = chordAtIncidence(14);
    const main = flow.camberLine({ le: { x: 0, y: 0 }, dir: chordAtIncidence(12), chord: 2.5, camber: 0.11, draft: 0.48 });
    const jib = flow.camberLine({ le: { x: 0.18 - 2.4 * jibDir.x, y: -0.45 - 2.4 * jibDir.y }, dir: jibDir, chord: 2.4, camber: 0.12, draft: 0.42 });
    const solved: flow.SliceSolution = flow.solveSlice([jib, main], STREAM);
    const loaded = flow.scaleToLift(solved, [1.4, 0.9], [2.4, 2.5]);
    const grid = new flow.VelocityGrid({ x0: -4, y0: -2.5, x1: 3, y1: 2.5 }, 32, 24);
    grid.fill(solved);

    expect(loaded.cl[0]).toBeCloseTo(1.4, 12);
    expect(loaded.cl[1]).toBeCloseTo(0.9, 12);
    expect(flow.deltaCp(loaded).map((row) => row.length)).toEqual([20, 20]);
    const [fromGrid, exact] = [grid.sample(-2, 1), flow.velocityAt(solved, -2, 1)];
    expect(fromGrid.x).toBeCloseTo(exact.x, 1); // 0.22 m cells: interpolation error stays small in the open flow
    expect(fromGrid.y).toBeCloseTo(exact.y, 1);
  });
});

// ------------------------------------------------------------------------------------- performance

describe('solve budget', () => {
  it('solves 2 elements × 20 panels in under 1 ms (best mean of 15 batches of 200)', () => {
    const { main, jib } = flowFrameSloop();
    const ms = bestMeanMs(() => solveSlice([jib, main], STREAM));
    expect(ms).toBeLessThan(1);
  });

  it('solve + scale to the force model together stay under 1 ms as well', () => {
    const { main, jib } = flowFrameSloop();
    const ms = bestMeanMs(() => scaleToLift(solveSlice([jib, main], STREAM), [1.4, 0.9], [2.4, 2.5]));
    expect(ms).toBeLessThan(1);
  });
});
