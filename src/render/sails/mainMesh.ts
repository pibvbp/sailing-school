// Mainsail cloth (spec §9.6): luff on the aft face of the mast from the gooseneck to the head, loose foot
// from the tack to the clew at the boom end, a roached leech held up by four battens and a head board.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import type { MainState, SailSection } from '../../sim/types';
import {
  RowFilter, SailRows, SailSurface, SideField, advancePhase, breathing, camberShape, exciteCloth, planFromRows, smooth, toLocal,
  writeState, type ClothPhase, type FlutterParams, type PlanPoint, type SailPlan,
} from './sailMesh';

const G = BOAT.boom.gooseneck;
const P = BOAT.main.P;
const E = BOAT.main.E;
const HW = BOAT.main.headWidth;
/** The tack and clew cringles sit on top of the boom, not inside it (m). */
export const MAIN_FOOT_LIFT = 0.07;
/** Roach amplitude (m, ∝ sin πh) that brings triangle + head board up to the rated area. */
export const MAIN_ROACH = (BOAT.main.area / P - (E + HW) / 2) * (Math.PI / 2);

/** Nominal chord (m) at height fraction h: triangle + head board + roach. */
export function mainPlanChord(h: number): number {
  return E * (1 - h) + HW * h + MAIN_ROACH * Math.sin(Math.PI * h);
}

/**
 * Battens: leech-end height fraction (the sim's leech telltales sit at the same heights) and length (m).
 * The top batten is full length — it carries the roach at the head.
 */
export const MAIN_BATTENS: ReadonlyArray<{ v: number; length: number }> = [
  { v: 0.2, length: 0.95 },
  { v: 0.4, length: 1.05 },
  { v: 0.6, length: 1.0 },
  { v: 0.8, length: Infinity },
];

const ENTRY = 2.0;
const EXIT = 1.15;
const FLUTTER: FlutterParams = {
  aLuff: 0.035, aFlog: 0.18, aLeech: 0.0011, f0: 1.3, fPerMs: 0.2, lambda0: 0.6, lambdaPerChord: 0.25, height: P,
};

/** Flat sections with the boom on the centreline — the sailmaker's layout for the texture plan. */
export function nominalMainSections(n = 8): SailSection[] {
  const out: SailSection[] = [];
  for (let i = 0; i < n; i++) {
    const h = (i + 0.5) / n;
    out.push({
      h, luff: { x: G.x, y: 0, z: -(G.h + h * P) }, chordDir: { x: -1, y: 0, z: 0 }, chord: mainPlanChord(h),
      camber: 0, draft: 0.45, leewardY: 0, aoa: 0, luffing: 0, stall: 0, cl: 0, cd: 0, q: 0,
    });
  }
  return out;
}

export interface BattenPlan { v: number; leech: PlanPoint; inner: PlanPoint }

/** Plan of the main: x = metres aft of the luff, y = metres above the tack. */
export function mainPlan(): { plan: SailPlan; battens: BattenPlan[] } {
  const rows = new SailRows(161);
  const tack = new THREE.Vector3(0, G.h + MAIN_FOOT_LIFT, -G.x);
  const clew = new THREE.Vector3(0, G.h + MAIN_FOOT_LIFT, -G.x + E);
  const head = new THREE.Vector3(0, G.h + P, -G.x);
  const headAft = head.clone().setZ(head.z + HW);
  rows.build(nominalMainSections(), tack, clew, head, headAft, 'luff');
  const plan = planFromRows(rows, (_x, y, z) => ({ x: z + G.x, y: y - tack.y }));
  const battens = MAIN_BATTENS.map(({ v, length }) => {
    const leech = plan.rowAt(v).b;
    const lo = plan.rowAt(v - 0.01).b, hi = plan.rowAt(v + 0.01).b;
    const tx = hi.x - lo.x, ty = hi.y - lo.y, tl = Math.hypot(tx, ty) || 1;
    // Perpendicular to the leech, pointing forward (and slightly down).
    const dx = -ty / tl, dy = tx / tl;
    const luffX = plan.rowAt(v).a.x + 0.06;
    const len = Math.min(length, (leech.x - luffX) / Math.max(-dx, 1e-3));
    return { v, leech, inner: { x: leech.x + dx * len, y: leech.y + dy * len } };
  });
  return { plan, battens };
}

function distToSegment(p: PlanPoint, a: PlanPoint, b: PlanPoint): number {
  const ex = b.x - a.x, ey = b.y - a.y;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
  return Math.hypot(p.x - a.x - t * ex, p.y - a.y - t * ey);
}

export class MainShape {
  readonly rows: SailRows;
  readonly surface: SailSurface;
  readonly plan: SailPlan;
  readonly battens: BattenPlan[];
  /** Grid (u, v) of each batten's leech end — where the leech telltales are tied. */
  readonly battenEnds: Array<{ u: number; v: number }>;
  /** Write per-vertex (luffing, stall) for the AoA colouring. */
  colouring = false;
  private readonly env: Float32Array;
  private readonly leechEnv: Float32Array;
  private readonly battenMask: Float32Array;
  private readonly battenU0: Float32Array;
  /** Which batten dominates each vertex (−1: none). */
  private readonly battenIdx: Int8Array;
  /** Curvature side each batten holds: it resists turning over, then flicks across. */
  private readonly battenSide: Float32Array;
  /** Side-field vertex each batten watches: the cloth at its mid-point. */
  private readonly battenCell: Int32Array;
  private readonly sideField: SideField;
  private readonly sideEff: Float32Array;
  private readonly luffF: RowFilter;
  private battensInit = false;
  private readonly phase: ClothPhase = { flog: 0, leech: 0 };
  private readonly tack = new THREE.Vector3();
  private readonly clew = new THREE.Vector3();
  private readonly head = new THREE.Vector3();
  private readonly headAft = new THREE.Vector3();

  constructor(resolution = 1) {
    const nu = Math.max(10, Math.round(22 * resolution));
    const nv = Math.max(16, Math.round(44 * resolution));
    this.rows = new SailRows(nv);
    this.surface = new SailSurface(nu, nv);
    const { plan, battens } = mainPlan();
    this.plan = plan;
    this.battens = battens;
    this.battenEnds = battens.map((b) => ({ u: 1, v: b.v }));
    this.surface.setPlanUV(plan);
    this.sideField = new SideField(nu, nv, this.surface.u, 0.06, 0.22);
    this.luffF = new RowFilter(nv);

    const n = this.surface.count;
    this.env = new Float32Array(n);
    this.leechEnv = new Float32Array(n);
    this.battenMask = new Float32Array(n);
    this.battenU0 = new Float32Array(n);
    this.battenIdx = new Int8Array(n).fill(-1);
    this.sideEff = new Float32Array(n);
    this.battenSide = new Float32Array(battens.length);
    this.battenCell = new Int32Array(battens.map((b) => {
      const mid = { x: (b.leech.x + b.inner.x) / 2, y: (b.leech.y + b.inner.y) / 2 };
      const v = Math.min(Math.max((mid.y - plan.luff[0]!.y) / (plan.luff[plan.luff.length - 1]!.y - plan.luff[0]!.y), 0), 1);
      const row = plan.rowAt(v);
      const u = Math.min(Math.max((mid.x - row.a.x) / Math.max(row.b.x - row.a.x, 1e-3), 0), 1);
      const i = Math.round((nu - 1) * Math.pow(u, 1 / this.surface.uPower));
      return Math.round(v * (nv - 1)) * nu + i;
    }));
    const clewP = plan.rowAt(0).b, tackP = plan.rowAt(0).a, headP = plan.rowAt(1).a;
    const s = this.surface;
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);
      const planChord = Math.max(plan.rowAt(v).b.x - plan.rowAt(v).a.x, 0.05);
      for (let i = 0; i < nu; i++) {
        const k = j * nu + i, u = s.u[i]!;
        const q = plan.at(u, v);
        let bm = 0, bmWide = 0, u0 = 0, bi = -1;
        battens.forEach((b, idx) => {
          const d = distToSegment(q, b.leech, b.inner);
          const m = 1 - smooth(0.035, 0.16, d);
          if (m > bm) { bm = m; bi = idx; u0 = Math.max(0, 1 - Math.hypot(b.leech.x - b.inner.x, b.leech.y - b.inner.y) / planChord); }
          bmWide = Math.max(bmWide, 1 - smooth(0.08, 0.4, d));
        });
        this.battenMask[k] = bm;
        this.battenIdx[k] = bm > 0.01 ? bi : -1;
        this.battenU0[k] = Math.min(u0, 0.95);
        const corners = smooth(0.1, 0.75, Math.hypot(q.x - clewP.x, q.y - clewP.y))
          * smooth(0.05, 0.6, Math.hypot(q.x - headP.x, q.y - headP.y))
          * smooth(0.05, 0.45, Math.hypot(q.x - tackP.x, q.y - tackP.y));
        this.env[k] = smooth(0, 0.1, u) * corners * (1 - 0.7 * bm);
        this.leechEnv[k] = smooth(0.8, 1, u) * (1 - 0.92 * bmWide) * corners;
        s.omega[k] = 15 - 6 * u;
        s.zeta[k] = 0.45;
        s.pinned[k] = i === 0 || j === nv - 1 || (i === nu - 1 && j === 0) ? 1 : 0;
      }
    }
  }

  update(dt: number, t: number, s: MainState, aws: number): void {
    dt = dt > 0 ? dt : 0; // NaN / negative → no step
    aws = aws > 0 ? aws : 0;
    const { rows, surface } = this;
    toLocal(s.tack, this.tack).y += MAIN_FOOT_LIFT;
    toLocal(s.clew, this.clew).y += MAIN_FOOT_LIFT;
    toLocal(s.head, this.head);
    const top = s.sections[s.sections.length - 1];
    if (top) this.headAft.set(top.chordDir.y, -top.chordDir.z, -top.chordDir.x).multiplyScalar(HW).add(this.head);
    else this.headAft.copy(this.head).setZ(this.head.z + HW);
    rows.build(s.sections, this.tack, this.clew, this.head, this.headAft, 'luff');
    const side = this.sideField.update(rows.side, dt);
    const luff = this.luffF.update(rows.luffing, dt, 0.08);
    this.updateBattens(dt);

    const { nu, nv, target: tgt, u: U } = surface;
    const { L, T, N } = rows;
    const sideEff = this.sideEff;
    // A pinching luff bubble never sits still: it pulses irregularly.
    const pulse = 0.78 + 0.16 * Math.sin(Math.PI * 2 * 1.7 * t) + 0.1 * Math.sin(Math.PI * 2 * 2.9 * t + 1.3);
    for (let j = 0; j < nv; j++) {
      const o = j * 3, v = rows.v[j]!;
      const l = luff[j]!;
      // Backwinding: a bubble inverts the cloth just behind the luff while the leech stays full.
      const bubble = smooth(0.05, 0.5, l) * (1 - 0.4 * smooth(0.75, 1, l)) * pulse;
      const reach = (0.1 + 0.3 * l) * (0.9 + 0.2 * pulse);
      const depthScale = rows.camber[j]! * breathing(t, v) * rows.chord[j]! * (1 - 0.85 * smooth(0.5, 1, l));
      const d = rows.draft[j]!;
      for (let i = 0; i < nu; i++) {
        const k = j * nu + i, u = U[i]!;
        let f = camberShape(u, d, ENTRY, EXIT);
        const bm = this.battenMask[k]!;
        let sd = side[k]!;
        if (bm > 0) {
          // A batten resists bending: blend the exit toward a straight line from its inner end, and it
          // keeps its curvature through a tack until it flicks over.
          const u0 = this.battenU0[k]!;
          if (u > u0) f += (camberShape(u0, d, ENTRY, EXIT) * (1 - u) / (1 - u0) - f) * 0.65 * bm;
          const bi = this.battenIdx[k]!;
          if (bi >= 0) sd += (this.battenSide[bi]! - sd) * 0.9 * bm;
        }
        sideEff[k] = sd;
        if (bubble > 0) f *= 1 - 2 * bubble * (1 - smooth(reach * 0.55, reach * 1.45, u));
        const dep = sd * depthScale * f;
        const ko = k * 3;
        tgt[ko] = L[o]! + u * (T[o]! - L[o]!) + N[o]! * dep;
        tgt[ko + 1] = L[o + 1]! + u * (T[o + 1]! - L[o + 1]!) + N[o + 1]! * dep;
        tgt[ko + 2] = L[o + 2]! + u * (T[o + 2]! - L[o + 2]!) + N[o + 2]! * dep;
      }
    }
    surface.follow(dt);
    advancePhase(this.phase, FLUTTER, aws, dt);
    exciteCloth(surface, rows, luff, sideEff, FLUTTER, this.phase, t, aws, this.env, this.leechEnv);
    if (this.colouring) writeState(surface, luff, rows.stall);
    surface.commit(this.colouring);
  }

  /**
   * Each batten holds the side it is curved to until the cloth at its mid-point has clearly gone over
   * (past 0.3 on the other side), then flicks across in under 0.2 s.
   */
  private updateBattens(dt: number): void {
    const bs = this.battenSide, field = this.sideField.value;
    for (let b = 0; b < bs.length; b++) {
      const cloth = field[this.battenCell[b]!]!;
      if (!this.battensInit) { bs[b] = cloth; continue; }
      const cur = bs[b]!;
      const flick = Math.sign(cloth) !== Math.sign(cur) && Math.abs(cloth) > 0.3;
      const settle = Math.sign(cloth) === Math.sign(cur) || cur === 0;
      if (flick || settle) {
        const target = flick ? Math.sign(cloth) : cloth;
        const rate = flick ? 12 : 6;
        bs[b] = cur + Math.max(-rate * dt, Math.min(rate * dt, target - cur));
      }
    }
    this.battensInit = true;
  }

  /** Forget all motion state: the next update snaps to the snapshot's shape (scenario change). */
  reset(): void {
    this.surface.reset();
    this.sideField.reset();
    this.luffF.reset();
    this.battensInit = false;
  }

  dispose(): void { this.surface.dispose(); }
}
