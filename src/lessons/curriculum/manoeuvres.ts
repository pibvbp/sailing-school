// Manoeuvre detectors (tacks and gybes, however they are sailed) and the demonstrations several lessons share.
import { toDeg } from '../../shared/units';
import type { SimSnapshot } from '../../sim/types';
import type { LessonCtx } from '../types';
import { absTwa, hasEvent, speedKn, twaDeg } from './readings';
import { holdTwa } from './scenario';
import { frameDt, type Demo } from './steps';

// ---- detectors -------------------------------------------------------------------------------------

export interface TackResult { entry: number; min: number; ratio: number }

/**
 * Seconds before a turn over which the entry speed is taken (its maximum): long enough that pinching or luffing
 * slowly into a tack still counts against it.
 */
export const ENTRY_WINDOW = 8;

/**
 * Detects tacks however they are sailed (T key, autopilot or tiller): the bow turns through the wind from
 * one close-hauled side to the other. `entry` is the best speed in the 8 s before the bow started to turn
 * toward the wind — so luffing or pinching before the tack counts against you — and `min` is the lowest
 * speed before the boat accelerates again on the new tack.
 */
export class TackWatch {
  private side: 0 | 1 | -1 = 0;
  private recent: { t: number; v: number }[] = [];
  private entry = 0;
  private turning = false;
  private crossed = false;
  private crossT = 0;
  private min = Infinity;

  update(s: SimSnapshot): TackResult | null {
    const twa = twaDeg(s), a = Math.abs(twa), v = speedKn(s);
    const side: 1 | -1 = twa >= 0 ? 1 : -1;
    if (a > 100) { this.turning = false; this.side = 0; this.recent = []; return null; }
    if (!this.turning) {
      this.recent.push({ t: s.t, v });
      while (this.recent.length > 1 && s.t - this.recent[0]!.t > ENTRY_WINDOW) this.recent.shift();
      if (a >= 32 || this.side === 0) this.side = side;
      if (a < 32) {
        this.turning = true;
        this.crossed = false;
        this.min = v;
        this.entry = Math.max(...this.recent.map((r) => r.v));
      }
      return null;
    }
    this.min = Math.min(this.min, v);
    if (!this.crossed && side !== this.side) { this.crossed = true; this.crossT = s.t; }
    if (a < 30) return null;
    const done = (): void => { this.turning = false; this.side = side; this.recent = [{ t: s.t, v }]; };
    if (!this.crossed || side === this.side) { done(); return null; } // turned back without tacking
    // On the new tack: wait until the boat accelerates again (or 5 s) so `min` is the real low point.
    if (v < this.min + 0.1 && s.t - this.crossT < 5) return null;
    const res = { entry: this.entry, min: this.min, ratio: this.entry > 0.1 ? this.min / this.entry : 0 };
    done();
    return res;
  }
}

export interface GybeResult { crashed: boolean }

/**
 * Detects gybes: the stern turns through the wind (TWA passes 180°) and the boom comes to rest on the new
 * side. `crashed` is true when the sim reported a crash gybe on the way — the crash is reported when the
 * boom slams into the end of its sheet, so the gybe only counts once the boom has stopped swinging.
 */
export class GybeWatch {
  private side: 0 | 1 | -1 = 0;
  private pending = false;
  private crashed = false;
  private flipT = 0;

  update(s: SimSnapshot): GybeResult | null {
    const twa = twaDeg(s), a = Math.abs(twa);
    const side: 1 | -1 = twa >= 0 ? 1 : -1;
    if (this.pending && hasEvent(s, 'crashGybe')) this.crashed = true;
    if (this.side === 0) { this.side = side; return null; }
    if (side !== this.side) {
      this.side = side;
      if (a < 90 || this.pending) { this.pending = false; return null; } // a tack, or back out of a gybe
      this.pending = true;
      this.crashed = hasEvent(s, 'crashGybe');
      this.flipT = s.t;
      return null;
    }
    if (!this.pending) return null;
    const main = s.sails.main;
    const boom = toDeg(main.boomAngle);
    if (Math.sign(boom) === side && Math.abs(boom) > 15 && Math.abs(main.boomRate) < 0.3) {
      this.pending = false;
      return { crashed: this.crashed };
    }
    if (s.t - this.flipT > 25) this.pending = false; // sailing by the lee without gybing: not a gybe
    return null;
  }
}

/**
 * Which tack the learner is deliberately steering the boat onto right now: +1 starboard tack (wind on the
 * starboard side), −1 port tack, 0 no clear input. It reads the helm as a sailor would: a tiller held over
 * (which works in reverse while the boat drifts astern), an autopilot set to a sailing angle, or a jib held
 * aback (it pushes the bow away from its own side).
 */
export function steeringOnto(c: LessonCtx): 1 | -1 | 0 {
  const k = c.app.controls;
  const s = c.snap;
  if (k.jibBacked) return s.sails.jib.clewAngle > 0 ? -1 : s.sails.jib.clewAngle < 0 ? 1 : 0;
  if (k.helmMode === 'twa') return Math.abs(toDeg(k.helmTarget)) >= 40 ? (k.helmTarget > 0 ? 1 : -1) : 0;
  if (k.helmMode === 'manual' && Math.abs(k.tiller) >= 0.3) {
    // Bow to starboard (tiller > 0 going ahead) swings the wind onto the port side, and vice versa.
    if (s.boat.u > 0.2) return k.tiller > 0 ? -1 : 1;
    if (s.boat.u < -0.1) return k.tiller > 0 ? 1 : -1;
  }
  return 0;
}

// ---- shared demos ----------------------------------------------------------------------------------

type RampKey = 'mainSheet' | 'jibSheet' | 'traveler' | 'spinSheet' | 'spinPole' | 'vang' | 'outhaul' | 'cunningham' | 'backstay' | 'jibLead';

/** Move controls toward targets at a hand-trimming rate (units per second), like a crew hauling a sheet. */
export function ramp(targets: Partial<Record<RampKey, number>>, rate = 0.35): Demo {
  return (c) => {
    const k = c.app.controls;
    const d = rate * frameDt(c, 'rampDt');
    for (const [key, target] of Object.entries(targets) as [RampKey, number][]) {
      k[key] += Math.max(-d, Math.min(d, target - k[key]));
    }
  };
}

/** Run several demos together. */
export const together = (...demos: Demo[]): Demo => (c) => { for (const d of demos) d(c); };

/**
 * Get the boat sailing at `absTwa` from wherever it is — including stopped head to wind: back the jib (it
 * pushes the bow away from the side it is held on) and steer in reverse while drifting astern; once the bow
 * is well off the wind, release the jib and let the autopilot take the new course.
 */
export function sailAway(absTargetTwa: number, opts: { releaseAt?: number } = {}): Demo {
  const releaseAt = opts.releaseAt ?? 50;
  let phase: 'turn' | 'sail' = 'turn';
  const sail = (c: LessonCtx): void => {
    const k = c.app.controls;
    k.jibBacked = false;
    k.autoTrim.main = true;
    k.autoTrim.jib = true;
    holdTwa(c, absTargetTwa);
  };
  return (c) => {
    const s = c.snap;
    const a = absTwa(s);
    if (phase === 'turn' && a >= releaseAt) phase = 'sail';
    // Still carrying way and already off to one side: simply steer away.
    if (phase === 'sail' || (s.boat.u > 0.9 && a > 12)) { sail(c); return; }
    // Back the jib: its old sheet stays pulled tight (the crew stops trimming it).
    const k = c.app.controls;
    k.jibBacked = true;
    k.autoTrim.jib = false;
    k.jibSheet = 1;
    k.helmMode = 'manual';
    // Clew held to port (+) pushes the bow to starboard. Going astern the rudder works in reverse, so the
    // tiller command that normally turns the bow to port now helps it to starboard.
    const clewSide = Math.sign(s.sails.jib.clewAngle) || 1;
    k.tiller = s.boat.u < -0.05 ? -clewSide : 0;
  };
}
