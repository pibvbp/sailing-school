// Water: the hiss of the hull moving through the sea (low-passed noise ∝ boat speed, with a bubbly texture) and a
// slower bow-wave "swoosh" that swells when the boat rolls or leans (roll rate and heel changes, gust hits).
import { GLIDE, clamp01, panFor, relativeBearing, swooshCentre, swooshDrive, swooshLevel, waterRushCutoff, waterRushLevel } from './mapping';
import { Glide, NoiseBank, Wander, bandpass, butterworth, gainNode } from './nodes';
import type { Rng } from './noise';

const PAN_WIDTH = 0.35;
/** Roll activity follows a rise quickly and lets go slowly (s): the water keeps running a moment after a lurch. */
const ROLL_ATTACK = 0.12;
const ROLL_RELEASE = 0.7;

export class WaterLayer {
  private readonly rush: Glide;
  private readonly rushCut: Glide;
  private readonly swoosh: Glide;
  private readonly swooshCut: Glide;
  private readonly swell: Wander;
  private readonly pan: Glide;
  private rollActivity = 0;
  private lastHeel = Number.NaN;

  constructor(ctx: BaseAudioContext, bank: NoiseBank, dest: AudioNode, rng: Rng) {
    const sum = gainNode(ctx, 1);
    // Both sources are mono: up-mix them to a stereo pair before the panner, or it would treat them as a single
    // channel and take 3 dB off at the centre.
    sum.channelCount = 2;
    sum.channelCountMode = 'explicit';
    const panner = ctx.createStereoPanner();
    sum.connect(panner).connect(dest);

    // Rush along the hull: low-passed pink noise with a fast, deep burble.
    const rushLp = butterworth(ctx, 'lowpass', 400);
    const rushGain = gainNode(ctx, 0);
    bank.loop(bank.pinkMono).connect(rushLp).connect(rushGain).connect(bank.modulator(0.5, 6)).connect(sum);
    this.rush = new Glide(rushGain.gain, GLIDE.water, 5e-5);
    this.rushCut = new Glide(rushLp.frequency, GLIDE.water, 1);

    // Bow-wave swoosh: a band that opens and rises as it builds, wave-slow random swell on top.
    const swooshBp = bandpass(ctx, 600, 0.9);
    const swooshGain = gainNode(ctx, 0);
    const swooshSwell = gainNode(ctx, 1);
    bank.loop(bank.pinkMono).connect(swooshBp).connect(swooshGain).connect(swooshSwell).connect(sum);
    this.swell = new Wander(swooshSwell.gain, 0.45, 0.45, rng);
    this.swoosh = new Glide(swooshGain.gain, GLIDE.swoosh, 5e-5);
    this.swooshCut = new Glide(swooshBp.frequency, GLIDE.swoosh, 1);

    this.pan = new Glide(panner.pan, GLIDE.pan, 0.002);
  }

  /** `speed` m/s, `heel` rad (+ starboard down), `rollRate` rad/s, `heading`/`cameraYaw` compass rad, `dt` s. */
  update(now: number, dt: number, speed: number, heel: number, rollRate: number, heading: number, cameraYaw: number): void {
    // Roll activity from the reported roll rate or, if the heel jumps without one (a scenario reset, a fake snapshot),
    // from the heel change itself.
    let raw = Math.abs(rollRate);
    if (this.lastHeel === this.lastHeel && dt > 1e-4) raw = Math.max(raw, Math.min(1, Math.abs(heel - this.lastHeel) / dt));
    this.lastHeel = heel;
    const k = 1 - Math.exp(-dt / (raw > this.rollActivity ? ROLL_ATTACK : ROLL_RELEASE));
    this.rollActivity += (raw - this.rollActivity) * clamp01(k);

    this.swell.update(now, dt);
    this.rush.to(waterRushLevel(speed), now);
    this.rushCut.to(waterRushCutoff(speed), now);
    const drive = swooshDrive(this.rollActivity, heel, speed);
    this.swoosh.to(swooshLevel(drive), now);
    this.swooshCut.to(swooshCentre(drive), now);
    // The leeward hull side is the loud one: 90° off the bow toward the side that is down.
    const lee = heel >= 0 ? Math.PI / 2 : -Math.PI / 2;
    this.pan.to(panFor(relativeBearing(heading, lee, cameraYaw), PAN_WIDTH) * Math.min(1, Math.abs(heel) / 0.12), now);
  }
}
