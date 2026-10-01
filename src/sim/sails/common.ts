// Strip-theory evaluation shared by all sails (spec §7.3).
// Each sail is cut into horizontal sections; every section sees its own apparent wind (height, heel,
// yaw/roll rates), has its own angle of attack and produces lift ⟂ flow toward its belly and drag ∥ flow.
import type { SailSection, Telltale } from '../types';
import { airVelocityBody, type Kinematics } from '../apparent';
import { alphaLuff, alphaStall, sailCoefficients, type SailAeroParams } from '../aero';
import { RHO_AIR } from '../constants';
import { clamp, rotX, smoothstep, DEG, type Vec3 } from '../../shared/math';

export { RHO_AIR };

/** The cloth-motion term in the section airflow is capped at this fraction of the airflow (see evaluateSection). */
const CLOTH_MOTION_CAP = 0.5;

/** Angles of attack live in [0, π]: an interaction shift must not push them past either end. */
const clampAlpha = (a: number): number => (a < 0 ? 0 : a > Math.PI ? Math.PI : a);

/** Side the rig is set on: +1 wind from starboard (boom and jib clew out to port), −1 wind from port. */
export type Side = 1 | -1;

/** Head to wind the rig changes side once the wind is more than 3° across the bow… */
export const SIDE_BAND_UPWIND = 3 * DEG;
/** …and dead downwind only once the wind is clearly (|AWA| < 165°) on the new side. */
export const SIDE_BAND_DOWNWIND = 165 * DEG;

/**
 * Which side the rig sets on, with hysteresis at both ends of the wind circle. Head to wind there is a ±3° dead
 * band. Dead downwind the wind wobbling across the stern must not move the sails: the new side needs |AWA| < 165°
 * (the simulation also moves the rig across when the boom gybes or the crew gybes it).
 */
export function sideFromAwa(prev: Side, awa: number): Side {
  const s: Side = awa >= 0 ? 1 : -1;
  if (s === prev) return prev;
  const a = Math.abs(awa);
  if (a <= Math.PI / 2) return a > SIDE_BAND_UPWIND ? s : prev;
  return a < SIDE_BAND_DOWNWIND ? s : prev;
}

/**
 * First-order rope handling: a sheet (or car) moves toward its target, hauled in (value rising) no faster than
 * `haul` and eased (value falling) no faster than `ease` (units per second).
 */
export function approachRate(x: number, target: number, haul: number, ease: number, dt: number): number {
  const d = target - x;
  return d >= 0 ? x + Math.min(d, haul * dt) : x + Math.max(d, -ease * dt);
}

/** Sheets are hauled at about 0.35 of their full range per second and eased at about 1 per second (M3). */
export const SHEET_HAUL_RATE = 0.35;
export const SHEET_EASE_RATE = 1.0;

export interface AirContext {
  kin: Kinematics;
  /** True-wind air velocity (toward) at height h above the water, world (east, north). */
  windAt: (h: number) => { e: number; n: number };
}

export interface SectionGeom {
  /** Height fraction 0 (foot) … 1 (head). */
  h: number;
  luff: Vec3;
  /** Unit, horizontal (z = 0) chord direction luff → leech, body frame. */
  chordDir: Vec3;
  chord: number;
  /** Strip height (m); area = chord · height · areaScale. */
  height: number;
  camber: number;
  draft: number;
  areaScale?: number;
}

export interface SectionResult extends SailSection {
  force: Vec3;
  point: Vec3;
  area: number;
  /** Local flow direction (unit, rig plane) and the lift direction used. */
  flow: Vec3;
  liftDir: Vec3;
  /** Unsigned geometric angle between chord and flow before any interaction shift. */
  alphaGeom: number;
  /** Air speed in the rig plane (m/s). */
  speed: number;
}

export interface SectionOptions {
  /** Added to the geometric angle (upwash > 0, downwash < 0). */
  alphaShift?: number;
  /**
   * The belly side (`leewardY`, ±1) the interaction shifts refer to — the leeward side the sail is set to. With it
   * the shifts are applied to the angle signed relative to that side, so a section the flow reaches from its lee
   * side is pushed further into luffing instead of lifting to windward. Without it the shift is added to the
   * unsigned angle (the original behaviour).
   */
  shiftSide?: number;
  /**
   * Extra shift on the front `luffFraction` of the chord (the main's luff sits in the jib's slot flow, which is
   * about 1.3–1.4× stronger there than on average). That part of the chord works at the more negative angle and,
   * when it drops below the luffing angle, is backwinded: it carries no lift and flogs, while the rest works.
   */
  luffShift?: number;
  /** Fraction of the chord `luffShift` acts on (default 0.3). */
  luffFraction?: number;
  /** Extra shift used only for the *visual* luffing value (backwinding near the main's luff). */
  visualShift?: number;
  /** Dynamic-pressure multiplier (blanketing, collapse). */
  blanket?: number;
  /** Replace the angle of attack entirely (spinnaker uses a signed angle). */
  alphaOverride?: (alphaGeom: number, flow: Vec3, chordDir: Vec3) => number;
  /** Multiplier on lift (e.g. spinnaker efficiency). */
  liftScale?: number;
  /**
   * The sail's own swing rate (rad/s, + turning forward toward starboard) about a vertical axis through
   * `rotationAxis` (default: the section's luff). Moving cloth meets the air — this is the strong
   * aerodynamic damping that stops a boom or clew from oscillating.
   */
  rotationRate?: number;
  rotationAxis?: { x: number; y: number };
}

/** Flow at a body point: unit direction and speed in the rig plane. */
export function flowAt(point: Vec3, air: AirContext): { flow: Vec3; speed: number } {
  const hWorld = -rotX(point, air.kin.heel).z;
  const a = airVelocityBody(point, air.kin, air.windAt(hWorld));
  const speed = Math.hypot(a.x, a.y);
  return { flow: speed > 1e-6 ? { x: a.x / speed, y: a.y / speed, z: 0 } : { x: -1, y: 0, z: 0 }, speed };
}

export function evaluateSection(g: SectionGeom, p: SailAeroParams, air: AirContext, opt: SectionOptions = {}): SectionResult {
  const c = g.chordDir;
  const cp = { x: g.luff.x + c.x * 0.38 * g.chord, y: g.luff.y + c.y * 0.38 * g.chord, z: g.luff.z };
  const hWorld = -rotX(cp, air.kin.heel).z;
  const a = airVelocityBody(cp, air.kin, air.windAt(hWorld));
  if (opt.rotationRate) {
    const axis = opt.rotationAxis ?? g.luff;
    const w0 = opt.rotationRate;
    // Subtract the cloth's own velocity ω × r = (−ω·dy, ω·dx). The damping this gives is real, but it grows with
    // the square of the swing rate, and once the cloth moves about as fast as the air the strip model no longer
    // holds (and an explicit integrator goes unstable) — so the term is capped at half the section's airflow.
    let mx = w0 * (cp.y - axis.y);
    let my = -w0 * (cp.x - axis.x);
    const m = Math.hypot(mx, my);
    const cap = CLOTH_MOTION_CAP * Math.hypot(a.x, a.y);
    if (m > cap) { const k = cap / m; mx *= k; my *= k; }
    a.x += mx;
    a.y += my;
  }
  const speed = Math.hypot(a.x, a.y);
  const w = speed > 1e-6 ? { x: a.x / speed, y: a.y / speed, z: 0 } : { x: -1, y: 0, z: 0 };

  const cw = c.x * w.x + c.y * w.y;
  const cross = c.x * w.y - c.y * w.x;
  const alphaGeom = Math.atan2(Math.abs(cross), cw);

  // Belly (leeward) normal: the part of the flow perpendicular to the chord.
  let nx = w.x - cw * c.x;
  let ny = w.y - cw * c.y;
  const nl = Math.hypot(nx, ny);
  if (nl > 1e-9) { nx /= nl; ny /= nl; } else { nx = c.y; ny = -c.x; }
  const flowBelly = nx * c.y - ny * c.x >= 0 ? 1 : -1; // s: belly = s · (c.y, −c.x)

  const shift = opt.alphaShift ?? 0;
  let bellySide = flowBelly;
  let alpha: number;
  let luffAlpha: number | null = null;
  if (opt.alphaOverride) {
    alpha = clampAlpha(opt.alphaOverride(alphaGeom, w, c));
  } else if (opt.shiftSide !== undefined) {
    // Shifts are referred to the leeward side the sail is set to: sign the angle relative to that side first.
    const side = opt.shiftSide >= 0 ? 1 : -1;
    const signed = (flowBelly === side ? alphaGeom : -alphaGeom) + shift;
    bellySide = signed >= 0 ? side : -side;
    alpha = Math.min(Math.PI, Math.abs(signed));
    if (opt.luffShift) {
      const s = signed + opt.luffShift;
      luffAlpha = clampAlpha(bellySide === side ? s : -s);
    }
  } else {
    alpha = clampAlpha(alphaGeom + shift);
    if (opt.luffShift) luffAlpha = clampAlpha(alpha + opt.luffShift);
  }
  if (bellySide !== flowBelly) { nx = -nx; ny = -ny; }

  // Backwinding (spec §7.3): the front of the chord sits in the jib's slot flow and works at a lower angle; below
  // the luffing angle it is backed — no lift, flogging drag — while the rest of the section keeps working.
  const k0 = sailCoefficients(p, alpha, g.camber, g.draft);
  const f = luffAlpha === null ? 0 : clamp(opt.luffFraction ?? 0.3, 0, 1);
  const kl = f > 0 ? sailCoefficients(p, luffAlpha!, g.camber, g.draft) : k0;
  const k = {
    cl: (1 - f) * k0.cl + f * kl.cl,
    cd: (1 - f) * k0.cd + f * kl.cd,
    luffing: Math.max(k0.luffing, kl.luffing),
    stall: k0.stall,
  };
  const visual = opt.visualShift ? sailCoefficients(p, clampAlpha(alpha + opt.visualShift), g.camber, g.draft).luffing : k.luffing;

  // Lift ⟂ flow, toward the belly; beyond 90° the normal-force model has cl < 0, so flip to keep the
  // resulting force pushing the cloth along its normal.
  let lx = -w.y, ly = w.x;
  if (lx * nx + ly * ny < 0) { lx = -lx; ly = -ly; }
  if (cw < 0) { lx = -lx; ly = -ly; }

  const area = g.chord * g.height * (g.areaScale ?? 1);
  const q = 0.5 * RHO_AIR * speed * speed * (opt.blanket ?? 1);
  const cl = k.cl * (opt.liftScale ?? 1);
  const fl = q * area * cl;
  const fd = q * area * k.cd;
  const depth = 0.75 * g.camber * g.chord;

  return {
    h: g.h,
    luff: g.luff,
    chordDir: c,
    chord: g.chord,
    camber: g.camber,
    draft: g.draft,
    leewardY: bellySide,
    aoa: alpha,
    luffing: Math.max(k.luffing, visual),
    stall: k.stall,
    cl,
    cd: k.cd,
    q,
    force: { x: fl * lx + fd * w.x, y: fl * ly + fd * w.y, z: 0 },
    point: { x: cp.x + nx * depth, y: cp.y + ny * depth, z: cp.z },
    area,
    flow: w,
    liftDir: { x: lx, y: ly, z: 0 },
    alphaGeom,
    speed,
  };
}

export interface SailSum {
  force: Vec3;
  /** Moment about `about` (body frame). */
  moment: Vec3;
  /** Force-weighted centre of effort. */
  ce: Vec3;
  area: number;
  /** Σ q·A (for coefficient normalisation). */
  qa: number;
  /** q·A-weighted section lift coefficient. */
  cl: number;
}

export function sumSections(rs: readonly SectionResult[], about: Vec3): SailSum {
  let fx = 0, fy = 0, fz = 0, mx = 0, my = 0, mz = 0;
  let wsum = 0, cex = 0, cey = 0, cez = 0, area = 0, qa = 0, clq = 0;
  for (const r of rs) {
    const f = r.force;
    fx += f.x; fy += f.y; fz += f.z;
    const rx = r.point.x - about.x, ry = r.point.y - about.y, rz = r.point.z - about.z;
    mx += ry * f.z - rz * f.y;
    my += rz * f.x - rx * f.z;
    mz += rx * f.y - ry * f.x;
    const mag = Math.hypot(f.x, f.y, f.z) + 1e-9;
    wsum += mag; cex += r.point.x * mag; cey += r.point.y * mag; cez += r.point.z * mag;
    area += r.area;
    qa += r.q * r.area;
    clq += r.cl * r.q * r.area;
  }
  return {
    force: { x: fx, y: fy, z: fz },
    moment: { x: mx, y: my, z: mz },
    ce: { x: cex / wsum, y: cey / wsum, z: cez / wsum },
    area,
    qa,
    cl: qa > 1e-9 ? clq / qa : 0,
  };
}

/** Moment about a vertical body axis through (px, py): positive turns forward toward starboard. */
export function momentAboutZ(rs: readonly SectionResult[], px: number, py: number): number {
  let m = 0;
  for (const r of rs) m += (r.point.x - px) * r.force.y - (r.point.y - py) * r.force.x;
  return m;
}

/** Upwash on the jib from the main's circulation, downwash on the main from the jib's (spec §7.3). */
export function interactionShifts(clMain: number, clJib: number, aMain: number, aJib: number, sameSide: boolean): { jib: number; main: number; mainLuff: number } {
  if (!sameSide || aMain <= 0 || aJib <= 0) return { jib: 0, main: 0, mainLuff: 0 };
  const tot = aMain + aJib;
  const main = -0.1 * Math.max(0, clJib) * (aJib / tot);
  return { jib: 0.06 * Math.max(0, clMain) * (aMain / tot), main, mainLuff: 0.4 * main };
}

/**
 * Blanketing of a sail sitting in the main's wind shadow when the wind comes from astern.
 * `offsetAcross` is the sail centroid's offset from the main's centroid perpendicular to the flow and
 * `halfWidth` the main's projected half-width in that direction.
 */
export function blanketFactor(awaAbs: number, offsetAcross: number, halfWidth: number): number {
  const shadow = smoothstep(110 * DEG, 165 * DEG, awaAbs);
  const x = offsetAcross / Math.max(halfWidth, 0.3);
  return 1 - 0.75 * shadow * Math.exp(-x * x);
}

/** Point on a section's surface at chord fraction u, displaced toward the belly by the camber line. */
export function surfacePoint(s: SailSection, u: number): Vec3 {
  const c = s.chordDir;
  const p = s.draft;
  const shape = u < p ? (2 * p * u - u * u) / (p * p) : ((1 - 2 * p) + 2 * p * u - u * u) / ((1 - p) * (1 - p));
  const depth = s.camber * s.chord * shape * Math.sign(s.leewardY || 1);
  return {
    x: s.luff.x + c.x * u * s.chord + c.y * depth,
    y: s.luff.y + c.y * u * s.chord - c.x * depth,
    z: s.luff.z,
  };
}

/** Linear interpolation of section data at height fraction h (sections sorted bottom → top). */
export function sectionAt(sections: readonly SailSection[], h: number): SailSection {
  const n = sections.length;
  if (h <= sections[0]!.h) return sections[0]!;
  if (h >= sections[n - 1]!.h) return sections[n - 1]!;
  let i = 0;
  while (i < n - 2 && sections[i + 1]!.h < h) i++;
  const a = sections[i]!, b = sections[i + 1]!;
  const t = (h - a.h) / (b.h - a.h);
  const L = (x: number, y: number) => x + (y - x) * t;
  const cx = L(a.chordDir.x, b.chordDir.x), cy = L(a.chordDir.y, b.chordDir.y);
  const cl = Math.hypot(cx, cy) || 1;
  return {
    h,
    luff: { x: L(a.luff.x, b.luff.x), y: L(a.luff.y, b.luff.y), z: L(a.luff.z, b.luff.z) },
    chordDir: { x: cx / cl, y: cy / cl, z: 0 },
    chord: L(a.chord, b.chord),
    camber: L(a.camber, b.camber),
    draft: L(a.draft, b.draft),
    leewardY: L(a.leewardY, b.leewardY),
    aoa: L(a.aoa, b.aoa),
    luffing: L(a.luffing, b.luffing),
    stall: L(a.stall, b.stall),
    cl: L(a.cl, b.cl),
    cd: L(a.cd, b.cd),
    q: L(a.q, b.q),
  };
}

/**
 * Luff telltales (jib): a pair at chord fraction 0.12 on both faces. The windward one lifts as the sail
 * approaches luffing; the leeward one stalls when the leading edge separates (over-trimmed / steering low).
 */
export function luffTelltales(prefix: string, sections: readonly SailSection[], p: SailAeroParams, heights: readonly number[]): Telltale[] {
  const out: Telltale[] = [];
  for (const h of heights) {
    const s = sectionAt(sections, h);
    const aL = alphaLuff(p, s.camber, s.draft);
    const aS = alphaStall(p, s.camber, s.draft);
    const leSep = aL + 0.8 * (aS - aL);
    const pos = surfacePoint(s, 0.12);
    const lift = 1 - smoothstep(aL, aL + 2.5 * DEG, s.aoa);
    const stall = smoothstep(leSep, leSep + 3 * DEG, s.aoa);
    const windward: Telltale['state'] = s.luffing > 0.5 ? 'fluttering' : lift > 0.35 ? 'lifting' : 'streaming';
    const leeward: Telltale['state'] = s.luffing > 0.8 ? 'fluttering' : stall > 0.5 ? 'stalled' : 'streaming';
    // Belly toward port (s < 0 for an aft chord) means the port face is leeward.
    const portIsLeeward = s.leewardY < 0;
    const pct = Math.round(h * 100);
    out.push({ id: `${prefix}-port-${pct}`, pos, side: 'port', state: portIsLeeward ? leeward : windward, intensity: portIsLeeward ? stall : Math.max(lift, s.luffing) });
    out.push({ id: `${prefix}-stbd-${pct}`, pos, side: 'stbd', state: portIsLeeward ? windward : leeward, intensity: portIsLeeward ? Math.max(lift, s.luffing) : stall });
  }
  return out;
}

/** Leech telltales (main): stream while the trailing-edge flow is attached, hide behind the leech when stalled. */
export function leechTelltales(prefix: string, sections: readonly SailSection[], p: SailAeroParams, heights: readonly number[]): Telltale[] {
  return heights.map((h) => {
    const s = sectionAt(sections, h);
    // The yarn at the leech stops streaming when its section stalls. Centred on the stall angle itself: a sail
    // trimmed to the powerful end of the groove (the crew's upwind trim) still has its leech telltales flying,
    // and only the sections that are really over-trimmed show it.
    const aS = alphaStall(p, s.camber, s.draft);
    const stall = smoothstep(aS - 2 * DEG, aS + 2 * DEG, s.aoa);
    const state: Telltale['state'] = s.luffing > 0.6 ? 'fluttering' : stall > 0.5 ? 'stalled' : 'streaming';
    return { id: `${prefix}-leech-${Math.round(h * 100)}`, pos: surfacePoint(s, 1), side: 'leech', state, intensity: s.luffing > 0.6 ? s.luffing : stall };
  });
}
