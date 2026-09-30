// Air-flow field on horizontal slices through the rig (spec §8, §8.1) — what the flow particles and the flow-slice
// overlay read. Pure TS (no three.js/DOM), rebuilt per slice at ~10 Hz.
//
// Per slice height the sails are cut from the snapshot's strip sections and each cut is handled by the flow regime the
// simulation reports for it:
//  * attached (angle of attack below ~30°): the coupled 2-D vortex lattice (`src/flow`). Particles advect through the
//    UNSCALED solution — it is tangent to the cloth, so streamlines never cut through a sail — while speed colours and
//    pressure use the circulation scaled to the section `cl` of the force model (the flow-solver ruling; scaling breaks
//    tangency). A luffing section loses its circulation (the cloth is flogging, not lifting);
//  * stalled (stall > 0.5): the same lattice plus a slowed, turbulent separated layer from the separation point along
//    the lee side, shed from the leech as a wake;
//  * separated (running sails at 45–90°, the spinnaker downwind): a bluff body — zero-circulation potential flow around
//    the chord (stagnation on the windward face, flow squeezing round both edges) and a wide dead-air wake behind.
// Regimes blend smoothly with angle of attack, so a sail easing from a reach to a run morphs from one picture to the
// other. The field is stored on a regular grid as (u, v, speed ratio, turbulence) per node.
import { solveSlice, type Element2D, type PanelGeom, type SliceSolution } from '../../flow/slices';
import type { JibState, SailId, SailState, SimSnapshot, SpinnakerState } from '../../sim/types';
import { DEG, clamp, lerp, smoothstep } from '../../shared/math';
import { rigAir } from './frames';

/** Grid over the rig in the body frame (x forward, y starboard), metres. */
export const FIELD_BOUNDS = { x0: -7.5, y0: -7.5, x1: 9, y1: 7.5 } as const;
export const FIELD_NX = 46;
export const FIELD_NY = 42;
/** Camber-line points per element (collision polylines and outlines). */
export const CAMBER_PTS = 21;

const MAX_ELEMENTS = 3;
/** Rows combined per `work()` step: a rebuild is published after ⌈ny / ROW_BAND⌉ steps. */
const ROW_BAND = 21;
const MIN_CHORD = 0.3;
/** Speeds in the bluff-body potential flow are capped at this multiple of the stream (edge singularities). */
const BLUFF_CAP = 2.2;

/** One sail cut at a slice height, in slice (body x, y) coordinates. */
export interface SliceElement {
  id: SailId;
  leX: number; leY: number;
  teX: number; teY: number;
  /** Unit chord direction luff → leech and unit normal toward the belly (lee) side. */
  dirX: number; dirY: number;
  nX: number; nY: number;
  chord: number;
  camber: number;
  draft: number;
  aoa: number;
  luffing: number;
  stall: number;
  cl: number;
  /** Weights: lattice circulation (luffing removes it), bluff-body share, stalled-layer strength. */
  lattice: number;
  bluff: number;
  stallW: number;
  /** Lift-matching factor of the lattice circulation for colours/pressure. */
  k: number;
  /** Camber line, CAMBER_PTS points (x, y). */
  readonly pts: Float32Array;
  /** Per-update constants of the wake model (see `prepareWake`). */
  readonly w: WakeConsts;
}

interface WakeConsts {
  cA: number; cB: number; cC: number;
  // bluff wake
  cx: number; cy: number; sL: number; sT: number; aL: number; aT: number; lo: number; hi: number; width: number; invLd: number;
  // stalled layer and leech wake
  sSep: number; deltaTE: number; ox: number; oy: number; invLs: number;
}

export interface FlowSample { u: number; v: number; ratio: number; turb: number }

/** Cubic camber-line shape of `camberLine` (src/flow/slices.ts): offset at chord fraction s for a unit depth. */
function camberCoeffs(draft: number): [number, number, number] {
  const d = clamp(draft, 0.35, 0.65);
  const q = d * d * (1 - d) * (1 - d);
  return [((2 - 3 * d) * d) / q, -(1 - 3 * d * d) / q, (1 - 2 * d) / q];
}

/** A blank element (pre-allocated storage for `sailCutAt`). */
export function newSliceElement(): SliceElement {
  return {
    id: 'main', leX: 0, leY: 0, teX: 0, teY: 0, dirX: 1, dirY: 0, nX: 0, nY: 1, chord: 1, camber: 0, draft: 0.5,
    aoa: 0, luffing: 0, stall: 0, cl: 0, lattice: 0, bluff: 0, stallW: 0, k: 0, pts: new Float32Array(2 * CAMBER_PTS),
    w: { cA: 0, cB: 0, cC: 0, cx: 0, cy: 0, sL: 0, sT: 0, aL: 0, aT: 0, lo: 0, hi: 0, width: 0, invLd: 0, sSep: 0, deltaTE: 0, ox: 0, oy: 0, invLs: 0 },
  };
}

/**
 * The sail's cut at height h (m above the waterline, body z = −h), interpolated between its strip sections; false when
 * the sail does not reach that height, is not set, or is too narrow there.
 */
export function sailCutAt(sail: SailState, h: number, out: SliceElement): boolean {
  const secs = sail.sections;
  const n = secs.length;
  if (!sail.set || n < 2) return false;
  if (sail.id === 'jib' && (sail as JibState).furl > 0.95) return false;
  // A spinnaker still going up (or coming down) has no settled shape to cut.
  const spin = sail.id === 'spinnaker' ? (sail as SpinnakerState) : null;
  if (spin && spin.hoist < 0.6) return false;
  const h0 = -secs[0]!.luff.z;
  const hN = -secs[n - 1]!.luff.z;
  const step = (hN - h0) / (n - 1);
  if (!(Math.abs(step) > 1e-6) || h < h0 - 0.5 * step || h > hN + 0.5 * step) return false;
  let i = Math.floor((h - h0) / step);
  i = clamp(i, 0, n - 2);
  const a = secs[i]!, b = secs[i + 1]!;
  const t = clamp((h - (-a.luff.z)) / (-b.luff.z - -a.luff.z), -0.5, 1.5);
  const chord = lerp(a.chord, b.chord, t);
  if (!(chord >= MIN_CHORD)) return false;
  let dx = lerp(a.chordDir.x, b.chordDir.x, t);
  let dy = lerp(a.chordDir.y, b.chordDir.y, t);
  const dl = Math.hypot(dx, dy);
  if (!(dl > 1e-6)) return false;
  dx /= dl; dy /= dl;
  const lee = lerp(a.leewardY, b.leewardY, t);
  out.id = sail.id;
  out.leX = lerp(a.luff.x, b.luff.x, t);
  out.leY = lerp(a.luff.y, b.luff.y, t);
  out.dirX = dx; out.dirY = dy;
  out.chord = chord;
  out.teX = out.leX + dx * chord;
  out.teY = out.leY + dy * chord;
  // Belly side s·(c.y, −c.x) (SailSection.leewardY); a sail passing through a tack flattens as s crosses 0.
  const side = lee >= 0 ? 1 : -1;
  out.nX = side * dy;
  out.nY = -side * dx;
  out.camber = lerp(a.camber, b.camber, t) * Math.min(1, Math.abs(lee));
  out.draft = lerp(a.draft, b.draft, t);
  out.aoa = lerp(a.aoa, b.aoa, t);
  out.luffing = clamp(Math.max(lerp(a.luffing, b.luffing, t), spin ? spin.collapsed : 0), 0, 1);
  out.stall = clamp(lerp(a.stall, b.stall, t), 0, 1);
  out.cl = lerp(a.cl, b.cl, t);
  const [A, B, C] = camberCoeffs(out.draft);
  out.w.cA = A; out.w.cB = B; out.w.cC = C;
  const depth = out.camber * chord;
  for (let k = 0; k < CAMBER_PTS; k++) {
    const s = k / (CAMBER_PTS - 1);
    const off = depth * s * (A + s * (B + s * C));
    out.pts[2 * k] = out.leX + chord * s * dx + off * out.nX;
    out.pts[2 * k + 1] = out.leY + chord * s * dy + off * out.nY;
  }
  // Flow regime weights.
  out.bluff = smoothstep(spin ? 15 * DEG : 32 * DEG, spin ? 45 * DEG : 60 * DEG, out.aoa);
  out.lattice = (1 - out.bluff) * (1 - smoothstep(0.55, 0.85, out.luffing));
  out.stallW = (1 - out.bluff) * smoothstep(0.5, 0.95, out.stall);
  out.k = 0;
  return true;
}

const SAIL_ORDER: readonly SailId[] = ['jib', 'spinnaker', 'main'];

export class SliceField {
  h: number;
  readonly nx = FIELD_NX;
  readonly ny = FIELD_NY;
  readonly x0 = FIELD_BOUNDS.x0;
  readonly y0 = FIELD_BOUNDS.y0;
  readonly x1 = FIELD_BOUNDS.x1;
  readonly y1 = FIELD_BOUNDS.y1;
  readonly dx = (FIELD_BOUNDS.x1 - FIELD_BOUNDS.x0) / (FIELD_NX - 1);
  readonly dy = (FIELD_BOUNDS.y1 - FIELD_BOUNDS.y0) / (FIELD_NY - 1);
  /** (u, v, speed ratio, turbulence) per node, row-major with x fastest (the published field). */
  data = new Float32Array(FIELD_NX * FIELD_NY * 4);
  /** Free stream of the published field: rig-plane apparent wind at this height (body x, y). */
  readonly uInf = { x: -1, y: 0 };
  speed = 1;
  /** Sail cuts the published field was built for (valid up to `count`). */
  elements: SliceElement[] = Array.from({ length: MAX_ELEMENTS }, newSliceElement);
  count = 0;
  /** Increments whenever a rebuilt field is published (consumers re-upload textures / re-trace streamlines). */
  version = 0;
  /** Simulated time of the snapshot the published field was built from. */
  builtAt = -Infinity;

  // A rebuild in progress: cuts, stream and output buffer, published by the last `work()` step.
  private back = new Float32Array(FIELD_NX * FIELD_NY * 4);
  private bElements: SliceElement[] = Array.from({ length: MAX_ELEMENTS }, newSliceElement);
  private bCount = 0;
  private readonly bU = { x: -1, y: 0 };
  private bSpeed = 1;
  /** Yaw rate of the rebuild (the stream turns across the grid while the boat turns). */
  private bR = 0;
  private bT = 0;
  /** Next band of rows to combine, or −1 when no rebuild is in progress. */
  private phase = -1;
  private scratch: SliceElement[] = Array.from({ length: MAX_ELEMENTS }, newSliceElement);
  private scratchCount = 0;

  /** Induced velocity (u, v) of each element's vortices at every node. */
  private readonly grids = Array.from({ length: MAX_ELEMENTS }, () => new Float32Array(FIELD_NX * FIELD_NY * 2));
  private readonly vort = Array.from({ length: MAX_ELEMENTS }, newVortices);
  private readonly invDx = 1 / this.dx;
  private readonly invDy = 1 / this.dy;
  private readonly air = { x: 0, y: 0 };

  constructor(h: number) {
    this.h = h;
  }

  /** A rebuild has been started and not yet published. */
  get building(): boolean {
    return this.phase >= 0;
  }

  /** Step of the rebuild in progress (0 = first band of rows), or −1 when idle. */
  get buildPhase(): number {
    return this.phase;
  }

  /**
   * Start a rebuild for this snapshot: cut the sails, solve the lattice and fill the induced-velocity grids. Unless
   * `force`d it is skipped (returns false) when the stream and every sail cut are unchanged within what the eye could
   * see — steady sailing costs almost nothing. Finish with `work()`; the published field stays valid meanwhile.
   */
  begin(s: SimSnapshot, force = false): boolean {
    rigAir(s, 1.0, 0, -this.h, this.air);
    this.scratchCount = 0;
    for (const id of SAIL_ORDER) {
      if (this.scratchCount >= MAX_ELEMENTS) break;
      if (sailCutAt(s.sails[id], this.h, this.scratch[this.scratchCount]!)) this.scratchCount++;
    }
    if (!force && !this.changed() && s.t >= this.builtAt) return false;
    const b = this.bElements;
    this.bElements = this.scratch;
    this.scratch = b;
    this.bCount = this.scratchCount;
    this.bU.x = this.air.x;
    this.bU.y = this.air.y;
    this.bSpeed = Math.max(Math.hypot(this.air.x, this.air.y), 0.05);
    this.bR = s.boat.yawRate;
    this.bT = s.t;
    this.remember();
    this.solveLattice();
    const ux = this.bU.x / this.bSpeed, uy = this.bU.y / this.bSpeed;
    for (let e = 0; e < this.bCount; e++) prepareWake(this.bElements[e]!, ux, uy);
    this.phase = 0;
    return true;
  }

  /** Combine the next band of rows; returns true when the rebuilt field has been published or nothing is pending. */
  work(): boolean {
    if (this.phase < 0) return true;
    const j0 = this.phase * ROW_BAND;
    const j1 = Math.min(this.ny, j0 + ROW_BAND);
    this.combine(j0, j1);
    this.phase++;
    if (j1 < this.ny) return false;
    const d = this.data;
    this.data = this.back;
    this.back = d;
    const e = this.elements;
    this.elements = this.bElements;
    this.bElements = e;
    this.count = this.bCount;
    this.uInf.x = this.bU.x;
    this.uInf.y = this.bU.y;
    this.speed = this.bSpeed;
    this.builtAt = this.bT;
    this.version++;
    this.phase = -1;
    return true;
  }

  /** Whole rebuild at once (returns false when skipped as unchanged). */
  update(s: SimSnapshot, force = false): boolean {
    if (!this.begin(s, force)) return false;
    while (!this.work());
    return true;
  }

  /** Inputs of the last rebuild: stream and, per element, geometry and regime weights. */
  private readonly last = new Float32Array(2 + MAX_ELEMENTS * 9);
  private lastCount = -1;

  private remember(): void {
    const L = this.last;
    L[0] = this.air.x; L[1] = this.air.y;
    for (let e = 0; e < this.bCount; e++) {
      const el = this.bElements[e]!, o = 2 + 9 * e;
      L[o] = el.leX; L[o + 1] = el.leY; L[o + 2] = el.teX; L[o + 3] = el.teY; L[o + 4] = el.camber;
      L[o + 5] = el.lattice; L[o + 6] = el.bluff; L[o + 7] = el.stallW; L[o + 8] = el.cl;
    }
    this.lastCount = this.bCount;
  }

  private changed(): boolean {
    if (this.scratchCount !== this.lastCount) return true;
    const L = this.last;
    const sp = Math.hypot(L[0]!, L[1]!);
    const dx = this.air.x - L[0]!, dy = this.air.y - L[1]!;
    if (Math.hypot(dx, dy) > 0.012 * sp + 0.02) return true; // ≈ 0.7° or 1.2 % of the stream
    for (let e = 0; e < this.scratchCount; e++) {
      const el = this.scratch[e]!, o = 2 + 9 * e;
      if (Math.abs(el.leX - L[o]!) + Math.abs(el.leY - L[o + 1]!) + Math.abs(el.teX - L[o + 2]!) + Math.abs(el.teY - L[o + 3]!) > 0.03) return true;
      if (Math.abs(el.camber - L[o + 4]!) > 0.003) return true;
      if (Math.abs(el.lattice - L[o + 5]!) + Math.abs(el.bluff - L[o + 6]!) + Math.abs(el.stallW - L[o + 7]!) > 0.03) return true;
      if (Math.abs(el.cl - L[o + 8]!) > 0.03) return true;
    }
    return false;
  }

  /** Bilinear sample of the field (positions outside take the nearest edge value). Allocation-free. */
  sample(x: number, y: number, out: FlowSample): FlowSample {
    const nx = this.nx, ny = this.ny, d = this.data;
    let fx = (x - this.x0) * this.invDx;
    let fy = (y - this.y0) * this.invDy;
    if (!(fx > 0)) fx = 0; else if (fx > nx - 1) fx = nx - 1;
    if (!(fy > 0)) fy = 0; else if (fy > ny - 1) fy = ny - 1;
    let i0 = fx | 0, j0 = fy | 0;
    if (i0 > nx - 2) i0 = nx - 2;
    if (j0 > ny - 2) j0 = ny - 2;
    const tx = fx - i0, ty = fy - j0;
    const k00 = 4 * (j0 * nx + i0), k10 = k00 + 4, k01 = k00 + 4 * nx, k11 = k01 + 4;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    out.u = d[k00]! * w00 + d[k10]! * w10 + d[k01]! * w01 + d[k11]! * w11;
    out.v = d[k00 + 1]! * w00 + d[k10 + 1]! * w10 + d[k01 + 1]! * w01 + d[k11 + 1]! * w11;
    out.ratio = d[k00 + 2]! * w00 + d[k10 + 2]! * w10 + d[k01 + 2]! * w01 + d[k11 + 2]! * w11;
    out.turb = d[k00 + 3]! * w00 + d[k10 + 3]! * w10 + d[k01 + 3]! * w01 + d[k11 + 3]! * w11;
    return out;
  }

  inBounds(x: number, y: number): boolean {
    return x >= this.x0 && x <= this.x1 && y >= this.y0 && y <= this.y1;
  }

  /** Solve the coupled lattice of the attached elements and fill one induced-velocity grid per element. */
  private solveLattice(): void {
    const active: number[] = [];
    const elems: Element2D[] = [];
    for (let e = 0; e < this.bCount; e++) {
      const el = this.bElements[e]!;
      // A near-bluff or flogging cut contributes too little circulation to be worth a grid fill.
      if (el.lattice < 0.15) { el.lattice = 0; continue; }
      active.push(e);
      const pts = [];
      for (let k = 0; k < CAMBER_PTS; k += 2) pts.push({ x: el.pts[2 * k]!, y: el.pts[2 * k + 1]! });
      if ((CAMBER_PTS - 1) % 2 !== 0) pts.push({ x: el.pts[2 * CAMBER_PTS - 2]!, y: el.pts[2 * CAMBER_PTS - 1]! });
      elems.push({ points: pts });
    }
    for (const g of this.grids) g.fill(0);
    if (active.length === 0) return;
    let sol: SliceSolution;
    try {
      sol = solveSlice(elems, this.bU);
    } catch {
      for (const e of active) this.bElements[e]!.lattice = 0;
      return;
    }
    for (let a = 0; a < active.length; a++) {
      const el = this.bElements[active[a]!]!;
      const solved = sol.cl[a]!;
      // Lift-matching factor for colours and pressure (belly-relative, like SailSection.cl).
      el.k = solved > 0.05 && el.cl > 0 ? clamp(el.cl / solved, 0, 1.5) : 0;
      // Induced field of this element's vortices alone (the coupled solve already holds the interaction).
      const v = this.vort[active[a]!]!;
      loadVortices(sol.panels[a]!, sol.gammas[a]!, v);
      this.fillInduced(v, this.grids[active[a]!]!);
    }
  }

  /**
   * Induced velocity of one element at every node (Biot–Savart with Rankine cores, as `velocityAt` in src/flow). Within
   * 1.2 chords of the element every vortex counts; further out four lumped vortices (Γ-weighted quarters of the
   * lattice) stand in — a few per cent of the induced velocity there, three times cheaper per rebuild.
   */
  private fillInduced(v: Vortices, out: Float32Array): void {
    const { nx, ny } = this;
    let k = 0;
    for (let j = 0; j < ny; j++) {
      const y = this.y0 + j * this.dy;
      for (let i = 0; i < nx; i++) {
        const x = this.x0 + i * this.dx;
        const ex = x - v.cx, ey = y - v.cy;
        const near = ex * ex + ey * ey < v.near2;
        const n = near ? v.n : v.gn;
        const px = near ? v.x : v.gx, py = near ? v.y : v.gy, pk = near ? v.k : v.gk;
        let u = 0, w = 0;
        for (let m = 0; m < n; m++) {
          const dx = x - px[m]!, dy = y - py[m]!;
          const r2 = dx * dx + dy * dy;
          const f = pk[m]! / (r2 > v.c2 ? r2 : v.c2);
          u += f * dy;
          w -= f * dx;
        }
        out[k++] = u;
        out[k++] = w;
      }
    }
  }

  /** Stream + lattice + bluff bodies + separated wakes → (u, v, ratio, turb) for rows [j0, j1) of the back buffer. */
  private combine(j0: number, j1: number): void {
    const { nx } = this;
    const data = this.back;
    const uInf = this.bU;
    const U = this.bSpeed;
    const ux = uInf.x / U, uy = uInf.y / U; // flow direction
    for (let j = j0; j < j1; j++) {
      const y = this.y0 + j * this.dy;
      for (let i = 0; i < nx; i++) {
        const x = this.x0 + i * this.dx;
        const node = j * nx + i;
        let ax = uInf.x, ay = uInf.y; // advection (unscaled lattice)
        let cx = uInf.x, cy = uInf.y; // colour (lift-matched lattice)
        let deficit = 0, turb = 0;
        for (let e = 0; e < this.bCount; e++) {
          const el = this.bElements[e]!;
          if (el.lattice > 0) {
            const g = this.grids[e]!;
            const gu = g[2 * node]!, gv = g[2 * node + 1]!;
            ax += el.lattice * gu; ay += el.lattice * gv;
            cx += el.lattice * el.k * gu; cy += el.lattice * el.k * gv;
          }
          if (el.bluff > 0) {
            bluffDisturbance(el, uInf.x, uInf.y, U, x, y, tmpV);
            ax += el.bluff * tmpV.x; ay += el.bluff * tmpV.y;
            cx += el.bluff * tmpV.x; cy += el.bluff * tmpV.y;
          }
          if (el.bluff > 0.02 || el.stallW > 0.02 || el.luffing > 0.3) {
            wakeAt(el, ux, uy, x, y, tmpW);
            if (tmpW.deficit > deficit) deficit = tmpW.deficit;
            if (tmpW.turb > turb) turb = tmpW.turb;
          }
        }
        const keep = 1 - Math.min(deficit, 1.1);
        // The free stream is taken at the mast (x = 1); a turning boat sees it rotate across the slice
        // (air relative to a body point gains (r·y, −r·(x − 1)) from −ω × r). Advection only: colours stay stream-relative.
        const o = 4 * node;
        data[o] = ax * keep + this.bR * y;
        data[o + 1] = ay * keep - this.bR * (x - 1);
        data[o + 2] = (Math.sqrt(cx * cx + cy * cy) / U) * Math.max(keep, 0);
        data[o + 3] = Math.min(turb, 1);
      }
    }
  }
}

const tmpV = { x: 0, y: 0 };
const tmpW = { deficit: 0, turb: 0 };
const cs1 = { re: 0, im: 0 };
const cs2 = { re: 0, im: 0 };

function csqrt(x: number, y: number, out: { re: number; im: number }): void {
  const r = Math.sqrt(x * x + y * y);
  out.re = Math.sqrt(Math.max(0.5 * (r + x), 0));
  const im = Math.sqrt(Math.max(0.5 * (r - x), 0));
  out.im = y < 0 ? -im : im;
}

/**
 * Disturbance velocity of a flat plate (the element's chord) in a stream, without circulation: the tangential part of
 * the stream passes undisturbed, the normal part flows round both edges (complex potential w = −i·Uₙ·√(z² − a²)).
 * Speeds near the edges are capped. Writes body-frame (x, y) into `out`.
 */
export function bluffDisturbance(el: SliceElement, ux: number, uy: number, U: number, x: number, y: number, out: { x: number; y: number }): void {
  const w = el.w;
  const a = 0.5 * el.chord;
  const tx = el.dirX, ty = el.dirY;
  const px = x - w.cx, py = y - w.cy;
  const xi = px * tx + py * ty;
  const eta = py * tx - px * ty; // along the left normal (−ty, tx): (ξ, η) is right-handed
  const Ut = ux * tx + uy * ty;
  const Un = uy * tx - ux * ty;
  const r2 = xi * xi + eta * eta;
  if (r2 > 9 * a * a) {
    // Far from the plate the disturbance is its dipole term, −i·Uₙ·a²/(2z²) (error ~ (a/r)² of a small field).
    const K = (Un * a * a) / (2 * r2 * r2);
    const du = -2 * K * xi * eta, dv = K * (xi * xi - eta * eta);
    out.x = du * tx - dv * ty;
    out.y = du * ty + dv * tx;
    return;
  }
  csqrt(xi - a, eta, cs1);
  csqrt(xi + a, eta, cs2);
  const fr = cs1.re * cs2.re - cs1.im * cs2.im;
  const fi = cs1.re * cs2.im + cs1.im * cs2.re;
  const f2 = fr * fr + fi * fi;
  let u = 0, v = 0;
  if (f2 > 1e-12) {
    u = (Un * (eta * fr - xi * fi)) / f2;
    v = (Un * (xi * fr + eta * fi)) / f2;
  }
  // Cap the total local speed (the ideal flow is singular at the edges).
  const tu = u + Ut;
  const sp2 = tu * tu + v * v;
  const cap = BLUFF_CAP * U;
  if (sp2 > cap * cap) { const k = cap / Math.sqrt(sp2); u = tu * k - Ut; v *= k; }
  const dv = v - Un;
  out.x = u * tx - dv * ty;
  out.y = u * ty + dv * tx;
}

/** Per-update constants of an element's wake for the flow direction (ux, uy). */
export function prepareWake(el: SliceElement, ux: number, uy: number): void {
  const w = el.w;
  const wnx = -uy, wny = ux;
  w.cx = 0.5 * (el.leX + el.teX);
  w.cy = 0.5 * (el.leY + el.teY);
  w.sL = (el.leX - w.cx) * wnx + (el.leY - w.cy) * wny;
  w.sT = (el.teX - w.cx) * wnx + (el.teY - w.cy) * wny;
  w.aL = (el.leX - w.cx) * ux + (el.leY - w.cy) * uy;
  w.aT = (el.teX - w.cx) * ux + (el.teY - w.cy) * uy;
  w.lo = Math.min(w.sL, w.sT);
  w.hi = Math.max(w.sL, w.sT);
  w.width = w.hi - w.lo;
  w.invLd = 1 / (2.2 * w.width + 1.5);
  const st = el.stallW;
  w.sSep = lerp(0.8, 0.3, st);
  w.deltaTE = (0.12 + 0.22 * st) * el.chord;
  w.ox = el.teX + el.nX * 0.5 * w.deltaTE;
  w.oy = el.teY + el.nY * 0.5 * w.deltaTE;
  w.invLs = 1 / (4 * w.deltaTE + 1.2);
}

/**
 * Separated-flow wake of an element at (x, y): the velocity deficit (fraction of the local flow removed; above 1 means
 * slight back-flow in the near wake) and turbulence 0…1. Stalled sails shed a layer from the separation point along
 * the lee side and off the leech; bluff sails a wide dead-air wake bounded by the streamlines leaving both edges.
 * Requires `prepareWake` for the same flow direction.
 */
export function wakeAt(el: SliceElement, ux: number, uy: number, x: number, y: number, out: { deficit: number; turb: number }): void {
  out.deficit = 0;
  out.turb = 0;
  const w = el.w;
  const wnx = -uy, wny = ux; // across-flow direction
  const px = x - el.leX, py = y - el.leY;
  const s = (px * el.dirX + py * el.dirY) / el.chord; // chord fraction
  const eta = px * el.nX + py * el.nY;                // height above the chord line toward the belly
  // Luffing cloth stirs the air right around it.
  if (el.luffing > 0.3 && s > -0.05 && s < 1.15) {
    const sc = s < 0 ? 0 : s > 1 ? 1 : s;
    const off = Math.abs(eta - el.camber * el.chord * 4 * sc * (1 - sc));
    const band = 1 - smoothstep(0.08, 0.45, off);
    out.turb = 0.45 * smoothstep(0.3, 0.9, el.luffing) * band;
  }
  if (el.bluff > 0.02 && w.width > 0.1) {
    const sx = x - w.cx, sy = y - w.cy;
    const al = sx * ux + sy * uy;
    // Downstream of the line joining the two edges?
    const lat = sx * wnx + sy * wny;
    const u = clamp((lat - w.sL) / (w.sT - w.sL), 0, 1);
    const d = al - (w.aL + u * (w.aT - w.aL));
    if (d > 0) {
      const grow = 0.16 * d;
      const edge = 0.25 + 0.12 * d;
      const inside = Math.min(lat - (w.lo - grow), w.hi + grow - lat);
      if (inside > -edge) {
        const profile = smoothstep(-edge, edge, inside);
        const decay = Math.exp(-d * w.invLd);
        const near = smoothstep(0, 0.35 * w.width + 0.3, d); // ramps in behind the cloth
        const k = el.bluff * profile * near;
        out.deficit = Math.max(out.deficit, k * (0.35 + 0.75 * decay));
        out.turb = Math.max(out.turb, k * (0.45 + 0.55 * decay));
      }
    }
  }
  if (el.stallW > 0.02) {
    // Separated layer on the lee side, from the separation point to the leech…
    const st = el.stallW;
    if (s >= w.sSep && s <= 1 && eta > -0.05) {
      const yc = el.camber * el.chord * s * (w.cA + s * (w.cB + s * w.cC));
      const t = smoothstep(w.sSep, 1, s);
      const thick = w.deltaTE * Math.sqrt(t) * (0.6 + 0.4 * t);
      const h = eta - yc;
      if (h > -0.05 && thick > 0.02) {
        const prof = 1 - smoothstep(0.6 * thick, thick + 0.1, h);
        out.deficit = Math.max(out.deficit, st * prof * 0.7);
        out.turb = Math.max(out.turb, st * prof);
      }
    }
    // …then a wake off the leech, centred half a layer to lee, drifting with the stream.
    const d = (x - w.ox) * ux + (y - w.oy) * uy;
    if (d > -0.1) {
      const lat = Math.abs((x - w.ox) * wnx + (y - w.oy) * wny);
      const half = 0.5 * w.deltaTE + 0.14 * (d > 0 ? d : 0);
      if (lat < half + 0.15) {
        const prof = 1 - smoothstep(half * 0.6, half + 0.15, lat);
        const decay = Math.exp(-(d > 0 ? d : 0) * w.invLs);
        out.deficit = Math.max(out.deficit, st * prof * 0.65 * decay);
        out.turb = Math.max(out.turb, st * prof * (0.35 + 0.65 * decay));
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ vortex sums

/** One element's lattice as flat arrays (clockwise-positive Γ/2π), plus a four-vortex far-field summary. */
interface Vortices {
  n: number;
  x: Float64Array; y: Float64Array; k: Float64Array;
  gn: number;
  gx: Float64Array; gy: Float64Array; gk: Float64Array;
  /** Element centre and the squared radius inside which the full lattice is used. */
  cx: number; cy: number; near2: number;
  /** Rankine core², 0.02 chord (the flow module's default). */
  c2: number;
}

const MAX_PANELS = 64;
const GROUPS = 4;

function newVortices(): Vortices {
  return {
    n: 0, x: new Float64Array(MAX_PANELS), y: new Float64Array(MAX_PANELS), k: new Float64Array(MAX_PANELS),
    gn: 0, gx: new Float64Array(GROUPS), gy: new Float64Array(GROUPS), gk: new Float64Array(GROUPS),
    cx: 0, cy: 0, near2: 0, c2: 1e-6,
  };
}

/**
 * Vortex positions and strengths of a solved element (conventions of src/flow/vortexLattice.ts: the vortex sits a
 * quarter panel ahead of the midpoint; belly-relative Γ becomes clockwise-positive through the panel's handedness).
 */
function loadVortices(panels: readonly PanelGeom[], gammas: readonly number[], v: Vortices): void {
  const n = Math.min(panels.length, MAX_PANELS);
  v.n = n;
  if (n === 0) { v.gn = 0; return; }
  const a = panels[0]!, b = panels[n - 1]!;
  const lx = a.x - 0.5 * a.ds * a.tx, ly = a.y - 0.5 * a.ds * a.ty;
  const tx = b.x + 0.5 * b.ds * b.tx, ty = b.y + 0.5 * b.ds * b.ty;
  const chord = Math.hypot(tx - lx, ty - ly);
  const core = 0.02 * chord;
  v.c2 = Math.max(core * core, 1e-18);
  v.cx = 0.5 * (lx + tx);
  v.cy = 0.5 * (ly + ty);
  v.near2 = (1.2 * chord) * (1.2 * chord);
  for (let i = 0; i < n; i++) {
    const p = panels[i]!;
    v.x[i] = p.x - 0.25 * p.ds * p.tx;
    v.y[i] = p.y - 0.25 * p.ds * p.ty;
    v.k[i] = (gammas[i]! * (p.tx * p.ny - p.ty * p.nx)) / (2 * Math.PI);
  }
  // Far field: each quarter of the lattice lumped at its |Γ|-weighted centre.
  v.gn = 0;
  const per = Math.ceil(n / GROUPS);
  for (let g = 0; g < GROUPS; g++) {
    let k = 0, w = 0, x = 0, y = 0;
    for (let i = g * per; i < Math.min(n, (g + 1) * per); i++) {
      const m = Math.abs(v.k[i]!) + 1e-12;
      k += v.k[i]!; w += m; x += v.x[i]! * m; y += v.y[i]! * m;
    }
    if (w === 0) continue;
    v.gx[v.gn] = x / w; v.gy[v.gn] = y / w; v.gk[v.gn] = k;
    v.gn++;
  }
}
