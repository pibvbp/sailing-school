// Signal measurements for the audio tests: level, spectrum band power, snap (onset) detection and click detection.
// Plain functions over Float32Array in Node — no WebAudio.

export function decodeBase64(b64: string): Float32Array {
  const bytes = Buffer.from(b64, 'base64');
  const out = new Float32Array(bytes.length / 4);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

export function peak(x: Float32Array, from = 0, to = x.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
}

/** Amplitude (RMS, peak) ratio → dB. */
export const toDb = (linear: number): number => 20 * Math.log10(Math.max(linear, 1e-12));
/** Power (mean-square, e.g. from bandPower) ratio → dB. */
export const powerDb = (power: number): number => 10 * Math.log10(Math.max(power, 1e-30));

/** In-place radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Mean-square (power) of `x[from, to)` inside the band [lo, hi] Hz, by Welch averaging of Hann-windowed FFTs. */
export function bandPower(x: Float32Array, sr: number, lo: number, hi: number, from = 0, to = x.length, size = 4096): number {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const win = new Float64Array(size);
  let wsum = 0;
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    wsum += win[i]! * win[i]!;
  }
  const k0 = Math.max(1, Math.floor((lo * size) / sr));
  const k1 = Math.min(size / 2 - 1, Math.ceil((hi * size) / sr));
  let total = 0;
  let count = 0;
  for (let start = from; start + size <= to; start += size / 2) {
    for (let i = 0; i < size; i++) {
      re[i] = x[start + i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let p = 0;
    for (let k = k0; k <= k1; k++) p += re[k]! * re[k]! + im[k]! * im[k]!;
    total += (2 * p) / (size * wsum); // one-sided: ×2; Parseval scaling to mean-square
    count++;
  }
  return count ? total / count : 0;
}

/** RBJ biquad band-pass (constant 0 dB peak) applied forward; returns a new array. */
export function bandpassed(x: Float32Array, sr: number, f0: number, q: number): Float32Array {
  const w = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = b0 * xi + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** Highest short-window RMS (5 ms windows, 1 ms hop) of `x[from, to)` after band-passing around `centre` Hz. */
export function peakBandLevel(x: Float32Array, sr: number, centre: number, q: number, from: number, to: number): number {
  const band = bandpassed(x, sr, centre, q);
  const win = Math.floor(0.005 * sr);
  const hop = Math.floor(0.001 * sr);
  let best = 0;
  for (let a = from; a + win <= to; a += hop) best = Math.max(best, rms(band, a, a + win));
  return best;
}

export interface OnsetOptions {
  /** Detection band (Hz), default 1.5–7 kHz where snaps stand out from wind and water. */
  lo?: number;
  hi?: number;
  /** A snap is an energy rise of at least this factor over the noise floor. */
  ratio?: number;
  /** Minimum spacing (s) between reported snaps. */
  refractory?: number;
}

/**
 * Times (s) of sharp transients in `x`: short-time energy in a band jumping well above its noise floor. The floor
 * follows the quiet stretches (it falls quickly and rises slowly), so dense snapping does not raise the bar.
 */
export function detectOnsets(x: Float32Array, sr: number, opts: OnsetOptions = {}): number[] {
  const { lo = 1500, hi = 7000, ratio = 8, refractory = 0.03 } = opts;
  const centre = Math.sqrt(lo * hi);
  const band = bandpassed(x, sr, centre, centre / (hi - lo));
  const fast = 1 - Math.exp(-1 / (0.0015 * sr));
  const floorUp = 1 - Math.exp(-1 / (1.5 * sr));
  const floorDown = 1 - Math.exp(-1 / (0.04 * sr));
  // Start the floor at half the mean energy of the first 100 ms so the detector needs no warm-up.
  let mean0 = 0;
  const warm = Math.min(band.length, Math.floor(0.1 * sr));
  for (let i = 0; i < warm; i++) mean0 += band[i]! * band[i]! / Math.max(1, warm);
  let env = mean0;
  let floor = Math.max(0.5 * mean0, 1e-10);
  let last = -1;
  const out: number[] = [];
  let armed = true;
  for (let i = 0; i < band.length; i++) {
    const e = band[i]! * band[i]!;
    env += (e - env) * fast;
    floor += (env - floor) * (env > floor ? floorUp : floorDown);
    if (armed && env > ratio * floor && env > 1e-8) {
      const t = i / sr;
      if (t - last >= refractory) {
        out.push(t);
        last = t;
      }
      armed = false;
    } else if (env < 2 * floor) armed = true;
  }
  return out;
}

export interface Intervals { count: number; rate: number; median: number; cv: number }

export function intervalStats(onsets: readonly number[], seconds: number): Intervals {
  const gaps: number[] = [];
  for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i]! - onsets[i - 1]!);
  if (gaps.length < 2) return { count: onsets.length, rate: onsets.length / seconds, median: NaN, cv: NaN };
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  const sorted = [...gaps].sort((a, b) => a - b);
  return { count: onsets.length, rate: onsets.length / seconds, median: sorted[Math.floor(sorted.length / 2)]!, cv: sd / mean };
}

/**
 * Click detector: the largest first difference in [from, to) relative to the RMS first difference of the preceding
 * `win` samples (a floor keeps digital silence from dividing by zero). A step or spike stands out at ≫ 8; noise with
 * a smoothly changing level stays below ~6.
 */
export function clickScore(x: Float32Array, from = 1, to = x.length, win = 480, floor = 2e-5): { score: number; maxStep: number; at: number } {
  const ring = new Float64Array(win);
  let sum = 0;
  let filled = 0;
  let pos = 0;
  let score = 0;
  let maxStep = 0;
  let at = -1;
  for (let n = Math.max(1, from - win); n < to; n++) {
    const d = x[n]! - x[n - 1]!;
    if (n >= from && filled >= win / 2) {
      const sigma = Math.max(Math.sqrt(Math.max(sum, 0) / filled), floor);
      const s = Math.abs(d) / sigma;
      if (s > score) { score = s; at = n; }
      maxStep = Math.max(maxStep, Math.abs(d));
    }
    sum += d * d - ring[pos]!;
    ring[pos] = d * d;
    pos = (pos + 1) % win;
    filled = Math.min(win, filled + 1);
  }
  return { score, maxStep, at };
}
