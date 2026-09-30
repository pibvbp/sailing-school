// Sea-state physics for the FFT ocean: wind → fetch-limited JONSWAP parameters, swell, spectral
// moments, and the visual wind responses (whitecaps, capillary roughness). Pure TypeScript (no three)
// so the mapping is unit-tested. The GPU spectrum pass (shaders/fft.glsl.ts) evaluates the same
// density as `spectrumDensity` below.
import { KN } from '../../../shared/math';
import type { OceanParams } from './types';

export const GRAVITY = 9.81;
/** Peak enhancement of a fetch-limited wind sea (Hasselmann et al. 1973). */
export const WIND_GAMMA = 3.3;
/** Swell is narrow-banded. */
export const SWELL_GAMMA = 6;

export interface JonswapParams {
  /** Phillips constant α of S(ω) = α g² ω⁻⁵ exp(−1.25 (ωp/ω)⁴) γ^r. */
  alpha: number;
  /** Peak angular frequency (rad/s). */
  peakOmega: number;
  gamma: number;
}

/**
 * Fetch-limited JONSWAP (Hasselmann 1973) for wind speed U10 (m/s) over `fetchM` metres of water.
 * Past the Pierson–Moskowitz saturation fetch (≈ 2.2·10⁴ U²/g) the sea is fully developed, so the
 * effective fetch is clamped there; the relations otherwise keep growing without bound.
 */
export function windSeaJonswap(windSpeed: number, fetchM: number): JonswapParams {
  const u = Math.max(windSpeed, 0.25);
  const fullyDeveloped = (2.2e4 * u * u) / GRAVITY;
  const fetch = Math.max(Math.min(fetchM, fullyDeveloped), 200);
  return {
    alpha: 0.076 * Math.pow((u * u) / (fetch * GRAVITY), 0.22),
    peakOmega: 22 * Math.pow((GRAVITY * GRAVITY) / (u * fetch), 1 / 3),
    gamma: WIND_GAMMA,
  };
}

/** Swell specified directly by Hs and Tp (DNV-RP-C205 α for a JONSWAP of peak enhancement γ). */
export function swellJonswap(hs: number, tp: number, gamma = SWELL_GAMMA): JonswapParams {
  const t = Math.max(tp, 2);
  const h = Math.max(hs, 0);
  return {
    alpha: (5.061 * h * h * (1 - 0.287 * Math.log(gamma))) / (t * t * t * t),
    peakOmega: (2 * Math.PI) / t,
    gamma,
  };
}

/** One-dimensional JONSWAP density S(ω) (m²·s). */
export function jonswapDensity(omega: number, p: JonswapParams): number {
  if (omega <= 1e-6 || p.alpha <= 0) return 0;
  const sigma = omega <= p.peakOmega ? 0.07 : 0.09;
  const d = omega - p.peakOmega;
  const r = Math.exp(-(d * d) / (2 * sigma * sigma * p.peakOmega * p.peakOmega));
  const inv = 1 / omega;
  return p.alpha * GRAVITY * GRAVITY * inv ** 5 * Math.exp(-1.25 * (p.peakOmega * inv) ** 4) * Math.pow(p.gamma, r);
}

/** Zeroth spectral moment m0 = ∫S(ω)dω (the surface elevation variance, m²), log-spaced quadrature. */
export function spectralM0(p: JonswapParams): number {
  const steps = 512;
  const w0 = 0.02, w1 = 80;
  const lr = Math.log(w1 / w0);
  let m0 = 0;
  for (let i = 0; i < steps; i++) {
    const w = w0 * Math.exp((lr * (i + 0.5)) / steps);
    m0 += jonswapDensity(w, p) * ((w * lr) / steps);
  }
  return m0;
}

export const significantHeight = (p: JonswapParams): number => 4 * Math.sqrt(Math.max(spectralM0(p), 0));

export interface SeaState {
  wind: JonswapParams;
  swell: JonswapParams;
  /** Significant height of the wind sea alone (m). */
  windHs: number;
  /** Wind-sea peak period (s) and deep-water peak wavelength (m). */
  windTp: number;
  windWavelength: number;
  swellHs: number;
  /** Combined significant height (m). */
  totalHs: number;
}

export function seaState(p: OceanParams): SeaState {
  const wind = windSeaJonswap(p.windSpeed, p.fetchKm * 1000);
  const swell = swellJonswap(p.swellHeight, p.swellPeriod);
  const m0w = spectralM0(wind);
  const m0s = p.swellHeight > 1e-3 ? spectralM0(swell) : 0;
  const windTp = (2 * Math.PI) / wind.peakOmega;
  return {
    wind,
    swell,
    windHs: 4 * Math.sqrt(m0w),
    windTp,
    windWavelength: (GRAVITY * windTp * windTp) / (2 * Math.PI),
    swellHs: 4 * Math.sqrt(m0s),
    totalHs: 4 * Math.sqrt(m0w + m0s),
  };
}

/**
 * How much the sea is breaking, 0…1. Whitecaps are a wind-forcing phenomenon (Monahan: coverage ∝
 * U^3.4) more than a steepness one — a young fetch-limited sea is about equally steep at 10 and 25 kn —
 * so the foam injection is keyed to wind: nothing below ≈ 10.5 kn, the first scattered caps at 12–14 kn,
 * plenty by 20 kn, saturating at 25 kn.
 */
export function whitecapActivity(windSpeed: number): number {
  const t = (windSpeed - 10.5 * KN) / (14.5 * KN);
  if (t <= 0) return 0;
  return t >= 1 ? 1 : t * (0.55 + 0.45 * t);
}

/**
 * Total mean-square slope of the capillary/short-gravity roughness (Cox & Munk 1954, clean surface),
 * with the ripples dying away in near calm so light air reads as glassy.
 */
export function coxMunkMss(windSpeed: number): number {
  const u = Math.max(windSpeed, 0);
  const onset = Math.min(1, Math.max(0, (u - 0.6) / 2.4));
  return 0.002 + 0.00512 * u * onset * onset * (3 - 2 * onset);
}

/**
 * Elevation and slope variance of the part of a spectrum between wavenumbers kLow and kHigh (rad/m),
 * integrated over all directions: m0 = ∫S(ω)dω, slope variance = ∫k²S(ω)dω with k = ω²/g. The
 * capillary fade exp(−(fade·k)²) is applied as on the GPU. Used to express each cascade's foam
 * thresholds in units of its own RMS elevation and slope, so breaking is keyed to wind, not to band.
 */
export function bandMoments(p: JonswapParams, kLow: number, kHigh: number, fade = 0): { m0: number; slopeVar: number } {
  const w0 = deepOmega(Math.max(kLow, 1e-5));
  const w1 = deepOmega(Math.min(kHigh, 1e4));
  if (w1 <= w0 || p.alpha <= 0) return { m0: 0, slopeVar: 0 };
  const steps = 256;
  const lr = Math.log(w1 / w0);
  let m0 = 0, slopeVar = 0;
  for (let i = 0; i < steps; i++) {
    const w = w0 * Math.exp((lr * (i + 0.5)) / steps);
    const k = (w * w) / GRAVITY;
    const s = jonswapDensity(w, p) * Math.exp(-((fade * k) ** 2)) * ((w * lr) / steps);
    m0 += s;
    slopeVar += k * k * s;
  }
  return { m0, slopeVar };
}

/**
 * Damping length (m) of the short-wave tail, exp(−(fade·k)²). The ω⁻⁵ tail only holds where the wind
 * actually forces the short waves; in light air ripples shorter than a few decimetres are missing,
 * which is what makes a 4-knot sea look glassy.
 */
export function capillaryFade(windSpeed: number): number {
  const u = Math.max(windSpeed, 0.5);
  return Math.min(0.006 * Math.pow(6 / u, 1.6), 0.12);
}

/** Compass bearing → angle atan2(z, x) of that horizontal direction in the three.js world. */
export const compassToWorldAngle = (bearing: number): number => Math.atan2(-Math.cos(bearing), Math.sin(bearing));

/** Sensible sea for a sheltered sailing area: fetch 15 km, gentle 0.3 m / 9 s swell 30° off the wind. */
export function defaultOceanParams(windKn: number, windFrom = 0): OceanParams {
  return {
    windSpeed: windKn * KN,
    windFrom,
    fetchKm: 15,
    swellHeight: 0.3,
    swellFrom: windFrom + (30 * Math.PI) / 180,
    swellPeriod: 9,
    choppiness: 1.1,
  };
}

// ---------------------------------------------------------------- 2-D wavenumber spectrum
// Mirrors SPECTRUM_FRAG in shaders/fft.glsl.ts (kept in TS for the normalisation tests).

export const deepOmega = (k: number): number => Math.sqrt(GRAVITY * k);

/** Normalisation of the cos^2s(θ/2) spreading (polynomial fit, identical to the GLSL). */
export function cos2sNorm(s: number): number {
  const s2 = s * s, s3 = s2 * s, s4 = s3 * s;
  if (s < 5) return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163;
  return -4.8e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 5.9e-2 * s + 3.93e-1;
}

/** Donelan–Hamilton–Hui spreading exponent; `swell` (0…1) narrows the spread for distant swell. */
export function spreadPower(omega: number, peakOmega: number, swell: number): number {
  const r = Math.max(omega / peakOmega, 1e-5);
  const s = r > 1 ? 9.77 * Math.pow(r, -2.5) : 6.97 * Math.pow(r, 5);
  return s + 16 * Math.tanh(Math.min(r, 20)) * swell * swell;
}

export interface DirectionalSpectrum {
  params: JonswapParams;
  /** World angle (atan2(z, x)) the energy is centred on; waves travel the opposite way (see fft.glsl.ts). */
  angle: number;
  /** 0 wind sea … 1 swell (narrow spread). */
  swell: number;
  /** Damping length (m) of the capillary tail: exp(−(fade·k)²). */
  shortWaveFade: number;
}

/** Variance density per unit wavenumber area, S(kx, kz) (m⁴), deep water. */
export function spectrumDensity(kx: number, kz: number, d: DirectionalSpectrum): number {
  const k = Math.hypot(kx, kz);
  if (k < 1e-6 || d.params.alpha <= 0) return 0;
  const omega = deepOmega(k);
  const dOmegaDk = GRAVITY / (2 * omega);
  const s = spreadPower(omega, d.params.peakOmega, d.swell);
  const theta = Math.atan2(kz, kx) - d.angle;
  const spread = cos2sNorm(s) * Math.pow(Math.max(Math.abs(Math.cos(0.5 * theta)), 1e-5), 2 * s);
  const fade = Math.exp(-((d.shortWaveFade * k) ** 2));
  return (jonswapDensity(omega, d.params) * spread * fade * dOmegaDk) / k;
}
