import { describe, it, expect } from 'vitest';
import { Rng, fillNoise, fillControl, makeNoiseBuffer, makeControlBuffer, CONTROL_RATE } from '../noise';
import { FakeContext } from './fakeContext';
import { bandPower, rms } from './analysis';

const SR = 48000;

function noise(color: 'white' | 'pink' | 'brown', seconds = 4, seed = 7): Float32Array {
  const x = new Float32Array(SR * seconds);
  fillNoise(x, color, new Rng(seed));
  return x;
}

describe('Rng', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = new Rng(42), b = new Rng(42), c = new Rng(43);
    const sa = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(sa);
  });

  it('is uniform in [0, 1) with the right mean', () => {
    const r = new Rng(1);
    let sum = 0, min = 1, max = 0;
    for (let i = 0; i < 100000; i++) { const x = r.next(); sum += x; min = Math.min(min, x); max = Math.max(max, x); }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
    expect(sum / 100000).toBeCloseTo(0.5, 2);
  });

  it('gauss() has zero mean and unit variance', () => {
    const r = new Rng(2);
    let s = 0, s2 = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) { const g = r.gauss(); s += g; s2 += g * g; }
    expect(s / n).toBeCloseTo(0, 1);
    expect(s2 / n).toBeCloseTo(1, 1);
  });
});

describe('noise buffers', () => {
  it('are unit RMS in every colour', () => {
    for (const color of ['white', 'pink', 'brown'] as const) expect(rms(noise(color, 2))).toBeCloseTo(1, 3);
  });

  it('have the spectral slope of their colour', () => {
    const octave = (x: Float32Array, lo: number) => bandPower(x, SR, lo, 2 * lo);
    const db = (a: number, b: number) => 10 * Math.log10(a / b);
    const white = noise('white', 6), pink = noise('pink', 6), brown = noise('brown', 6);
    // Power per octave: white rises 3 dB/oct (bandwidth doubles), pink is flat, brown falls 3 dB/oct.
    const lo = 200, hi = 3200; // four octaves apart
    expect(db(octave(white, hi), octave(white, lo))).toBeGreaterThan(10);
    expect(Math.abs(db(octave(pink, hi), octave(pink, lo)))).toBeLessThan(3);
    expect(db(octave(brown, hi), octave(brown, lo))).toBeLessThan(-8);
  });

  it('loop without a tick: the seam is no bigger than any other step', () => {
    for (const color of ['white', 'pink', 'brown'] as const) {
      const x = noise(color, 4, 11);
      let sum = 0;
      for (let i = 1; i < x.length; i++) sum += (x[i]! - x[i - 1]!) ** 2;
      const typical = Math.sqrt(sum / (x.length - 1));
      const seam = Math.abs(x[0]! - x[x.length - 1]!);
      expect(seam).toBeLessThan(5 * typical);
    }
  });

  it('are independent between channels and between seeds', () => {
    const ctx = new FakeContext().asContext();
    const a = makeNoiseBuffer(ctx, 'pink', 1, 2, new Rng(3));
    const l = a.getChannelData(0), r = a.getChannelData(1);
    let dot = 0;
    for (let i = 0; i < l.length; i++) dot += l[i]! * r[i]!;
    expect(Math.abs(dot / l.length)).toBeLessThan(0.05);
  });
});

describe('control noise', () => {
  it('is unit RMS, slow and loops seamlessly', () => {
    const ctx = new FakeContext().asContext();
    const buf = makeControlBuffer(ctx, new Rng(5), 24);
    expect(buf.sampleRate).toBe(CONTROL_RATE);
    const x = buf.getChannelData(0);
    expect(rms(x)).toBeCloseTo(1, 3);
    // Almost all the energy is below ~3 Hz.
    const low = bandPower(x, CONTROL_RATE, 0.05, 3, 0, x.length, 16384);
    const high = bandPower(x, CONTROL_RATE, 3, 100, 0, x.length, 16384);
    expect(low / (low + high)).toBeGreaterThan(0.9);
    let sum = 0;
    for (let i = 1; i < x.length; i++) sum += (x[i]! - x[i - 1]!) ** 2;
    expect(Math.abs(x[0]! - x[x.length - 1]!)).toBeLessThan(5 * Math.sqrt(sum / x.length));
  });

  it('a higher cut-off gives faster wandering', () => {
    const slow = new Float32Array(CONTROL_RATE * 8), fast = new Float32Array(CONTROL_RATE * 8);
    fillControl(slow, new Rng(9), 1);
    fillControl(fast, new Rng(9), 30);
    const crossings = (x: Float32Array) => { let n = 0; for (let i = 1; i < x.length; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) n++; return n; };
    expect(crossings(fast)).toBeGreaterThan(5 * crossings(slow));
  });
});
