// Procedural Kestrel 25 hull (spec §6, §9.5): design curves (centreline profile, sheer, deck line,
// section shape), the lofted shell and a waterplane measurement used by the unit test.
//
// Spec coordinates: x forward of the CG station, y to starboard, h above the design waterline.
// Boat-local three.js frame: X = y, Y = h, Z = −x (spec §5).
//
// Sections are built in the transverse plane of each station as a superellipse quadrant in the skewed
// frame spanned by the keel tangent (deadrise) and the topside tangent (flare): exponent 2 gives a slack
// round bilge, larger exponents a firmer bilge. One global firmness factor is solved so the maximum
// waterline beam equals BOAT.hull.bwl exactly; waterline length, beam and draft follow from the curves.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import type { BoatDetail, Part } from './materials';

const H = BOAT.hull;
export const X_TRANSOM = H.transomDeck.x;
export const X_STEM = H.stemDeck.x;
const HALF_BEAM = H.beam / 2;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// 1-D cubic spline (C2), natural or clamped ends, linear extrapolation outside the knots.

export class CubicSpline {
  private readonly xs: number[];
  private readonly ys: number[];
  private readonly m: number[];

  constructor(knots: ReadonlyArray<readonly [number, number]>, startSlope?: number, endSlope?: number) {
    const n = knots.length;
    this.xs = knots.map((k) => k[0]);
    this.ys = knots.map((k) => k[1]);
    const xs = this.xs, ys = this.ys;
    const a = new Array<number>(n).fill(0), b = new Array<number>(n).fill(1);
    const c = new Array<number>(n).fill(0), d = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
      a[i] = h0 / 6; b[i] = (h0 + h1) / 3; c[i] = h1 / 6;
      d[i] = (ys[i + 1] - ys[i]) / h1 - (ys[i] - ys[i - 1]) / h0;
    }
    if (startSlope !== undefined) {
      const h0 = xs[1] - xs[0];
      b[0] = h0 / 3; c[0] = h0 / 6; d[0] = (ys[1] - ys[0]) / h0 - startSlope;
    }
    if (endSlope !== undefined) {
      const h = xs[n - 1] - xs[n - 2];
      a[n - 1] = h / 6; b[n - 1] = h / 3; d[n - 1] = endSlope - (ys[n - 1] - ys[n - 2]) / h;
    }
    // Thomas algorithm.
    for (let i = 1; i < n; i++) {
      const w = a[i] / b[i - 1];
      b[i] -= w * c[i - 1];
      d[i] -= w * d[i - 1];
    }
    const m = new Array<number>(n).fill(0);
    m[n - 1] = d[n - 1] / b[n - 1];
    for (let i = n - 2; i >= 0; i--) m[i] = (d[i] - c[i] * m[i + 1]) / b[i];
    this.m = m;
  }

  private interval(x: number): number {
    const xs = this.xs;
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    return lo;
  }

  value(x: number): number {
    const xs = this.xs, n = xs.length;
    if (x < xs[0]) return this.ys[0] + this.slope(xs[0]) * (x - xs[0]);
    if (x > xs[n - 1]) return this.ys[n - 1] + this.slope(xs[n - 1]) * (x - xs[n - 1]);
    const i = this.interval(x);
    const h = xs[i + 1] - xs[i];
    const A = (xs[i + 1] - x) / h, B = (x - xs[i]) / h;
    return A * this.ys[i] + B * this.ys[i + 1] + ((A * A * A - A) * this.m[i] + (B * B * B - B) * this.m[i + 1]) * (h * h) / 6;
  }

  slope(x: number): number {
    const xs = this.xs, n = xs.length;
    const xc = Math.min(Math.max(x, xs[0]), xs[n - 1]);
    const i = Math.min(this.interval(xc), n - 2);
    const h = xs[i + 1] - xs[i];
    const A = (xs[i + 1] - xc) / h, B = (xc - xs[i]) / h;
    return (this.ys[i + 1] - this.ys[i]) / h + ((1 - 3 * A * A) * this.m[i] + (3 * B * B - 1) * this.m[i + 1]) * h / 6;
  }
}

// ---------------------------------------------------------------------------------------------
// Longitudinal design curves.

function solve3(A: number[][], r: number[]): number[] {
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  return [0, 1, 2].map((col) => det(A.map((row, i) => row.map((v, j) => (j === col ? r[i] : v)))) / D);
}

/** Sheer: quartic in (x − minX) with zero slope at the low point, through the four spec freeboards. */
const SHEER = (() => {
  const f = H.freeboard;
  const pts: Array<[number, number]> = [[H.transomDeck.x, f.stern], [BOAT.mast.x, f.mast], [H.stemDeck.x, f.bow]];
  const A = pts.map(([x]) => { const d = x - f.minX; return [d * d, d * d * d, d * d * d * d]; });
  return solve3(A, pts.map(([, h]) => h - f.min));
})();

/** Height of the deck edge (sheer) above the waterline. */
export function sheerH(x: number): number {
  const d = x - H.freeboard.minX;
  return H.freeboard.min + d * d * (SHEER[0] + d * (SHEER[1] + d * SHEER[2]));
}

export function sheerSlope(x: number): number {
  const d = x - H.freeboard.minX;
  return d * (2 * SHEER[0] + d * (3 * SHEER[1] + d * 4 * SHEER[2]));
}

/** Plan shape of the deck edge: half-breadth relative to the maximum (shape choice, max at maxBeamX). */
const DECK_LINE_KNOTS: Array<[number, number]> = [
  [X_TRANSOM, 0.770], [-3.0, 0.846], [-2.2, 0.919], [-1.4, 0.968], [H.maxBeamX, 1.0], [0.6, 0.988],
  [1.4, 0.947], [2.1, 0.862], [2.7, 0.731], [3.2, 0.548], [3.55, 0.366], [3.8, 0.172], [X_STEM, 0.027],
];
const deckLineSpline = new CubicSpline(DECK_LINE_KNOTS);
const DECK_LINE_SCALE = (() => {
  let peak = 0;
  for (let x = -1.5; x <= 1.0; x += 0.002) peak = Math.max(peak, deckLineSpline.value(x));
  return HALF_BEAM / peak;
})();

/** Half-breadth of the deck edge (sheer) at station x. */
export function deckHalfBeam(x: number): number {
  return Math.max(0, deckLineSpline.value(Math.min(Math.max(x, X_TRANSOM), X_STEM)) * DECK_LINE_SCALE);
}

export function deckHalfBeamSlope(x: number): number {
  return deckLineSpline.slope(Math.min(Math.max(x, X_TRANSOM), X_STEM)) * DECK_LINE_SCALE;
}

/** Stem profile above the waterline: slightly raked at the deck, curving into the forefoot below. */
const STEM_TOP_RAKE = 0.72; // fraction of the average rake left at the stem head
const STEM_CURVE = 2.2;     // how strongly the lower stem sweeps aft into the forefoot
const stemShape = (t: number) => STEM_TOP_RAKE * t + (1 - STEM_TOP_RAKE) * (1 - Math.pow(1 - t, STEM_CURVE));
const stemShapeSlope0 = STEM_TOP_RAKE + (1 - STEM_TOP_RAKE) * STEM_CURVE;

/** x of the stem at height h (0 … stem head). */
export function stemX(h: number): number {
  const t = Math.min(Math.max(h / H.stemDeck.h, 0), 1);
  return H.stemWL.x + (H.stemDeck.x - H.stemWL.x) * stemShape(t);
}

/** Height of the stem at station x (inverse of {@link stemX}). */
export function stemH(x: number): number {
  let lo = 0, hi: number = H.stemDeck.h;
  for (let k = 0; k < 40; k++) {
    const mid = 0.5 * (lo + hi);
    if (stemX(mid) < x) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Canoe-body keel line (centreline bottom) from the transom to the stem at the waterline. */
const TRANSOM_BOTTOM_H = 0.145;
const KEEL_DEPTH: Array<[number, number]> = [
  // (fraction of LWL from the aft waterline end, fraction of canoe-body draft)
  [0.0, 0.0], [0.039, 0.172], [0.094, 0.375], [0.172, 0.597], [0.25, 0.767], [0.328, 0.889],
  [0.406, 0.964], [0.484, 0.997], [0.531, 1.0], [0.594, 0.996], [0.672, 0.978], [0.75, 0.937],
  [0.828, 0.862], [0.891, 0.755], [0.945, 0.585], [0.977, 0.39], [1.0, 0.0],
];
const keelSpline = (() => {
  const xa = H.transomWL.x, xf = H.stemWL.x, L = xf - xa;
  const knots: Array<[number, number]> = [
    [X_TRANSOM, TRANSOM_BOTTOM_H],
    [xa - 0.3, TRANSOM_BOTTOM_H * 0.5],
    ...KEEL_DEPTH.map(([f, d]): [number, number] => [xa + f * L, -d * H.canoeDraft]),
  ];
  const stemSlope = H.stemDeck.h / ((H.stemDeck.x - H.stemWL.x) * stemShapeSlope0);
  return new CubicSpline(knots, undefined, stemSlope);
})();
const KEEL_SCALE = (() => {
  let low = 0;
  for (let x = -2; x <= 2; x += 0.002) low = Math.min(low, keelSpline.value(x));
  return H.canoeDraft / -low;
})();

/** Centreline bottom height at station x (canoe body below the waterline, stem above it). */
export function keelH(x: number): number {
  if (x >= H.stemWL.x) return stemH(x);
  const h = keelSpline.value(Math.max(x, X_TRANSOM));
  return h < 0 ? h * KEEL_SCALE : h;
}

// Section-shape tables (shape choices; degrees and superellipse exponent).
const deadrise = new CubicSpline([[X_TRANSOM, 2], [-3.1, 2.5], [-2.0, 4], [-0.5, 6], [0.5, 8], [1.5, 14], [2.3, 24], [2.9, 36], [3.3, 46], [3.6, 52], [X_STEM, 56]]);
const flare = new CubicSpline([[X_TRANSOM, 10], [-1.5, 9], [0, 9], [1.2, 11], [2.2, 16], [3.0, 24], [3.5, 27], [X_STEM, 28]]);
const firmness = new CubicSpline([[X_TRANSOM, 3.2], [-2.5, 3.1], [-1.0, 2.9], [0.5, 2.7], [1.5, 2.45], [2.5, 2.2], [3.3, 2.0], [X_STEM, 2.0]]);

// ---------------------------------------------------------------------------------------------
// Sections.

interface SectionFrame { ky: number; kh: number; sy: number; sh: number; cy: number; ch: number; n: number }

/** Keel point, sheer point and tangent-corner of the section at station x; null when degenerate. */
function sectionFrame(x: number, kappa: number): SectionFrame | null {
  const kh = keelH(x), sh = sheerH(x), sy = deckHalfBeam(x);
  if (sh - kh < 0.004 || sy < 0.004) return null;
  const chord = Math.atan2(sh - kh, sy);
  let beta = deadrise.value(x) * DEG;
  let phi = flare.value(x) * DEG;
  beta = Math.min(beta, chord - 3 * DEG);
  phi = Math.min(phi, Math.PI / 2 - chord - 3 * DEG);
  if (beta < 0 || phi < 0) return null;
  // Intersect keel tangent K + t(cos β, sin β) with topside tangent S − u(sin φ, cos φ).
  const ax = Math.cos(beta), ay = Math.sin(beta);
  const bx = -Math.sin(phi), by = -Math.cos(phi);
  const det = ax * by - ay * bx;
  if (Math.abs(det) < 1e-6) return null;
  const rx = sy, ry = sh - kh;
  const t = (rx * by - ry * bx) / det;
  const n = 1 + kappa * (firmness.value(x) - 1);
  return { ky: 0, kh, sy, sh, cy: t * ax, ch: kh + t * ay, n };
}

/** Point on the section quadrant; θ = 0 at the keel, π/2 at the sheer. */
function sectionPoint(f: SectionFrame, theta: number, out: { y: number; h: number }): void {
  const e = 2 / f.n;
  const a = Math.pow(Math.sin(theta), e);
  const g = Math.pow(Math.cos(theta), e);
  out.y = f.cy + (1 - a) * (f.ky - f.cy) + (1 - g) * (f.sy - f.cy);
  out.h = f.ch + (1 - a) * (f.kh - f.ch) + (1 - g) * (f.sh - f.ch);
}

/** Half-breadth where the section crosses height h (null if it does not). */
function sectionBreadthAt(f: SectionFrame, h: number): number | null {
  if (h < f.kh || h > f.sh) return null;
  const p = { y: 0, h: 0 };
  let lo = 0, hi = Math.PI / 2;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    sectionPoint(f, mid, p);
    if (p.h < h) lo = mid; else hi = mid;
  }
  sectionPoint(f, 0.5 * (lo + hi), p);
  return p.y;
}

/** Global bilge firmness chosen so the maximum waterline half-breadth is BWL/2. */
export const BILGE_KAPPA = (() => {
  const maxWL = (kappa: number) => {
    let best = 0;
    for (let x = -2.2; x <= 1.2; x += 0.02) {
      const f = sectionFrame(x, kappa);
      const b = f ? sectionBreadthAt(f, 0) : null;
      if (b !== null) best = Math.max(best, b);
    }
    return best;
  };
  let lo = 0.2, hi = 4;
  for (let k = 0; k < 40; k++) {
    const mid = 0.5 * (lo + hi);
    if (maxWL(mid) < H.bwl / 2) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
})();

// ---------------------------------------------------------------------------------------------
// Stations and the lofted shell.

export interface HullStation {
  x: number;
  /** Half-section points from the keel (index 0) to the sheer, as (y, h) pairs. */
  y: Float64Array;
  h: Float64Array;
  /** Girth from the keel to each point (m). */
  girth: Float64Array;
}

export interface HullLines {
  stations: HullStation[];
  /** Points per half section. */
  pointsPerSide: number;
}

/** Dense centreline profile from the transom bottom, along the keel line, up the stem. */
function profilePolyline(): Array<{ x: number; h: number }> {
  const pts: Array<{ x: number; h: number }> = [];
  const nKeel = 900;
  for (let i = 0; i <= nKeel; i++) {
    const x = X_TRANSOM + (H.stemWL.x - X_TRANSOM) * (i / nKeel);
    pts.push({ x, h: keelH(x) });
  }
  const nStem = 300;
  for (let i = 1; i <= nStem; i++) {
    const h = H.stemDeck.h * (i / nStem);
    pts.push({ x: stemX(h), h });
  }
  return pts;
}

/** Station x positions: arc-length spacing along the profile, denser toward the stem and transom. */
function stationXs(count: number): number[] {
  const prof = profilePolyline();
  const s = [0];
  for (let i = 1; i < prof.length; i++) s.push(s[i - 1] + Math.hypot(prof[i].x - prof[i - 1].x, prof[i].h - prof[i - 1].h));
  const total = s[s.length - 1];
  const density = (u: number) => 1 + 1.6 * Math.exp(-(((total - u) / 0.9) ** 2)) + 0.6 * Math.exp(-((u / 0.35) ** 2));
  const cdf = [0];
  for (let i = 1; i < s.length; i++) cdf.push(cdf[i - 1] + 0.5 * (density(s[i]) + density(s[i - 1])) * (s[i] - s[i - 1]));
  const cTotal = cdf[cdf.length - 1];
  const xs: number[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = (cTotal * k) / (count - 1);
    while (j < cdf.length - 2 && cdf[j + 1] < target) j++;
    const t = (target - cdf[j]) / Math.max(1e-12, cdf[j + 1] - cdf[j]);
    xs.push(prof[j].x + (prof[j + 1].x - prof[j].x) * Math.min(Math.max(t, 0), 1));
  }
  xs[0] = X_TRANSOM;
  xs[count - 1] = X_STEM;
  // Keep strictly increasing (the upper stem is nearly plumb).
  for (let k = 1; k < count; k++) xs[k] = Math.max(xs[k], xs[k - 1] + 1e-5);
  return xs;
}

/** Resample one half section by curvature-weighted arc length (a short first span keeps the stem crisp). */
function buildStation(x: number, m: number): HullStation {
  const y = new Float64Array(m), h = new Float64Array(m), girth = new Float64Array(m);
  const f = sectionFrame(x, BILGE_KAPPA);
  if (!f) {
    // Degenerate (stem head): straight segment from the centreline to the deck edge.
    const kh = keelH(x), sh = sheerH(x), sy = deckHalfBeam(x);
    for (let j = 0; j < m; j++) {
      const t = j / (m - 1);
      y[j] = sy * t; h[j] = kh + (sh - kh) * t;
      girth[j] = Math.hypot(y[j], h[j] - kh);
    }
    return { x, y, h, girth };
  }
  const nd = 240;
  const dy = new Float64Array(nd), dh = new Float64Array(nd), ds = new Float64Array(nd);
  const p = { y: 0, h: 0 };
  for (let k = 0; k < nd; k++) {
    sectionPoint(f, (Math.PI / 2) * (k / (nd - 1)), p);
    dy[k] = p.y; dh[k] = p.h;
    ds[k] = k === 0 ? 0 : ds[k - 1] + Math.hypot(dy[k] - dy[k - 1], dh[k] - dh[k - 1]);
  }
  const L = ds[nd - 1];
  // Curvature from the turning angle between neighbouring spans.
  const w = new Float64Array(nd).fill(1);
  for (let k = 1; k < nd - 1; k++) {
    const a1 = Math.atan2(dh[k] - dh[k - 1], dy[k] - dy[k - 1]);
    const a2 = Math.atan2(dh[k + 1] - dh[k], dy[k + 1] - dy[k]);
    const span = 0.5 * (ds[k + 1] - ds[k - 1]);
    const kappa = Math.abs(a2 - a1) / Math.max(span, 1e-6);
    w[k] = 1 + Math.min(4, 0.35 * kappa * L);
  }
  const cdf = new Float64Array(nd);
  for (let k = 1; k < nd; k++) cdf[k] = cdf[k - 1] + 0.5 * (w[k] + w[k - 1]) * (ds[k] - ds[k - 1]);
  const first = Math.min(0.012, L * 0.05);
  // CDF value at arc length `first`.
  const cdfAt = (s: number) => {
    let k = 1;
    while (k < nd - 1 && ds[k] < s) k++;
    const t = (s - ds[k - 1]) / Math.max(1e-12, ds[k] - ds[k - 1]);
    return cdf[k - 1] + (cdf[k] - cdf[k - 1]) * t;
  };
  const c0 = cdfAt(first), c1 = cdf[nd - 1];
  let k = 1;
  for (let j = 0; j < m; j++) {
    const target = j === 0 ? 0 : c0 + ((c1 - c0) * (j - 1)) / (m - 2);
    while (k < nd - 1 && cdf[k] < target) k++;
    const t = Math.min(1, Math.max(0, (target - cdf[k - 1]) / Math.max(1e-12, cdf[k] - cdf[k - 1])));
    y[j] = dy[k - 1] + (dy[k] - dy[k - 1]) * t;
    h[j] = dh[k - 1] + (dh[k] - dh[k - 1]) * t;
    girth[j] = ds[k - 1] + (ds[k] - ds[k - 1]) * t;
  }
  y[0] = 0; h[0] = f.kh; y[m - 1] = f.sy; h[m - 1] = f.sh;
  return { x, y, h, girth };
}

export function hullLines(detail: Pick<BoatDetail, 'hullStations' | 'hullSectionPoints'>): HullLines {
  const xs = stationXs(detail.hullStations);
  const m = detail.hullSectionPoints;
  return { stations: xs.map((x) => buildStation(x, m)), pointsPerSide: m };
}

/** UV rectangle of the hull paint texture (x along the hull, h up): see textures.ts. */
export const PAINT_UV = { x0: X_TRANSOM - 0.05, x1: X_STEM + 0.05, h0: -0.45, h1: 1.05 };

/** The shell from the transom section to the stem head, both sides in one grid sharing the keel column. */
export function buildHullGeometry(lines: HullLines): THREE.BufferGeometry {
  const { stations, pointsPerSide: m } = lines;
  const cols = 2 * m - 1;
  const rows = stations.length;
  const pos = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const uv1 = new Float32Array(rows * cols * 2);
  const P = PAINT_UV;
  for (let i = 0; i < rows; i++) {
    const st = stations[i];
    for (let c = 0; c < cols; c++) {
      const j = Math.abs(c - (m - 1));
      const side = c < m - 1 ? -1 : 1;
      const v = i * cols + c;
      pos[v * 3] = side * st.y[j];
      pos[v * 3 + 1] = st.h[j];
      pos[v * 3 + 2] = -st.x;
      uv[v * 2] = (st.x - P.x0) / (P.x1 - P.x0);
      uv[v * 2 + 1] = (st.h[j] - P.h0) / (P.h1 - P.h0);
      uv1[v * 2] = st.x * 0.5;
      uv1[v * 2 + 1] = side * st.girth[j];
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = i * cols + c, b = (i + 1) * cols + c, d = (i + 1) * cols + c + 1, e = i * cols + c + 1;
      index.push(a, b, d, a, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

export function buildHull(lines: HullLines): Part[] {
  return [{ geometry: buildHullGeometry(lines), mat: 'hull', shadow: true }];
}

// ---------------------------------------------------------------------------------------------
// Queries used by the other builders.

/** Half-breadth of the hull surface at station x and height h (interpolated between stations). */
export function hullHalfBreadth(lines: HullLines, x: number, h: number): number {
  const st = lines.stations;
  let i = 0;
  while (i < st.length - 2 && st[i + 1].x < x) i++;
  const a = st[i], b = st[i + 1];
  const t = Math.min(1, Math.max(0, (x - a.x) / Math.max(1e-9, b.x - a.x)));
  return (1 - t) * breadthInSection(a, h) + t * breadthInSection(b, h);
}

function breadthInSection(s: HullStation, h: number): number {
  const n = s.h.length;
  if (h <= s.h[0]) return 0;
  if (h >= s.h[n - 1]) return s.y[n - 1];
  for (let j = 1; j < n; j++) {
    if (s.h[j] >= h) {
      const t = (h - s.h[j - 1]) / Math.max(1e-9, s.h[j] - s.h[j - 1]);
      return s.y[j - 1] + (s.y[j] - s.y[j - 1]) * t;
    }
  }
  return s.y[n - 1];
}

/** Outward unit normal (in the section plane, as y/h components) of the topsides just below the sheer. */
export function topsideNormal(lines: HullLines, x: number): { ny: number; nh: number } {
  const st = lines.stations;
  let i = 0;
  while (i < st.length - 2 && st[i + 1].x < x) i++;
  const s = st[i];
  const n = s.y.length;
  const ty = s.y[n - 1] - s.y[n - 3], th = s.h[n - 1] - s.h[n - 3];
  const l = Math.hypot(ty, th) || 1;
  return { ny: th / l, nh: -ty / l };
}

// ---------------------------------------------------------------------------------------------
// Measurement (unit test + report).

export interface HullMeasure {
  lwl: number;
  wlFwd: number;
  wlAft: number;
  bwl: number;
  beam: number;
  loa: number;
  canoeDraft: number;
}

/** Waterplane and extreme dimensions of a hull geometry in the boat-local frame. */
export function measureHull(geo: THREE.BufferGeometry): HullMeasure {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const idx = geo.getIndex();
  let beam = 0, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    beam = Math.max(beam, 2 * Math.abs(pos.getX(i)));
    minY = Math.min(minY, pos.getY(i));
    minZ = Math.min(minZ, pos.getZ(i));
    maxZ = Math.max(maxZ, pos.getZ(i));
  }
  let wlFwd = -Infinity, wlAft = Infinity, bwl = 0;
  const edge = (a: number, b: number) => {
    const ya = pos.getY(a), yb = pos.getY(b);
    if ((ya < 0) === (yb < 0) || ya === yb) return;
    const t = ya / (ya - yb);
    const X = pos.getX(a) + (pos.getX(b) - pos.getX(a)) * t;
    const x = -(pos.getZ(a) + (pos.getZ(b) - pos.getZ(a)) * t);
    wlFwd = Math.max(wlFwd, x);
    wlAft = Math.min(wlAft, x);
    bwl = Math.max(bwl, 2 * Math.abs(X));
  };
  const n = idx ? idx.count : pos.count;
  for (let t = 0; t < n; t += 3) {
    const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
    edge(a, b); edge(b, c); edge(c, a);
  }
  return { lwl: wlFwd - wlAft, wlFwd, wlAft, bwl, beam, loa: maxZ - minZ, canoeDraft: -minY };
}
