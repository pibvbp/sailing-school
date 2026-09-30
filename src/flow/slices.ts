// Entry point of the flow module: re-exports the solver and the velocity grid, and adds the helper that turns a
// sail section's parameters into the camber line the solver wants.
//
// Typical per-slice update (spec §8.1, ~10 Hz per slice height):
//     const solved = solveSlice([jib, main], airVelocity);            // ≈ 60 µs for 2 × 20 panels
//     const loaded = scaleToLift(solved, [jibSection.cl, mainSection.cl], [jibSection.chord, mainSection.chord]);
//     grid.fill(solved);       // particles: grid.sample(x, y, out) — the tangent field; streamlines do not cross the cloth
//     loadGrid.fill(loaded);   // optional second grid: speeds/pressure at the force model's strength (≈ 0.3 ms each)
// with `jib`/`main` from `camberLine({ le: luff xy, dir: chordDir xy, chord, camber, draft, bellyToward: lee side })`.
// Read the caveat on `scaleToLift` before advecting particles through the scaled field.
import { clamp } from '../shared/math';
import type { Vec2 } from '../shared/math';
import type { Element2D } from './vortexLattice';

export { deltaCp, scaleToLift, solveSlice, velocityAt } from './vortexLattice';
export type { Element2D, PanelGeom, SliceSolution, SolveOptions } from './vortexLattice';
export { VelocityGrid } from './grid';
export type { GridBounds } from './grid';

export interface CamberLineSpec {
  /** Leading edge (luff) point. */
  le: Vec2;
  /** Direction leading edge → trailing edge (any length; it is normalised). */
  dir: Vec2;
  chord: number;
  /** Maximum depth / chord (0 = flat), like `SailSection.camber`. */
  camber: number;
  /** Position of maximum depth as a fraction of the chord, like `SailSection.draft`. Default 0.5; kept within 0.35…0.65. */
  draft?: number;
  /**
   * Direction the belly bulges toward (any length) — for a sail, the lee side, e.g. `{ x: 0, y: leewardY }` in the
   * boat frame. Default: the left of `dir`. Its component along the chord is ignored.
   */
  bellyToward?: Vec2;
  /** Number of points, ≥ 2. Default 21. */
  samples?: number;
}

/**
 * Camber line of a sail section: a cubic through the luff and the leech whose depth peaks at `draft` (a parabola for
 * draft 0.5), sampled evenly along the chord. Hand it to `solveSlice` as an element.
 */
export function camberLine(spec: CamberLineSpec): Element2D {
  const { le, dir, chord, camber } = spec;
  const len = Math.hypot(dir.x, dir.y);
  if (![le.x, le.y, dir.x, dir.y, chord, camber].every(Number.isFinite) || !(len > 0) || !(chord > 0)) {
    throw new RangeError('camberLine: needs finite inputs, a non-zero direction and a positive chord');
  }
  const samples = Math.max(2, Math.floor(spec.samples ?? 21));
  const tx = dir.x / len;
  const ty = dir.y / len;
  let nx = -ty;
  let ny = tx;
  const lee = spec.bellyToward;
  if (lee && lee.x * nx + lee.y * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  // y(s) = A·s + B·s² + C·s³ with y(0) = y(1) = 0, y′(d) = 0, y(d) = 1.
  const d = clamp(spec.draft ?? 0.5, 0.35, 0.65);
  const q = d * d * (1 - d) * (1 - d);
  const A = ((2 - 3 * d) * d) / q;
  const B = -(1 - 3 * d * d) / q;
  const C = (1 - 2 * d) / q;
  const depth = camber * chord;
  const points: Vec2[] = new Array(samples);
  for (let i = 0; i < samples; i++) {
    const s = i / (samples - 1);
    const h = depth * s * (A + s * (B + s * C));
    points[i] = { x: le.x + chord * s * tx + h * nx, y: le.y + chord * s * ty + h * ny };
  }
  return { points };
}
