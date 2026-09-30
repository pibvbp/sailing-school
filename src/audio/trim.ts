// Trimming sounds: the ratchet of a winch or block while a sheet is hauled in, and the soft hiss of rope running
// out while it is eased. There is no "trim" event in the snapshot, so the layer listens to the sails themselves: a
// boom or jib clew coming steadily toward the centreline is a sheet being hauled, one going away is a sheet running.
// A swing much faster than any crew can haul (tack, gybe, crash) is not a winch and stays silent.
import { GLIDE, clamp01 } from './mapping';
import { Glide, NoiseBank, bandpass, gainNode, pulse } from './nodes';
import type { Rng } from './noise';
import { smoothstep } from '../shared/math';

/** Below this the sail is just moving with the wind and the crew's small corrections; above it someone is hauling. */
const RATE_ON = 0.05;
/** Faster than this (rad/s) the sail is swinging across, not being trimmed. */
const RATE_SWING = 0.9;
const LOOKAHEAD = 0.09;

interface ClickShape {
  /** Click band centre range (Hz), level (gain on unit noise) and body (low "tok") level. */
  hz: readonly [number, number];
  gain: number;
  body: number;
}

/** A winch drum for the jib: lower and heavier. A block ratchet for the main: lighter and higher. */
const WINCH: ClickShape = { hz: [1900, 2800], gain: 0.9, body: 0.5 };
const BLOCK: ClickShape = { hz: [3000, 4400], gain: 0.55, body: 0.25 };

class ClickTrain {
  private next = 0;
  private armed = false;

  constructor(private readonly shape: ClickShape, private readonly rng: Rng, private readonly fire: (t: number, shape: ClickShape, jitter: number) => void) {}

  /** `rate` = haul speed in rad/s (0 = not hauling). Clicks come faster the harder the crew grinds. */
  advance(now: number, rate: number): void {
    if (!(rate > RATE_ON) || rate > RATE_SWING) {
      this.armed = false;
      return;
    }
    if (!this.armed || this.next < now) {
      this.next = now + 0.01 + this.rng.next() * 0.05;
      this.armed = true;
    }
    const perSecond = 6 + 22 * smoothstep(RATE_ON, 0.5, rate);
    for (let guard = 0; this.next < now + LOOKAHEAD && guard < 4; guard++) {
      this.fire(this.next, this.shape, this.rng.range(0.7, 1.15));
      this.next += (1 / perSecond) * this.rng.range(0.85, 1.15);
    }
  }
}

export class TrimLayer {
  private readonly voices: { gain: GainNode; band: BiquadFilterNode; bodyGain: GainNode }[] = [];
  private cursor = 0;
  private readonly main: ClickTrain;
  private readonly jib: ClickTrain;
  private readonly run: Glide;
  private mainSmooth = 0;
  private jibSmooth = 0;
  private prevJibAbs = Number.NaN;
  private load = 1;

  constructor(ctx: BaseAudioContext, bank: NoiseBank, dest: AudioNode, private readonly rng: Rng) {
    for (let i = 0; i < 3; i++) {
      const src = bank.loop(bank.white);
      const gain = gainNode(ctx, 0);
      const band = bandpass(ctx, 2600, 3.5);
      src.connect(gain).connect(band).connect(dest);
      const bodyGain = gainNode(ctx, 0);
      src.connect(bodyGain).connect(bandpass(ctx, 850, 1.6)).connect(dest);
      this.voices.push({ gain, band, bodyGain });
    }
    const fire = (t: number, shape: ClickShape, jitter: number): void => this.click(t, shape, jitter);
    this.main = new ClickTrain(BLOCK, rng, fire);
    this.jib = new ClickTrain(WINCH, rng, fire);

    // Rope running out through the blocks while a sheet is eased.
    const runGain = gainNode(ctx, 0);
    bank.loop(bank.white).connect(bandpass(ctx, 2300, 0.8)).connect(runGain).connect(dest);
    this.run = new Glide(runGain.gain, GLIDE.swoosh, 5e-5);
  }

  /**
   * `aws` m/s. `boomAngle`/`boomRate`: main boom angle and its rate (rad/s). `jibClew`: jib clew angle (rad; the rate comes from
   * the difference between frames), 0 with `jibSet` false. `dt` seconds since the last call.
   */
  update(now: number, dt: number, aws: number, boomAngle: number, boomRate: number, jibClew: number, jibSet: boolean): void {
    // Ratchets ring louder under more load — which also lifts them out of the wind noise that would otherwise mask them.
    this.load = 1 + 1.6 * Math.min(1, aws / 12);
    // + = a sheet coming in (the sail moving toward the centreline), − = running out.
    const side = boomAngle > 0.02 ? 1 : boomAngle < -0.02 ? -1 : 0;
    const mainIn = -side * boomRate;
    const jibAbs = Math.abs(jibClew);
    const jibIn = jibSet && dt > 1e-4 && this.prevJibAbs === this.prevJibAbs ? -(jibAbs - this.prevJibAbs) / dt : 0;
    this.prevJibAbs = jibSet ? jibAbs : Number.NaN;

    const k = 1 - Math.exp(-dt / 0.06);
    this.mainSmooth += (mainIn - this.mainSmooth) * clamp01(k);
    this.jibSmooth += (jibIn - this.jibSmooth) * clamp01(k);
    this.main.advance(now, this.mainSmooth);
    this.jib.advance(now, this.jibSmooth);

    const out = Math.max(-this.mainSmooth, -this.jibSmooth);
    this.run.to(out > RATE_ON && out < RATE_SWING ? 0.03 * smoothstep(RATE_ON, 0.4, out) : 0, now);
  }

  private click(t: number, shape: ClickShape, jitter: number): void {
    const v = this.voices[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.voices.length;
    const hz = shape.hz[0] * (shape.hz[1] / shape.hz[0]) ** this.rng.next();
    v.band.frequency.setValueAtTime(hz, t);
    const a = shape.gain * jitter * this.load;
    pulse(v.gain.gain, t, a, 0.0003, 0.0016);
    pulse(v.bodyGain.gain, t, a * shape.body, 0.0006, 0.005);
  }
}
