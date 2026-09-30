// Sail sounds: the flogging of a luffing main/jib (the "flap of the fabric") and the rustle of a collapsed
// spinnaker.
//
// Flogging is built from discrete snaps placed on the audio clock by a FlogTrain (irregular timing, 3–8 Hz rising
// with AWS). Each snap is a small cluster of noise crinkles (band-passed, a few kHz, a few ms), an optional low
// thud of the panel, a rustle tail, and — now and then — a rattle of blocks and boom. Between the snaps grainy
// crumpling noise keeps the sound of the sail alive. Voices are a fixed pool of always-running noise sources with
// gain envelopes, so nothing is created per snap.
import { FillDetector, FlogTrain, JIB_PROFILE, MAIN_PROFILE, SPIN_PROFILE, type CrackEvent, type CrackSink } from './flog';
import type { ImpactsLayer } from './impacts';
import { GLIDE, flogLevel as flogLevelOf, flutterRate, luffDrive, panFor, relativeBearing } from './mapping';
import { Glide, NoiseBank, bandpass, butterworth, gainNode, pulse, pulseMore, type Crackle } from './nodes';
import type { Rng } from './noise';
import { RigRattle } from './rattle';

/** How far ahead of the audio clock snaps are scheduled (s): long enough to survive a slow frame, short enough
 *  that the flogging stops promptly when the sail fills. */
const LOOKAHEAD = 0.09;
const VOICES = 5;
const PAN_WIDTH = 0.7;

/** Gain on the unit-RMS noise at the loudest crack (level 1); calibrated by rendering the layer alone. */
const CRACK_GAIN = 1.7;
const ATTACK = 0.0004;

/** A voice: one noise source feeding a crack band, a low body thud and a rustle band. */
class CrackVoice {
  private readonly crackGain: GainNode;
  private readonly crackBand: BiquadFilterNode;
  private readonly bodyGain: GainNode;
  private readonly bodyLp: BiquadFilterNode;
  private readonly rustleGain: GainNode;
  private readonly rustleBand: BiquadFilterNode;
  private readonly pan: StereoPannerNode;

  constructor(ctx: BaseAudioContext, bank: NoiseBank, dest: AudioNode) {
    this.pan = ctx.createStereoPanner();
    this.pan.connect(dest);
    const src = bank.loop(bank.white);
    this.crackGain = gainNode(ctx, 0);
    this.crackBand = bandpass(ctx, 2500, 0.8);
    src.connect(this.crackGain).connect(this.crackBand).connect(this.pan);
    this.rustleGain = gainNode(ctx, 0);
    this.rustleBand = bandpass(ctx, 1500, 0.8);
    src.connect(this.rustleGain).connect(this.rustleBand).connect(this.pan);
    // Low frequencies do not localise: the body goes straight to the bus.
    this.bodyGain = gainNode(ctx, 0);
    this.bodyLp = butterworth(ctx, 'lowpass', 300);
    src.connect(this.bodyGain).connect(this.bodyLp).connect(dest);
  }

  trigger(e: CrackEvent, pan: number, gain: number): void {
    const t = e.t;
    const a = e.amp * gain;
    this.pan.pan.setValueAtTime(pan, t);

    this.crackBand.frequency.setValueAtTime(e.crackHz, t);
    this.crackBand.Q.setValueAtTime(e.crackQ, t);
    // The crack and its crinkles are one envelope: only its last hit is finished off with an exact 0.
    pulse(this.crackGain.gain, t, a, ATTACK, e.crackTau, e.subCount === 0);
    if (e.subCount > 0) pulseMore(this.crackGain.gain, t + e.subGap0, a * e.subAmp0, ATTACK, e.crackTau * 0.8, e.subCount === 1);
    if (e.subCount > 1) pulseMore(this.crackGain.gain, t + e.subGap1, a * e.subAmp1, ATTACK, e.crackTau * 0.7);

    this.rustleBand.frequency.setValueAtTime(e.rustleHz, t);
    pulse(this.rustleGain.gain, t + 0.002, a * e.rustleGain, 0.004, e.rustleTau);

    if (e.bodyAmp > 0) {
      this.bodyLp.frequency.setValueAtTime(e.bodyHz, t);
      pulse(this.bodyGain.gain, t, a * e.bodyAmp, 0.0015, e.bodyTau);
    }
  }
}

export class SailsLayer implements CrackSink {
  private readonly voices: CrackVoice[] = [];
  private next = 0;
  private readonly main: FlogTrain;
  private readonly jib: FlogTrain;
  private readonly spin: FlogTrain;
  private readonly rattle: RigRattle;
  private readonly flogBed: Glide;
  private readonly spinBed: Glide;
  private readonly flogCrackle: Crackle;
  private readonly spinCrackle: Crackle;
  /** How long (s) each bed has been silent: its crumple texture is only switched off once the bed has faded out. */
  private flogIdle = 0;
  private spinIdle = 0;
  private readonly mainFill = new FillDetector();
  private readonly jibFill = new FillDetector();
  /** Loudness of the louder of main and jib flogging (0 = quiet) and the flutter rate, as of the last update. */
  flogLevel = 0;
  flutterHz = 3;
  // Per-update context for the crack callback (kept in fields so scheduling allocates nothing).
  private heading = 0;
  private leeSign = 1;
  private cameraYaw = 0;

  constructor(ctx: BaseAudioContext, bank: NoiseBank, dest: AudioNode, rng: Rng, private readonly impacts: ImpactsLayer) {
    for (let i = 0; i < VOICES; i++) this.voices.push(new CrackVoice(ctx, bank, dest));
    this.main = new FlogTrain(MAIN_PROFILE, rng);
    this.jib = new FlogTrain(JIB_PROFILE, rng);
    this.spin = new FlogTrain(SPIN_PROFILE, rng);
    this.rattle = new RigRattle(ctx, bank, dest, rng);

    // Crumpling between the snaps (main + jib): band-limited noise gated by sparse random grains.
    const bedGain = gainNode(ctx, 0);
    this.flogCrackle = bank.crackle(0.25, 0.9);
    bank.loop(bank.white).connect(bandpass(ctx, 2200, 0.6)).connect(bedGain).connect(this.flogCrackle.node).connect(dest);
    this.flogBed = new Glide(bedGain.gain, GLIDE.flogBed, 5e-5);

    // Collapsed spinnaker: thin nylon rustle, brighter, softer and finer-grained than the cloth of the main.
    const spinGain = gainNode(ctx, 0);
    this.spinCrackle = bank.crackle(0.2, 1.2, 1.6, 0.1);
    bank.loop(bank.white).connect(butterworth(ctx, 'highpass', 1300)).connect(bandpass(ctx, 3300, 0.7)).connect(spinGain)
      .connect(this.spinCrackle.node).connect(dest);
    this.spinBed = new Glide(spinGain.gain, GLIDE.spin, 5e-5);
  }

  /**
   * `mainLuff`/`jibLuff`: mean section luffing 0…1 (0 when the sail is not set). `spinRustle`: 0…1 drive of the collapsed
   * spinnaker. `awa` decides which side the sails are on (to leeward).
   */
  update(now: number, dt: number, aws: number, mainLuff: number, jibLuff: number, spinRustle: number, heading: number, awa: number, cameraYaw: number): void {
    this.heading = heading;
    this.leeSign = awa >= 0 ? -1 : 1; // wind from starboard → sails set out to port
    this.cameraYaw = cameraYaw;
    const rate = flutterRate(aws);
    const mainDrive = luffDrive(mainLuff);
    const jibDrive = luffDrive(jibLuff);
    const mainLevel = flogLevelOf(mainDrive, aws);
    const jibLevel = flogLevelOf(jibDrive, aws);
    this.flogLevel = Math.max(mainLevel, jibLevel);
    this.flutterHz = rate;
    this.main.advance(now, LOOKAHEAD, rate, mainLevel, this);
    this.jib.advance(now, LOOKAHEAD, rate, jibLevel, this);
    this.spin.advance(now, LOOKAHEAD, 4, spinRustle * 0.15, this);
    const flogBed = 0.4 * (mainLevel + 0.7 * jibLevel) ** 0.85;
    this.flogBed.to(flogBed, now);
    this.flogIdle = flogBed > 1e-3 ? 0 : this.flogIdle + dt;
    this.flogCrackle.setActive(this.flogIdle < 12 * GLIDE.flogBed + 0.2);
    const spinBed = 0.1 * spinRustle;
    this.spinBed.to(spinBed, now);
    this.spinIdle = spinBed > 1e-3 ? 0 : this.spinIdle + dt;
    this.spinCrackle.setActive(this.spinIdle < 12 * GLIDE.spin + 0.2);

    // When a flogging spell ends the sail fills with a thud — harder in more wind, higher for the smaller jib.
    const windy = 0.5 + 0.5 * Math.min(1, aws / 6);
    const mainThud = this.mainFill.update(now, dt, mainDrive);
    if (mainThud > 0) this.impacts.fill(now + 0.006, 0.5 * mainThud * windy, 1);
    const jibThud = this.jibFill.update(now, dt, jibDrive);
    if (jibThud > 0) this.impacts.fill(now + 0.006, 0.35 * jibThud * windy, 1.4);
  }

  /** Forget the flogging history (a new scenario starts). */
  reset(): void {
    this.mainFill.reset();
    this.jibFill.reset();
  }

  crack(train: FlogTrain, e: CrackEvent): void {
    const v = this.voices[this.next]!;
    this.next = (this.next + 1) % VOICES;
    const pan = panFor(relativeBearing(this.heading, this.leeSign * train.profile.angle, this.cameraYaw), PAN_WIDTH);
    v.trigger(e, pan, CRACK_GAIN);
    if (e.rattle) this.rattle.trigger(e.t, 0.9 * e.amp, 5, 0.35);
  }
}
