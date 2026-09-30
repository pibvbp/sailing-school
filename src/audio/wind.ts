// Wind: a low roar and a brighter hiss (both filtered noise whose level grows ~AWS² and whose brightness grows
// with AWS), gusty turbulence from slowly wandering levels, a subtle rigging whistle above ~15 kn, all panned
// toward the direction the apparent wind comes from (relative to where the camera looks).
import { GLIDE, panFor, relativeBearing, whistleDrive, whistleFreqA, whistleFreqB, windHissCutoff, windHissLevel, windRoarCutoff, windRoarLevel } from './mapping';
import { Glide, NoiseBank, Wander, bandpass, butterworth, gainNode } from './nodes';
import type { Rng } from './noise';

/** Diffuse source: never hard-panned. */
const PAN_WIDTH = 0.55;

interface Tone {
  freq: Glide;
  level: Glide;
  pitchWander: Wander;
  levelWander: Wander;
}

export class WindLayer {
  /** Stereo position of the wind as of the last update, −1 (left) … +1 (right). */
  panNow = 0;
  private readonly roar: Glide;
  private readonly roarCut: Glide;
  private readonly hiss: Glide;
  private readonly hissCut: Glide;
  private readonly whistle: Glide;
  private readonly whistleA: Glide;
  private readonly whistleB: Glide;
  private readonly tones: [Tone, Tone];
  private readonly wanders: Wander[];
  private readonly pan: Glide;

  constructor(ctx: BaseAudioContext, bank: NoiseBank, dest: AudioNode, rng: Rng) {
    const sum = gainNode(ctx, 1);
    const panner = ctx.createStereoPanner();
    sum.connect(panner).connect(dest);

    // Roar: brown noise (mono — low frequencies do not localise), high-passed just above the inaudible rumble and
    // low-passed by the wind speed; slow gusts.
    const roarLp = butterworth(ctx, 'lowpass', 300);
    const roarGain = gainNode(ctx, 0);
    const roarGust = gainNode(ctx, 1);
    bank.loop(bank.brownMono).connect(butterworth(ctx, 'highpass', 55)).connect(roarLp).connect(roarGain).connect(roarGust).connect(sum);
    this.roar = new Glide(roarGain.gain, GLIDE.wind, 5e-5);
    this.roarCut = new Glide(roarLp.frequency, GLIDE.windTone, 0.5);

    // Hiss: pink noise (decorrelated left and right) through a wide band that opens and rises with the wind;
    // faster, shallower turbulence.
    const hissBp = bandpass(ctx, 900, 0.55);
    const hissGain = gainNode(ctx, 0);
    const hissGust = gainNode(ctx, 1);
    bank.loop(bank.pinkStereo).connect(hissBp).connect(hissGain).connect(hissGust).connect(sum);
    this.hiss = new Glide(hissGain.gain, GLIDE.wind, 5e-5);
    this.hissCut = new Glide(hissBp.frequency, GLIDE.windTone, 1);

    // Whistle: noise squeezed through two narrow, high-Q bands (breathy wires) plus two faint, wandering sine tones
    // (the singing itself); the level wanders like a gust.
    const whistleGain = gainNode(ctx, 0);
    const whistleGust = gainNode(ctx, 1);
    const bpA = bandpass(ctx, 900, 22);
    const bpB = bandpass(ctx, 1400, 26);
    bank.loop(bank.white).connect(whistleGain);
    whistleGain.connect(bpA).connect(whistleGust);
    whistleGain.connect(bpB).connect(whistleGust);
    whistleGust.connect(sum);
    this.whistle = new Glide(whistleGain.gain, GLIDE.wind, 5e-5);
    this.whistleA = new Glide(bpA.frequency, GLIDE.windTone, 1);
    this.whistleB = new Glide(bpB.frequency, GLIDE.windTone, 1);
    this.tones = [this.tone(ctx, sum, rng), this.tone(ctx, sum, rng)];

    this.wanders = [
      new Wander(roarGust.gain, 0.28, 0.35, rng),
      new Wander(hissGust.gain, 0.35, 1.1, rng),
      new Wander(whistleGust.gain, 0.6, 0.5, rng),
    ];
    this.pan = new Glide(panner.pan, GLIDE.pan, 0.002);
  }

  /** `aws` m/s, `awa` rad (+ wind from starboard), `heading` and `cameraYaw` compass rad, `dt` seconds. */
  update(now: number, dt: number, aws: number, awa: number, heading: number, cameraYaw: number): void {
    this.roar.to(windRoarLevel(aws), now);
    this.roarCut.to(windRoarCutoff(aws), now);
    this.hiss.to(windHissLevel(aws), now);
    this.hissCut.to(windHissCutoff(aws), now);
    for (let i = 0; i < this.wanders.length; i++) this.wanders[i]!.update(now, dt);

    const whistle = whistleDrive(aws);
    const fa = whistleFreqA(aws);
    const fb = whistleFreqB(aws);
    this.whistle.to(0.6 * whistle, now);
    this.whistleA.to(fa, now);
    this.whistleB.to(fb, now);
    const a = this.tones[0];
    const b = this.tones[1];
    a.freq.to(fa, now);
    b.freq.to(fb, now);
    a.level.to(0.05 * whistle, now);
    b.level.to(0.03 * whistle, now);
    if (whistle > 0) {
      a.pitchWander.update(now, dt);
      a.levelWander.update(now, dt);
      b.pitchWander.update(now, dt);
      b.levelWander.update(now, dt);
    }

    this.panNow = panFor(relativeBearing(heading, awa, cameraYaw), PAN_WIDTH);
    this.pan.to(this.panNow, now);
  }

  /** A sine whose pitch wanders a few tens of cents and whose level drifts, into `dest`. */
  private tone(ctx: BaseAudioContext, dest: AudioNode, rng: Rng): Tone {
    const osc = ctx.createOscillator();
    osc.frequency.value = 900;
    const gain = gainNode(ctx, 0);
    const drift = gainNode(ctx, 1);
    osc.connect(gain).connect(drift).connect(dest);
    osc.start();
    return {
      freq: new Glide(osc.frequency, GLIDE.windTone, 1),
      level: new Glide(gain.gain, GLIDE.wind, 5e-5),
      pitchWander: new Wander(osc.detune, 35, 0.7, rng, 0, -1200), // cents
      levelWander: new Wander(drift.gain, 0.55, 0.45, rng),
    };
  }
}
