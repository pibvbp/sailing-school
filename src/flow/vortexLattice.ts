// 2-D lumped-vortex ("discrete vortex") flow solver for horizontal slices through the sails (spec §8.1).
//
// Each sail section is a thin camber line, split into N panels of equal arc length. A point vortex sits at the ¼-panel
// point and flow tangency is enforced at the ¾-panel point (Katz & Plotkin §12) — that pairing satisfies the Kutta
// condition at the trailing edge implicitly. The tangency direction used is that of the curve at the ¾ point
// (interpolated between neighbouring panels), which makes the scheme second-order on curved camber lines. The vortex
// strengths of all elements of a slice are solved together, so each sail's circulation changes the flow the other
// one sees: upwash on the jib, downwash on the main (the "slot").
//
// Conventions (read before integrating — this is where sign bugs live):
//  * Coordinates are metres in any 2-D frame you like (rig plane, boat frame, flow frame). Camber lines run
//    leading edge → trailing edge (luff → leech); `uInf` is the velocity of the air relative to the sails.
//  * The solver never asks which tack you are on. Circulation, lift and pressure jump are signed RELATIVE TO THE
//    ELEMENT'S BELLY: positive means the resultant force acts toward the side the camber line bulges to — the lee
//    side of a sail — exactly like the section `cl` of the sail force model, on port and starboard tack alike.
//    (A perfectly flat element has no belly; its "belly" is the left of LE → TE, so positive lift = left of the stream.)
//  * `panels[e][j].(nx, ny)` is therefore the unit normal toward the belly side, i.e. toward the suction side:
//    ΔCp > 0 means the panel is pushed along +n. The LE → TE unit tangent is `(tx, ty)`; `(x, y)` is the panel midpoint;
//    the vortex sits at midpoint − ¼·ds·t and the tangency point at midpoint + ¼·ds·t.
//  * Circulation Γ has units m²/s. Section lift coefficient (Kutta–Joukowski):  cl = 2·ΣΓ / (|U∞|·chord),
//    chord = distance leading edge → trailing edge. Pressure jump per panel:  ΔCp = 2·Γ / (|U∞|·Δs).
//
// Not modelled: thickness, wake roll-up, stall — `scaleToLift` brings the circulation up or down to the sail force
// model's lift (which includes stall and luffing) while keeping the distribution shape.
import { smoothstep } from '../shared/math';
import type { Vec2 } from '../shared/math';

/** A sail section's camber line, leading edge → trailing edge, in slice coordinates (m). */
export interface Element2D {
  points: Vec2[];
}

/** One lattice panel. See the conventions at the top of this file. */
export interface PanelGeom {
  /** Panel midpoint. */
  x: number;
  y: number;
  /** Unit normal toward the element's belly (suction) side. */
  nx: number;
  ny: number;
  /** Panel length. */
  ds: number;
  /** Unit tangent, leading edge → trailing edge. */
  tx: number;
  ty: number;
}

export interface SliceSolution {
  /** Bound circulation per panel (m²/s), positive toward the belly side, per element. */
  gammas: number[][];
  panels: PanelGeom[][];
  /** Free-stream velocity the solution was computed for. */
  uInf: Vec2;
  /** Section lift coefficient per element, belly-signed (see the conventions above). */
  cl: number[];
}

export interface SolveOptions {
  /** Panels per element: one number for all elements, or one per element. Default 20; 1…200. */
  panels?: number | readonly number[];
}

const DEFAULT_PANELS = 20;
const MAX_PANELS = 200;
const TWO_PI = 2 * Math.PI;
/** Default vortex-core radius as a fraction of the element chord (spec: ≈ 0.02·chord). */
const CORE_FRACTION = 0.02;
const CORE_FLOOR = 1e-18; // core² floor: keeps a zero core finite when a point lands exactly on a vortex
const R2_FLOOR = 1e-30;
const EPS = 1e-12;
/** Σ|Γ| / |ΣΓ| of the solved loading up to which it is used as it is (see scaleToLift)… */
const CANCEL_LO = 2.5;
/** …and beyond which it is replaced by the flat-plate loading. */
const CANCEL_HI = 5;
/** |mean signed camber depth| / chord below which an element counts as flat (no belly side). */
const FLAT_CAMBER = 1e-4;

// ---------------------------------------------------------------------------------------- geometry

interface Nodes {
  xs: Float64Array;
  ys: Float64Array;
}

function checkFinite(points: readonly Vec2[]): void {
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new RangeError('solveSlice: camber-line points must be finite numbers');
    }
  }
}

function panelCount(spec: SolveOptions['panels'], element: number): number {
  const n = typeof spec === 'number' ? spec : spec?.[element];
  if (n === undefined) return DEFAULT_PANELS;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PANELS) {
    throw new RangeError(`solveSlice: panels must be an integer in 1…${MAX_PANELS}, got ${n}`);
  }
  return n;
}

/**
 * The n+1 panel nodes: equally spaced in arc length along the smooth (cubic Hermite, chord-length parametrised)
 * curve through `points`, so a sparse camber line is smoothed rather than turned into a kinked polyline.
 * Returns null when there is no curve (fewer than two distinct points).
 */
function discretise(points: readonly Vec2[], n: number): Nodes | null {
  checkFinite(points);
  const count = points.length;
  let length = 0;
  for (let i = 1; i < count; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  if (count < 2 || !(length > 0)) return null;

  // Drop coincident vertices (relative tolerance, so the result is scale-invariant): a zero-length segment would
  // divide by zero in the spline.
  const tol = 1e-9 * length;
  const px = [points[0].x];
  const py = [points[0].y];
  for (let i = 1; i < count; i++) {
    const last = px.length - 1;
    if (Math.hypot(points[i].x - px[last], points[i].y - py[last]) > tol) {
      px.push(points[i].x);
      py.push(points[i].y);
    }
  }
  const m = px.length - 1;
  if (m < 1) return null;

  const xs = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);
  if (m === 1) {
    for (let j = 0; j <= n; j++) {
      xs[j] = px[0] + ((px[1] - px[0]) * j) / n;
      ys[j] = py[0] + ((py[1] - py[0]) * j) / n;
    }
    xs[n] = px[1];
    ys[n] = py[1];
    return { xs, ys };
  }

  // Chord-length parameter and Hermite tangents (three-point, non-uniform, exact for quadratics).
  const t = new Float64Array(m + 1);
  for (let i = 1; i <= m; i++) t[i] = t[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
  const mx = new Float64Array(m + 1);
  const my = new Float64Array(m + 1);
  const tangent = (i: number, a: number, b: number, c: number, i0: number): void => {
    mx[i] = a * px[i0] + b * px[i0 + 1] + c * px[i0 + 2];
    my[i] = a * py[i0] + b * py[i0 + 1] + c * py[i0 + 2];
  };
  for (let i = 1; i < m; i++) {
    const h0 = t[i] - t[i - 1];
    const h1 = t[i + 1] - t[i];
    tangent(i, -h1 / (h0 * (h0 + h1)), (h1 - h0) / (h0 * h1), h0 / (h1 * (h0 + h1)), i - 1);
  }
  {
    const h0 = t[1] - t[0];
    const h1 = t[2] - t[1];
    tangent(0, -(2 * h0 + h1) / (h0 * (h0 + h1)), (h0 + h1) / (h0 * h1), -h0 / (h1 * (h0 + h1)), 0);
  }
  {
    const h0 = t[m - 1] - t[m - 2];
    const h1 = t[m] - t[m - 1];
    tangent(m, h1 / (h0 * (h0 + h1)), -(h0 + h1) / (h0 * h1), (h0 + 2 * h1) / (h1 * (h0 + h1)), m - 2);
  }

  // Dense polyline along the spline, then invert its cumulative arc length at n+1 equal steps.
  const sub = Math.max(4, Math.ceil(96 / m));
  const fine = m * sub + 1;
  const fx = new Float64Array(fine);
  const fy = new Float64Array(fine);
  for (let i = 0; i < m; i++) {
    const h = t[i + 1] - t[i];
    for (let s = 0; s < sub; s++) {
      const u = s / sub;
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      fx[i * sub + s] = h00 * px[i] + h10 * h * mx[i] + h01 * px[i + 1] + h11 * h * mx[i + 1];
      fy[i * sub + s] = h00 * py[i] + h10 * h * my[i] + h01 * py[i + 1] + h11 * h * my[i + 1];
    }
  }
  fx[fine - 1] = px[m];
  fy[fine - 1] = py[m];
  const cum = new Float64Array(fine);
  for (let k = 1; k < fine; k++) cum[k] = cum[k - 1] + Math.hypot(fx[k] - fx[k - 1], fy[k] - fy[k - 1]);

  let k = 0;
  for (let j = 1; j < n; j++) {
    const target = (cum[fine - 1] * j) / n;
    while (k < fine - 2 && cum[k + 1] < target) k++;
    const seg = cum[k + 1] - cum[k];
    const f = seg > 0 ? (target - cum[k]) / seg : 0;
    xs[j] = fx[k] + f * (fx[k + 1] - fx[k]);
    ys[j] = fy[k] + f * (fy[k + 1] - fy[k]);
  }
  xs[0] = px[0];
  ys[0] = py[0];
  xs[n] = px[m];
  ys[n] = py[m];
  return { xs, ys };
}

/** +1 if the camber line bulges to the left of leading edge → trailing edge, −1 if to the right; flat counts as +1. */
function bellySide(nodes: Nodes, n: number): 1 | -1 {
  const { xs, ys } = nodes;
  const cx = xs[n] - xs[0];
  const cy = ys[n] - ys[0];
  const chord = Math.hypot(cx, cy);
  if (chord === 0) return 1;
  let area = 0; // ∫ (signed distance left of the chord) ds
  let arc = 0;
  for (let j = 0; j < n; j++) {
    const ds = Math.hypot(xs[j + 1] - xs[j], ys[j + 1] - ys[j]);
    const mx = 0.5 * (xs[j] + xs[j + 1]) - xs[0];
    const my = 0.5 * (ys[j] + ys[j + 1]) - ys[0];
    area += ((cx * my - cy * mx) / chord) * ds;
    arc += ds;
  }
  return area / (arc * chord) < -FLAT_CAMBER ? -1 : 1;
}

/** LE → TE distance of an element, rebuilt from its panels. */
function elementChord(panels: readonly PanelGeom[]): number {
  const n = panels.length;
  if (n === 0) return 0;
  const a = panels[0];
  const b = panels[n - 1];
  return Math.hypot(
    b.x + 0.5 * b.ds * b.tx - (a.x - 0.5 * a.ds * a.tx),
    b.y + 0.5 * b.ds * b.ty - (a.y - 0.5 * a.ds * a.ty),
  );
}

const sumOf = (a: readonly number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};

// ------------------------------------------------------------------------------------------ solve

let scratchMatrix = new Float64Array(0);

/**
 * In-place Gaussian elimination with partial pivoting on the n × (n+1) row-major augmented matrix [A | b]; the
 * solution is left in column n. A vanishing pivot (singular system) leaves that unknown at 0. Internal: exported
 * for its unit test.
 */
export function solveLinear(a: Float64Array, n: number): void {
  const w = n + 1;
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(a[col * w + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r * w + col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (piv !== col) {
      for (let c = col; c <= n; c++) {
        const tmp = a[col * w + c];
        a[col * w + c] = a[piv * w + c];
        a[piv * w + c] = tmp;
      }
    }
    const d = a[col * w + col];
    if (Math.abs(d) < 1e-300) continue; // singular column: back-substitution sets that unknown to 0
    const rc = col * w;
    for (let r = col + 1; r < n; r++) {
      const rr = r * w;
      const f = a[rr + col] / d;
      if (f === 0) continue;
      for (let c = col + 1; c <= n; c++) a[rr + c] -= f * a[rc + c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    const rr = r * w;
    let s = a[rr + n];
    for (let c = r + 1; c < n; c++) s -= a[rr + c] * a[c * w + n];
    const d = a[rr + r];
    a[rr + n] = Math.abs(d) < 1e-300 ? 0 : s / d;
  }
}

/**
 * Solve the flow around a slice: every element's camber line is discretised into panels and all vortex strengths are
 * found in one coupled solve, so the elements feel each other. Throws RangeError on non-finite input or an unusable
 * panel count. An element with fewer than two distinct points gets no panels (cl 0) but keeps its index.
 */
export function solveSlice(elements: Element2D[], uInf: Vec2, options: SolveOptions = {}): SliceSolution {
  if (!Number.isFinite(uInf.x) || !Number.isFinite(uInf.y)) {
    throw new RangeError('solveSlice: the free stream must be finite');
  }
  const ne = elements.length;
  const counts: number[] = new Array(ne);
  const nodes: (Nodes | null)[] = new Array(ne);
  let total = 0;
  for (let e = 0; e < ne; e++) {
    counts[e] = panelCount(options.panels, e);
    nodes[e] = discretise(elements[e].points, counts[e]);
    if (nodes[e]) total += counts[e];
  }

  const vx = new Float64Array(total); // vortex points (¼)
  const vy = new Float64Array(total);
  const cx = new Float64Array(total); // tangency points (¾)
  const cy = new Float64Array(total);
  const cnx = new Float64Array(total); // normal enforced at the tangency point
  const cny = new Float64Array(total);
  const panels: PanelGeom[][] = new Array(ne);
  const sides: number[] = new Array(ne).fill(1);
  const starts: number[] = new Array(ne).fill(0);

  let o = 0;
  for (let e = 0; e < ne; e++) {
    const nd = nodes[e];
    if (!nd) {
      panels[e] = [];
      continue;
    }
    const n = counts[e];
    const { xs, ys } = nd;
    const side = bellySide(nd, n);
    sides[e] = side;
    starts[e] = o;
    const tx = new Float64Array(n);
    const ty = new Float64Array(n);
    const ds = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const dx = xs[j + 1] - xs[j];
      const dy = ys[j + 1] - ys[j];
      ds[j] = Math.hypot(dx, dy);
      tx[j] = dx / ds[j];
      ty[j] = dy / ds[j];
    }
    const list: PanelGeom[] = new Array(n);
    for (let j = 0; j < n; j++) {
      const dx = xs[j + 1] - xs[j];
      const dy = ys[j + 1] - ys[j];
      list[j] = {
        x: 0.5 * (xs[j] + xs[j + 1]),
        y: 0.5 * (ys[j] + ys[j + 1]),
        nx: -side * ty[j],
        ny: side * tx[j],
        ds: ds[j],
        tx: tx[j],
        ty: ty[j],
      };
      vx[o + j] = xs[j] + 0.25 * dx;
      vy[o + j] = ys[j] + 0.25 * dy;
      cx[o + j] = xs[j] + 0.75 * dx;
      cy[o + j] = ys[j] + 0.75 * dy;
      // Tangency is enforced at the ¾ point, so use the curve direction THERE, interpolated between the neighbouring
      // panel directions — the panel's own direction is the one at its middle, which costs first-order accuracy on
      // curved camber lines (≈ 6 % on the zero-lift angle at 20 panels). Vectors, not angles: no ±π wrap-around.
      let bx = tx[j];
      let by = ty[j];
      if (n > 1) {
        const other = j < n - 1 ? j + 1 : j - 1;
        const w = (0.5 * ds[j]) / (ds[j] + ds[other]);
        const sign = j < n - 1 ? 1 : -1; // extrapolate at the trailing edge
        bx += sign * w * (tx[other] - tx[j]);
        by += sign * w * (ty[other] - ty[j]);
      }
      const bl = Math.hypot(bx, by);
      cnx[o + j] = -by / bl;
      cny[o + j] = bx / bl;
    }
    panels[e] = list;
    o += n;
  }

  // Influence matrix: normal velocity at tangency point i from a unit clockwise vortex k, and the free-stream RHS.
  const w = total + 1;
  if (scratchMatrix.length < total * w) scratchMatrix = new Float64Array(total * w);
  const a = scratchMatrix;
  const inv2pi = 1 / TWO_PI;
  for (let i = 0; i < total; i++) {
    const row = i * w;
    for (let k = 0; k < total; k++) {
      const dx = cx[i] - vx[k];
      const dy = cy[i] - vy[k];
      const r2 = dx * dx + dy * dy;
      a[row + k] = ((dy * cnx[i] - dx * cny[i]) * inv2pi) / (r2 > R2_FLOOR ? r2 : R2_FLOOR);
    }
    a[row + total] = -(uInf.x * cnx[i] + uInf.y * cny[i]);
  }
  solveLinear(a, total);

  const speed = Math.hypot(uInf.x, uInf.y);
  const gammas: number[][] = new Array(ne);
  const cl: number[] = new Array(ne);
  for (let e = 0; e < ne; e++) {
    const n = panels[e].length;
    const g: number[] = new Array(n);
    for (let j = 0; j < n; j++) g[j] = sides[e] * a[(starts[e] + j) * w + total];
    gammas[e] = g;
    const chord = elementChord(panels[e]);
    cl[e] = n > 0 && speed > EPS && chord > 0 ? (2 * sumOf(g)) / (speed * chord) : 0;
  }
  return { gammas, panels, uInf: { x: uInf.x, y: uInf.y }, cl };
}

// ------------------------------------------------------------------------------------ post-processing

/** Share of the total lift each panel of a flat plate carries: thin-airfoil loading ∝ √((1−ξ)/ξ), integrated per panel. */
function flatPlateShares(panels: readonly PanelGeom[]): number[] {
  let length = 0;
  for (const p of panels) length += p.ds;
  const primitive = (xi: number): number => Math.asin(Math.sqrt(xi)) + Math.sqrt(xi * (1 - xi)); // ∫₀^ξ √((1−s)/s) ds
  const shares: number[] = new Array(panels.length);
  let travelled = 0;
  let previous = 0;
  for (let j = 0; j < panels.length; j++) {
    travelled += panels[j].ds;
    const current = primitive(Math.min(1, travelled / length));
    shares[j] = (current - previous) / (Math.PI / 2);
    previous = current;
  }
  return shares;
}

/**
 * Rescale each element's circulations so its section lift coefficient equals `targetCl[e]` — the sail force model's
 * value, which knows about stall, luffing and 3-D effects — keeping the shape of the distribution. `chords[e]` is the
 * chord `cl` is referred to (default: the element's own leading-to-trailing-edge distance). Targets use the same
 * belly-relative sign as `SliceSolution.cl`, so the model's positive `cl` can be passed straight in on either tack.
 * Elements whose target is missing or not finite are left as solved; a target of 0 removes the element's circulation.
 *
 * Rescaling is only safe while the solved loading is not dominated by cancellation. Near the zero-lift incidence
 * positive and negative loading nearly cancel (Σ|Γ| ≫ |ΣΓ|), and if the net lift has the wrong sign the scale factor
 * would flip the whole distribution; scaling would blow the field up or invert it. Ordinary shapes — including the
 * luff reversal that backwinding puts into a main behind a jib (Σ|Γ|/|ΣΓ| ≈ 1.5–2) — are kept exactly. Between 2.5
 * and 5 the shape blends smoothly into the thin-airfoil flat-plate loading, which replaces it beyond 5 and on any
 * sign mismatch; the lift equals the target exactly either way, and Σ|Γ| never exceeds five times the net
 * circulation asked for. Returns a new solution; the input is not modified.
 *
 * CAVEAT — scaling breaks flow tangency. The solved vortices cancel the stream's normal component at the cloth;
 * after scaling by k they cancel only a fraction k of it, so the scaled field lets air through the sail: at the
 * tangency points the normal velocity is exactly (1−k)·(U∞·n) (mean ≈ 0.2·|U∞| for a jib scaled to a typical model
 * cl), and about a third of the streamlines of a jib + main slice cross a sail. The unscaled `solveSlice` field is tangent (≈ 1 %), but its circulation is
 * 2–3× the force model's, so its speeds and deflections are exaggerated by about that much. Use the scaled solution
 * for lift, ΔCp and speed colouring; if particles or streamlines must not visibly pass through the sails, advect
 * them through a grid filled from the unscaled solution, or scale only part of the way (targets between the solved
 * and the model `cl` trade the two continuously). See the module report for measurements.
 */
export function scaleToLift(sol: SliceSolution, targetCl: readonly number[], chords: readonly number[]): SliceSolution {
  const speed = Math.hypot(sol.uInf.x, sol.uInf.y);
  const gammas = sol.gammas.map((g) => g.slice());
  const cl = sol.cl.slice();
  if (speed > EPS) {
    for (let e = 0; e < gammas.length; e++) {
      const g = gammas[e];
      const target = targetCl[e];
      if (g.length === 0 || target === undefined || !Number.isFinite(target)) continue;
      const given = chords[e];
      const chord = given !== undefined && Number.isFinite(given) && given > 0 ? given : elementChord(sol.panels[e]);
      const need = 0.5 * target * speed * chord; // required ΣΓ (a zero target lands on flat = 1 and yields exact zeros)
      const have = sumOf(g);
      let flat = 1; // weight of the flat-plate loading: 1 → ignore the solved shape
      if (have * need > 0) {
        let magnitude = 0;
        for (let j = 0; j < g.length; j++) magnitude += Math.abs(g[j]);
        flat = smoothstep(CANCEL_LO, CANCEL_HI, magnitude / Math.abs(have));
      }
      const shares = flat > 0 ? flatPlateShares(sol.panels[e]) : null;
      const k = flat < 1 ? need / have : 0;
      for (let j = 0; j < g.length; j++) {
        g[j] = (1 - flat) * k * g[j] + (shares ? flat * need * shares[j] : 0);
      }
      cl[e] = (2 * sumOf(g)) / (speed * chord);
    }
  }
  return { gammas, panels: sol.panels, uInf: { x: sol.uInf.x, y: sol.uInf.y }, cl };
}

/** Pressure-coefficient jump across every panel, ΔCp = 2Γ/(|U∞|·Δs); positive = pushed toward the belly side. */
export function deltaCp(sol: SliceSolution): number[][] {
  const speed = Math.hypot(sol.uInf.x, sol.uInf.y);
  return sol.gammas.map((g, e) =>
    g.map((gamma, j) => (speed > EPS ? (2 * gamma) / (speed * sol.panels[e][j].ds) : 0)),
  );
}

// -------------------------------------------------------------------------------------- velocity field

/**
 * The lattice as flat arrays for fast field evaluation: vortex positions, strengths in the sense the induction
 * formula wants (clockwise-positive Γ/2π — the belly-relative Γ of the solution times the element's handedness),
 * and per-vortex core². Internal — shared by `velocityAt` and `VelocityGrid.fill`.
 */
export class VortexPack {
  x = new Float64Array(0);
  y = new Float64Array(0);
  /** Γ/(2π), clockwise-positive. */
  k = new Float64Array(0);
  c2 = new Float64Array(0);
  count = 0;

  load(sol: SliceSolution, core?: number): void {
    let total = 0;
    for (const g of sol.gammas) total += g.length;
    if (this.x.length < total) {
      this.x = new Float64Array(total);
      this.y = new Float64Array(total);
      this.k = new Float64Array(total);
      this.c2 = new Float64Array(total);
    }
    let n = 0;
    for (let e = 0; e < sol.gammas.length; e++) {
      const panels = sol.panels[e];
      if (panels.length === 0) continue;
      const rc = core ?? CORE_FRACTION * elementChord(panels);
      const c2 = Math.max(rc * rc, CORE_FLOOR);
      for (let j = 0; j < panels.length; j++) {
        const p = panels[j];
        // Belly-relative Γ → clockwise-positive Γ: +1 when the belly (normal) is on the left of LE → TE, −1 on the right.
        const handed = p.tx * p.ny - p.ty * p.nx;
        this.x[n] = p.x - 0.25 * p.ds * p.tx;
        this.y[n] = p.y - 0.25 * p.ds * p.ty;
        this.k[n] = (sol.gammas[e][j] * handed) / TWO_PI;
        this.c2[n] = c2;
        n++;
      }
    }
    this.count = n;
  }
}

/** Free stream (u0, v0) plus the field of every vortex in `pack` at (x, y), written into `out`. Rankine cores. */
export function fieldAt(pack: VortexPack, u0: number, v0: number, x: number, y: number, out: Vec2): Vec2 {
  const px = pack.x;
  const py = pack.y;
  const pk = pack.k;
  const pc = pack.c2;
  const count = pack.count;
  let u = u0;
  let v = v0;
  for (let i = 0; i < count; i++) {
    const dx = x - px[i];
    const dy = y - py[i];
    const r2 = dx * dx + dy * dy;
    const d = r2 > pc[i] ? r2 : pc[i];
    const f = pk[i] / d;
    u += f * dy;
    v -= f * dx;
  }
  out.x = u;
  out.y = v;
  return out;
}

const scratchPack = new VortexPack();

/**
 * Air velocity (free stream + induced) at (x, y). Every vortex has a Rankine core — solid-body rotation inside radius
 * `core` (default 0.02 × the element's chord) — so the field stays finite right at the sail. Allocates one small
 * object per call unless you pass `out`; for whole fields use `VelocityGrid`.
 */
export function velocityAt(sol: SliceSolution, x: number, y: number, core?: number, out?: Vec2): Vec2 {
  scratchPack.load(sol, core);
  return fieldAt(scratchPack, sol.uInf.x, sol.uInf.y, x, y, out ?? { x: 0, y: 0 });
}
