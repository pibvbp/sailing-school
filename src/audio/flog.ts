// The statistics of a flogging sail: WHEN it snaps and how each snap is shaped. Pure logic (no WebAudio) so the
// timing can be unit-tested; the audio layer turns each CrackEvent into scheduled envelopes on a voice pool.
//
// A real flogging sail is not a tremolo: the leech snaps at irregular intervals (mean rate 3–8 Hz), some snaps
// are much harder than others, now and then a flap doubles up ("ta-tak"), a hard snap brings a low thud of the
// whole panel, and every crack is a small cluster of crinkles that ends in a rustle.
import type { Rng } from './noise';
import { clamp } from '../shared/math';

export interface FlogProfile {
  /** Multiplies the flutter rate (a big main flaps a little slower than a small jib). */
  rateMul: number;
  /** Centre-frequency range (Hz, log-uniform) and Q of the crack's band-pass. */
  crackHz: readonly [number, number];
  crackQ: number;
  /** Decay time constant range (s) of the crack. */
  crackTau: readonly [number, number];
  /** Body: the low thud of the whole panel — low-pass cut-off range (Hz), decay range (s), chance on an average
   *  snap and level relative to the crack. */
  bodyHz: readonly [number, number];
  bodyTau: readonly [number, number];
  bodyProb: number;
  bodyGain: number;
  /** Rustle tail: band centre range (Hz), decay range (s) and level relative to the crack. */
  rustleHz: readonly [number, number];
  rustleTau: readonly [number, number];
  rustleGain: number;
  /** Chance that a flap doubles up. */
  doubleProb: number;
  /** Chance that a snap sets the blocks and boom rattling. */
  rattleProb: number;
  /** Where the sail sits off the bow, to leeward (rad), for stereo placement. */
  angle: number;
}

export const MAIN_PROFILE: FlogProfile = {
  rateMul: 0.92,
  crackHz: [1400, 4200],
  crackQ: 0.8,
  crackTau: [0.004, 0.01],
  bodyHz: [220, 520],
  bodyTau: [0.025, 0.05],
  bodyProb: 0.8,
  bodyGain: 0.7,
  rustleHz: [900, 2400],
  rustleTau: [0.05, 0.14],
  rustleGain: 0.3,
  doubleProb: 0.2,
  rattleProb: 0.22,
  angle: 0.2,
};

export const JIB_PROFILE: FlogProfile = {
  rateMul: 1.08,
  crackHz: [2200, 6500],
  crackQ: 0.9,
  crackTau: [0.003, 0.008],
  bodyHz: [300, 700],
  bodyTau: [0.02, 0.04],
  bodyProb: 0.4,
  bodyGain: 0.4,
  rustleHz: [1800, 4500],
  rustleTau: [0.04, 0.1],
  rustleGain: 0.25,
  doubleProb: 0.26,
  rattleProb: 0.05,
  angle: 0.1,
};

/** A collapsed spinnaker: soft nylon pops, hardly any body, no hardware. */
export const SPIN_PROFILE: FlogProfile = {
  rateMul: 1,
  crackHz: [1200, 3000],
  crackQ: 0.5,
  crackTau: [0.01, 0.03],
  bodyHz: [150, 300],
  bodyTau: [0.04, 0.08],
  bodyProb: 0.1,
  bodyGain: 0.3,
  rustleHz: [1500, 4000],
  rustleTau: [0.08, 0.2],
  rustleGain: 0.6,
  doubleProb: 0.1,
  rattleProb: 0,
  angle: 0,
};

/** One scheduled snap. The train reuses a single instance, so emitting events allocates nothing. */
export interface CrackEvent {
  /** Audio-clock time (s). */
  t: number;
  /** Loudness 0…~1.6 (already includes the flogging level and this snap's accent). */
  amp: number;
  crackHz: number;
  crackQ: number;
  crackTau: number;
  /** 0 = no body thud on this snap. */
  bodyAmp: number;
  bodyHz: number;
  bodyTau: number;
  rustleHz: number;
  rustleTau: number;
  rustleGain: number;
  /** Extra crinkles after the main crack (0…2): delay (s) and relative level of each. */
  subCount: number;
  subGap0: number;
  subGap1: number;
  subAmp0: number;
  subAmp1: number;
  /** True when this snap should set the rig rattling. */
  rattle: boolean;
}

export interface CrackSink {
  crack(train: FlogTrain, e: CrackEvent): void;
}

export class FlogTrain {
  /** Audio time of the next snap. */
  nextT = 0;
  private armed = false;
  private second = false;
  private readonly evt: CrackEvent = {
    t: 0, amp: 0, crackHz: 0, crackQ: 0, crackTau: 0, bodyAmp: 0, bodyHz: 0, bodyTau: 0, rustleHz: 0, rustleTau: 0, rustleGain: 0,
    subCount: 0, subGap0: 0, subGap1: 0, subAmp0: 0, subAmp1: 0, rattle: false,
  };

  constructor(readonly profile: FlogProfile, private readonly rng: Rng) {}

  /**
   * Schedule every snap that falls before `now + lookahead`. `rate` is the flutter rate (Hz) and `level` the loudness
   * (0 = not flogging). Snaps are placed on the audio clock, so their timing does not depend on the frame rate.
   */
  advance(now: number, lookahead: number, rate: number, level: number, sink: CrackSink): void {
    if (!(level > 1e-3) || !(rate > 0)) {
      this.armed = false;
      return;
    }
    if (!this.armed || this.nextT < now) {
      // (Re)start: the first snap comes a little later, never exactly on the frame.
      this.nextT = now + 0.01 + (this.rng.next() * 0.6) / rate;
      this.armed = true;
      this.second = false;
    }
    const horizon = now + lookahead;
    for (let guard = 0; this.nextT < horizon && guard < 8; guard++) {
      this.fire(this.nextT, level, sink);
      this.nextT += this.gap(rate);
    }
  }

  /** Time to the next snap: irregular, with occasional quick doubles, mean event rate = rate × profile.rateMul. */
  private gap(rate: number): number {
    const p = this.profile;
    const rng = this.rng;
    if (!this.second && rng.next() < p.doubleProb) {
      this.second = true;
      return rng.range(0.028, 0.075);
    }
    this.second = false;
    const meanPause = Math.max(0.05, (1 + p.doubleProb) / (rate * p.rateMul) - p.doubleProb * 0.05);
    return meanPause * clamp(Math.exp(0.42 * rng.gauss() - 0.088), 0.3, 2.6); // log-normal, mean ≈ 1
  }

  private fire(t: number, level: number, sink: CrackSink): void {
    const p = this.profile;
    const rng = this.rng;
    const e = this.evt;
    const accent = clamp(Math.exp(0.5 * rng.gauss() - 0.125), 0.3, 1.6); // some flaps are much harder than others
    e.t = t;
    e.amp = level * accent * (this.second ? 0.6 : 1);
    e.crackHz = p.crackHz[0] * (p.crackHz[1] / p.crackHz[0]) ** rng.next();
    e.crackQ = p.crackQ;
    e.crackTau = rng.range(p.crackTau[0], p.crackTau[1]);
    const hard = clamp(accent, 0, 1.3);
    e.bodyAmp = rng.next() < p.bodyProb * (0.4 + 0.6 * hard) ? p.bodyGain * hard : 0;
    e.bodyHz = p.bodyHz[0] * (p.bodyHz[1] / p.bodyHz[0]) ** rng.next();
    e.bodyTau = rng.range(p.bodyTau[0], p.bodyTau[1]);
    e.rustleHz = p.rustleHz[0] * (p.rustleHz[1] / p.rustleHz[0]) ** rng.next();
    e.rustleTau = rng.range(p.rustleTau[0], p.rustleTau[1]);
    e.rustleGain = p.rustleGain;
    e.subCount = rng.next() < 0.6 ? (rng.next() < 0.4 ? 2 : 1) : 0;
    e.subGap0 = rng.range(0.002, 0.007);
    e.subGap1 = e.subGap0 + rng.range(0.003, 0.008);
    e.subAmp0 = rng.range(0.4, 0.75);
    e.subAmp1 = rng.range(0.2, 0.45);
    e.rattle = rng.next() < p.rattleProb * (0.5 + 0.5 * hard);
    sink.crack(this, e);
  }
}

/**
 * Watches how hard a sail has been flogging and reports the moment it stops: the sail fills with a soft thud
 * (the end of a tack, or the trimmer hauling a luffing jib back in). Fires once per flogging spell, and only after a
 * spell of some substance — a flutter of a fraction of a second is not one.
 */
export class FillDetector {
  private peak = 0;
  /** Seconds of proper flogging so far in this spell (drains while the sail is quiet). */
  private spell = 0;
  private last = -Infinity;

  /** `drive` is the sail's luffDrive 0…1; returns the thud level 0…1 for this frame (0 = nothing). */
  update(now: number, dt: number, drive: number): number {
    this.peak = Math.max(drive, this.peak * Math.exp(-dt / 1.2));
    this.spell = drive > 0.3 ? this.spell + dt : Math.max(0, this.spell - 0.5 * dt);
    if (drive < 0.1 && this.spell > 0.6 && this.peak > 0.5 && now - this.last > 1.5) {
      const level = Math.min(1, this.peak);
      this.peak = 0;
      this.spell = 0;
      this.last = now;
      return level;
    }
    return 0;
  }

  reset(): void {
    this.peak = 0;
    this.spell = 0;
  }
}
