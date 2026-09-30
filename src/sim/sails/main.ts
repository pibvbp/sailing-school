// Mainsail and boom (spec §7.4).
// The boom is a pendulum about the gooseneck driven by the sail's aerodynamic moment, gravity when heeled
// and air damping. The mainsheet is a ONE-SIDED rope constraint around the traveler car: it can only pull,
// so an eased main weathervanes (luffs) and an eased boom crossing the centreline slams across (crash gybe).
import { BOAT } from '../../shared/boatSpec';
import { DEG, clamp, smoothstep } from '../../shared/math';
import type { Controls, MainState } from '../types';
import { MAIN_AERO } from '../aero';
import { G as GRAVITY } from '../constants';
import {
  SHEET_EASE_RATE, SHEET_HAUL_RATE, approachRate, evaluateSection, leechTelltales, momentAboutZ, sideFromAwa, sumSections,
  type AirContext, type SailSum, type SectionGeom, type SectionResult, type Side,
} from './common';

const N_SECTIONS = 8;
const G = BOAT.boom.gooseneck;
const P = BOAT.main.P;
const E = BOAT.main.E;
/** Roach amplitude (m) that, with the head width, gives the rated area. */
const ROACH = 0.314;
const MAX_BOOM = BOAT.boom.maxAngleDeg * DEG;
/** Shroud hard stop: the sheet spring normally holds the boom inside ±80°; nothing gets past this. */
const HARD_STOP = MAX_BOOM + 2 * DEG;
const I_BOOM = BOAT.boom.inertia;
const M_BOOM = BOAT.boom.mass + 8; // boom + sail
const D_BOOM_CG = 1.6;
const SHEET_K = 60000;
const SHEET_C = 2400;
const AIR_DAMP = 60;
const CRASH_RATE = 1.5;
/** An uncontrolled gybe: the boom swings from ≥ 40° out on one side to ≥ 40° out on the other within 2 s. */
const SWING_OUT = 40 * DEG;
const SWING_S = 2;
/** A gybe needs the wind from aft: at the centreline crossing |AWA| > 100°. */
const GYBE_AWA = 100 * DEG;
const BATTENS = [0.2, 0.4, 0.6, 0.8] as const;
const HALF_TRACK = BOAT.boom.traveler.halfWidth;
/** Front part of the main's chord that sits in the jib's slot flow (potential flow: 1.3–1.4× the mean downwash). */
const MAIN_LUFF_FRACTION = 0.3;
/** Crew holding the boom out by hand (Controls.boomPush): full push = 70° out. */
const BOOM_PUSH_MAX = 70 * DEG;
/** A firm hand: ≈ 260 N·m for a 5° error, critically damped on the boom's inertia. */
const BOOM_PUSH_K = 3000;
const BOOM_PUSH_C = 2 * Math.sqrt(BOOM_PUSH_K * BOAT.boom.inertia);
/** What one person can push at the boom end: ≈ 300 N × boom length. */
const BOOM_PUSH_CAP = 300 * BOAT.boom.length;

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
  /** +1 wind from starboard (boom to port), −1 from port — with hysteresis at head to wind and dead downwind. */
  tackSign: 1 | -1 = 1;
  /** Head twist magnitude (rad). */
  twist = 8 * DEG;
  /**
   * Which way the leech twists off (−1…+1, + toward port): the boom side, or the tack side while the boom is
   * within a few degrees of the centreline. It swings across smoothly when the sail flips.
   */
  twistSide = 1;
  /** Set to the impact rate (rad/s) on the step a crash gybe happens, else 0. */
  crashRate = 0;
  /**
   * Set (rad/s) on the step an uncontrolled gybe is recognised by its swing — the boom from ≥ 40° out on one
   * side to ≥ 40° out on the other within 2 s with the wind from aft — even when it is too slow to slam. Else 0.
   */
  swingRate = 0;
  /** Mainsheet actually hauled (0…1): it follows `Controls.mainSheet` at rope-handling speed. */
  sheet = 0.7;
  /** Traveler car position (m, + to starboard). A physical state: it follows its target at a finite speed. */
  carY = 0;
  last: MainEvaluation | null = null;
  private t = 0;
  private lastCrossT = -Infinity;
  private crossAwa = 0;
  private outT = { port: -Infinity, stbd: -Infinity };
  private wasInside = true;
  private lastMoment = 0;
  private primed = false;

  /** Allowed boom range from traveler car + sheet (rad) for these controls on the current tack. */
  limits(c: Controls): { lo: number; hi: number; car: number } {
    return this.range(c.mainSheet, this.carTarget(c));
  }

  /** Boom range the sheet and car allow right now (their actual, rate-limited positions). */
  appliedLimits(): { lo: number; hi: number; car: number } {
    return this.range(this.sheet, this.carY);
  }

  /** Where the car is told to go: `traveler` is relative to the tack (+ to windward). */
  carTarget(c: Controls): number {
    return clamp(c.traveler, -1, 1) * this.tackSign * HALF_TRACK;
  }

  /** Put the sheet and car where the controls say, at once (scenario start). */
  syncControls(c: Controls): void {
    this.sheet = clamp(c.mainSheet, 0, 1);
    this.carY = this.carTarget(c);
    this.primed = true;
  }

  private range(sheet: number, carY: number): { lo: number; hi: number; car: number } {
    const car = Math.atan2(-carY, BOAT.boom.sheetAttach);
    const delta = 85 * DEG * Math.pow(1 - clamp(sheet, 0, 1), 1.5);
    return { lo: Math.max(-MAX_BOOM, car - delta), hi: Math.min(MAX_BOOM, car + delta), car };
  }

  geometry(c: Controls, beta: number, twist: number): SectionGeom[] {
    const out: SectionGeom[] = [];
    const bend = 0.1 * c.backstay;
    const draft = BOAT.main.draftBase - 0.08 * c.cunningham;
    for (let i = 0; i < N_SECTIONS; i++) {
      const h = (i + 0.5) / N_SECTIONS;
      const theta = beta + this.twistSide * twist * Math.pow(h, 1.4);
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

  /**
   * Forces for a given boom angle and twist (no state change) — used by the dynamics, tests and VPP. The jib's
   * downwash (`shift.main`) acts on every section, its stronger part at the luff (`shift.mainLuff`) on the front
   * 30 % of the chord: when that part is backwinded it costs lift, not just looks (I5).
   */
  evaluate(c: Controls, beta: number, twist: number, air: AirContext, shift: MainShift, blanket = 1, betaDot = 0): MainEvaluation {
    const axis = { x: G.x, y: 0 };
    const opts = {
      alphaShift: shift.main, luffShift: shift.mainLuff, luffFraction: MAIN_LUFF_FRACTION, shiftSide: -this.tackSign,
      blanket, rotationRate: betaDot, rotationAxis: axis,
    };
    const sections = this.geometry(c, beta, twist).map((g) => evaluateSection(g, MAIN_AERO, air, opts));
    return {
      sections,
      sum: sumSections(sections, { x: 0, y: 0, z: -BOAT.mass.cgH }),
      mastMoment: momentAboutZ(sections, G.x, 0),
    };
  }

  /**
   * Advance the boom one step. `side` is the rig side decided by the simulation (hysteresis, gybes); without it
   * the model keeps its own from `awaRef` with the same hysteresis.
   */
  step(dt: number, c: Controls, air: AirContext, shift: MainShift, blanket: number, awaRef: number, side?: Side): MainEvaluation {
    this.t += dt;
    this.tackSign = side ?? sideFromAwa(this.tackSign, awaRef);

    // The crew handles the rope at a finite speed: the controls are targets (M3). The car does not jump when the
    // tack flips — only its target changes side (I2).
    if (!this.primed) this.syncControls(c);
    this.sheet = approachRate(this.sheet, clamp(c.mainSheet, 0, 1), SHEET_HAUL_RATE, SHEET_EASE_RATE, dt);
    // Traveler: pulling the car to windward is hauling (against the boom's load), letting it run to leeward easing.
    // Work in "metres to windward" so the same rates apply on either tack.
    const track = 2 * HALF_TRACK;
    const toWindward = this.carY * this.tackSign;
    const target = clamp(c.traveler, -1, 1) * HALF_TRACK;
    this.carY = this.tackSign * approachRate(toWindward, target, SHEET_HAUL_RATE * track, SHEET_EASE_RATE * track, dt);

    const { lo, hi } = this.appliedLimits();
    const pressingOut = (this.beta >= hi - DEG && this.lastMoment > 0) || (this.beta <= lo + DEG && this.lastMoment < 0);
    const sheetDown = Math.pow(this.sheet, 1.5) * (pressingOut ? 1 : 0.35);
    const tension = Math.max(clamp(c.vang, 0, 1), sheetDown);
    // Twist only exists while the sail is loaded: when the lower sail luffs the leech falls into the wind.
    const lower = this.last ? this.last.sections.slice(0, 4) : [];
    const lowerLuff = lower.length ? lower.reduce((a, r) => a + r.luffing, 0) / lower.length : 0;
    const loaded = 1 - smoothstep(0.3, 0.8, lowerLuff);
    const twistTarget = (2 + 20 * Math.pow(1 - tension, 1.3)) * DEG * loaded;
    const relax = Math.min(1, dt / 0.3);
    this.twist += (twistTarget - this.twist) * relax;
    // The leech falls off toward the boom side (C3: not the wind side, which flickers on a run). Near the
    // centreline the boom side means nothing (sheet stretch), so there the tack side decides.
    const boomOut = smoothstep(4 * DEG, 8 * DEG, Math.abs(this.beta));
    const sideTarget = boomOut * Math.sign(this.beta) + (1 - boomOut) * this.tackSign;
    this.twistSide += (sideTarget - this.twistSide) * relax;

    const ev = this.evaluate(c, this.beta, this.twist, air, shift, blanket, this.betaDot);
    this.last = ev;
    this.lastMoment = ev.mastMoment;

    let m = ev.mastMoment - M_BOOM * GRAVITY * D_BOOM_CG * Math.cos(this.beta) * Math.sin(air.kin.heel) - AIR_DAMP * this.betaDot;
    // Sailing by the lee: a strip/flat-plate model would hold an eased boom out until the wind is ~75° by
    // the lee, but on a real boat the flow reverses over the leech and the sail flips across once the wind
    // is roughly 12–22° by the lee. Model that reversal as a gybing moment toward (and across) the centreline,
    // blended in as the boom comes 3–7° off the centreline (M8) so it never switches on in a single step.
    if (Math.sign(awaRef) === -Math.sign(this.beta)) {
      const boomSide = Math.sign(this.beta) * smoothstep(3 * DEG, 7 * DEG, Math.abs(this.beta));
      const byLee = Math.PI - Math.abs(awaRef);
      const mid = ev.sections[Math.floor(ev.sections.length / 2)]!;
      m -= boomSide * smoothstep(12 * DEG, 22 * DEG, byLee) * 30 * mid.q * (ev.sum.area / BOAT.main.area);
    }
    // The crew holding the boom out by hand: a firm push toward their target, never more than a person can give,
    // and never past the sheet (the sheet spring below is far stiffer). 0 lets go at once.
    const push = clamp(c.boomPush ?? 0, -1, 1);
    if (push !== 0) {
      const hand = -BOOM_PUSH_K * (this.beta - push * BOOM_PUSH_MAX) - BOOM_PUSH_C * this.betaDot;
      m += clamp(hand, -BOOM_PUSH_CAP, BOOM_PUSH_CAP);
    }
    // While the rope is stretched it damps both ways (rope hysteresis, block friction) — no elastic bounce.
    if (this.beta > hi) m += -SHEET_K * (this.beta - hi) - SHEET_C * this.betaDot;
    else if (this.beta < lo) m += -SHEET_K * (this.beta - lo) - SHEET_C * this.betaDot;

    const before = this.beta;
    const rateBefore = this.betaDot;
    this.betaDot += (m / I_BOOM) * dt;
    this.beta += this.betaDot * dt;
    // The shrouds are a hard stop: the boom stops dead there (C1: no rate left over to grow).
    let hitStop = false;
    if (Math.abs(this.beta) > HARD_STOP) {
      const s = Math.sign(this.beta);
      this.beta = s * HARD_STOP;
      if (this.betaDot * s > 0) this.betaDot = 0;
      hitStop = true;
    }

    // Crash gybe (spec §7.4): the boom crossed the centreline with the wind from aft and slams into the sheet or
    // the shrouds — or swings right across (40° → 40° within 2 s) even when too slow to slam.
    if (Math.sign(before) !== Math.sign(this.beta) && before !== 0) {
      this.lastCrossT = this.t;
      this.crossAwa = awaRef;
    }
    const fromAft = Math.abs(this.crossAwa) > GYBE_AWA && this.t - this.lastCrossT < 4;
    const inside = this.beta >= lo && this.beta <= hi;
    this.crashRate = 0;
    if (fromAft && ((this.wasInside && !inside) || hitStop) && Math.abs(rateBefore) > CRASH_RATE) {
      this.crashRate = Math.abs(rateBefore);
    }
    this.wasInside = inside;
    this.swingRate = 0;
    if (Math.abs(this.beta) >= SWING_OUT) {
      const port = this.beta > 0;
      const otherT = port ? this.outT.stbd : this.outT.port;
      if (fromAft && this.lastCrossT > otherT && this.t - otherT <= SWING_S) {
        this.swingRate = Math.max(Math.abs(this.betaDot), Math.abs(rateBefore));
        if (port) this.outT.stbd = -Infinity; else this.outT.port = -Infinity;
      }
      if (port) this.outT.port = this.t; else this.outT.stbd = this.t;
    }
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
