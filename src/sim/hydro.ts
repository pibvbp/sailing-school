// Hull and appendage hydrodynamics (spec §7.5).
import { BOAT } from '../shared/boatSpec';
import { DEG, interpTable, smoothstep, type Vec3 } from '../shared/math';
import { bodyPoint } from '../shared/coords';

export const RHO_WATER = 1025;
export const NU_WATER = 1.19e-6;
export const G = 9.81;
const RHO_AIR = 1.225;

/** ORC VPP 2023 §6.1.1 friction line (form factor applied by the caller). */
export function frictionCf(V: number): number {
  const re = (Math.max(Math.abs(V), 0.05) * 0.85 * BOAT.hull.lwl) / NU_WATER;
  const l = Math.log10(re) - 2.03;
  return 0.066 / (l * l);
}

/** Residuary resistance per unit weight against Froude number (tuned by the polar tests). */
export const RR_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.1, 1e-4], [0.15, 4e-4], [0.2, 1.1e-3], [0.25, 2.4e-3], [0.3, 4.7e-3], [0.35, 9.2e-3],
  [0.4, 0.018], [0.45, 0.033], [0.5, 0.048], [0.55, 0.058], [0.6, 0.064], [0.7, 0.07], [1.0, 0.085],
];

export function hullResistance(V: number, heel: number): { rf: number; rr: number; rh: number; total: number } {
  const v = Math.abs(V);
  const rf = 0.5 * RHO_WATER * v * v * BOAT.hull.wettedArea * frictionCf(v) * 1.05;
  const fn = v / Math.sqrt(G * BOAT.hull.lwl);
  const rr = BOAT.mass.total * G * interpTable(RR_TABLE, fn);
  const s = Math.sin(heel);
  const rh = (rf + rr) * 0.8 * s * s;
  return { rf, rr, rh, total: rf + rr + rh };
}

export interface FoilSpec {
  /** Planform area including the canoe-body contribution (m²). */
  area: number;
  arEff: number;
  chord: number;
  tc: number;
  stallDeg: number;
  cn90: number;
  /** Centre of pressure, body frame. */
  point: Vec3;
}

export const KEEL: FoilSpec = {
  area: BOAT.keel.area * 1.25,
  arEff: BOAT.keel.arEff,
  chord: (BOAT.keel.rootChord + BOAT.keel.tipChord) / 2,
  tc: BOAT.keel.tc,
  stallDeg: BOAT.keel.stallDeg,
  cn90: 1.2,
  point: bodyPoint(BOAT.keel.cp.x, 0, BOAT.keel.cp.h),
};

export const RUDDER: FoilSpec = {
  area: BOAT.rudder.area,
  arEff: BOAT.rudder.arEff,
  chord: (BOAT.rudder.rootChord + BOAT.rudder.tipChord) / 2,
  tc: BOAT.rudder.tc,
  stallDeg: BOAT.rudder.stallDeg,
  cn90: 1.2,
  point: bodyPoint(BOAT.rudder.cp.x, 0, BOAT.rudder.cp.h),
};

function foilFriction(U: number, chord: number): number {
  const re = Math.max(U * chord / NU_WATER, 1e5);
  const l = Math.log10(re) - 2;
  return 0.075 / (l * l);
}

/**
 * Force on a symmetric foil (keel/rudder) from the water velocity relative to it (body frame).
 * Valid for all 360°: attached lift → stall → flat-plate normal force; reversed flow (sternway) stalls
 * earlier. `deflection` turns the chord (rudder angle, + turns the boat to starboard).
 */
export function foilForce(f: FoilSpec, waterRelB: Vec3, deflection: number): { force: Vec3; cl: number; alpha: number; stalled: boolean } {
  const U = Math.hypot(waterRelB.x, waterRelB.y);
  if (U < 1e-6) return { force: { x: 0, y: 0, z: 0 }, cl: 0, alpha: 0, stalled: false };
  const wx = waterRelB.x / U, wy = waterRelB.y / U;
  // Chord direction trailing edge → leading edge ("forward").
  const cx = Math.cos(deflection), cy = -Math.sin(deflection);
  const dot = wx * cx + wy * cy;             // < 0 for normal forward motion
  const reversed = dot > 0;
  const alpha = Math.atan2(Math.abs(wx * cy - wy * cx), Math.abs(dot)); // angle to the chord line, 0…90°

  // Lift acts along the flow's component perpendicular to the chord (the foil turns the water back
  // toward its own line, so it is pushed the other way — i.e. it resists the cross-flow).
  let nx = wx - dot * cx, ny = wy - dot * cy;
  const nl = Math.hypot(nx, ny);
  if (nl > 1e-9) { nx /= nl; ny /= nl; } else { nx = 0; ny = 0; }
  let lx = -wy, ly = wx;
  if (lx * nx + ly * ny < 0) { lx = -lx; ly = -ly; }

  const clAlpha = ((2 * Math.PI * f.arEff) / (f.arEff + 2)) * (reversed ? 0.8 : 1);
  const aStall = (reversed ? 8 : f.stallDeg) * DEG;
  const sep = smoothstep(aStall, aStall + 6 * DEG, alpha);
  const clAtt = clAlpha * alpha;
  const cn = f.cn90 * Math.sin(alpha);
  const cl = (1 - sep) * clAtt + sep * cn * Math.cos(alpha);
  const cdProfile = foilFriction(U, f.chord) * 2 * (1 + 2 * f.tc + 60 * f.tc ** 4) + 0.0016 * Math.abs(clAtt) + 0.0032 * clAtt * clAtt;
  const cdInduced = (clAtt * clAtt) / (Math.PI * f.arEff * 0.9);
  const cd = (1 - sep) * (cdProfile + cdInduced) + sep * (cn * Math.sin(alpha) + cdProfile);

  const q = 0.5 * RHO_WATER * U * U * f.area;
  return {
    force: { x: q * (cl * lx + cd * wx), y: q * (cl * ly + cd * wy), z: 0 },
    cl,
    alpha,
    stalled: sep > 0.5,
  };
}

const N_STATIONS = 10;
const STATION_X = Array.from({ length: N_STATIONS }, (_, i) =>
  BOAT.hull.transomWL.x + ((i + 0.5) / N_STATIONS) * (BOAT.hull.stemWL.x - BOAT.hull.transomWL.x));

/** Cross-flow drag of the canoe body along its length (slow sideways drift, pivoting). */
export function crossFlow(v: number, r: number): { Y: number; N: number } {
  const a = BOAT.hull.lateralArea / N_STATIONS;
  let Y = 0, N = 0;
  for (const x of STATION_X) {
    const vi = v + r * x;
    const fy = -0.5 * RHO_WATER * 1.0 * a * Math.abs(vi) * vi;
    Y += fy;
    N += x * fy;
  }
  return { Y, N };
}

/** Point where hull, mast, rigging and crew windage acts (body frame). */
export const WINDAGE_POINT: Vec3 = bodyPoint(0.3, 0, 2.5);
const CDA_FRONT = 3.2;
const CDA_SIDE = 6.5;

/** Windage force (body frame) from the air velocity relative to the boat (body frame). */
export function windage(airB: Vec3): Vec3 {
  const V = Math.hypot(airB.x, airB.y);
  if (V < 1e-6) return { x: 0, y: 0, z: 0 };
  const cosb = Math.abs(airB.x) / V, sinb = Math.abs(airB.y) / V;
  const d = 0.5 * RHO_AIR * V * (CDA_FRONT * cosb + CDA_SIDE * sinb);
  return { x: d * airB.x, y: d * airB.y, z: 0 };
}

/** Hydrostatic righting moment about the longitudinal axis (N·m); opposes heel. */
export function rightingMoment(heel: number): number {
  const gz = interpTable(BOAT.gz, Math.abs(heel) / DEG);
  return -Math.sign(heel) * BOAT.mass.total * G * gz;
}
