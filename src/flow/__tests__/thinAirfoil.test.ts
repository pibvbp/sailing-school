// Accuracy of the 2-D lumped-vortex solver on a single element, checked against thin-airfoil theory,
// hand-derived one/two-panel fixtures and an independent numpy transcription of Katz & Plotkin (§12).
import { describe, expect, it } from 'vitest';
import { DEG } from '../../shared/math';
import type { Vec2 } from '../../shared/math';
import { deltaCp, scaleToLift, solveLinear, solveSlice, velocityAt } from '../vortexLattice';
import type { Element2D, SliceSolution } from '../vortexLattice';
import { camberLine } from '../slices';

// ---------------------------------------------------------------------------------------- helpers

/** Free stream of `speed` m/s meeting a plate that lies along +x at incidence α (flow tilted up by α). */
const flow = (alphaDeg: number, speed = 1): Vec2 => ({
  x: speed * Math.cos(alphaDeg * DEG),
  y: speed * Math.sin(alphaDeg * DEG),
});
const flatPlate = (chord = 1): Element2D => ({ points: [{ x: 0, y: 0 }, { x: chord, y: 0 }] });
const sum = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0);
const relErr = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

/** y = 4 (f/c) x (1 − x/c): parabolic camber, belly toward +y. Built here, independent of camberLine(). */
function parabola(fOverC: number, samples = 41, chord = 1): Element2D {
  const points: Vec2[] = [];
  for (let i = 0; i < samples; i++) {
    const x = (chord * i) / (samples - 1);
    points.push({ x, y: 4 * fOverC * x * (1 - x / chord) });
  }
  return { points };
}
const mapPoints = (el: Element2D, f: (p: Vec2) => Vec2): Element2D => ({ points: el.points.map(f) });
const mirrorY = (p: Vec2): Vec2 => ({ x: p.x, y: -p.y });
const rotate = (theta: number) => (p: Vec2): Vec2 => ({
  x: p.x * Math.cos(theta) - p.y * Math.sin(theta),
  y: p.x * Math.sin(theta) + p.y * Math.cos(theta),
});

/** Zero-lift angle (rad) from two solves — cl(α) is linear to good accuracy. */
function zeroLiftAngle(el: Element2D, panels = 20): number {
  const cl = (aDeg: number) => solveSlice([el], flow(aDeg), { panels }).cl[0];
  const [a1, a2] = [0, 4];
  const [c1, c2] = [cl(a1), cl(a2)];
  return (-c1 * (a2 - a1) * DEG) / (c2 - c1);
}

/** ∮ V·dl once counter-clockwise on a circle (trapezoid rule: exponentially accurate for this smooth periodic integrand). */
function circulationAround(sol: SliceSolution, cx: number, cy: number, radius: number, samples = 720): number {
  let total = 0;
  for (let m = 0; m < samples; m++) {
    const t = (2 * Math.PI * m) / samples;
    const v = velocityAt(sol, cx + radius * Math.cos(t), cy + radius * Math.sin(t));
    total += (-v.x * Math.sin(t) + v.y * Math.cos(t)) * radius * ((2 * Math.PI) / samples);
  }
  return total;
}

/** Perturbation of the flow along the free-stream direction at (x, y). */
function alongFlowPerturbation(sol: SliceSolution, x: number, y: number): number {
  const v = velocityAt(sol, x, y);
  const u = sol.uInf;
  const speed = Math.hypot(u.x, u.y);
  return ((v.x - u.x) * u.x + (v.y - u.y) * u.y) / speed;
}

// ------------------------------------------------------------------------- discretisation contract

describe('lumped vortex at ¼ panel, tangency at ¾ panel (hand-derived fixtures)', () => {
  it('one panel: Γ = π·U·c·sin α', () => {
    const [chord, speed, alpha] = [2.5, 3, 5];
    const sol = solveSlice([flatPlate(chord)], flow(alpha, speed), { panels: 1 });
    expect(sol.gammas[0]).toHaveLength(1);
    expect(sol.gammas[0][0]).toBeCloseTo(Math.PI * speed * chord * Math.sin(alpha * DEG), 9);
  });

  it('two panels: Γ = ¾ and ¼ of π·U·c·sin α', () => {
    const sol = solveSlice([flatPlate()], flow(5), { panels: 2 });
    const total = Math.PI * Math.sin(5 * DEG);
    expect(sol.gammas[0][0]).toBeCloseTo(0.75 * total, 9);
    expect(sol.gammas[0][1]).toBeCloseTo(0.25 * total, 9);
  });

  it('describes every panel by midpoint, LE→TE tangent, belly-side normal and length', () => {
    const sol = solveSlice([flatPlate(2)], flow(3), { panels: 4 });
    expect(sol.panels[0]).toHaveLength(4);
    sol.panels[0].forEach((p, j) => {
      expect(p.x).toBeCloseTo(0.25 + 0.5 * j, 12);
      expect(p.y).toBeCloseTo(0, 12);
      expect(p.ds).toBeCloseTo(0.5, 12);
      expect(p.tx).toBeCloseTo(1, 12);
      expect(p.ty).toBeCloseTo(0, 12);
      expect(p.nx).toBeCloseTo(0, 12);
      expect(p.ny).toBeCloseTo(1, 12);
    });
  });

  it('uses 20 panels per element by default and honours options.panels per element', () => {
    const els = [flatPlate(), flatPlate(2)];
    const dflt = solveSlice(els, flow(3));
    expect(dflt.panels.map((p) => p.length)).toEqual([20, 20]);
    expect(dflt.gammas.map((g) => g.length)).toEqual([20, 20]);
    expect(solveSlice(els, flow(3), { panels: 8 }).panels.map((p) => p.length)).toEqual([8, 8]);
    expect(solveSlice(els, flow(3), { panels: [5, 12] }).panels.map((p) => p.length)).toEqual([5, 12]);
  });

  it('spaces panels evenly along the arc even when the input vertices are unevenly spaced', () => {
    const p = parabola(0.1, 41).points;
    const uneven = [0, 1, 3, 20, 33, 37, 40].map((i) => p[i]); // dense at the LE, sparse mid-chord
    const ds = solveSlice([{ points: uneven }], flow(3), { panels: 10 }).panels[0].map((q) => q.ds);
    expect(Math.max(...ds) / Math.min(...ds)).toBeLessThan(1.01);
  });

  it('smooths a sparse camber line into the parabola instead of a kinked polyline', () => {
    const three = { points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.1 }, { x: 1, y: 0 }] }; // 3 points of y = 0.4x(1−x)
    const sol = solveSlice([three], flow(4));
    for (const p of sol.panels[0]) {
      expect(Math.abs(p.y - 0.4 * p.x * (1 - p.x))).toBeLessThan(2e-3); // a V-shaped polyline is off by 0.025 at x = ¼
    }
    const dense = solveSlice([parabola(0.1, 41)], flow(4));
    expect(relErr(sol.cl[0], dense.cl[0])).toBeLessThan(0.005);
  });

  it('ignores repeated vertices instead of dividing by a zero-length segment', () => {
    const p = parabola(0.1, 41).points;
    const repeated = [p[0], p[0], ...p.slice(1, 20), p[19], p[19], ...p.slice(20), p[40]];
    const sol = solveSlice([{ points: repeated }], flow(5));
    expect(sol.gammas[0].every(Number.isFinite)).toBe(true);
    expect(sol.cl[0]).toBeCloseTo(solveSlice([parabola(0.1, 41)], flow(5)).cl[0], 9);
  });
});

// -------------------------------------------------------------------------------------- flat plate

describe('flat plate (thin-airfoil theory)', () => {
  it.each([0.5, 1, 2, 4, 6])('cl = 2πα within 3 percent at α = %s°', (alpha) => {
    const cl = solveSlice([flatPlate()], flow(alpha)).cl[0];
    expect(relErr(cl, 2 * Math.PI * alpha * DEG)).toBeLessThan(0.03);
  });

  it.each([1, 3, 7, 20, 60])('cl = 2π sin α to 1e-9 with %d panels', (n) => {
    const cl = solveSlice([flatPlate()], flow(6), { panels: n }).cl[0];
    expect(cl).toBeCloseTo(2 * Math.PI * Math.sin(6 * DEG), 9);
  });

  it('gives no lift at zero incidence and negative lift at negative incidence', () => {
    expect(solveSlice([flatPlate()], flow(0)).cl[0]).toBeCloseTo(0, 12);
    expect(solveSlice([flatPlate()], flow(-3)).cl[0]).toBeCloseTo(-2 * Math.PI * Math.sin(3 * DEG), 9);
  });

  it('never mistakes a flat plate for a cambered one: at any orientation, positive incidence lifts to its left', () => {
    // Rounding noise makes the "area between camber line and chord" of a flat plate ±1e-17 depending on orientation.
    for (let deg = 0; deg < 360; deg += 7) {
      const rot = rotate(deg * DEG);
      const sol = solveSlice([mapPoints(flatPlate(), rot)], rot(flow(4)));
      expect(sol.cl[0], `rotated ${deg}°`).toBeCloseTo(2 * Math.PI * Math.sin(4 * DEG), 9);
    }
  });

  it('loads the plate like √((1−ξ)/ξ) with the centre of pressure at c/4', () => {
    const alpha = 5;
    const n = 20;
    const sol = solveSlice([flatPlate()], flow(alpha), { panels: n });
    const dcp = deltaCp(sol)[0];
    // Panel average of 4·sin α·√((1−ξ)/ξ):   ∫₀^ξ √((1−s)/s) ds = asin√ξ + √(ξ(1−ξ))
    const primitive = (xi: number) => Math.asin(Math.sqrt(xi)) + Math.sqrt(xi * (1 - xi));
    for (let j = 2; j <= 15; j++) {
      const exact = (4 * Math.sin(alpha * DEG) * (primitive((j + 1) / n) - primitive(j / n))) * n;
      expect(relErr(dcp[j], exact)).toBeLessThan(0.07);
    }
    const moment = sum(sol.gammas[0].map((g, j) => g * (sol.panels[0][j].x - 0.25 * sol.panels[0][j].ds)));
    expect(moment / sum(sol.gammas[0])).toBeCloseTo(0.25, 9);
  });
});

// ------------------------------------------------------------------------------------ cambered plate

describe('cambered plate', () => {
  it('parabolic camber f/c = 0.1: zero-lift angle within 5 % of −2f/c', () => {
    const alpha0 = zeroLiftAngle(parabola(0.1));
    expect(alpha0).toBeLessThan(-0.2 * 0.95);
    expect(alpha0).toBeGreaterThan(-0.2 * 1.05);
  });

  it('matches an independent numpy solution of the same lattice (f/c = 0.1, 20 panels)', () => {
    const at = (aDeg: number) => solveSlice([parabola(0.1)], flow(aDeg)).cl[0];
    expect(relErr(at(0), 1.233415932)).toBeLessThan(2e-4);
    expect(relErr(at(5), 1.776534632)).toBeLessThan(2e-4);
    expect(zeroLiftAngle(parabola(0.1))).toBeCloseTo(-0.197748406, 4);
  });

  it('recovers the thin-airfoil limit for small camber (f/c = 0.02 within 1 %)', () => {
    expect(relErr(zeroLiftAngle(parabola(0.02)), -0.04)).toBeLessThan(0.01);
  });

  it('is converged at the default 20 panels (curvature is evaluated at the ¾ point, not the panel middle)', () => {
    const coarse = zeroLiftAngle(parabola(0.1), 20);
    const fine = zeroLiftAngle(parabola(0.1), 100);
    expect(relErr(coarse, fine)).toBeLessThan(0.005);
  });

  it.each([
    ['belly up', 1],
    ['belly down', -1],
  ] as const)('panel normals point to the side the camber bulges to (%s)', (_name, side) => {
    const el = side === 1 ? parabola(0.1) : mapPoints(parabola(0.1), mirrorY);
    const u = side === 1 ? flow(4) : { x: flow(4).x, y: -flow(4).y };
    for (const p of solveSlice([el], u).panels[0]) expect(p.ny * side).toBeGreaterThan(0.9);
  });
});

// -------------------------------------------------------------------------- frames and handedness

describe('frame independence', () => {
  it('mirroring the whole problem (y → −y, so belly on the other side) keeps cl and mirrors the field', () => {
    const el = parabola(0.1);
    const u = flow(5);
    const a = solveSlice([el], u);
    const b = solveSlice([mapPoints(el, mirrorY)], mirrorY(u));
    expect(b.cl[0]).toBeCloseTo(a.cl[0], 9);
    for (const [x, y] of [[0.3, 0.2], [0.9, -0.4], [-0.5, 0.05], [2, 1]] as const) {
      const va = velocityAt(a, x, y);
      const vb = velocityAt(b, x, -y);
      expect(vb.x).toBeCloseTo(va.x, 9);
      expect(vb.y).toBeCloseTo(-va.y, 9);
    }
  });

  it('rotating the whole problem leaves cl unchanged and rotates the field', () => {
    const theta = 37 * DEG;
    const rot = rotate(theta);
    const el = parabola(0.1);
    const u = flow(5, 4);
    const a = solveSlice([el], u);
    const b = solveSlice([mapPoints(el, rot)], rot(u));
    expect(b.cl[0]).toBeCloseTo(a.cl[0], 9);
    for (const [x, y] of [[0.3, 0.2], [0.9, -0.4], [-0.5, 0.05]] as const) {
      const va = velocityAt(a, x, y);
      const vb = velocityAt(b, rot({ x, y }).x, rot({ x, y }).y);
      expect(vb.x).toBeCloseTo(rot(va).x, 9);
      expect(vb.y).toBeCloseTo(rot(va).y, 9);
    }
  });

  it('the belly side speeds the stream up and the other side slows it, in every orientation', () => {
    const configs: [string, Element2D, Vec2][] = [
      ['flat plate', flatPlate(), flow(8)],
      ['belly up', parabola(0.08), flow(4)],
      ['belly down', mapPoints(parabola(0.08), mirrorY), mirrorY(flow(4))],
      ['rotated', mapPoints(parabola(0.08), rotate(2.1)), rotate(2.1)(flow(4))],
    ];
    for (const [name, el, u] of configs) {
      const sol = solveSlice([el], u);
      const mid = sol.panels[0][10]; // belly-facing normal by contract
      const [px, py] = [(el.points[0].x + el.points[el.points.length - 1].x) / 2, (el.points[0].y + el.points[el.points.length - 1].y) / 2];
      expect(alongFlowPerturbation(sol, px + 1.5 * mid.nx, py + 1.5 * mid.ny), `${name}: belly side`).toBeGreaterThan(0.03);
      expect(alongFlowPerturbation(sol, px - 1.5 * mid.nx, py - 1.5 * mid.ny), `${name}: far side`).toBeLessThan(-0.03);
    }
  });
});

// ------------------------------------------------------------------------------------ velocity field

describe('velocityAt', () => {
  it('single lumped vortex: speed-up above it, downwash behind it (hand-derived)', () => {
    const sol = solveSlice([flatPlate()], flow(5), { panels: 1 }); // Γ = π sin α at (0.25, 0)
    const [s, c] = [Math.sin(5 * DEG), Math.cos(5 * DEG)];
    const above = velocityAt(sol, 0.25, 2); //  u' = Γ/(2π·2) = s/4
    expect(above.x).toBeCloseTo(c + s / 4, 9);
    expect(above.y).toBeCloseTo(s, 9);
    const behind = velocityAt(sol, 10.25, 0); // v' = −Γ/(2π·10) = −s/20
    expect(behind.x).toBeCloseTo(c, 9);
    expect(behind.y).toBeCloseTo(0.95 * s, 9);
  });

  it('has no flow through the plate: normal velocity vanishes at every ¾-point', () => {
    const sol = solveSlice([flatPlate(2)], flow(6, 4));
    for (const p of sol.panels[0]) {
      const v = velocityAt(sol, p.x + 0.25 * p.ds * p.tx, p.y + 0.25 * p.ds * p.ty, 1e-9);
      expect(v.x * p.nx + v.y * p.ny).toBeCloseTo(0, 9);
    }
  });

  it.each([
    ['belly up', parabola(0.1), flow(5), -1],
    ['belly down', mapPoints(parabola(0.1), mirrorY), mirrorY(flow(5)), 1],
  ] as const)('circulation about the element equals the lattice strength (%s)', (_n, el, u, sign) => {
    const sol = solveSlice([el], u);
    // Clockwise circulation (belly up, lift to the left of the stream) gives ∮ V·dl < 0 counter-clockwise.
    expect(circulationAround(sol, 0.5, 0, 5)).toBeCloseTo(sign * sum(sol.gammas[0]), 9);
    expect(sum(sol.gammas[0])).toBeCloseTo((sol.cl[0] * Math.hypot(u.x, u.y) * 1) / 2, 9);
  });

  it('far field is the free stream plus one point vortex of the total strength', () => {
    const sol = solveSlice([parabola(0.1)], flow(5));
    const [x, y] = [0.5, 200];
    const v = velocityAt(sol, x, y);
    const total = sum(sol.gammas[0]);
    expect((v.x - sol.uInf.x) / (total / (2 * Math.PI * y))).toBeCloseTo(1, 2);
    expect(Math.abs(v.y - sol.uInf.y)).toBeLessThan(0.01 * Math.abs(v.x - sol.uInf.x));
  });

  it('stays finite on top of a vortex and with a zero core', () => {
    const sol = solveSlice([parabola(0.1)], flow(5));
    for (const p of sol.panels[0]) {
      const [vx, vy] = [p.x - 0.25 * p.ds * p.tx, p.y - 0.25 * p.ds * p.ty];
      for (const core of [undefined, 0]) {
        const v = velocityAt(sol, vx, vy, core);
        expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
      }
    }
  });

  it('caps the swirl speed near a vortex at Γ/(2π·core); far away the core no longer matters', () => {
    const sol = solveSlice([flatPlate()], flow(5), { panels: 1 }); // one vortex, Γ = π sin α
    const gamma = sol.gammas[0][0];
    const perturbation = (r: number, core?: number) => {
      const v = velocityAt(sol, 0.25, r, core);
      return Math.hypot(v.x - sol.uInf.x, v.y - sol.uInf.y);
    };
    for (const r of [1e-4, 1e-3, 5e-3, 0.01, 0.02]) {
      expect(perturbation(r)).toBeLessThanOrEqual((gamma / (2 * Math.PI * 0.02)) * 1.01); // default core = 0.02·chord
    }
    expect(perturbation(0.005, 0.01)).toBeGreaterThan(5 * perturbation(0.005, 0.05)); // smaller core, faster swirl
    expect(perturbation(0.5, 0.01)).toBeCloseTo(perturbation(0.5, 0.001), 9);
  });

  it('has a default core of about 0.02·chord: plain 1/r two and a half cores out, much weaker well inside', () => {
    const sol = solveSlice([flatPlate()], flow(5), { panels: 1 });
    const singular = (r: number) => sol.gammas[0][0] / (2 * Math.PI * r);
    const perturbation = (r: number) => {
      const v = velocityAt(sol, 0.25, r);
      return Math.hypot(v.x - sol.uInf.x, v.y - sol.uInf.y);
    };
    expect(perturbation(0.05) / singular(0.05)).toBeGreaterThan(0.99);
    expect(perturbation(0.05) / singular(0.05)).toBeLessThan(1.01);
    expect(perturbation(0.005) / singular(0.005)).toBeLessThan(0.5);
  });

  it('scales its default core with the chord, so a scaled-up element sees the same field at scaled points', () => {
    const small = solveSlice([parabola(0.1, 41, 1)], flow(5));
    const big = solveSlice([parabola(0.1, 41, 3)], flow(5));
    for (const [x, y] of [[0.3, 0.02], [0.5, 0.11], [0.02, 0.01], [1.5, 0.4]] as const) {
      const a = velocityAt(small, x, y);
      const b = velocityAt(big, 3 * x, 3 * y);
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
    }
  });

  it('writes into a supplied output object without allocating a new one', () => {
    const sol = solveSlice([flatPlate()], flow(5));
    const out = { x: 0, y: 0 };
    const ret = velocityAt(sol, 0.4, 1, undefined, out);
    expect(ret).toBe(out);
    const fresh = velocityAt(sol, 0.4, 1);
    expect(out.x).toBeCloseTo(fresh.x, 12);
    expect(out.y).toBeCloseTo(fresh.y, 12);
  });
});

// -------------------------------------------------------------------------------------- deltaCp

describe('deltaCp', () => {
  it('is 2Γ/(U·Δs) per panel — hand-derived for two panels', () => {
    const sol = solveSlice([flatPlate()], flow(5), { panels: 2 }); // Γ = ¾, ¼ of π sin α; Δs = ½
    const s = Math.sin(5 * DEG);
    const dcp = deltaCp(sol)[0];
    expect(dcp[0]).toBeCloseTo(3 * Math.PI * s, 9);
    expect(dcp[1]).toBeCloseTo(Math.PI * s, 9);
  });

  it('is dimensionless: independent of the free-stream speed', () => {
    const a = deltaCp(solveSlice([parabola(0.1)], flow(5, 1)))[0];
    const b = deltaCp(solveSlice([parabola(0.1)], flow(5, 7)))[0];
    a.forEach((v, j) => expect(b[j]).toBeCloseTo(v, 9));
  });

  it('integrates to cl·chord (Kutta–Joukowski)', () => {
    for (const el of [flatPlate(2), parabola(0.1, 41, 2)]) {
      const sol = solveSlice([el], flow(5, 3));
      const integral = sum(deltaCp(sol)[0].map((v, j) => v * sol.panels[0][j].ds));
      expect(integral).toBeCloseTo(sol.cl[0] * 2, 9);
    }
  });

  it('is positive when the element lifts toward its belly, whichever way that side faces', () => {
    const up = deltaCp(solveSlice([parabola(0.1)], flow(5)))[0];
    const down = deltaCp(solveSlice([mapPoints(parabola(0.1), mirrorY)], mirrorY(flow(5))))[0];
    expect(up.slice(2).every((v) => v > 0)).toBe(true);
    down.forEach((v, j) => expect(v).toBeCloseTo(up[j], 9));
  });
});

// ---------------------------------------------------------------------------------- scaleToLift

describe('scaleToLift', () => {
  const plate10 = () => solveSlice([flatPlate()], flow(10), { panels: 2 }); // Γ ∝ [¾, ¼], cl = 2π sin 10° ≈ 1.09

  it('rescales the circulations to the target cl and keeps their distribution', () => {
    const scaled = scaleToLift(plate10(), [0.8], [1]);
    expect(scaled.cl[0]).toBeCloseTo(0.8, 12);
    expect(scaled.gammas[0][0]).toBeCloseTo(0.3, 12); // ΣΓ = ½·cl·U·c = 0.4, split ¾ : ¼
    expect(scaled.gammas[0][1]).toBeCloseTo(0.1, 12);
  });

  it('takes the target relative to the chord it is given', () => {
    const scaled = scaleToLift(plate10(), [0.8], [2]);
    expect(scaled.cl[0]).toBeCloseTo(0.8, 12);
    expect(sum(scaled.gammas[0])).toBeCloseTo(0.8, 12); // ½·0.8·1·2
  });

  it('falls back to the element chord when none is supplied', () => {
    const scaled = scaleToLift(plate10(), [0.8], []);
    expect(sum(scaled.gammas[0])).toBeCloseTo(0.4, 12);
  });

  it('a zero target removes the disturbance completely', () => {
    const scaled = scaleToLift(solveSlice([parabola(0.1)], flow(5, 3)), [0], [1]);
    expect(scaled.cl[0]).toBe(0);
    expect(scaled.gammas[0].every((g) => g === 0)).toBe(true);
    const v = velocityAt(scaled, 0.5, 0.05);
    expect(v.x).toBe(scaled.uInf.x);
    expect(v.y).toBe(scaled.uInf.y);
  });

  it('scales the whole induced field linearly', () => {
    const sol = solveSlice([parabola(0.1)], flow(5, 3));
    const half = scaleToLift(sol, [sol.cl[0] * 0.5], [1]);
    for (const [x, y] of [[0.3, 0.2], [0.9, -0.4], [-0.5, 0.05]] as const) {
      const [a, b] = [velocityAt(sol, x, y), velocityAt(half, x, y)];
      expect(b.x - sol.uInf.x).toBeCloseTo(0.5 * (a.x - sol.uInf.x), 12);
      expect(b.y - sol.uInf.y).toBeCloseTo(0.5 * (a.y - sol.uInf.y), 12);
    }
  });

  it('takes the sign of the target relative to the belly side: positive lifts toward the belly on either tack', () => {
    for (const [el, u] of [
      [parabola(0.1), flow(5)],
      [mapPoints(parabola(0.1), mirrorY), mirrorY(flow(5))],
    ] as const) {
      const sol = solveSlice([el], u);
      const pos = scaleToLift(sol, [1.2], [1]);
      const neg = scaleToLift(sol, [-0.4], [1]);
      expect(pos.cl[0]).toBeCloseTo(1.2, 12);
      expect(neg.cl[0]).toBeCloseTo(-0.4, 12);
      const mid = sol.panels[0][10];
      const belly = (s: SliceSolution) => alongFlowPerturbation(s, 0.5 + 1.5 * mid.nx, 1.5 * mid.ny);
      expect(belly(pos)).toBeGreaterThan(0.03);
      expect(belly(neg)).toBeLessThan(-0.005);
    }
  });

  it('leaves its input untouched and shares the geometry', () => {
    const sol = solveSlice([parabola(0.1)], flow(5));
    const before = sol.gammas[0].slice();
    const scaled = scaleToLift(sol, [0.5], [1]);
    expect(sol.gammas[0]).toEqual(before);
    expect(scaled.gammas[0]).not.toBe(sol.gammas[0]);
    expect(scaled.panels).toEqual(sol.panels);
    expect(scaled.uInf).toEqual(sol.uInf);
  });

  it('leaves elements without a usable target as solved', () => {
    const sol = solveSlice([flatPlate(), flatPlate()], flow(5));
    const scaled = scaleToLift(sol, [Number.NaN], [1, 1]);
    expect(scaled.gammas).toEqual(sol.gammas);
    expect(scaled.cl).toEqual(sol.cl);
    const partial = scaleToLift(sol, [0.3], [1, 1]);
    expect(partial.cl[0]).toBeCloseTo(0.3, 12);
    expect(partial.gammas[1]).toEqual(sol.gammas[1]);
  });

  it('keeps a well-conditioned distribution exactly, however far the target is from the solved lift', () => {
    const sol = solveSlice([parabola(0.1)], flow(-3.3)); // cl ≈ 0.87, loading one-signed but for a mild reversal at the luff
    const share = (g: number[]) => g.map((v) => v / sum(g));
    for (const target of [0.05, 0.4, 3.5]) {
      // 3.5 is four times the solved lift: a bigger target must not swap the shape for a generic one
      const scaled = scaleToLift(sol, [target], [1]);
      expect(scaled.cl[0]).toBeCloseTo(target, 12);
      share(scaled.gammas[0]).forEach((v, j) => expect(v).toBeCloseTo(share(sol.gammas[0])[j], 12));
    }
  });

  describe('when the solved lift is unusable (zero-lift incidence, or opposite in sign to the target)', () => {
    const el = parabola(0.1);
    const alpha0Deg = () => zeroLiftAngle(el) / DEG;
    for (const [name, offsetDeg] of [['at the zero-lift angle', 0], ['below the zero-lift angle', -3]] as const) {
      it(`still delivers the target with a finite, leading-edge-loaded distribution (${name})`, () => {
        const sol = solveSlice([el], flow(alpha0Deg() + offsetDeg));
        const scaled = scaleToLift(sol, [0.6], [1]);
        expect(scaled.cl[0]).toBeCloseTo(0.6, 12);
        const g = scaled.gammas[0];
        expect(g.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
        for (let j = 1; j < g.length; j++) expect(g[j]).toBeLessThan(g[j - 1]);
        expect(Math.max(...g)).toBeLessThan(0.3); // no single panel carries more than the whole ½·cl·c
      });
    }

    it('changes shape continuously as the incidence sweeps through zero lift (no popping)', () => {
      // A hard switch between "keep the solved shape" and "generic shape" would jump by 0.2+ between two
      // neighbouring incidences; a smooth blend moves by a few hundredths per 0.01°.
      let previous: number[] | null = null;
      const a0 = alpha0Deg();
      for (let a = a0 - 2; a <= a0 + 3; a += 0.01) {
        const g = scaleToLift(solveSlice([el], flow(a)), [0.6], [1]).gammas[0];
        const shape = g.map((v) => v / sum(g));
        if (previous) shape.forEach((v, j) => expect(Math.abs(v - previous![j])).toBeLessThan(0.03));
        previous = shape;
      }
    });
  });
});

// ------------------------------------------------------------------------------------ camberLine

describe('camberLine (analytic sail-section camber line)', () => {
  it('runs from the luff to the leech and is a parabola for draft 0.5', () => {
    const el = camberLine({ le: { x: 1, y: 2 }, dir: { x: 1, y: 0 }, chord: 4, camber: 0.1, draft: 0.5, samples: 5 });
    expect(el.points).toHaveLength(5);
    expect(el.points[0]).toEqual({ x: 1, y: 2 });
    expect(el.points[4].x).toBeCloseTo(5, 12);
    expect(el.points[4].y).toBeCloseTo(2, 12);
    // y = depth·4s(1−s), depth = camber·chord = 0.4: s = ¼ → 0.3, s = ½ → 0.4
    expect(el.points[1].y).toBeCloseTo(2 + 0.3, 12);
    expect(el.points[2].y).toBeCloseTo(2 + 0.4, 12);
  });

  it('puts the maximum depth at the draft position', () => {
    const el = camberLine({ le: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, chord: 1, camber: 0.11, draft: 0.4, samples: 21 });
    const depth = el.points.map((p) => p.y);
    expect(depth[8]).toBeCloseTo(0.11, 12); // s = 0.4 is sample 8: hand-derived cubic peaks at exactly camber·chord
    expect(depth[8]).toBeGreaterThan(depth[7]);
    expect(depth[8]).toBeGreaterThan(depth[9]);
    expect(depth.every((d) => d >= -1e-12)).toBe(true);
  });

  it('bulges to the left of the chord by default and toward bellyToward when given', () => {
    const left = camberLine({ le: { x: 0, y: 0 }, dir: { x: 0, y: 1 }, chord: 2, camber: 0.1, samples: 3 });
    expect(left.points[1].x).toBeCloseTo(-0.2, 12); // left of +y is −x
    const right = camberLine({ le: { x: 0, y: 0 }, dir: { x: 0, y: 1 }, chord: 2, camber: 0.1, samples: 3, bellyToward: { x: 1, y: 0 } });
    expect(right.points[1].x).toBeCloseTo(0.2, 12);
  });

  it('keeps the chord length on a tilted chord line', () => {
    const el = camberLine({ le: { x: 0, y: 0 }, dir: { x: 3, y: 4 }, chord: 2.5, camber: 0.12, draft: 0.45 });
    const [a, b] = [el.points[0], el.points[el.points.length - 1]];
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(2.5, 12);
  });

  it('rejects a zero direction or a non-positive chord', () => {
    expect(() => camberLine({ le: { x: 0, y: 0 }, dir: { x: 0, y: 0 }, chord: 1, camber: 0.1 })).toThrow(RangeError);
    expect(() => camberLine({ le: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, chord: 0, camber: 0.1 })).toThrow(RangeError);
  });
});

// ------------------------------------------------------------------------------------- dense solve

describe('dense solve (Gaussian elimination with partial pivoting)', () => {
  /** Solve the system given as rows [a₁…aₙ | b]; returns x. */
  const solve = (rows: number[][]): number[] => {
    const n = rows.length;
    const a = new Float64Array(n * (n + 1));
    rows.forEach((row, i) => row.forEach((v, j) => (a[i * (n + 1) + j] = v)));
    solveLinear(a, n);
    return Array.from({ length: n }, (_, i) => a[i * (n + 1) + n]);
  };

  it('pivots past a zero on the diagonal', () => {
    const x = solve([[0, 2, 4], [3, 1, 5]]); // 2y = 4, 3x + y = 5
    expect(x[0]).toBeCloseTo(1, 12);
    expect(x[1]).toBeCloseTo(2, 12);
  });

  it('recovers the known answer of a 6 × 6 system', () => {
    const truth = [1, -2, 3, 0.5, -4, 7];
    const rows = truth.map((_, i) => {
      const coeffs = truth.map((__, j) => ((3 * i + 5 * j + 1) % 7) - 3 + (i === (j + 2) % 6 ? 9 : 0)); // needs row exchanges
      return [...coeffs, coeffs.reduce((s, c, j) => s + c * truth[j], 0)];
    });
    solve(rows).forEach((v, i) => expect(v).toBeCloseTo(truth[i], 9));
  });

  it('leaves the unknown of a singular system at 0 instead of producing NaN', () => {
    const x = solve([[1, 2, 3], [2, 4, 6]]);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(x[0] + 2 * x[1]).toBeCloseTo(3, 12); // still a solution of the consistent system
  });
});

// ------------------------------------------------------------------------------------ bad input

describe('degenerate and invalid input', () => {
  it('no elements: empty solution and an undisturbed stream', () => {
    const sol = solveSlice([], { x: 3, y: -1 });
    expect(sol.gammas).toEqual([]);
    expect(sol.panels).toEqual([]);
    expect(sol.cl).toEqual([]);
    expect(velocityAt(sol, 1, 1)).toEqual({ x: 3, y: -1 });
  });

  it('an element with fewer than two distinct points gets no panels but keeps its index', () => {
    const sol = solveSlice([{ points: [{ x: 0, y: 0 }] }, flatPlate(), { points: [{ x: 2, y: 2 }, { x: 2, y: 2 }] }], flow(5));
    expect(sol.panels.map((p) => p.length)).toEqual([0, 20, 0]);
    expect(sol.gammas.map((g) => g.length)).toEqual([0, 20, 0]);
    expect(sol.cl[0]).toBe(0);
    expect(sol.cl[2]).toBe(0);
    expect(sol.cl[1]).toBeCloseTo(2 * Math.PI * Math.sin(5 * DEG), 9);
  });

  it('zero free stream: no circulation, no NaN', () => {
    const sol = solveSlice([parabola(0.1)], { x: 0, y: 0 });
    expect(sol.cl[0]).toBe(0);
    expect(sol.gammas[0].every((g) => g === 0)).toBe(true);
    expect(deltaCp(sol)[0].every((v) => v === 0)).toBe(true);
    expect(scaleToLift(sol, [1], [1]).cl[0]).toBe(0);
  });

  it('two coincident elements (a singular system) give a bounded answer rather than NaN or overflow', () => {
    const sol = solveSlice([parabola(0.1), parabola(0.1)], flow(5));
    const all = sol.gammas.flat();
    expect(all.every(Number.isFinite)).toBe(true);
    expect(Math.max(...all.map(Math.abs))).toBeLessThan(10); // a lone element carries at most ~0.3 per panel here
    const v = velocityAt(sol, 0.5, 0.3);
    expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
  });

  it('rejects non-finite coordinates, a non-finite free stream and unusable panel counts', () => {
    const bad = { points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }] };
    expect(() => solveSlice([bad], flow(3))).toThrow(RangeError);
    expect(() => solveSlice([flatPlate()], { x: Number.POSITIVE_INFINITY, y: 0 })).toThrow(RangeError);
    for (const panels of [0, 2.5, -4, 1000]) {
      expect(() => solveSlice([flatPlate()], flow(3), { panels })).toThrow(RangeError);
    }
  });

  it('does not modify its inputs, and keeps its own copy of the free stream', () => {
    const el = Object.freeze({ points: Object.freeze(parabola(0.1).points.map((p) => Object.freeze({ ...p }))) as Vec2[] });
    const u = Object.freeze(flow(5));
    const sol = solveSlice([el], u, Object.freeze({ panels: 12 }));
    expect(sol.uInf).toEqual(u);
    expect(sol.uInf).not.toBe(u);
  });
});
