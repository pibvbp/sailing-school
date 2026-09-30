// One-shot heavy sounds triggered by simulation events: the boom crash (a heavy thump through the whole boat, the
// crack of the sheet snatching taut and the rig rattling), the spinnaker's deep "whump" as it refills and the soft
// "poof" of it collapsing. Every voice is built once; a trigger only schedules envelopes.
import { RigRattle } from './rattle';
import { bandpass, butterworth, gainNode, pulse } from './nodes';
import type { NoiseBank } from './nodes';
import type { Rng } from './noise';

/** The character of an impact: a pitched sub thump, a low-passed body of noise and a band-passed crack. */
interface ImpactShape {
  /** Sub thump: pitch sweeps f0 → f1 (Hz) over `glide` s; attack/release time constants (s) and level. */
  f0: number; f1: number; glide: number; subAtk: number; subRel: number; subGain: number;
  bodyHz: number; bodyAtk: number; bodyRel: number; bodyGain: number;
  crackHz: number; crackQ: number; crackAtk: number; crackRel: number; crackGain: number;
}

const CRASH: ImpactShape = {
  f0: 90, f1: 42, glide: 0.2, subAtk: 0.002, subRel: 0.07, subGain: 0.9,
  bodyHz: 650, bodyAtk: 0.0012, bodyRel: 0.075, bodyGain: 1.35,
  crackHz: 1800, crackQ: 0.7, crackAtk: 0.0005, crackRel: 0.018, crackGain: 0.8,
};

const WHUMP: ImpactShape = {
  f0: 74, f1: 42, glide: 0.35, subAtk: 0.005, subRel: 0.09, subGain: 0.8,
  bodyHz: 280, bodyAtk: 0.01, bodyRel: 0.11, bodyGain: 1.4,
  crackHz: 1000, crackQ: 0.8, crackAtk: 0.003, crackRel: 0.03, crackGain: 0.24,
};

const POOF: ImpactShape = {
  f0: 60, f1: 42, glide: 0.3, subAtk: 0.02, subRel: 0.12, subGain: 0.15,
  bodyHz: 520, bodyAtk: 0.03, bodyRel: 0.16, bodyGain: 0.9,
  crackHz: 2200, crackQ: 0.6, crackAtk: 0.02, crackRel: 0.06, crackGain: 0.1,
};

class ImpactVoice {
  private readonly subGain: GainNode;
  private readonly bodyGain: GainNode;
  private readonly body: BiquadFilterNode;
  private readonly crackGain: GainNode;
  private readonly crackBand: BiquadFilterNode;

  constructor(
    private readonly ctx: BaseAudioContext,
    bank: NoiseBank,
    dest: AudioNode,
    private readonly subType: OscillatorType,
    private readonly shape: ImpactShape,
    private readonly rng: Rng,
  ) {
    this.subGain = gainNode(ctx, 0);
    this.subGain.connect(dest);
    const src = bank.loop(bank.white);
    this.bodyGain = gainNode(ctx, 0);
    this.body = butterworth(ctx, 'lowpass', shape.bodyHz);
    src.connect(this.bodyGain).connect(this.body).connect(dest);
    this.crackGain = gainNode(ctx, 0);
    this.crackBand = bandpass(ctx, shape.crackHz, shape.crackQ);
    src.connect(this.crackGain).connect(this.crackBand).connect(dest);
  }

  /** Schedule the impact at audio time `t`, `level` 0…1 scaling everything together (each one is a little different). */
  trigger(t: number, level: number, pitchScale = 1): void {
    const s = this.shape;
    const pitch = this.rng.range(0.94, 1.06) * pitchScale;
    const lvl = level * this.rng.range(0.9, 1.1);
    // The sub thump is a one-shot oscillator: impacts are rare, and an oscillator that is not running costs nothing.
    const osc = this.ctx.createOscillator();
    osc.type = this.subType;
    osc.frequency.setValueAtTime(s.f0 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(s.f1 * pitch, t + s.glide);
    osc.connect(this.subGain);
    osc.start(t);
    osc.stop(t + s.glide + 0.1 + 12 * s.subRel);
    osc.onended = () => osc.disconnect();
    pulse(this.subGain.gain, t, lvl * s.subGain, s.subAtk, s.subRel);
    this.body.frequency.setValueAtTime(s.bodyHz * pitch, t);
    pulse(this.bodyGain.gain, t, lvl * s.bodyGain, s.bodyAtk, s.bodyRel);
    pulse(this.crackGain.gain, t, lvl * s.crackGain, s.crackAtk, s.crackRel);
  }
}

export class ImpactsLayer {
  private readonly crashVoice: ImpactVoice;
  private readonly whumpVoice: ImpactVoice;
  private readonly poofVoice: ImpactVoice;
  private readonly rattle: RigRattle;

  constructor(ctx: BaseAudioContext, bank: NoiseBank, dest: AudioNode, rng: Rng) {
    this.crashVoice = new ImpactVoice(ctx, bank, dest, 'triangle', CRASH, rng);
    this.whumpVoice = new ImpactVoice(ctx, bank, dest, 'sine', WHUMP, rng);
    this.poofVoice = new ImpactVoice(ctx, bank, dest, 'sine', POOF, rng);
    this.rattle = new RigRattle(ctx, bank, dest, rng);
  }

  /** The boom slams across and the mainsheet snatches taut. `level` 0.55…1 (louder with the impact rate). */
  crash(t: number, level: number): void {
    this.crashVoice.trigger(t, level);
    this.rattle.trigger(t + 0.012, 1.8 * level, 16, 0.8);
  }

  /** The spinnaker fills after a collapse: a deep whump. */
  refill(t: number, level: number): void {
    this.whumpVoice.trigger(t, level);
  }

  /** The spinnaker loses its air. */
  collapse(t: number, level: number): void {
    this.poofVoice.trigger(t, level);
  }

  /** A flogging sail fills: the same thud as the spinnaker's, softer, higher for a smaller sail (`pitch` > 1). */
  fill(t: number, level: number, pitch: number): void {
    this.whumpVoice.trigger(t, level, pitch);
  }
}
