import { describe, expect, it } from 'vitest';
import { butterflyTable, gaussianNoise } from '../fft';

/** Runs the GPU butterfly passes (BUTTERFLY_FRAG) on the CPU for one row of complex values. */
function butterflyIfft(re: Float64Array, im: Float64Array): [Float64Array, Float64Array] {
  const n = re.length;
  const stages = Math.round(Math.log2(n));
  const table = butterflyTable(n);
  let sr = Float64Array.from(re), si = Float64Array.from(im);
  for (let stage = 0; stage < stages; stage++) {
    const dr = new Float64Array(n), di = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const o = (stage + i * stages) * 4;
      const wr = table[o]!, wi = table[o + 1]!, a = table[o + 2]!, b = table[o + 3]!;
      dr[i] = sr[a]! + wr * sr[b]! - wi * si[b]!;
      di[i] = si[a]! + wr * si[b]! + wi * sr[b]!;
    }
    sr = dr; si = di;
  }
  return [sr, si];
}

function naiveIdft(re: Float64Array, im: Float64Array): [Float64Array, Float64Array] {
  const n = re.length;
  const or = new Float64Array(n), oi = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k * x) / n;
      or[x] += re[k]! * Math.cos(a) - im[k]! * Math.sin(a);
      oi[x] += re[k]! * Math.sin(a) + im[k]! * Math.cos(a);
    }
  }
  return [or, oi];
}

describe('GPU FFT butterfly table', () => {
  for (const n of [8, 16, 64, 256]) {
    it(`reproduces the inverse DFT for N = ${n}`, () => {
      const re = new Float64Array(n), im = new Float64Array(n);
      for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 1.7) + 0.3 * Math.cos(i * i); im[i] = Math.cos(i * 0.9) - 0.2 * i / n; }
      const [fr, fi] = butterflyIfft(re, im);
      const [dr, di] = naiveIdft(re, im);
      for (let i = 0; i < n; i++) {
        expect(fr[i]).toBeCloseTo(dr[i]!, 3);
        expect(fi[i]).toBeCloseTo(di[i]!, 3);
      }
    });
  }
});

describe('spectrum noise', () => {
  it('is reproducible and standard normal', () => {
    const a = gaussianNoise(4096, 7), b = gaussianNoise(4096, 7), c = gaussianNoise(4096, 8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    let sum = 0, sq = 0, count = 0;
    for (let i = 0; i < a.length; i += 4) for (const v of [a[i]!, a[i + 1]!]) { sum += v; sq += v * v; count++; }
    expect(Math.abs(sum / count)).toBeLessThan(0.05);
    expect(sq / count).toBeGreaterThan(0.93);
    expect(sq / count).toBeLessThan(1.07);
  });
});
