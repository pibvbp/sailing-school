// Mainsail and boom (spec §7.4).
// The boom is a pendulum about the gooseneck driven by the sail's aerodynamic moment, gravity when heeled
// and air damping. The mainsheet is a ONE-SIDED rope constraint around the traveler car: it can only pull,
// so an eased main weathervanes (luffs) and an eased boom crossing the centreline slams across (crash gybe).
import { BOAT } from '../../shared/boatSpec';
import { DEG, clamp, smoothstep } from '../../shared/math';
import type { Controls, MainState } from '../types';
import { MAIN_AERO } from '../aero';
import {
  evaluateSection, leechTelltales, momentAboutZ, sumSections,
  type AirContext, type SailSum, type SectionGeom, type SectionResult,
} from './common';

const N_SECTIONS = 8;
const G = BOAT.boom.gooseneck;
const P = BOAT.main.P;
const E = BOAT.main.E;
/** Roach amplitude (m) that, with the head width, gives the rated area. */
const ROACH = 0.314;
const MAX_BOOM = BOAT.boom.maxAngleDeg * DEG;
const I_BOOM = BOAT.boom.inertia;
const M_BOOM = BOAT.boom.mass + 8; // boom + sail
const D_BOOM_CG = 1.6;
const SHEET_K = 60000;
const SHEET_C = 2400;
const AIR_DAMP = 60;
const CRASH_RATE = 1.5;
const BATTENS = [0.2, 0.4, 0.6, 0.8] as const;

/** Main chord (m) at height fraction h, including roach. */
export function mainChord(h: number): number {
  return E * (1 - h) + BOAT.main.headWidth * h + ROACH * Math.sin(Math.PI * h);
}

export interface MainShift { main: number; mainLuff: number }

export interface MainEvaluation {
  sections: SectionResult[];
  sum: SailSum;
  /** Aerodynamic moment about the mast axis (rotates the boom; + toward port). */
  mastMoment: number;
}

export class MainModel {
  /** Boom angle (rad, + out to port) and rate. */
  beta = 0;
  betaDot = 0;
  /** +1 wind from starboard (boom to port), −1 from port. */
  tackSign: 1 | -1 = 1;
  twist = 8 * DEG;
  /** Set to the impact rate (rad/s) on the step a crash gybe happens, else 0. */
  crashRate = 0;
  last: MainEvaluation | null = null;
  private t = 0;
  private lastCrossT = -Infinity;
  private wasInside = true;
  private lastMoment = 0;

  /** Allowed boom range from traveler car + sheet (rad). */
  limits(c: Controls): { lo: number; hi: number; car: number } {
    const yCar = c.traveler * this.tackSign * BOAT.boom.traveler.halfWidth;
    const car = Math.atan2(-yCar, BOAT.boom.sheetAttach);
    const delta = 85 * DEG * Math.pow(1 - clamp(c.mainSheet, 0, 1), 1.5);
    return { lo: Math.max(-MAX_BOOM, car - delta), hi: Math.min(MAX_BOOM, car + delta), car };
  }

  geometry(c: Controls, beta: number, twist: number): SectionGeom[] {
    const out: SectionGeom[] = [];
    const bend = 0.1 * c.backstay;
    const draft = BOAT.main.draftBase - 0.08 * c.cunningham;
    for (let i = 0; i < N_SECTIONS; i++) {
      const h = (i + 0.5) / N_SECTIONS;
      const theta = beta + this.tackSign * twist * Math.pow(h, 1.4);
      const camber = BOAT.main.camberBase
        - 0.04 * c.outhaul * (1 - smoothstep(0, 0.45, h))
        - 0.03 * c.backstay * smoothstep(0.15, 0.75, h)
        + 0.015 * (1 - c.outhaul) * (1 - smoothstep(0, 0.45, h));
      out.push({
        h,
        luff: { x: G.x + bend * Math.sin(Math.PI * h), y: 0, z: -(G.h + h * P) },
        chordDir: { x: -Math.cos(theta), y: -Math.sin(theta), z: 0 },
        chord: mainChord(h),
        height: P / N_SECTIONS,
        camber,
        draft,
      });
    }
    return out;
  }

  /** Forces for a given boom angle and twist (no state change) — used by the dynamics, tests and VPP. */
  evaluate(c: Controls, beta: number, twist: number, air: AirContext, shift: MainShift, blanket = 1, betaDot = 0): MainEvaluation {
    const axis = { x: G.x, y: 0 };
    const sections = this.geometry(c, beta, twist).map((g) =>
      evaluateSection(g, MAIN_AERO, air, { alphaShift: shift.main, visualShift: shift.mainLuff, blanket, rotationRate: betaDot, rotationAxis: axis }));
    return {
      sections,
      sum: sumSections(sections, { x: 0, y: 0, z: -BOAT.mass.cgH }),
      mastMoment: momentAboutZ(sections, G.x, 0),
    };
  }

  step(dt: number, c: Controls, air: AirContext, shift: MainShift, blanket: number, awaRef: number): MainEvaluation {
    this.t += dt;
    if (awaRef > 3 * DEG) this.tackSign = 1;
    else if (awaRef < -3 * DEG) this.tackSign = -1;

    const { lo, hi } = this.limits(c);
    const pressingOut = (this.beta >= hi - DEG && this.lastMoment > 0) || (this.beta <= lo + DEG && this.lastMoment < 0);
    const sheetDown = Math.pow(clamp(c.mainSheet, 0, 1), 1.5) * (pressingOut ? 1 : 0.35);
    const tension = Math.max(clamp(c.vang, 0, 1), sheetDown);
    // Twist only exists while the sail is loaded: when the lower sail luffs the leech falls into the wind.
    const lower = this.last ? this.last.sections.slice(0, 4) : [];
    const lowerLuff = lower.length ? lower.reduce((a, r) => a + r.luffing, 0) / lower.length : 0;
    const loaded = 1 - smoothstep(0.3, 0.8, lowerLuff);
    const twistTarget = (2 + 20 * Math.pow(1 - tension, 1.3)) * DEG * loaded;
    this.twist += (twistTarget - this.twist) * Math.min(1, dt / 0.3);

    const ev = this.evaluate(c, this.beta, this.twist, air, shift, blanket, this.betaDot);
    this.last = ev;
    this.lastMoment = ev.mastMoment;

    let m = ev.mastMoment - M_BOOM * 9.81 * D_BOOM_CG * Math.cos(this.beta) * Math.sin(air.kin.heel) - AIR_DAMP * this.betaDot;
    // Sailing by the lee: a strip/flat-plate model would hold an eased boom out until the wind is ~75° by
    // the lee, but on a real boat the flow reverses over the leech and the sail flips across once the wind
    // is roughly 12–22° by the lee. Model that reversal as a gybing moment toward (and across) the centreline.
    const boomSide = this.beta > 5 * DEG ? 1 : this.beta < -5 * DEG ? -1 : 0;
    if (boomSide !== 0 && Math.sign(awaRef) === -boomSide) {
      const byLee = Math.PI - Math.abs(awaRef);
      const mid = ev.sections[Math.floor(ev.sections.length / 2)]!;
      m -= boomSide * smoothstep(12 * DEG, 22 * DEG, byLee) * 30 * mid.q * (ev.sum.area / BOAT.main.area);
    }
    // While the rope is stretched it damps both ways (rope hysteresis, block friction) — no elastic bounce.
    if (this.beta > hi) m += -SHEET_K * (this.beta - hi) - SHEET_C * this.betaDot;
    else if (this.beta < lo) m += -SHEET_K * (this.beta - lo) - SHEET_C * this.betaDot;

    const before = this.beta;
    const rateBefore = this.betaDot;
    this.betaDot += (m / I_BOOM) * dt;
    this.beta += this.betaDot * dt;

    if (Math.sign(before) !== Math.sign(this.beta) && before !== 0) this.lastCrossT = this.t;
    const inside = this.beta >= lo && this.beta <= hi;
    this.crashRate = 0;
    if (this.wasInside && !inside && Math.abs(rateBefore) > CRASH_RATE && this.t - this.lastCrossT < 4) {
      this.crashRate = Math.abs(rateBefore);
    }
    this.wasInside = inside;
    return ev;
  }

  state(ev: MainEvaluation, heel: number): MainState {
    const s = ev.sum;
    const cosH = Math.cos(heel), sinH = Math.sin(heel);
    const lift = ev.sections.reduce((a, r) => a + r.cl * r.q * r.area, 0);
    const drag = ev.sections.reduce((a, r) => a + r.cd * r.q * r.area, 0);
    const top = ev.sections[ev.sections.length - 1]!;
    const boomDir = { x: -Math.cos(this.beta), y: -Math.sin(this.beta) };
    const out: MainState = {
      id: 'main',
      set: true,
      area: s.area,
      tack: { x: G.x, y: 0, z: -G.h },
      clew: { x: G.x + boomDir.x * E, y: boomDir.y * E, z: -G.h },
      head: { x: top.luff.x, y: 0, z: -(G.h + P) },
      sections: ev.sections,
      force: s.force,
      ce: s.ce,
      lift,
      drag,
      drive: s.force.x,
      heelForce: s.force.y * cosH - s.force.z * sinH,
      telltales: leechTelltales('main', ev.sections, MAIN_AERO, BATTENS),
      boomAngle: this.beta,
      boomRate: this.betaDot,
      twistDeg: this.twist / DEG,
    };
    return out;
  }
}
