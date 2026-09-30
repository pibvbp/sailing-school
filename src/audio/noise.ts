// Deterministic noise for the procedural soundscape (spec §10: no audio assets, everything synthesised).
//
// All noise is generated once at start-up into looping AudioBuffers. The colouring filters are run over the
// buffer once before the pass that is kept, so their state at the end equals their state at the start: the
// loop seam is then as smooth as any other pair of samples (a plainly filtered loop would tick once per loop).

/** mulberry32: tiny, fast and well distributed. The soundscape's only source of randomness (seedable for tests). */
export class Rng {
  private state: number;
  private spare = 0;
  private hasSpare = false;

  constructor(seed = 0x5eed) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /**
   * Cheap unit-variance noise: three uniforms summed (Irwin–Hall, bounded at ±3σ). Three times faster than gauss() and
   * indistinguishable by ear once filtered; used to fill the big buffers at start-up.
   */
  noise(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }

  /** Standard normal (Box–Muller; the second value of each pair is kept for the next call). */
  gauss(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = 2 * Math.PI * this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(v);
    this.hasSpare = true;
    return r * Math.cos(v);
  }
}

export type NoiseColor = 'white' | 'pink' | 'brown';

/** Sample rate of the slow "control noise" buffer (see makeControlBuffer). */
export const CONTROL_RATE = 8000;

function normaliseRms(x: Float64Array, out: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
  const k = sum > 0 ? 1 / Math.sqrt(sum / x.length) : 0;
  for (let i = 0; i < x.length; i++) out[i] = x[i]! * k;
}

/** One pass of Paul Kellet's refined pink filter (−3 dB/oct, ±0.05 dB from ~9 Hz up) over `w`, warm state kept. */
function pinkPass(w: Float64Array, out: Float64Array, s: Float64Array): void {
  let b0 = s[0]!, b1 = s[1]!, b2 = s[2]!, b3 = s[3]!, b4 = s[4]!, b5 = s[5]!, b6 = s[6]!;
  for (let i = 0; i < w.length; i++) {
    const x = w[i]!;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
    b6 = x * 0.115926;
  }
  s[0] = b0; s[1] = b1; s[2] = b2; s[3] = b3; s[4] = b4; s[5] = b5; s[6] = b6;
}

/** Leaky integrator (−6 dB/oct above ~15 Hz at 48 kHz) — "brown" noise without the runaway drift. */
function brownPass(w: Float64Array, out: Float64Array, s: Float64Array): void {
  let y = s[0]!;
  for (let i = 0; i < w.length; i++) {
    y = 0.998 * y + w[i]!;
    out[i] = y;
  }
  s[0] = y;
}

/** Fill `out` with unit-RMS noise of the given colour that loops seamlessly. */
export function fillNoise(out: Float32Array, color: NoiseColor, rng: Rng): void {
  const n = out.length;
  const white = new Float64Array(n);
  for (let i = 0; i < n; i++) white[i] = rng.noise();
  if (color === 'white') {
    normaliseRms(white, out);
    return;
  }
  const coloured = new Float64Array(n);
  const state = new Float64Array(7);
  const pass = color === 'pink' ? pinkPass : brownPass;
  pass(white, coloured, state); // warm-up period: leaves the filter in the state the loop will re-enter with
  pass(white, coloured, state); // the period that is kept
  normaliseRms(coloured, out);
}

export function makeNoiseBuffer(ctx: BaseAudioContext, color: NoiseColor, seconds: number, channels: number, rng: Rng): AudioBuffer {
  const length = Math.max(1, Math.round(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(channels, length, ctx.sampleRate);
  for (let c = 0; c < channels; c++) fillNoise(buf.getChannelData(c), color, rng);
  return buf;
}

/**
 * Slow random modulation signal (unit RMS, energy below ~1 Hz, loops seamlessly) stored at CONTROL_RATE.
 * Played through an AudioBufferSourceNode whose playbackRate scales its speed (0.25 → gusts every few seconds,
 * 8 → a 5–10 Hz flutter), it is a truly irregular LFO that costs one source node instead of JS work per frame.
 */
export function fillControl(out: Float32Array, rng: Rng, cutoffHz = 1): void {
  const n = out.length;
  const a = Math.exp((-2 * Math.PI * cutoffHz) / CONTROL_RATE);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = rng.noise();
  const y = new Float64Array(n);
  let y1 = 0, y2 = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      y1 = a * y1 + (1 - a) * w[i]!;
      y2 = a * y2 + (1 - a) * y1;
      y[i] = y2;
    }
  }
  normaliseRms(y, out);
}

export function makeControlBuffer(ctx: BaseAudioContext, rng: Rng, seconds = 24, cutoffHz = 1): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.round(seconds * CONTROL_RATE), CONTROL_RATE);
  fillControl(buf.getChannelData(0), rng, cutoffHz);
  return buf;
}
