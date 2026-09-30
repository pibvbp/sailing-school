import { describe, expect, it } from 'vitest';
import { KN } from '../../../../shared/math';
import {
  bandMoments, capillaryFade, compassToWorldAngle, cos2sNorm, defaultOceanParams, seaState, significantHeight,
  spectralM0, spectrumDensity, swellJonswap, whitecapActivity, windSeaJonswap, type DirectionalSpectrum,
} from '../spectrum';

const hsAt = (kn: number, fetchKm = 15) => significantHeight(windSeaJonswap(kn * KN, fetchKm * 1000));
const tpAt = (kn: number, fetchKm = 15) => (2 * Math.PI) / windSeaJonswap(kn * KN, fetchKm * 1000).peakOmega;

describe('wind → sea state (sheltered sailing area, fetch 15 km)', () => {
  it('12 kn gives a significant wave height of 0.3–0.8 m with a short (2–4 s) period', () => {
    expect(hsAt(12)).toBeGreaterThan(0.3);
    expect(hsAt(12)).toBeLessThan(0.8);
    expect(tpAt(12)).toBeGreaterThan(2);
    expect(tpAt(12)).toBeLessThan(4);
  });

  it('light air is nearly flat and a fresh breeze is under about a metre', () => {
    expect(hsAt(4)).toBeLessThan(0.25);
    expect(hsAt(20)).toBeGreaterThan(0.55);
    expect(hsAt(20)).toBeLessThan(1.3);
  });

  it('grows monotonically with wind speed', () => {
    let prev = 0;
    for (let kn = 2; kn <= 30; kn += 2) {
      const hs = hsAt(kn);
      expect(hs).toBeGreaterThan(prev);
      prev = hs;
    }
  });

  it('grows with fetch until the sea is fully developed, then saturates', () => {
    expect(hsAt(12, 30)).toBeGreaterThan(hsAt(12, 5));
    expect(hsAt(12, 2000)).toBeCloseTo(hsAt(12, 4000), 6);
  });

  it('the default sea (wind sea + 0.3 m swell) stays in range at 12 kn', () => {
    const s = seaState(defaultOceanParams(12));
    expect(s.windHs).toBeGreaterThan(0.3);
    expect(s.totalHs).toBeLessThan(0.8);
    expect(s.swellHs).toBeCloseTo(0.3, 1);
    expect(s.totalHs).toBeCloseTo(Math.hypot(s.windHs, s.swellHs), 6);
  });
});

describe('swell and moments', () => {
  it('a swell specified by Hs integrates back to that Hs', () => {
    for (const [hs, tp] of [[0.3, 9], [1.2, 12], [0.5, 6]] as const) {
      expect(significantHeight(swellJonswap(hs, tp)) / hs).toBeCloseTo(1, 1);
    }
  });

  it('band moments over contiguous bands add up to the whole spectrum', () => {
    const p = windSeaJonswap(12 * KN, 15000);
    const cuts = [1e-4, 0.3, 0.7, 3, 1e4];
    let m0 = 0;
    for (let i = 0; i < cuts.length - 1; i++) m0 += bandMoments(p, cuts[i]!, cuts[i + 1]!).m0;
    expect(m0 / spectralM0(p)).toBeCloseTo(1, 2);
  });
});

describe('2-D wavenumber spectrum (mirrors the GPU spectrum pass)', () => {
  const wind: DirectionalSpectrum = { params: windSeaJonswap(12 * KN, 15000), angle: 0.7, swell: 0, shortWaveFade: 0 };

  it('the cos^2s spreading is normalised over a full circle', () => {
    for (const s of [0.5, 1, 3, 8, 20]) {
      let sum = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) {
        const th = -Math.PI + (2 * Math.PI * (i + 0.5)) / n;
        sum += cos2sNorm(s) * Math.pow(Math.abs(Math.cos(0.5 * th)), 2 * s) * ((2 * Math.PI) / n);
      }
      expect(sum).toBeCloseTo(1, 1);
    }
  });

  it('summing the density over a discrete wavenumber grid recovers the variance m0', () => {
    // Same discretisation as one FFT tile: k = (i − N/2)·2π/L, each mode weighted dk².
    const L = 400, N = 512, dk = (2 * Math.PI) / L;
    let variance = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        variance += spectrumDensity((i - N / 2) * dk, (j - N / 2) * dk, wind) * dk * dk;
      }
    }
    expect(variance / spectralM0(wind.params)).toBeGreaterThan(0.9);
    expect(variance / spectralM0(wind.params)).toBeLessThan(1.1);
  });

  it('energy is centred on the given direction (the wind-from side)', () => {
    const k = 0.5;
    const along = spectrumDensity(k * Math.cos(0.7), k * Math.sin(0.7), wind);
    const against = spectrumDensity(-k * Math.cos(0.7), -k * Math.sin(0.7), wind);
    expect(along).toBeGreaterThan(20 * against);
  });
});

describe('visual wind responses', () => {
  it('whitecaps start just above 10 kn and saturate by 25 kn', () => {
    expect(whitecapActivity(10 * KN)).toBe(0);
    expect(whitecapActivity(12 * KN)).toBeGreaterThan(0);
    expect(whitecapActivity(14 * KN)).toBeGreaterThan(whitecapActivity(12 * KN));
    expect(whitecapActivity(25 * KN)).toBeCloseTo(1, 5);
  });

  it('light air loses its capillary tail (glassy), wind restores it', () => {
    expect(capillaryFade(2 * KN)).toBeGreaterThan(capillaryFade(12 * KN) * 5);
    expect(capillaryFade(20 * KN)).toBeLessThan(capillaryFade(12 * KN));
  });

  it('compass bearings map onto the three.js world (north = −Z, east = +X)', () => {
    expect(compassToWorldAngle(0)).toBeCloseTo(-Math.PI / 2, 9);
    expect(compassToWorldAngle(Math.PI / 2)).toBeCloseTo(0, 9);
    expect(Math.abs(compassToWorldAngle(Math.PI))).toBeCloseTo(Math.PI / 2, 9);
  });
});
