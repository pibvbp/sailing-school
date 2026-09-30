// Small WebAudio building blocks shared by the sound layers: smoothed parameter drivers, percussive envelopes and
// the shared bank of looping noise buffers.
import { Rng, makeControlBuffer, makeNoiseBuffer } from './noise';

/** After this many time constants an exponential fade to zero has fallen below −100 dB and is finished. */
const SETTLED = 12;

/**
 * Drives one AudioParam with exponential glides (`setTargetAtTime`), so nothing ever steps → no clicks or zipper
 * noise however the simulation jumps. Calls are skipped while the target has not moved by more than `eps`, which
 * also keeps the automation timeline short. Non-finite targets are ignored (the browser would throw).
 *
 * A glide towards 0 is finished off with an exact 0 once it has fallen below −100 dB. An exponential never gets there
 * by itself, and a gain that is "almost" 0 still makes the browser process everything behind it; an exact 0 lets it
 * see silence and skip that part of the graph (idle layers then cost next to nothing on the audio thread).
 */
export class Glide {
  private last = Number.NaN;
  private zeroPending = false;

  constructor(readonly param: AudioParam, private readonly tc: number, private readonly eps = 1e-4) {}

  to(value: number, now: number, tc = this.tc): void {
    if (value - value !== 0) return;
    const d = value - this.last;
    if (d < this.eps && d > -this.eps) return;
    this.last = value;
    if (this.zeroPending) {
      this.param.cancelScheduledValues(now); // a coming "settle to exactly 0" must not cut into this new glide
      this.zeroPending = false;
    }
    this.param.setTargetAtTime(value, now, tc);
    if (value === 0) {
      this.param.setValueAtTime(0, now + SETTLED * tc);
      this.zeroPending = true;
    }
  }
}

/**
 * Percussive gain envelope starting at audio time `t`: a fast exponential attack (time constant `atk`), then an
 * exponential release (time constant `rel`) after `4·atk`, finished off with an exact 0 (see Glide). Built from
 * setTarget curves, which continue from wherever the gain currently is, so retriggering a voice that is still
 * ringing cannot click. Cancelling from `t` on also drops the previous trigger's pending "exact 0".
 *
 * When more hits follow on the same envelope (`pulseMore`), pass `settle = false` on all but the last one.
 */
export function pulse(p: AudioParam, t: number, peak: number, atk: number, rel: number, settle = true): void {
  p.cancelScheduledValues(t);
  pulseMore(p, t, peak, atk, rel, settle);
}

/** A further percussive hit on an envelope already started with pulse() (crinkles of one crack, rattle ticks). */
export function pulseMore(p: AudioParam, t: number, peak: number, atk: number, rel: number, settle = true): void {
  p.setTargetAtTime(peak, t, atk);
  p.setTargetAtTime(0, t + 4 * atk, rel);
  if (settle) p.setValueAtTime(0, t + 4 * atk + SETTLED * rel);
}

export function gainNode(ctx: BaseAudioContext, value = 0): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/** Band-pass (Q = centre/bandwidth), 0 dB at the centre. */
export function bandpass(ctx: BaseAudioContext, hz: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = hz;
  f.Q.value = q;
  return f;
}

/** Flat (Butterworth) low-/high-pass: for these types the Q param is in dB, −3.01 dB = 0.707 linear. */
export function butterworth(ctx: BaseAudioContext, type: 'lowpass' | 'highpass', hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = -3.0103;
  return f;
}

/** The loop lengths (s) of the shared buffers; long enough that a loop is not recognisable as one. */
const NOISE_SECONDS = 3;
const CONTROL_SECONDS = 16;
/** Bandwidth (Hz) of the fast control noise that drives crackle textures. */
const FAST_CUTOFF = 30;

/** Sparse random spikes from a Gaussian control signal: nothing below `threshold`, then rising quadratically. */
function crackleCurve(threshold: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1;
    curve[i] = u > threshold ? ((u - threshold) / (1 - threshold)) ** 2 : 0;
  }
  return curve;
}

/** The shared looping buffers every layer draws its noise from. */
export class NoiseBank {
  readonly white: AudioBuffer;      // mono, for bursts, beds and tones
  readonly pinkMono: AudioBuffer;
  readonly pinkStereo: AudioBuffer; // decorrelated channels, for the parts of the wind that should surround the listener
  readonly brownMono: AudioBuffer;  // low frequencies do not localise: no need for two channels
  readonly control: AudioBuffer;
  /** Like `control` but with content up to ~30 Hz: the raw material of crackle. */
  readonly controlFast: AudioBuffer;

  private constructor(
    private readonly ctx: BaseAudioContext,
    private readonly rng: Rng,
    buffers: Pick<NoiseBank, 'white' | 'pinkMono' | 'pinkStereo' | 'brownMono' | 'control' | 'controlFast'>,
  ) {
    this.white = buffers.white;
    this.pinkMono = buffers.pinkMono;
    this.pinkStereo = buffers.pinkStereo;
    this.brownMono = buffers.brownMono;
    this.control = buffers.control;
    this.controlFast = buffers.controlFast;
  }

  /** Generate all the buffers, yielding to the event loop between them so the start-up never blocks a frame for long. */
  static async create(ctx: BaseAudioContext, seed: number): Promise<NoiseBank> {
    const rng = new Rng(seed);
    const yielded = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const white = makeNoiseBuffer(ctx, 'white', NOISE_SECONDS, 1, rng);
    const pinkMono = makeNoiseBuffer(ctx, 'pink', NOISE_SECONDS, 1, rng);
    await yielded();
    const pinkStereo = makeNoiseBuffer(ctx, 'pink', NOISE_SECONDS, 2, rng);
    await yielded();
    const brownMono = makeNoiseBuffer(ctx, 'brown', NOISE_SECONDS, 1, rng);
    const control = makeControlBuffer(ctx, rng, CONTROL_SECONDS);
    const controlFast = makeControlBuffer(ctx, rng, 8, FAST_CUTOFF);
    return new NoiseBank(ctx, rng, { white, pinkMono, pinkStereo, brownMono, control, controlFast });
  }

  /** A started, looping source on `buffer` at a random offset so that layers sharing a buffer stay uncorrelated. */
  loop(buffer: AudioBuffer, playbackRate = 1): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    src.start(0, this.rng.next() * buffer.duration);
    return src;
  }

  /**
   * Fast multiplicative randomness: returns a gain node with intrinsic gain 1 whose gain param is also fed by control
   * noise, i.e. out = in · (1 + depth · noise); `speed` scales how quickly the noise wanders. Audio-rate, so it can
   * be quick (the burble of water) — but it is the most expensive thing in the graph: use Wander for slow drifts.
   */
  modulator(depth: number, speed: number): GainNode {
    const mod = gainNode(this.ctx, 1);
    const d = gainNode(this.ctx, depth);
    this.loop(this.control, speed).connect(d).connect(mod.gain);
    return mod;
  }

  /**
   * Crumpling-cloth texture: a gain node (`.node`) with intrinsic gain `floor` whose gain param is also fed with sparse
   * random spikes (about 15–20 a second at `speed` 1), each up to `depth` high — out = in · (floor + depth · spike).
   * The spikes only run while `setActive(true)`, so an idle texture costs nothing.
   */
  crackle(floor: number, depth: number, speed = 1, threshold = 0.3): Crackle {
    return new Crackle(this.ctx, this.loop(this.controlFast, speed), floor, depth, threshold);
  }
}

export class Crackle {
  readonly node: GainNode;
  private readonly pre: GainNode;
  private active = false;

  constructor(ctx: BaseAudioContext, private readonly source: AudioBufferSourceNode, floor: number, depth: number, threshold: number) {
    this.node = gainNode(ctx, floor);
    this.pre = gainNode(ctx, 0.3); // control noise reaches ±3.5σ; keep it inside the shaper's ±1 input range
    const shaper = ctx.createWaveShaper();
    shaper.curve = crackleCurve(threshold);
    this.pre.connect(shaper).connect(gainNode(ctx, depth)).connect(this.node.gain);
  }

  /** Switch the spikes on or off. Only do it while whatever runs through `node` is silent: the gain jumps by a spike. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) this.source.connect(this.pre);
    else this.source.disconnect();
  }
}

/**
 * A slowly wandering multiplier `center + depth·x(t)` for a gain (or pitch) param, where x is an Ornstein–Uhlenbeck
 * process — unit variance, correlated over about 1/`hz` seconds — advanced from update(). It is how gusts and drifts are
 * made: a few AudioParam calls a frame instead of an audio-rate modulator running all the time.
 */
export class Wander {
  private x = 0;
  private pending = 0;
  private readonly glide: Glide;

  constructor(param: AudioParam, private readonly depth: number, private readonly hz: number, private readonly rng: Rng, private readonly center = 1, private readonly min = 0.1) {
    this.glide = new Glide(param, Math.max(0.03, 1 / (2 * Math.PI * 4 * hz)), 1e-4);
  }

  /** Advance by `dt`; the param is only re-aimed about 30 times a second (the glide smooths the steps). */
  update(now: number, dt: number): void {
    this.pending += dt;
    if (this.pending < 1 / 30) return;
    const a = Math.exp(-2 * Math.PI * this.hz * this.pending);
    this.pending = 0;
    this.x = a * this.x + Math.sqrt(1 - a * a) * this.rng.gauss();
    this.glide.to(Math.max(this.min, this.center + this.depth * this.x), now);
  }
}
