// The ocean's wave cascades: sea state → spectrum, per-frame FFT, and per-cascade assembly of
// displacement, derivatives and accumulated foam. Materials bind `uniforms` by reference.
// Structure adapted from ABYSSAL `src/ocean/OceanFFT.js` (OceanFFT manager, foam scales per cascade).
// Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school (TypeScript,
// three r186, sheltered-water sea states, wind-keyed whitecaps, quality tiers).
import * as THREE from 'three';
import { interpTable, KN } from '../../../shared/math';
import type { QualitySettings } from '../../core/types';
import { PackedFFT, type SpectrumUniforms } from './fft';
import { FullScreenPass, makeRT } from './gpuPass';
import { ASSEMBLE_FRAG } from './shaders/fft.glsl';
import { bandMoments, capillaryFade, compassToWorldAngle, seaState, whitecapActivity, type JonswapParams, type SeaState } from './spectrum';
import type { OceanParams } from './types';

/** Per-cascade slope statistics the surface shader needs to split slope into normals and roughness. */
export interface CascadeStats { mss: THREE.Vector3; lambdaMin: THREE.Vector3; octaves: THREE.Vector3; resolvedMss: number }

/** Tile sizes (m), spec §9.3 ≈ 250 / 37 / 7 — non-harmonic so the tiles never line up. */
const LENGTHS: Record<2 | 3, readonly number[]> = { 3: [251.3, 37.13, 7.07], 2: [251.3, 37.13] };
/** Horizontal chop per cascade: the long band carries the amplitude and is reined in most. */
const CHOP_SCALE = [0.85, 1.0, 1.0];
/** Air entrainment per cascade: the energetic band breaks, the capillary band only glistens. */
const FOAM_SCALE = [1.0, 0.8, 0.15];
const SWELL_FADE = 3.0;
const ANISOTROPY = 8;
/** Breaking threshold (slope, in RMS units of the cascade band) against wind (kn). */
const BREAKING_THRESHOLD: ReadonlyArray<readonly [number, number]> = [
  [10.5, 2.75], [12, 2.5], [14, 2.22], [16, 1.99], [20, 1.64], [25, 1.38], [30, 1.2],
];

export type CascadeUniforms = Record<string, THREE.IUniform>;

interface CascadeTargets { a: THREE.WebGLRenderTarget; b: THREE.WebGLRenderTarget }

export class OceanCascades {
  /** Shared uniform objects: uOceanDisp0‥2, uOceanDeriv0‥2, uOceanTurb0‥2, uOceanScales, uOceanTexels, uCascadeGain. */
  readonly uniforms: CascadeUniforms;
  seaState: SeaState;
  /** Slope statistics per cascade band for the current sea state (valid after the first update). */
  readonly stats: CascadeStats = {
    mss: new THREE.Vector3(), lambdaMin: new THREE.Vector3(1, 1, 1), octaves: new THREE.Vector3(1, 1, 1), resolvedMss: 0,
  };
  /** Bumped whenever `seaState`/`stats` change so dependants can re-sync. */
  version = 0;
  private params: OceanParams;
  private fft!: PackedFFT;
  private targets: CascadeTargets[] = [];
  private lengths: readonly number[] = [];
  private cuts: number[] = [];
  private readonly assemble: FullScreenPass;
  private readonly spectrum: SpectrumUniforms = {
    windA: new THREE.Vector4(), windB: new THREE.Vector4(), swellA: new THREE.Vector4(), swellB: new THREE.Vector4(),
  };
  private readonly upwind = new THREE.Vector2(0, -1);
  private invSigma: number[] = [1, 1, 1];
  private invSlopeSigma: number[] = [1, 1, 1];
  private foam = { mul: 0, steepBias: 3, foldBias: 0.35, decay: 0.35 };
  private dirty = true;
  private frame = 0;
  private lastTime = Number.NaN;
  private n: 128 | 256 = 256;
  private count: 2 | 3 = 3;

  constructor(private readonly renderer: THREE.WebGLRenderer, q: QualitySettings, params: OceanParams) {
    this.params = { ...params };
    this.seaState = seaState(params);
    const tex = (): THREE.IUniform => ({ value: null });
    this.uniforms = {
      uOceanDisp0: tex(), uOceanDisp1: tex(), uOceanDisp2: tex(),
      uOceanDeriv0: tex(), uOceanDeriv1: tex(), uOceanDeriv2: tex(),
      uOceanTurb0: tex(), uOceanTurb1: tex(), uOceanTurb2: tex(),
      uOceanScales: { value: new THREE.Vector3(1, 1, 1) },
      uOceanTexels: { value: 256 },
      uCascadeGain: { value: new THREE.Vector3(1, 1, 1) },
    };
    this.assemble = new FullScreenPass(ASSEMBLE_FRAG, {
      uBuf0: { value: null }, uBuf1: { value: null }, uPrevTurb: { value: null }, uOffset: { value: 0 },
      uLambda: { value: 1 }, uFoamBias: { value: 0.4 }, uSteepBias: { value: 3 },
      uInvSigma: { value: 1 }, uInvSlopeSigma: { value: 1 }, uUpwind: { value: this.upwind },
      uFoamMul: { value: 0 }, uFoamDecay: { value: 0.35 }, uBubbleDecay: { value: 0.6 }, uDt: { value: 0 },
    }, 'oceanAssemble');
    this.build(q);
    this.setParams(params);
  }

  get oceanParams(): Readonly<OceanParams> { return this.params; }

  setQuality(q: QualitySettings): void {
    if (q.oceanFFTSize === this.n && q.oceanCascades === this.count) return;
    this.disposeTargets();
    this.build(q);
  }

  setParams(p: OceanParams): void {
    const o = this.params;
    // Rebuild only for changes that matter; callers may push the same state every frame.
    const changed = this.dirty
      || Math.abs(p.windSpeed - o.windSpeed) > 0.02 * Math.max(o.windSpeed, 1)
      || Math.abs(p.windFrom - o.windFrom) > 0.005 || Math.abs(p.swellFrom - o.swellFrom) > 0.005
      || Math.abs(p.fetchKm - o.fetchKm) > 0.01 * o.fetchKm || Math.abs(p.swellHeight - o.swellHeight) > 0.005
      || Math.abs(p.swellPeriod - o.swellPeriod) > 0.05 || Math.abs(p.choppiness - o.choppiness) > 1e-3;
    if (!changed) return;
    this.params = { ...p };
    this.seaState = seaState(p);
    this.dirty = true;
  }

  /** Advance the sea to time `t` (s); `dt` integrates foam. Skipped while time stands still (pause). */
  update(t: number, dt: number): void {
    if (this.dirty) this.rebuildSpectrum();
    else if (t === this.lastTime) return;
    this.lastTime = t;
    const fields = this.fft.transform(this.renderer, t);
    this.frame++;
    const ap = this.assemble;
    ap.set('uBuf0', fields.textures[0]).set('uBuf1', fields.textures[1]).set('uDt', Math.min(dt, 0.1));
    for (let c = 0; c < this.count; c++) {
      const pair = this.targets[c]!;
      const cur = this.frame & 1 ? pair.a : pair.b;
      const prev = cur === pair.a ? pair.b : pair.a;
      const scale = FOAM_SCALE[c] ?? 1;
      ap.set('uOffset', c * this.n)
        .set('uPrevTurb', prev.textures[2])
        .set('uLambda', this.params.choppiness * (CHOP_SCALE[c] ?? 1))
        .set('uFoamBias', this.foam.foldBias)
        .set('uSteepBias', this.foam.steepBias)
        .set('uInvSigma', this.invSigma[c] ?? 1)
        .set('uInvSlopeSigma', this.invSlopeSigma[c] ?? 1)
        .set('uFoamMul', this.foam.mul * scale)
        .set('uFoamDecay', this.foam.decay / Math.max(scale, 0.2));
      ap.render(this.renderer, cur);
      this.bindCascade(c, cur);
    }
  }

  dispose(): void {
    this.disposeTargets();
    this.assemble.dispose();
  }

  private build(q: QualitySettings): void {
    this.n = q.oceanFFTSize;
    this.count = q.oceanCascades;
    this.lengths = LENGTHS[this.count];
    // Hand a band to the next cascade while its shortest wave still spans ≥ ~6 texels: cascade c keeps
    // wavelengths down to L(c+1)/4.
    this.cuts = [1e-4, ...this.lengths.slice(1).map((l) => ((2 * Math.PI) / l) * 4), 1e9];
    const cutLow = this.lengths.map((_, i) => this.cuts[i]!);
    const cutHigh = this.lengths.map((_, i) => this.cuts[i + 1]!);
    this.fft = new PackedFFT(this.n, this.lengths, cutLow, cutHigh);
    // Only the slope textures need anisotropic filtering (it keeps ripples alive at grazing angles);
    // displacement is read with explicit LOD and foam coverage is soft anyway.
    const aniso = Math.min(ANISOTROPY, this.renderer.capabilities.getMaxAnisotropy());
    // The finest band turns into roughness within tens of metres anyway: 2× is plenty there.
    const target = (name: string, c: number) => {
      const rt = makeRT(this.n, this.n, { filter: 'mipmap', wrap: THREE.RepeatWrapping, count: 3, name });
      rt.textures[1]!.anisotropy = c < 2 ? aniso : Math.min(2, aniso);
      return rt;
    };
    this.targets = this.lengths.map((_, i) => ({ a: target(`oceanCascade${i}a`, i), b: target(`oceanCascade${i}b`, i) }));
    const u = this.uniforms;
    (u['uOceanScales']!.value as THREE.Vector3).set(this.lengths[0]!, this.lengths[1]!, this.lengths[2] ?? 1e6);
    u['uOceanTexels']!.value = this.n;
    (u['uCascadeGain']!.value as THREE.Vector3).set(1, 1, this.count === 3 ? 1 : 0);
    // Unused slots must still hold a valid sampler.
    for (let c = 0; c < 3; c++) this.bindCascade(c, this.targets[Math.min(c, this.count - 1)]!.a);
    this.dirty = true;
    this.lastTime = Number.NaN;
  }

  private bindCascade(c: number, rt: THREE.WebGLRenderTarget): void {
    const u = this.uniforms;
    u[`uOceanDisp${c}`]!.value = rt.textures[0];
    u[`uOceanDeriv${c}`]!.value = rt.textures[1];
    u[`uOceanTurb${c}`]!.value = rt.textures[2];
  }

  private rebuildSpectrum(): void {
    this.dirty = false;
    const p = this.params;
    const s = this.seaState;
    const swellOn = p.swellHeight > 1e-3 ? 1 : 0;
    const windFade = capillaryFade(p.windSpeed);
    this.spectrum.windA.set(1, compassToWorldAngle(p.windFrom), 0, windFade);
    this.spectrum.windB.set(s.wind.alpha, s.wind.peakOmega, s.wind.gamma, 0);
    this.spectrum.swellA.set(swellOn, compassToWorldAngle(p.swellFrom), 1, SWELL_FADE);
    this.spectrum.swellB.set(swellOn ? s.swell.alpha : 0, s.swell.peakOmega, s.swell.gamma, 0);
    this.fft.updateSpectrum(this.renderer, this.spectrum);

    // Per-cascade RMS elevation / slope (breaking thresholds become band-independent) and the slope
    // statistics the surface shader splits into resolved normals and GGX roughness.
    const peakLambda = s.windWavelength;
    this.stats.resolvedMss = 0;
    this.stats.mss.set(0, 0, 0);
    this.stats.lambdaMin.set(1, 1, 1);
    this.stats.octaves.set(1, 1, 1);
    for (let c = 0; c < this.count; c++) {
      const nyquist = (Math.PI * this.n) / this.lengths[c]!;
      const lo = this.cuts[c]!, hi = Math.min(this.cuts[c + 1]!, nyquist);
      const band = (sp: JonswapParams, fade: number, on: number) => (on ? bandMoments(sp, lo, hi, fade) : { m0: 0, slopeVar: 0 });
      const w = band(s.wind, windFade, 1), sw = band(s.swell, SWELL_FADE, swellOn);
      this.invSigma[c] = 1 / Math.max(Math.sqrt(w.m0 + sw.m0), 1e-4);
      this.invSlopeSigma[c] = 1 / Math.max(Math.sqrt(w.slopeVar + sw.slopeVar), 1e-4);
      const mss = w.slopeVar + sw.slopeVar;
      const lambdaMin = (2 * Math.PI) / hi;
      // Slope variance is spread ~evenly per octave of the ω⁻⁵ tail, from the peak down to the band edge.
      const lambdaMax = Math.max(Math.min((2 * Math.PI) / Math.max(lo, 1e-4), 2 * peakLambda), lambdaMin * 1.5);
      this.stats.mss.setComponent(c, mss);
      this.stats.lambdaMin.setComponent(c, lambdaMin);
      this.stats.octaves.setComponent(c, Math.log2(lambdaMax / lambdaMin));
      this.stats.resolvedMss += mss;
    }

    // Breaking = the steepest crests of each band: how far into the tail of the slope distribution a
    // crest must reach falls with wind (Beaufort: occasional caps at 12 kn, fairly frequent at 16 kn,
    // many at 20 kn). Residual foam is laid per unit of breaking.
    const activity = whitecapActivity(p.windSpeed);
    this.foam.mul = activity > 0 ? 2.6 : 0;
    this.foam.steepBias = interpTable(BREAKING_THRESHOLD, p.windSpeed / KN);
    this.foam.foldBias = 0.3 + 0.25 * activity;
    this.upwind.set(Math.sin(p.windFrom), -Math.cos(p.windFrom));
    this.lastTime = Number.NaN;
    this.version++;
  }

  private disposeTargets(): void {
    this.fft?.dispose();
    for (const t of this.targets) { t.a.dispose(); t.b.dispose(); }
    this.targets = [];
  }
}
