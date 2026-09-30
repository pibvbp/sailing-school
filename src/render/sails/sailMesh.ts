// Generic sail cloth shared by the main, jib and spinnaker (spec §9.6).
//
// A sail is a (u, v) vertex grid: u = chord fraction luff → leech, v = height fraction foot → head.
// Every frame the owning sail builds a TARGET surface from the simulation's sections — interpolated
// smoothly in height (there are only 6–8 sections) and pinned to the corner points — then each free
// vertex chases its target through a damped spring (implicit Euler: unconditionally stable, so a long
// frame can never explode), procedural excitation (luffing waves, flogging, leech flutter) is added on
// top along the cloth normal, and normals are rebuilt from the grid.
// Everything here is plain math on typed arrays (no DOM) so the unit tests run it in Node.
import * as THREE from 'three';
import type { SailSection } from '../../sim/types';
import type { Vec3 } from '../../shared/math';

/** Clamp to [0, 1]; NaN → 0. */
export const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
/** `x` if finite, else the fallback. */
export const fin = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);
export const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Body frame (x fwd, y stbd, z down) → boat-local (X stbd, Y up, Z aft), written into `out`. */
export function toLocal(p: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(p.y, -p.z, -p.x);
}

/**
 * Normalised camber line: 0 at the luff and leech, 1 at the draft position. Cubic Hermite pieces with
 * the given entry / exit slopes (in units of the piece length, both ≤ 3 so the curve stays monotone):
 * sails have a round entry and a much straighter exit than a parabola.
 */
export function camberShape(u: number, draft: number, entry: number, exit: number): number {
  if (u <= 0 || u >= 1) return 0;
  const d = draft < 0.15 ? 0.15 : draft > 0.85 ? 0.85 : draft;
  if (u < d) {
    const y = u / d;
    return entry * (y * y * y - 2 * y * y + y) + (3 * y * y - 2 * y * y * y);
  }
  const x = (u - d) / (1 - d);
  return 2 * x * x * x - 3 * x * x + 1 - exit * (x * x * x - x * x);
}

/** Cubic Hermite curve through non-uniform knots (three-point tangents): C1 and exact at the knots. */
export class KnotCurve {
  readonly dim: number;
  private readonly ts: Float64Array;
  private readonly ps: Float64Array;
  private readonly ms: Float64Array;
  private n = 0;

  constructor(dim: number, capacity = 40) {
    this.dim = dim;
    this.ts = new Float64Array(capacity);
    this.ps = new Float64Array(capacity * dim);
    this.ms = new Float64Array(capacity * dim);
  }

  get count(): number { return this.n; }

  reset(): void { this.n = 0; }

  /** Append a knot (values from `src[off…]`). Knots must increase; one within 1e-4 of the last is dropped. */
  push(t: number, src: ArrayLike<number>, off = 0): void {
    if (this.n >= this.ts.length || !Number.isFinite(t)) return;
    if (this.n > 0 && t < this.ts[this.n - 1]! + 1e-4) return;
    const o = this.n * this.dim;
    for (let k = 0; k < this.dim; k++) {
      const v = src[off + k]!;
      this.ps[o + k] = Number.isFinite(v) ? v : 0;
    }
    this.ts[this.n++] = t;
  }

  push3(t: number, x: number, y: number, z: number): void {
    SCRATCH3[0] = x; SCRATCH3[1] = y; SCRATCH3[2] = z;
    this.push(t, SCRATCH3);
  }

  /** Compute the tangents; call after the last push. */
  finish(): void {
    const n = this.n, d = this.dim, t = this.ts, p = this.ps, m = this.ms;
    if (n < 2) { m.fill(0, 0, Math.max(n, 1) * d); return; }
    for (let k = 0; k < d; k++) {
      for (let i = 1; i < n - 1; i++) {
        const h0 = t[i]! - t[i - 1]!, h1 = t[i + 1]! - t[i]!;
        const s0 = (p[i * d + k]! - p[(i - 1) * d + k]!) / h0;
        const s1 = (p[(i + 1) * d + k]! - p[i * d + k]!) / h1;
        m[i * d + k] = (s0 * h1 + s1 * h0) / (h0 + h1);
      }
      // Ends: tangent of the parabola through the end knot's neighbourhood (falls back to the secant).
      const sa = (p[d + k]! - p[k]!) / (t[1]! - t[0]!);
      const sb = (p[(n - 1) * d + k]! - p[(n - 2) * d + k]!) / (t[n - 1]! - t[n - 2]!);
      if (n > 2) {
        const ma = 1.5 * sa - 0.5 * m[d + k]!;
        const mb = 1.5 * sb - 0.5 * m[(n - 2) * d + k]!;
        m[k] = ma * sa > 0 ? ma : 0;
        m[(n - 1) * d + k] = mb * sb > 0 ? mb : 0;
      } else {
        m[k] = sa;
        m[d + k] = sb;
      }
    }
  }

  /** Value at t (clamped to the knot range) into out[off…]; optionally d/dt into dout[doff…]. */
  valueAt(t: number, out: Float64Array, off = 0, dout?: Float64Array, doff = 0): void {
    const n = this.n, d = this.dim, ts = this.ts, p = this.ps, m = this.ms;
    if (n === 0) {
      for (let k = 0; k < d; k++) { out[off + k] = 0; if (dout) dout[doff + k] = 0; }
      return;
    }
    if (n === 1 || t <= ts[0]! || t >= ts[n - 1]!) {
      const i = n === 1 || t <= ts[0]! ? 0 : n - 1;
      for (let k = 0; k < d; k++) {
        out[off + k] = p[i * d + k]!;
        if (dout) dout[doff + k] = n > 1 ? m[i * d + k]! : 0;
      }
      return;
    }
    let i = 0;
    while (i < n - 2 && ts[i + 1]! < t) i++;
    const h = ts[i + 1]! - ts[i]!;
    const s = (t - ts[i]!) / h, s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = 3 * s2 - 2 * s3, h11 = s3 - s2;
    for (let k = 0; k < d; k++) {
      const p0 = p[i * d + k]!, p1 = p[(i + 1) * d + k]!;
      const m0 = m[i * d + k]!, m1 = m[(i + 1) * d + k]!;
      out[off + k] = h00 * p0 + h10 * h * m0 + h01 * p1 + h11 * h * m1;
      if (dout) {
        dout[doff + k] = ((6 * s2 - 6 * s) * (p0 - p1)) / h + (3 * s2 - 4 * s + 1) * m0 + (3 * s2 - 2 * s) * m1;
      }
    }
  }
}
const SCRATCH3 = new Float64Array(3);

/** How a row's cloth normal is formed: across the luff (main, jib) or horizontally (spinnaker). */
export type RowNormalMode = 'luff' | 'horizontal';

/**
 * Per-row geometry of a sail interpolated from the snapshot sections, in the boat-local frame.
 * `N` is the unit starboard-side cloth normal: the cloth bellies toward `side · N`, which is the
 * contract's `leewardY · (chordDir.y, −chordDir.x, 0)` written in three.js coordinates.
 */
export class SailRows {
  readonly nv: number;
  readonly v: Float32Array;
  readonly L: Float32Array;
  readonly T: Float32Array;
  readonly D: Float32Array;
  readonly N: Float32Array;
  readonly chord: Float32Array;
  readonly camber: Float32Array;
  readonly draft: Float32Array;
  readonly side: Float32Array;
  readonly luffing: Float32Array;
  readonly stall: Float32Array;
  readonly aoa: Float32Array;
  private readonly luffCurve = new KnotCurve(3);
  private readonly leechCurve = new KnotCurve(3);
  private readonly scalars = new KnotCurve(6);
  private readonly a = new Float64Array(6);
  private readonly da = new Float64Array(3);

  constructor(nv: number) {
    this.nv = nv;
    this.v = new Float32Array(nv);
    for (let j = 0; j < nv; j++) this.v[j] = j / (nv - 1);
    this.L = new Float32Array(nv * 3);
    this.T = new Float32Array(nv * 3);
    this.D = new Float32Array(nv * 3);
    this.N = new Float32Array(nv * 3);
    this.chord = new Float32Array(nv);
    this.camber = new Float32Array(nv);
    this.draft = new Float32Array(nv);
    this.side = new Float32Array(nv);
    this.luffing = new Float32Array(nv);
    this.stall = new Float32Array(nv);
    this.aoa = new Float32Array(nv);
  }

  /**
   * Rebuild all rows. `sections` are body-frame, bottom → top (only those with 0 < h < 1 are used);
   * the corners are boat-local. `headAft` is the top of the leech (head board) — equal to `head` for a
   * pointed head.
   */
  build(sections: readonly SailSection[], tack: Vec3, clew: Vec3, head: Vec3, headAft: Vec3, mode: RowNormalMode): void {
    const lc = this.luffCurve, tc = this.leechCurve, sc = this.scalars, a = this.a;
    lc.reset(); tc.reset(); sc.reset();
    lc.push3(0, tack.x, tack.y, tack.z);
    tc.push3(0, clew.x, clew.y, clew.z);
    for (const s of sections) {
      if (!(s.h > 0.002 && s.h < 0.998)) continue;
      const lx = s.luff.y, ly = -s.luff.z, lz = -s.luff.x;
      const c = s.chord > 0 ? s.chord : 0;
      const tx = lx + s.chordDir.y * c, ty = ly - s.chordDir.z * c, tz = lz - s.chordDir.x * c;
      // A non-finite section is skipped (the curves span the gap); its scalars fall back to neutral values,
      // so one bad snapshot cannot poison the side fields and filters downstream.
      if (!Number.isFinite(lx + ly + lz + tx + ty + tz)) continue;
      lc.push3(s.h, lx, ly, lz);
      tc.push3(s.h, tx, ty, tz);
      a[0] = fin(s.camber, 0); a[1] = fin(s.draft, 0.45); a[2] = fin(s.leewardY, 0);
      a[3] = fin(s.luffing, 0); a[4] = fin(s.stall, 0); a[5] = fin(s.aoa, 0);
      sc.push(s.h, a);
    }
    lc.push3(1, head.x, head.y, head.z);
    tc.push3(1, headAft.x, headAft.y, headAft.z);
    lc.finish(); tc.finish(); sc.finish();

    const { L, T, D, N } = this;
    let pdx = 0, pdy = 0, pdz = 1, pnx = 1, pny = 0, pnz = 0;
    for (let j = 0; j < this.nv; j++) {
      const v = this.v[j]!, o = j * 3;
      lc.valueAt(v, a, 0, this.da, 0);
      L[o] = a[0]!; L[o + 1] = a[1]!; L[o + 2] = a[2]!;
      tc.valueAt(v, a, 0);
      T[o] = a[0]!; T[o + 1] = a[1]!; T[o + 2] = a[2]!;
      if (sc.count > 0) {
        sc.valueAt(v, a, 0);
        this.camber[j] = Math.min(Math.max(a[0]!, 0), 0.45);
        this.draft[j] = Math.min(Math.max(a[1]!, 0.15), 0.85);
        this.side[j] = Math.min(Math.max(a[2]!, -1), 1);
        this.luffing[j] = clamp01(a[3]!);
        this.stall[j] = clamp01(a[4]!);
        this.aoa[j] = a[5]!;
      } else {
        this.camber[j] = 0; this.draft[j] = 0.45; this.side[j] = 0;
        this.luffing[j] = 0; this.stall[j] = 0; this.aoa[j] = 0;
      }
      let dx = T[o]! - L[o]!, dy = T[o + 1]! - L[o + 1]!, dz = T[o + 2]! - L[o + 2]!;
      const c = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.chord[j] = c;
      if (c > 1e-4) { dx /= c; dy /= c; dz /= c; } else { dx = pdx; dy = pdy; dz = pdz; }
      D[o] = dx; D[o + 1] = dy; D[o + 2] = dz;
      // Axis the cloth normal is built around: the luff tangent, or straight up.
      let ax = 0, ay = 1, az = 0;
      if (mode === 'luff') {
        const d0 = this.da[0]!, d1 = this.da[1]!, d2 = this.da[2]!;
        const al = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
        if (al > 1e-6) { ax = this.da[0]! / al; ay = this.da[1]! / al; az = this.da[2]! / al; }
      }
      let nx = ay * dz - az * dy, ny = az * dx - ax * dz, nz = ax * dy - ay * dx;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl > 1e-6 && c > 1e-4) { nx /= nl; ny /= nl; nz /= nl; } else { nx = pnx; ny = pny; nz = pnz; }
      N[o] = nx; N[o + 1] = ny; N[o + 2] = nz;
      pdx = dx; pdy = dy; pdz = dz; pnx = nx; pny = ny; pnz = nz;
    }
  }
}

/** A flat 2-D layout of the sail in metres (a sailmaker's plan), used for texture coordinates. */
export interface PlanPoint { x: number; y: number }

export class SailPlan {
  /** Texture rectangle in plan metres: uv = ((x − x0) / w, (y − y0) / h). */
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  /** Dense luff and leech polylines, foot → head (index k ↔ v = k / (n − 1)). */
  readonly luff: PlanPoint[];
  readonly leech: PlanPoint[];

  constructor(luff: PlanPoint[], leech: PlanPoint[], margin = 0.04) {
    this.luff = luff;
    this.leech = leech;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of [...luff, ...leech]) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    this.x0 = x0 - margin; this.y0 = y0 - margin;
    this.w = x1 - x0 + 2 * margin; this.h = y1 - y0 + 2 * margin;
  }

  /** Luff (a) and leech (b) plan points of the row at height fraction v. */
  rowAt(v: number): { a: PlanPoint; b: PlanPoint } {
    const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
    this.rowInto(v, a, b);
    return { a, b };
  }

  /** Allocation-free {@link rowAt}: luff point into `a`, leech point into `b`. */
  rowInto(v: number, a: PlanPoint, b: PlanPoint): void {
    const n = this.luff.length - 1;
    const f = clamp01(v) * n;
    const i = Math.min(Math.floor(f), n - 1), t = f - i;
    const la = this.luff[i]!, lb = this.luff[i + 1]!, ta = this.leech[i]!, tb = this.leech[i + 1]!;
    a.x = la.x + (lb.x - la.x) * t; a.y = la.y + (lb.y - la.y) * t;
    b.x = ta.x + (tb.x - ta.x) * t; b.y = ta.y + (tb.y - ta.y) * t;
  }

  /** Allocation-free {@link at}. */
  atInto(u: number, v: number, out: PlanPoint): PlanPoint {
    this.rowInto(v, PLAN_A, PLAN_B);
    out.x = PLAN_A.x + (PLAN_B.x - PLAN_A.x) * u;
    out.y = PLAN_A.y + (PLAN_B.y - PLAN_A.y) * u;
    return out;
  }

  /** Plan position of grid point (u, v): straight chord line between luff and leech. */
  at(u: number, v: number): PlanPoint {
    const { a, b } = this.rowAt(v);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  }
}

const PLAN_A: PlanPoint = { x: 0, y: 0 };
const PLAN_B: PlanPoint = { x: 0, y: 0 };

/** Build a plan from densely sampled (flat, nominal) rows, mapping boat-local points to plan metres. */
export function planFromRows(rows: SailRows, toPlan: (x: number, y: number, z: number) => PlanPoint, margin = 0.04): SailPlan {
  const luff: PlanPoint[] = [], leech: PlanPoint[] = [];
  for (let j = 0; j < rows.nv; j++) {
    const o = j * 3;
    luff.push(toPlan(rows.L[o]!, rows.L[o + 1]!, rows.L[o + 2]!));
    leech.push(toPlan(rows.T[o]!, rows.T[o + 1]!, rows.T[o + 2]!));
  }
  return new SailPlan(luff, leech, margin);
}

/** Tunables for the procedural motion added on top of the spring-followed shape. */
export interface FlutterParams {
  /** Shiver amplitude near the luff while partly luffing (m). */
  aLuff: number;
  /** Flogging amplitude when fully luffing (m, grows toward the leech). */
  aFlog: number;
  /** Leech flutter amplitude per m/s of apparent wind (m). */
  aLeech: number;
  /** Flog frequency (Hz) = f0 + fPerMs · aws. */
  f0: number;
  fPerMs: number;
  /** Wavelength (m) = lambda0 + lambdaPerChord · chord. */
  lambda0: number;
  lambdaPerChord: number;
  /** Sail height used to phase waves along the luff (m). */
  height: number;
}

/**
 * Spring-followed cloth grid. Owns the BufferGeometry: `out` IS the position attribute and `nrm` the
 * normal attribute. Triangles wind so the front face (and `nrm`) is ∂P/∂v × ∂P/∂u — the starboard side
 * of a main or jib.
 */
export class SailSurface {
  readonly nu: number;
  readonly nv: number;
  readonly count: number;
  /** Chord fraction of each column (clustered slightly toward the luff). */
  readonly u: Float32Array;
  readonly uPower: number;
  readonly geometry: THREE.BufferGeometry;
  readonly target: Float32Array;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly out: Float32Array;
  readonly nrm: Float32Array;
  /** Per-vertex spring natural frequency (rad/s) and damping ratio; pinned vertices follow exactly. */
  readonly omega: Float32Array;
  readonly zeta: Float32Array;
  readonly pinned: Uint8Array;
  /** Per-vertex (luffing, stall) for the AoA colouring. */
  readonly state: Float32Array;
  private readonly uvArr: Float32Array;
  private initialised = false;

  constructor(nu: number, nv: number, uPower = 1.15) {
    this.nu = nu;
    this.nv = nv;
    this.count = nu * nv;
    this.uPower = uPower;
    this.u = new Float32Array(nu);
    for (let i = 0; i < nu; i++) this.u[i] = Math.pow(i / (nu - 1), uPower);
    const n = this.count;
    this.target = new Float32Array(n * 3);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.out = new Float32Array(n * 3);
    this.nrm = new Float32Array(n * 3);
    this.omega = new Float32Array(n).fill(12);
    this.zeta = new Float32Array(n).fill(0.5);
    this.pinned = new Uint8Array(n);
    this.state = new Float32Array(n * 2);
    this.uvArr = new Float32Array(n * 2);

    const sail = new Float32Array(n * 2);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = j * nu + i;
        sail[k * 2] = this.u[i]!;
        sail[k * 2 + 1] = j / (nv - 1);
      }
    }
    const index: number[] = [];
    for (let j = 0; j < nv - 1; j++) {
      for (let i = 0; i < nu - 1; i++) {
        const a = j * nu + i, b = a + 1, c = a + nu, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setIndex(index);
    g.setAttribute('position', new THREE.BufferAttribute(this.out, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uvArr, 2));
    g.setAttribute('aSail', new THREE.BufferAttribute(sail, 2));
    g.setAttribute('aState', new THREE.BufferAttribute(this.state, 2).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    g.boundingBox = new THREE.Box3();
    this.geometry = g;
  }

  index(i: number, j: number): number { return j * this.nu + i; }

  /** Set the texture coordinates from a plan; `uShift` maps u ∈ [0,1] onto [uShift, 1] (furled jib). */
  setPlanUV(plan: SailPlan, uShift = 0): void {
    const a = PLAN_A, b = PLAN_B;
    for (let j = 0; j < this.nv; j++) {
      plan.rowInto(j / (this.nv - 1), a, b);
      for (let i = 0; i < this.nu; i++) {
        const u = uShift + this.u[i]! * (1 - uShift);
        const k = (j * this.nu + i) * 2;
        this.uvArr[k] = (a.x + (b.x - a.x) * u - plan.x0) / plan.w;
        this.uvArr[k + 1] = (a.y + (b.y - a.y) * u - plan.y0) / plan.h;
      }
    }
    (this.geometry.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Snap to the target on the next `follow` (e.g. after a teleport or when a sail is re-shown). */
  reset(): void { this.initialised = false; }

  /** True once the springs hold a state (the first `follow` snaps to the target). */
  get live(): boolean { return this.initialised; }

  /**
   * Swap columns i ↔ nu − 1 − i of the spring state (u → 1 − u; exact for a uniform u grid): the cloth that
   * was at the leech is now addressed as the luff. A spinnaker gybe does exactly this — the old clew is
   * clipped to the pole and becomes the new tack.
   */
  mirrorColumns(): void {
    const { nu, nv } = this;
    for (const arr of [this.pos, this.vel, this.out, this.nrm]) {
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu >> 1; i++) {
          const a = (j * nu + i) * 3, b = (j * nu + nu - 1 - i) * 3;
          for (let c = 0; c < 3; c++) { const t = arr[a + c]!; arr[a + c] = arr[b + c]!; arr[b + c] = t; }
        }
      }
    }
  }

  /** Advance the spring–damper toward `target`. */
  follow(dt: number): void {
    const { target, pos, vel } = this;
    if (!this.initialised) {
      pos.set(target);
      vel.fill(0);
      this.initialised = true;
      return;
    }
    const h = dt > 0 ? Math.min(dt, 1 / 15) : 0;
    if (h === 0) return;
    for (let k = 0; k < this.count; k++) {
      const o = k * 3;
      if (this.pinned[k]) {
        pos[o] = target[o]!; pos[o + 1] = target[o + 1]!; pos[o + 2] = target[o + 2]!;
        vel[o] = 0; vel[o + 1] = 0; vel[o + 2] = 0;
        continue;
      }
      const w = this.omega[k]!, z = this.zeta[k]!;
      const a = h * w * w;
      const inv = 1 / (1 + 2 * z * w * h + w * w * h * h);
      for (let c = 0; c < 3; c++) {
        const vNew = (vel[o + c]! + a * (target[o + c]! - pos[o + c]!)) * inv;
        vel[o + c] = vNew;
        pos[o + c] = pos[o + c]! + h * vNew;
      }
    }
  }

  /** Rebuild normals from `out`, flag attributes for upload and refresh the bounds. */
  commit(stateChanged: boolean): void {
    const { nu, nv, out, nrm } = this;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let bad = false;
    for (let j = 0; j < nv; j++) {
      const jd = j > 0 ? j - 1 : 0, ju = j < nv - 1 ? j + 1 : nv - 1;
      for (let i = 0; i < nu; i++) {
        const il = i > 0 ? i - 1 : 0, ir = i < nu - 1 ? i + 1 : nu - 1;
        const o = (j * nu + i) * 3;
        const oR = (j * nu + ir) * 3, oL = (j * nu + il) * 3, oU = (ju * nu + i) * 3, oD = (jd * nu + i) * 3;
        const ux = out[oR]! - out[oL]!, uy = out[oR + 1]! - out[oL + 1]!, uz = out[oR + 2]! - out[oL + 2]!;
        const vx = out[oU]! - out[oD]!, vy = out[oU + 1]! - out[oD + 1]!, vz = out[oU + 2]! - out[oD + 2]!;
        let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux;
        const l2 = nx * nx + ny * ny + nz * nz;
        if (l2 > 1e-24) { const il = 1 / Math.sqrt(l2); nx *= il; ny *= il; nz *= il; }
        else if (j > 0) { const ob = o - nu * 3; nx = nrm[ob]!; ny = nrm[ob + 1]!; nz = nrm[ob + 2]!; }
        else { nx = 1; ny = 0; nz = 0; }
        nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
        const x = out[o]!, y = out[o + 1]!, z = out[o + 2]!;
        if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) bad = true;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    if (bad) {
      // A non-finite input slipped through: fall back to the target and restart the springs.
      out.set(this.target);
      this.initialised = false;
    }
    const g = this.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    if (stateChanged) (g.getAttribute('aState') as THREE.BufferAttribute).needsUpdate = true;
    if (Number.isFinite(minX)) {
      g.boundingBox!.min.set(minX, minY, minZ);
      g.boundingBox!.max.set(maxX, maxY, maxZ);
      g.boundingBox!.getBoundingSphere(g.boundingSphere!);
    }
  }

  /** Bilinear sample of the rendered surface (and its normal) at grid coordinates (u, v). */
  sample(u: number, v: number, p: THREE.Vector3, n?: THREE.Vector3): void {
    const fi = (this.nu - 1) * Math.pow(clamp01(u), 1 / this.uPower);
    const fj = (this.nv - 1) * clamp01(v);
    const i = Math.min(Math.floor(fi), this.nu - 2), j = Math.min(Math.floor(fj), this.nv - 2);
    const a = fi - i, b = fj - j;
    const w00 = (1 - a) * (1 - b), w10 = a * (1 - b), w01 = (1 - a) * b, w11 = a * b;
    const k00 = (j * this.nu + i) * 3, k10 = k00 + 3, k01 = k00 + this.nu * 3, k11 = k01 + 3;
    const o = this.out;
    p.set(
      o[k00]! * w00 + o[k10]! * w10 + o[k01]! * w01 + o[k11]! * w11,
      o[k00 + 1]! * w00 + o[k10 + 1]! * w10 + o[k01 + 1]! * w01 + o[k11 + 1]! * w11,
      o[k00 + 2]! * w00 + o[k10 + 2]! * w10 + o[k01 + 2]! * w01 + o[k11 + 2]! * w11,
    );
    if (n) {
      const q = this.nrm;
      n.set(
        q[k00]! * w00 + q[k10]! * w10 + q[k01]! * w01 + q[k11]! * w11,
        q[k00 + 1]! * w00 + q[k10 + 1]! * w10 + q[k01 + 1]! * w01 + q[k11 + 1]! * w11,
        q[k00 + 2]! * w00 + q[k10 + 2]! * w10 + q[k01 + 2]! * w01 + q[k11 + 2]! * w11,
      ).normalize();
    }
  }

  /** Grid coordinates (u, v) of the target-surface point nearest to `p` (boat-local). */
  locate(p: Vec3): { u: number; v: number } {
    const t = this.target;
    let best = Infinity, bi = 0, bj = 0;
    for (let j = 0; j < this.nv; j++) {
      for (let i = 0; i < this.nu; i++) {
        const o = (j * this.nu + i) * 3;
        const d = (t[o]! - p.x) ** 2 + (t[o + 1]! - p.y) ** 2 + (t[o + 2]! - p.z) ** 2;
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    // Refine inside the neighbouring cells by projecting onto each cell's parallelogram.
    let bu = this.u[bi]!, bv = bj / (this.nv - 1), bestD = best;
    for (let dj = -1; dj <= 0; dj++) {
      for (let di = -1; di <= 0; di++) {
        const i = bi + di, j = bj + dj;
        if (i < 0 || j < 0 || i >= this.nu - 1 || j >= this.nv - 1) continue;
        const o = (j * this.nu + i) * 3, oi = o + 3, oj = o + this.nu * 3;
        const ex = t[oi]! - t[o]!, ey = t[oi + 1]! - t[o + 1]!, ez = t[oi + 2]! - t[o + 2]!;
        const fx = t[oj]! - t[o]!, fy = t[oj + 1]! - t[o + 1]!, fz = t[oj + 2]! - t[o + 2]!;
        const qx = p.x - t[o]!, qy = p.y - t[o + 1]!, qz = p.z - t[o + 2]!;
        const ee = ex * ex + ey * ey + ez * ez, ff = fx * fx + fy * fy + fz * fz, ef = ex * fx + ey * fy + ez * fz;
        const qe = qx * ex + qy * ey + qz * ez, qf = qx * fx + qy * fy + qz * fz;
        const det = ee * ff - ef * ef;
        if (det < 1e-12) continue;
        const a = clamp01((qe * ff - qf * ef) / det), b = clamp01((qf * ee - qe * ef) / det);
        const rx = qx - a * ex - b * fx, ry = qy - a * ey - b * fy, rz = qz - a * ez - b * fz;
        const d = rx * rx + ry * ry + rz * rz;
        if (d <= bestD) {
          bestD = d;
          bu = this.u[i]! + a * (this.u[i + 1]! - this.u[i]!);
          bv = (j + b) / (this.nv - 1);
        }
      }
    }
    return { u: bu, v: bv };
  }

  dispose(): void { this.geometry.dispose(); }
}

/** Fast tanh (Padé 3/3) — plenty for |x| ≤ 3. */
export function tanhFast(x: number): number {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

function hash2(a: number, b: number): number {
  let n = Math.imul(a, 374761393) + Math.imul(b, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** 2-D value noise in [0, 1] (smooth, deterministic, allocation-free). */
export function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const SNAP = 2.3;
const SNAP_NORM = 1 / tanhFast(SNAP);

/**
 * Phases (in cycles) of the wind-dependent motions, integrated frame by frame. A frequency that follows the
 * apparent wind must never be multiplied by absolute time: sin(2π·f(aws)·t) jumps by Δf·t whenever the wind
 * changes, which after a few minutes of sailing turns flogging and flutter into noise.
 */
export interface ClothPhase { flog: number; leech: number }

/** Leech-flutter frequency (Hz) at apparent wind speed `aws` (m/s). */
export const leechFlutterHz = (aws: number): number => 5.5 + 0.45 * Math.max(0, aws);

/** Advance a sail's cloth phases by `dt` at the current apparent wind (dt = 0 holds them: pause). */
export function advancePhase(phase: ClothPhase, p: FlutterParams, aws: number, dt: number): void {
  if (!(dt > 0)) return;
  const w = aws > 0 ? aws : 0;
  phase.flog += (p.f0 + p.fPerMs * w) * dt;
  phase.leech += leechFlutterHz(w) * dt;
}

/**
 * Write `out = pos + displacement · N_row` with the procedural cloth motion:
 *  - partial luffing: a shiver running aft from the luff (the edge of the luff bubble);
 *  - full luffing, or cloth that is flat because it is flipping sides (per-vertex `side` ≈ 0): flogging —
 *    travelling waves luff → leech with a snapping (square-ish) waveform, i.e. the cloth sits on one side
 *    and cracks across, growing into a whip at the leech; slow phase wobble keeps it from looking periodic;
 *  - fine leech flutter in fresh wind.
 * `env` scales luff/flog motion per vertex (0 on attached edges, reduced by battens); `leechEnv` masks the
 * leech flutter.
 */
export function exciteCloth(
  s: SailSurface, rows: SailRows, luffing: Float32Array, side: Float32Array,
  p: FlutterParams, phase: ClothPhase, t: number, aws: number, env: Float32Array, leechEnv: Float32Array,
): void {
  const { nu, nv, pos, out, u } = s;
  const N = rows.N;
  const w = aws > 0 ? aws : 0;
  // Leech flutter grows with the square of the breeze: nothing in light air, obvious in a fresh one.
  const aLeech = p.aLeech * w * Math.min(w / 8, 1.8);
  const TAU = Math.PI * 2;
  const wobble = 1.2 * Math.sin(TAU * 0.37 * t);
  for (let j = 0; j < nv; j++) {
    const o = j * 3;
    const nx = N[o]!, ny = N[o + 1]!, nz = N[o + 2]!;
    const chord = rows.chord[j]!;
    const lRow = luffing[j]!;
    const lambda = p.lambda0 + p.lambdaPerChord * chord;
    // Short chords near the head cannot fold as far as the broad middle of the sail.
    const chordAmp = Math.min(1, 0.25 + chord / 1.4);
    const y = rows.v[j]! * p.height;
    const phY = 0.9 * y + wobble * Math.sin(0.5 * y + 0.3);
    const tf = phase.flog;
    const leechPh = TAU * (phase.leech - y / 0.9);
    const leechMod = aLeech * (0.7 + 0.3 * Math.sin(TAU * 0.37 * t + y));
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i, ko = k * 3;
      const uu = u[i]!, x = uu * chord;
      let d = 0;
      const e = env[k]!;
      const sk = side[k]!;
      const lEff = lRow > 1 - (sk < 0 ? -sk : sk) ? lRow : 1 - (sk < 0 ? -sk : sk);
      if (e > 0 && lEff > 0.01) {
        const flog = smooth(0.45, 1, lEff);
        const shiver = lEff * (1 - flog);
        const ph1 = TAU * (x / lambda - tf) + phY;
        const s1 = Math.sin(ph1), c1 = Math.cos(ph1);
        // Second harmonic (the crack running behind each snap) from the double-angle identity.
        const s2 = 2 * s1 * c1, c2 = 1 - 2 * s1 * s1;
        let wave = 0;
        if (flog > 0) {
          // Snap waveform travelling aft, plus a slower heavy roll of the whole panel.
          const snap = tanhFast(SNAP * s1) * SNAP_NORM;
          const roll = Math.sin(TAU * (x / (1.9 * lambda) - 0.61 * tf) - 0.6 * y + 2.1);
          const crack = s2 * 0.2675 + c2 * 0.9636; // sin(2·ph1 + 1.3)
          wave = flog * p.aFlog * chordAmp * (0.3 + 0.9 * uu) * (0.62 * snap + 0.28 * roll + 0.14 * uu * crack);
        }
        if (shiver > 0) wave += shiver * p.aLuff * Math.exp(-x / (0.25 + 1.2 * lEff)) * (s2 * 0.7648 + c2 * 0.6442); // sin(2·ph1 + 0.7)
        d += e * wave;
      }
      const le = leechEnv[k]!;
      if (le > 0 && aLeech > 0) d += le * leechMod * Math.sin(leechPh + 3 * x);
      out[ko] = pos[ko]! + nx * d;
      out[ko + 1] = pos[ko + 1]! + ny * d;
      out[ko + 2] = pos[ko + 2]! + nz * d;
    }
  }
}

/**
 * Per-vertex belly side (−1 … +1). The simulation's `leewardY` is a hard sign per section; real cloth
 * turns over progressively — the luff fills first, the leech last — so each column follows the row value
 * with its own lag. Cloth caught mid-way is flat, and flat cloth flogs (see exciteCloth).
 */
export class SideField {
  readonly value: Float32Array;
  private readonly tau: Float32Array;
  private readonly alpha: Float32Array;
  private init = false;

  constructor(private readonly nu: number, private readonly nv: number, u: Float32Array, luffTau = 0.07, leechTau = 0.32) {
    this.value = new Float32Array(nu * nv);
    this.tau = new Float32Array(nu);
    this.alpha = new Float32Array(nu);
    for (let i = 0; i < nu; i++) this.tau[i] = luffTau + (leechTau - luffTau) * Math.pow(u[i]!, 1.3);
  }

  update(rowSide: Float32Array, dt: number): Float32Array {
    const { nu, nv, value } = this;
    if (!this.init) {
      for (let j = 0; j < nv; j++) value.fill(rowSide[j]!, j * nu, (j + 1) * nu);
      this.init = true;
      return value;
    }
    if (!(dt > 0)) return value;
    for (let i = 0; i < nu; i++) this.alpha[i] = 1 - Math.exp(-dt / this.tau[i]!);
    for (let j = 0; j < nv; j++) {
      const target = rowSide[j]!;
      const o = j * nu;
      for (let i = 0; i < nu; i++) value[o + i] = value[o + i]! + (target - value[o + i]!) * this.alpha[i]!;
    }
    return value;
  }

  reset(): void { this.init = false; }

  /** Swap columns i ↔ nu − 1 − i (the cloth was relabelled: see SailSurface.mirrorColumns). */
  mirrorColumns(): void {
    const { nu, nv, value } = this;
    for (let j = 0; j < nv; j++) {
      const o = j * nu;
      for (let i = 0; i < nu >> 1; i++) {
        const a = o + i, b = o + nu - 1 - i, t = value[a]!;
        value[a] = value[b]!;
        value[b] = t;
      }
    }
  }

  /**
   * Negate every value: the rows' chord (and so the cloth normal N) reversed, so the same belly in space is
   * now −side · N.
   */
  negate(): void {
    const v = this.value;
    for (let k = 0; k < v.length; k++) v[k] = -v[k]!;
  }
}

/** First-order low-pass of per-row values (the sim's leewardY is a hard ±1 sign; the cloth must flip). */
export class RowFilter {
  readonly value: Float32Array;
  private init = false;
  constructor(n: number) { this.value = new Float32Array(n); }
  update(src: Float32Array, dt: number, tau: number): Float32Array {
    if (!this.init || !(dt > 0)) {
      if (!this.init) { this.value.set(src); this.init = true; }
      return this.value;
    }
    const a = 1 - Math.exp(-dt / tau);
    for (let j = 0; j < src.length; j++) this.value[j] = this.value[j]! + (src[j]! - this.value[j]!) * a;
    return this.value;
  }
  reset(): void { this.init = false; }
}

/** Gentle breathing of the sail's depth in the wind (slow, a few percent). */
export function breathing(t: number, v: number): number {
  return 1 + 0.03 * Math.sin(Math.PI * 2 * 0.21 * t + 1.7 * v) + 0.02 * Math.sin(Math.PI * 2 * 0.57 * t + 0.4 + v);
}

/** Per-vertex (luffing, stall) from per-row values, for the AoA colouring. */
export function writeState(s: SailSurface, luffing: Float32Array, stall: Float32Array): void {
  for (let j = 0; j < s.nv; j++) {
    const l = luffing[j]!, st = stall[j]!;
    for (let i = 0; i < s.nu; i++) {
      const k = (j * s.nu + i) * 2;
      s.state[k] = l;
      s.state[k + 1] = st;
    }
  }
}
