// GPU inverse FFT for all ocean cascades at once (packed side by side in one (C·N)×N buffer).
// Adapted from ABYSSAL `src/ocean/OceanFFT.js` (butterfly texture, Gaussian noise, pass structure).
// Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school (TypeScript,
// three r186, packed cascades: 2·log2(N) butterfly passes total instead of per cascade).
import * as THREE from 'three';
import { FullScreenPass, makeRT } from './gpuPass';
import { BUTTERFLY_FRAG, CONJUGATE_FRAG, SPECTRUM_FRAG, TIME_FRAG } from './shaders/fft.glsl';

/**
 * Butterfly table for a radix-2 decimation-in-time inverse FFT of size n: log2(n) stages × n entries of
 * (twiddle re, twiddle im, top input index, bottom input index); output = top + twiddle·bottom.
 * Stage 0 reads bit-reversed inputs. Stored stage-major per row: index (stage + i·stages)·4.
 */
export function butterflyTable(n: number): Float32Array {
  const stages = Math.round(Math.log2(n));
  const data = new Float32Array(stages * n * 4);
  const reverse = (i: number): number => {
    let r = 0;
    for (let b = 0; b < stages; b++) r |= ((i >> b) & 1) << (stages - 1 - b);
    return r;
  };
  for (let stage = 0; stage < stages; stage++) {
    const span = 1 << stage;
    for (let i = 0; i < n; i++) {
      const k = (i * (n >> (stage + 1))) % n;
      const top = i % (span << 1) < span;
      let a: number, b: number;
      if (stage === 0) {
        a = top ? reverse(i) : reverse(i - 1);
        b = top ? reverse(i + 1) : reverse(i);
      } else {
        a = top ? i : i - span;
        b = top ? i + span : i;
      }
      const o = (stage + i * stages) * 4;
      data[o] = Math.cos((2 * Math.PI * k) / n);
      data[o + 1] = Math.sin((2 * Math.PI * k) / n);
      data[o + 2] = a;
      data[o + 3] = b;
    }
  }
  return data;
}

/** Reproducible standard-normal pairs (xorshift32 + Box–Muller), 4 floats per texel (xy used). */
export function gaussianNoise(texels: number, seed: number): Float32Array {
  let s = seed >>> 0 || 1;
  const rnd = (): number => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 8) / 16777216;
  };
  const data = new Float32Array(texels * 4);
  for (let i = 0; i < data.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-7)));
    const a = 2 * Math.PI * rnd();
    data[i] = r * Math.cos(a);
    data[i + 1] = r * Math.sin(a);
  }
  return data;
}

function dataTexture(data: Float32Array, w: number, h: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The sea repeats every 20 minutes: wave frequencies are rounded to multiples of 2π/1200 s (at most
 * 0.4 % off for the 9 s swell, far less for wind waves), which keeps every wave's phase exact in fp32.
 */
export const LOOP_PERIOD_S = 1200;

/** Spectrum description handed to the GPU: a = (amplitude, angle, swell, fade), b = (α, ωp, γ, 0). */
export interface SpectrumUniforms { windA: THREE.Vector4; windB: THREE.Vector4; swellA: THREE.Vector4; swellB: THREE.Vector4 }

export class PackedFFT {
  readonly n: number;
  readonly count: number;
  private readonly h0: THREE.WebGLRenderTarget;
  private readonly h0k: THREE.WebGLRenderTarget;
  private readonly ping: THREE.WebGLRenderTarget;
  private readonly pong: THREE.WebGLRenderTarget;
  private readonly noise: THREE.DataTexture;
  private readonly butterfly: THREE.DataTexture;
  private readonly spectrumPass: FullScreenPass;
  private readonly conjPass: FullScreenPass;
  private readonly timePass: FullScreenPass;
  private readonly butterflyPass: FullScreenPass;
  private readonly stages: number;

  constructor(n: number, lengths: readonly number[], cutLow: readonly number[], cutHigh: readonly number[], seed = 0xc0ffee) {
    this.n = n;
    this.count = lengths.length;
    this.stages = Math.round(Math.log2(n));
    const width = n * this.count;
    // Half float halves the bandwidth of the 2·log2(N) butterfly passes; its rounding over 8 stages
    // stays around a millimetre on half-metre waves.
    const type = THREE.HalfFloatType;
    this.h0 = makeRT(width, n, { type, filter: 'nearest', name: 'oceanH0' });
    this.h0k = makeRT(width, n, { type, filter: 'nearest', name: 'oceanH0k' });
    this.ping = makeRT(width, n, { type, filter: 'nearest', count: 2, name: 'oceanFFTa' });
    this.pong = makeRT(width, n, { type, filter: 'nearest', count: 2, name: 'oceanFFTb' });
    this.noise = dataTexture(gaussianNoise(width * n, seed), width, n);
    this.butterfly = dataTexture(butterflyTable(n), this.stages, n);

    const vec3 = (v: readonly number[]): THREE.Vector3 => new THREE.Vector3(v[0] ?? 1, v[1] ?? 1, v[2] ?? 1);
    this.spectrumPass = new FullScreenPass(SPECTRUM_FRAG, {
      uNoise: { value: this.noise },
      uN: { value: n },
      uLength: { value: vec3(lengths) },
      uCutLow: { value: vec3(cutLow) },
      uCutHigh: { value: vec3(cutHigh) },
      uWindA: { value: new THREE.Vector4() }, uWindB: { value: new THREE.Vector4() },
      uSwellA: { value: new THREE.Vector4() }, uSwellB: { value: new THREE.Vector4() },
    }, 'oceanSpectrum');
    this.conjPass = new FullScreenPass(CONJUGATE_FRAG, { uH0: { value: this.h0.texture }, uN: { value: n } }, 'oceanConjugate');
    this.timePass = new FullScreenPass(TIME_FRAG, {
      uH0: { value: this.h0k.texture }, uN: { value: n }, uLength: { value: vec3(lengths) },
      uOmega0: { value: (2 * Math.PI) / LOOP_PERIOD_S }, uTimeFrac: { value: 0 },
    }, 'oceanTimeSpectrum');
    this.butterflyPass = new FullScreenPass(BUTTERFLY_FRAG, {
      uButterfly: { value: this.butterfly }, uSrc0: { value: null }, uSrc1: { value: null },
      uN: { value: n }, uStage: { value: 0 }, uVertical: { value: 0 },
    }, 'oceanButterfly');
  }

  updateSpectrum(renderer: THREE.WebGLRenderer, s: SpectrumUniforms): void {
    const u = this.spectrumPass.uniforms;
    (u['uWindA']!.value as THREE.Vector4).copy(s.windA);
    (u['uWindB']!.value as THREE.Vector4).copy(s.windB);
    (u['uSwellA']!.value as THREE.Vector4).copy(s.swellA);
    (u['uSwellB']!.value as THREE.Vector4).copy(s.swellB);
    this.spectrumPass.render(renderer, this.h0);
    this.conjPass.render(renderer, this.h0k);
  }

  /** Runs the time evolution and the 2-D inverse transform; returns the target holding the fields. */
  transform(renderer: THREE.WebGLRenderer, time: number): THREE.WebGLRenderTarget {
    const wrapped = ((time % LOOP_PERIOD_S) + LOOP_PERIOD_S) % LOOP_PERIOD_S;
    this.timePass.set('uTimeFrac', wrapped / LOOP_PERIOD_S).render(renderer, this.ping);
    let src = this.ping, dst = this.pong;
    const bp = this.butterflyPass;
    for (let vertical = 0; vertical < 2; vertical++) {
      bp.set('uVertical', vertical);
      for (let stage = 0; stage < this.stages; stage++) {
        bp.set('uStage', stage).set('uSrc0', src.textures[0]).set('uSrc1', src.textures[1]);
        bp.render(renderer, dst);
        const t = src; src = dst; dst = t;
      }
    }
    return src;
  }

  dispose(): void {
    [this.h0, this.h0k, this.ping, this.pong].forEach((t) => t.dispose());
    [this.noise, this.butterfly].forEach((t) => t.dispose());
    [this.spectrumPass, this.conjPass, this.timePass, this.butterflyPass].forEach((p) => p.dispose());
  }
}
