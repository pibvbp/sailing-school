// Sail section force coefficients versus angle of attack (spec §7.3).
//
// A soft sail has three regimes:
//   luffing  — below α_luff (≈5° for main/jib) a soft sail cannot hold its shape: the luff backs and the
//              cloth flogs, lift fades to 0 by α ≈ 0 and drag → cdFlog;
//   attached — Cl = CLα·(α − α0(camber)), Cd = cd0 + kpp·Cl²;
//   stalled  — beyond α_stall the flow separates; the force becomes a normal force Cn(α) ⟂ chord,
//              Cl = Cn·cos α, Cd = Cn·sin α + cd0 (the shape the ORC tables show at wide angles).
// All blends are smoothsteps so every coefficient is continuous in α — important for stable dynamics.
import { interpTable, smoothstep, DEG } from '../shared/math';

export interface SailAeroParams {
  /** Attached-flow lift slope per radian (finite span). */
  clSlope: number;
  /** Zero-lift angle per unit camber (rad): α0 = −alpha0PerCamber · camber. */
  alpha0PerCamber: number;
  /** Luffing threshold for a mid-draft sail (rad). */
  alphaLuff0: number;
  /** How much a forward draft lowers α_luff (rad per unit of (0.5 − draft), scaled by camber/0.1). */
  draftLuffGain: number;
  /** Width of the luffing transition (rad). */
  luffWidth: number;
  stallBase: number;
  stallCamberGain: number;
  /** Width of the attached → separated blend (rad). */
  stallWidth: number;
  cd0: number;
  kpp: number;
  cdFlog: number;
  /** Separated-flow normal force: cnMax up to cnPeakAlpha, then decaying smoothly toward cn90. */
  cnMax: number;
  cnPeakAlpha: number;
  cn90: number;
  /** Decay width (rad) of the normal force beyond its peak. */
  cnDecay: number;
}

// Calibrated against the ORC VPP 2023 sail tables (see orc-envelope.test.ts).
export const MAIN_AERO: SailAeroParams = {
  clSlope: 3.4, alpha0PerCamber: 1.15, alphaLuff0: 0.085, draftLuffGain: 0.25, luffWidth: 0.07,
  stallBase: 0.21, stallCamberGain: 0.8, stallWidth: 6 * DEG,
  cd0: 0.022, kpp: 0.0138, cdFlog: 0.1, cnMax: 1.34, cnPeakAlpha: 0.6, cn90: 1.34, cnDecay: 0.6,
};

export const JIB_AERO: SailAeroParams = {
  clSlope: 3.4, alpha0PerCamber: 1.15, alphaLuff0: 0.085, draftLuffGain: 0.25, luffWidth: 0.07,
  stallBase: 0.2, stallCamberGain: 0.8, stallWidth: 6 * DEG,
  cd0: 0.025, kpp: 0.016, cdFlog: 0.1, cnMax: 0.95, cnPeakAlpha: 0.6, cn90: 0.9, cnDecay: 0.6,
};

export const SPIN_AERO: SailAeroParams = {
  clSlope: 2.0, alpha0PerCamber: 1.15, alphaLuff0: 0.12, draftLuffGain: 0.05, luffWidth: 0.11,
  stallBase: 0.02, stallCamberGain: 0.7, stallWidth: 0.2,
  // Normal force peaks near 26° and decays toward a parachute's 0.64 — the values the ORC tables imply.
  cd0: 0.06, kpp: 0.026, cdFlog: 0.15, cnMax: 1.05, cnPeakAlpha: 0.45, cn90: 0.64, cnDecay: 0.45,
};

export interface Coeffs {
  cl: number;
  cd: number;
  /** 0 full … 1 flogging. */
  luffing: number;
  /** 0 attached … 1 fully separated. */
  stall: number;
}

export function alphaLuff(p: SailAeroParams, camber: number, draft: number): number {
  return p.alphaLuff0 - p.draftLuffGain * (0.5 - draft) * (camber / 0.1);
}

export function alphaStall(p: SailAeroParams, camber: number, draft: number): number {
  return p.stallBase + p.stallCamberGain * camber + 0.1 * (0.5 - draft);
}

function normalForce(p: SailAeroParams, alpha: number): number {
  const a = alpha <= Math.PI / 2 ? alpha : Math.PI - alpha;
  if (a <= p.cnPeakAlpha) return p.cnMax;
  const x = (a - p.cnPeakAlpha) / p.cnDecay;
  return p.cn90 + (p.cnMax - p.cn90) * Math.exp(-Math.pow(x, 1.5));
}

/** Section coefficients for an angle of attack α ∈ [0, π] measured between chord and flow. */
export function sailCoefficients(p: SailAeroParams, alpha: number, camber: number, draft: number): Coeffs {
  const aLuff = alphaLuff(p, camber, draft);
  const aStall = alphaStall(p, camber, draft);
  const full = smoothstep(aLuff - p.luffWidth, aLuff, alpha);       // 0 flogging … 1 powered
  const sep = smoothstep(aStall, aStall + p.stallWidth, alpha);      // 0 attached … 1 separated

  const clAtt = p.clSlope * (alpha + p.alpha0PerCamber * camber);
  const cdAtt = p.cd0 + p.kpp * clAtt * clAtt;
  const cn = normalForce(p, alpha);
  const clSep = cn * Math.cos(alpha);
  const cdSep = cn * Math.sin(alpha) + p.cd0;

  const cl = full * ((1 - sep) * clAtt + sep * clSep);
  const cd = full * ((1 - sep) * cdAtt + sep * cdSep) + (1 - full) * p.cdFlog;
  return { cl, cd, luffing: 1 - full, stall: sep };
}

// ORC VPP 2023 Fig. 5.14: effective-span factor against apparent wind angle.
const KHEFF: ReadonlyArray<readonly [number, number]> = [
  [0, 1.0], [10, 1.33], [20, 1.45], [30, 1.25], [40, 1.05], [50, 0.93], [60, 0.87], [70, 0.82], [80, 0.8], [180, 0.8],
];

export function kheff(awaAbs: number): number {
  return interpTable(KHEFF, awaAbs / DEG);
}

/** Induced drag coefficient of a sail set: Cl²·A / (π·h_eff²). */
export function inducedDragCoeff(cl: number, area: number, hEff: number): number {
  return (cl * cl * area) / (Math.PI * hEff * hEff);
}
