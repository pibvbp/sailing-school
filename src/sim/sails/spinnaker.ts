// Symmetric spinnaker on a pole (spec §7.4).
// Geometry is solved, not scripted: the tack sits on the pole tip; the clew lies on a circle of radius
// "foot" around the tack and is held by the sheet's length to the leeward quarter block. The wind pushes
// the clew toward the flow direction until the sheet comes taut — so easing the sheet lowers the angle of
// attack until the luff curls and, eased further, collapses; squaring the pole rotates the whole sail to
// windward and out of the main's shadow. The usual trim rules (pole ⟂ apparent wind, ease to the curl)
// therefore emerge from the model.
import { BOAT } from '../../shared/boatSpec';
import { DEG, clamp, lerp, smoothstep, wrapPi, type Vec3 } from '../../shared/math';
import type { Controls, SpinnakerState } from '../types';
import { SPIN_AERO } from '../aero';
import {
  SHEET_EASE_RATE, SHEET_HAUL_RATE, approachRate, evaluateSection, flowAt, sideFromAwa, sumSections,
  type AirContext, type SailSum, type SectionGeom, type SectionResult, type Side,
} from './common';

const S = BOAT.spinnaker;
const N_SECTIONS = 6;
const MAST_FRONT_X = BOAT.mast.x + BOAT.mast.sectionBase[0] / 2;
const HEAD: Vec3 = { x: S.head.x + 0.35, y: 0, z: -(S.head.h - 0.15) };
const SHEET_EASED = 14;
const SHEET_TRIMMED = 2.8;
const HOIST_S = 6;
const DOUSE_S = 5;
const POLE_TRANSFER_S = 6;
const CAMBER = 0.26;
/**
 * Trim angle at which the luff starts to curl. It sits where the ORC-calibrated force is near its peak —
 * so the real-world rule "ease until the luff just curls, then trim a touch" is also the fast trim here.
 */
export const ALPHA_CURL = 16 * DEG;
/** A symmetric spinnaker's clew cannot fly ahead of the tack's beam line (the sheet leads aft). */
const PSI_MIN = 95 * DEG;

export interface SpinTrim {
  /** Chord angle the sheet alone would allow. */
  psiSheet: number;
  /** Chord angle the sail can physically reach (leech length, clew aft of the tack). */
  psiMin: number;
  /** Largest chord angle the leech length allows (the clew cannot get further from the head). */
  psiMax?: number;
  /** Chord angle actually flown (drives the forces). */
  psiChord: number;
  /** Trim angle relative to the flow at the luff: below the curl angle the luff curls, then collapses. */
  alphaTrim: number;
}

export interface SpinEvaluation { sections: SectionResult[]; sum: SailSum; tack: Vec3; clew: Vec3; psi: number; alphaMid: number }

export class SpinnakerModel {
  hoist = 0;
  collapsed = 0;
  curl = 0;
  /** +1 wind from starboard → pole on the starboard side. */
  windwardSide: 1 | -1 = 1;
  poleOn = true;
  /** Chord angle ψ (rad): angle of tack→clew from straight ahead, measured toward leeward. */
  psi = 100 * DEG;
  /** Latest trim angle relative to the flow (rad). */
  alphaTrim = 0.3;
  /** Sheet actually hauled (0…1): it follows `Controls.spinSheet` at rope-handling speed. */
  sheet = 0.5;
  events: Array<'spinCollapse' | 'spinRefill'> = [];
  last: SpinEvaluation | null = null;
  private poleT = 0;
  /** Side of the pole tip, continuous: in an end-for-end gybe it swings across instead of jumping. */
  private poleSide = 1;
  private poleFrom = 1;
  private lowT = 0;
  private highT = 0;
  private collapseTarget = 0;
  private primed = false;

  /** Put the sheet where the controls say, at once (scenario start). */
  syncControls(c: Controls): void {
    this.sheet = clamp(c.spinSheet, 0, 1);
    this.primed = true;
    this.poleSide = this.poleFrom = this.windwardSide;
  }

  poleAngle(c: Controls): number { return clamp(c.spinPole, 0, 1) * 90 * DEG; }
  poleTipH(c: Controls): number { return lerp(S.poleTipH[0], S.poleTipH[1], clamp(c.spinPoleHeight, 0, 1)); }

  poleTip(c: Controls): Vec3 {
    const h = this.poleTipH(c);
    const reach = Math.sqrt(Math.max(S.poleLength ** 2 - (h - S.poleMastH) ** 2, 0.1));
    const a = this.poleAngle(c);
    return { x: MAST_FRONT_X + reach * Math.cos(a), y: this.windwardSide * reach * Math.sin(a), z: -h };
  }

  /**
   * Where the pole itself is. In an end-for-end gybe the kite's corners stay where they are and swap roles (the old
   * clew becomes the new tack); the pole is unclipped and carried across the bow to the new tack over the transfer.
   */
  drawnPoleTip(c: Controls): Vec3 {
    const h = this.poleTipH(c);
    const reach = Math.sqrt(Math.max(S.poleLength ** 2 - (h - S.poleMastH) ** 2, 0.1));
    // The pole keeps its length: its angle swings through dead ahead (a dip-pole gybe), it does not telescope.
    const a = this.poleAngle(c) * this.poleSide;
    return { x: MAST_FRONT_X + reach * Math.cos(a), y: reach * Math.sin(a), z: -h };
  }

  private chordAt(psi: number): { x: number; y: number } {
    return { x: Math.cos(psi), y: -this.windwardSide * Math.sin(psi) };
  }

  /** Smallest chord angle the sheet allows (the wind pushes the clew toward smaller ψ). */
  sheetLimitedPsi(c: Controls, tack: Vec3): number {
    const block = { x: S.sheetBlock.x, y: -this.windwardSide * S.sheetBlock.y };
    const sheet = lerp(SHEET_EASED, SHEET_TRIMMED, clamp(c.spinSheet, 0, 1));
    const dist = (psi: number) => {
      const d = this.chordAt(psi);
      return Math.hypot(tack.x + S.foot * d.x - block.x, tack.y + S.foot * d.y - block.y);
    };
    let near = 0, best = Infinity;
    for (let a = 0; a <= 180; a += 3) { const d = dist(a * DEG); if (d < best) { best = d; near = a * DEG; } }
    if (dist(0) <= sheet) return 0;
    if (best > sheet) return near;
    let lo = 0, hi = near;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (dist(mid) > sheet) lo = mid; else hi = mid; }
    return hi;
  }

  private flowPsi(flow: Vec3): number {
    return Math.atan2(-this.windwardSide * flow.y, flow.x);
  }

  /** Smallest chord angle the leech length allows (clew within SL of the head). */
  leechLimitedPsi(tack: Vec3): number {
    return this.leechRange(tack).lo;
  }

  /**
   * Chord angles the leech length allows (the clew within SL of the head), ψ ∈ [lo, hi]. The distance from the
   * head is a sinusoid in ψ, so the reachable set is one interval around the angle that brings the clew closest:
   * find that angle, then bisect out toward 0 and toward π. (With the pole squared the interval sits inside
   * (0, π) — both ends matter.) If no angle is reachable, the closest one is returned for both ends.
   */
  leechRange(tack: Vec3): { lo: number; hi: number } {
    const reach2 = (S.SL * 0.98) ** 2 - (HEAD.z - tack.z) ** 2;
    const dist2 = (psi: number) => {
      const d = this.chordAt(psi);
      return (tack.x + S.foot * d.x - HEAD.x) ** 2 + (tack.y + S.foot * d.y - HEAD.y) ** 2;
    };
    // dist² = C + 2·foot·(a·cos ψ + b·sin ψ): its minimum over the circle is at ψ = atan2(b, a) + π.
    const a = tack.x - HEAD.x;
    const b = -this.windwardSide * (tack.y - HEAD.y);
    const m = wrapPi(Math.atan2(b, a) + Math.PI);
    // If the minimum lies on the other half of the circle, the closest end of [0, π] is the best reachable.
    const best = m >= 0 ? m : m > -Math.PI / 2 ? 0 : Math.PI;
    if (dist2(best) > reach2) return { lo: best, hi: best };
    const edge = (inside: number, outside: number): number => {
      if (dist2(outside) <= reach2) return outside;
      for (let i = 0; i < 24; i++) {
        const mid = (inside + outside) / 2;
        if (dist2(mid) > reach2) outside = mid; else inside = mid;
      }
      return inside;
    };
    return { lo: edge(best, 0), hi: edge(best, Math.PI) };
  }

  trim(c: Controls, flowPsi: number): SpinTrim {
    const tack = this.poleTip(c);
    const psiSheet = this.sheetLimitedPsi(c, tack);
    const leech = this.leechRange(tack);
    const psiMin = Math.max(PSI_MIN, leech.lo);
    const psiMax = Math.max(psiMin, leech.hi);
    const psiChord = Math.min(Math.max(psiSheet, psiMin, flowPsi), psiMax);
    return { psiSheet, psiMin, psiMax, psiChord, alphaTrim: wrapPi(psiSheet - flowPsi) };
  }

  geometry(c: Controls, psi: number, tack: Vec3): SectionGeom[] {
    const footH = -tack.z;
    const topH = -HEAD.z;
    const dz = (topH - footH) / N_SECTIONS;
    const a = this.poleAngle(c);
    const out: SectionGeom[] = [];
    const chordOf = (t: number) => S.foot * (1 - t) + 1.3 * Math.sin(Math.PI * t);
    let raw = 0;
    for (let i = 0; i < N_SECTIONS; i++) raw += chordOf((i + 0.5) / N_SECTIONS) * dz;
    const areaScale = S.area / raw;
    const d = this.chordAt(psi);
    for (let i = 0; i < N_SECTIONS; i++) {
      const t = (i + 0.5) / N_SECTIONS;
      const bow = 0.6 * Math.sin(Math.PI * t);
      out.push({
        h: t,
        luff: {
          x: lerp(tack.x, HEAD.x, t) + bow * Math.cos(a),
          y: lerp(tack.y, HEAD.y, t) + bow * this.windwardSide * Math.sin(a),
          z: -(footH + t * (topH - footH)),
        },
        chordDir: { x: d.x, y: d.y, z: 0 },
        chord: chordOf(t),
        height: dz,
        camber: CAMBER + 0.03 * (1 - clamp(c.spinSheet, 0, 1)),
        draft: 0.45,
        areaScale,
      });
    }
    return out;
  }

  evaluate(c: Controls, psi: number, air: AirContext, blanket: number, awaAbs: number, aws: number, hoist = this.hoist, collapsed = this.collapsed): SpinEvaluation {
    const tack = this.poleTip(c);
    const geom = this.geometry(c, psi, tack);
    // Lifting efficiency against AWA (ORC spinnaker table): it builds to a peak on a close reach (67–75°) and, as the
    // pole goes back and the sail turns into a drag device, falls about 10 % by 100–110°.
    const reach = 0.55 + 0.45 * smoothstep(35 * DEG, 75 * DEG, awaAbs) - 0.1 * smoothstep(75 * DEG, 110 * DEG, awaAbs);
    const hNat = clamp(2.0 + 0.08 * aws, 2.0, 3.0);
    const poleEff = 1 - 0.35 * ((-tack.z - hNat) / 1.8) ** 2;
    const fill = smoothstep(0.6, 0.9, hoist);
    const liftScale = reach * poleEff * (this.poleOn ? 1 : 0.6);
    const q = blanket * (1 - 0.8 * collapsed) * lerp(0.2, 1, fill);
    const sections = geom.map((g) => {
      const scaled = { ...g, areaScale: (g.areaScale ?? 1) * Math.max(hoist, 1e-3) };
      return evaluateSection(scaled, SPIN_AERO, air, {
        blanket: q,
        liftScale,
        alphaOverride: (_geom, flow) => Math.max(0, wrapPi(psi - this.flowPsi(flow))),
      });
    });
    const mid = sections[Math.floor(N_SECTIONS / 2)]!;
    const d = this.chordAt(psi);
    return {
      sections,
      sum: sumSections(sections, { x: 0, y: 0, z: -BOAT.mass.cgH }),
      tack,
      clew: { x: tack.x + S.foot * d.x, y: tack.y + S.foot * d.y, z: tack.z },
      psi,
      alphaMid: mid.aoa,
    };
  }

  /**
   * Advance one step. `side` is the rig side decided by the simulation (hysteresis, gybes); without it the model
   * keeps its own from `awaRef` with the same hysteresis.
   */
  step(dt: number, c: Controls, air: AirContext, blanket: number, awaRef: number, aws: number, side?: Side): SpinEvaluation {
    this.events.length = 0;
    // Hoist / douse.
    this.hoist = clamp(this.hoist + (c.spinHoist ? dt / HOIST_S : -dt / DOUSE_S), 0, 1);
    if (!this.primed) this.syncControls(c);
    this.sheet = approachRate(this.sheet, clamp(c.spinSheet, 0, 1), SHEET_HAUL_RATE, SHEET_EASE_RATE, dt);
    const ca = this.sheet === c.spinSheet ? c : { ...c, spinSheet: this.sheet };

    // Gybe: the pole goes end-for-end to the new windward side — only when the rig really changes side (C3).
    const s = side ?? sideFromAwa(this.windwardSide, awaRef);
    if (s !== this.windwardSide) {
      this.windwardSide = s;
      this.poleFrom = this.poleSide;
      if (this.hoist > 0.05) { this.poleOn = false; this.poleT = 0; }
    }
    if (!this.poleOn) { this.poleT += dt; if (this.poleT >= POLE_TRANSFER_S) this.poleOn = true; }
    // The pole goes end-for-end: it swings across the bow over the transfer, reaching the new tack as it clips on.
    this.poleSide = this.poleOn ? this.windwardSide
      : lerp(this.poleFrom, this.windwardSide, smoothstep(0, POLE_TRANSFER_S, this.poleT));

    // Where does the sheet let the clew sit, where can the sail physically go, and where does the wind
    // want it? Easing beyond the geometric limit unloads the luff (curl, then collapse) instead of turning
    // the sail further.
    const tack = this.poleTip(ca);
    const centre = { x: (tack.x + HEAD.x) / 2, y: tack.y / 2, z: (tack.z + HEAD.z) / 2 };
    const tr = this.trim(ca, this.flowPsi(flowAt(centre, air).flow));
    this.psi += (tr.psiChord - this.psi) * Math.min(1, dt / 0.4);
    this.alphaTrim = tr.alphaTrim;

    const ev = this.evaluate(ca, this.psi, air, blanket, Math.abs(awaRef), aws);
    this.last = ev;

    // Curl → collapse → refill state machine (only meaningful once the sail is up).
    const a = tr.alphaTrim;
    this.curl = this.hoist > 0.85 ? 1 - smoothstep(ALPHA_CURL - 2 * DEG, ALPHA_CURL + 3 * DEG, a) : 0;
    if (this.hoist > 0.85) {
      this.lowT = a < ALPHA_CURL - 7 * DEG ? this.lowT + dt : 0;
      this.highT = a > ALPHA_CURL - 3 * DEG ? this.highT + dt : 0;
      if (this.lowT > 0.6) this.collapseTarget = 1;
      if (this.highT > 1.0) this.collapseTarget = 0;
    } else {
      this.collapseTarget = 0;
    }
    const before = this.collapsed;
    const rate = this.collapseTarget > this.collapsed ? 2.5 : 1.2;
    this.collapsed = clamp(this.collapsed + clamp(this.collapseTarget - this.collapsed, -rate * dt, rate * dt), 0, 1);
    if (before < 0.5 && this.collapsed >= 0.5) this.events.push('spinCollapse');
    if (before >= 0.5 && this.collapsed < 0.5) this.events.push('spinRefill');
    return ev;
  }

  state(ev: SpinEvaluation, c: Controls, heel: number): SpinnakerState {
    const s = ev.sum;
    return {
      id: 'spinnaker',
      set: this.hoist > 0.01,
      area: s.area,
      tack: ev.tack,
      clew: ev.clew,
      head: { x: HEAD.x, y: 0, z: HEAD.z + (1 - this.hoist) * (-HEAD.z - 1.2) },
      sections: ev.sections,
      force: s.force,
      ce: s.ce,
      lift: ev.sections.reduce((acc, r) => acc + r.cl * r.q * r.area, 0),
      drag: ev.sections.reduce((acc, r) => acc + r.cd * r.q * r.area, 0),
      drive: s.force.x,
      heelForce: s.force.y * Math.cos(heel) - s.force.z * Math.sin(heel),
      telltales: [],
      hoist: this.hoist,
      poleAngle: this.poleAngle(c),
      poleTip: this.drawnPoleTip(c),
      poleHeight: -ev.tack.z,
      collapsed: this.collapsed,
      curl: this.curl,
    };
  }
}
