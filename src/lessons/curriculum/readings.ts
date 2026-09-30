// What a sailor reads off the boat, from a SimSnapshot: speeds and angles in knots and degrees, the sails'
// angle of attack, luffing and stall (the trim panel's groove meter), telltales, the spinnaker, and polars.
import { wrapPi } from '../../shared/math';
import { fromDeg, toDeg, toKn } from '../../shared/units';
import type { SailState, SimEventType, SimSnapshot, Telltale } from '../../sim/types';
import { optimalVmg, targetSpeed, type PolarPoint, type PolarTable } from '../../sim/polarTable';
import polarData from '../../sim/data/polars.json';

// ---- boat and wind -----------------------------------------------------------------------------

/** Speed through the water (kn), whichever way the boat is moving — going astern counts too. */
export const speedKn = (s: SimSnapshot): number => toKn(s.boat.speed);
/** Speed along the boat's heading (kn): negative while she makes sternway. Use it for "sailing again" checks. */
export const forwardKn = (s: SimSnapshot): number => toKn(s.boat.u);
/** Signed true wind angle (deg): + = wind from starboard (starboard tack). */
export const twaDeg = (s: SimSnapshot): number => toDeg(s.wind.twa);
export const absTwa = (s: SimSnapshot): number => Math.abs(twaDeg(s));
export const awaDeg = (s: SimSnapshot): number => toDeg(s.wind.awa);
export const absAwa = (s: SimSnapshot): number => Math.abs(awaDeg(s));
export const twsKn = (s: SimSnapshot): number => toKn(s.wind.tws);
export const awsKn = (s: SimSnapshot): number => toKn(s.wind.aws);
/** Heel (deg, unsigned). */
export const heelDeg = (s: SimSnapshot): number => Math.abs(toDeg(s.boat.heel));
/** Rudder angle (deg, unsigned): the helm the boat needs. */
export const helmDeg = (s: SimSnapshot): number => Math.abs(toDeg(s.boat.rudder));
export const vmgKn = (s: SimSnapshot): number => toKn(s.boat.vmg);
/** Compass heading 0…360 (deg, not rounded). */
export const headingDeg = (s: SimSnapshot): number => ((toDeg(s.boat.heading) % 360) + 360) % 360;
/** +1 on starboard tack (wind from starboard), −1 on port tack. */
export const tackOf = (s: SimSnapshot): 1 | -1 => (s.wind.twa >= 0 ? 1 : -1);
/** Signed smallest difference a − b in degrees, in (−180, 180]. */
export const angleDiff = (a: number, b: number): number => toDeg(wrapPi(fromDeg(a - b)));
export const fmt = (x: number, digits = 1): string => (Number.isFinite(x) ? x.toFixed(digits) : '–');

export const hasEvent = (s: SimSnapshot, type: SimEventType): boolean => s.events.some((e) => e.type === type);

/** Arrow key that turns the bow toward the wind (heading up) on the current tack, and away from it. */
export const upKey = (s: SimSnapshot): '→' | '←' => (s.wind.twa >= 0 ? '→' : '←');
export const downKey = (s: SimSnapshot): '→' | '←' => (s.wind.twa >= 0 ? '←' : '→');

/** The wind comes over the same side as the boom: one step from an accidental gybe. */
export function byTheLee(s: SimSnapshot): boolean {
  const boom = Math.sign(s.sails.main.boomAngle);
  return boom !== 0 && boom !== tackOf(s);
}

// ---- sails -------------------------------------------------------------------------------------

export interface TrimReading {
  /** Mean angle of attack over all sections (deg) — the trim panel's "AoA" read-out. */
  aoa: number;
  /** Mean luffing and stall intensities 0…1 — what the trim panel's groove meter shows. */
  luffing: number;
  stall: number;
}

export function trimOf(sail: SailState): TrimReading {
  const n = sail.sections.length;
  if (n === 0) return { aoa: 0, luffing: 0, stall: 0 };
  let aoa = 0, luffing = 0, stall = 0;
  for (const sec of sail.sections) { aoa += sec.aoa; luffing += sec.luffing; stall += sec.stall; }
  return { aoa: toDeg(aoa / n), luffing: luffing / n, stall: stall / n };
}

/**
 * Luffing near the mainsail's luff — the middle half of its sections, as the sim's `backwinded` detector
 * measures it — plus whether the leech is still drawing (a backwinded main, not a flogging one).
 */
export function mainLuffBubble(s: SimSnapshot): { bubble: number; leechFull: boolean } {
  const secs = s.sails.main.sections;
  const mid = secs.slice(Math.floor(secs.length / 4), Math.ceil((3 * secs.length) / 4));
  const bubble = mid.length ? mid.reduce((a, x) => a + x.luffing, 0) / mid.length : 0;
  const leechFull = mid.every((x) => x.stall < 0.9) && trimOf(s.sails.main).luffing < 0.6;
  return { bubble, leechFull };
}

export interface TelltaleCount { streaming: number; lifting: number; stalled: number; fluttering: number; total: number }

export function countTelltales(tts: readonly Telltale[]): TelltaleCount {
  const out: TelltaleCount = { streaming: 0, lifting: 0, stalled: 0, fluttering: 0, total: tts.length };
  for (const t of tts) out[t.state]++;
  return out;
}

/**
 * The jib's luff telltales. A telltale can only *lift* on the face the wind meets and only *stall* on the lee
 * face, so counting states is enough — no need to work out which side is windward.
 */
export const jibTelltales = (s: SimSnapshot): TelltaleCount => countTelltales(s.sails.jib.telltales);

/** The mainsail's highest and lowest leech telltales (top and bottom battens). */
export function topLeechTelltale(s: SimSnapshot): Telltale | null {
  let top: Telltale | null = null;
  for (const t of s.sails.main.telltales) if (!top || -t.pos.z > -top.pos.z) top = t;
  return top;
}

export function bottomLeechTelltale(s: SimSnapshot): Telltale | null {
  let low: Telltale | null = null;
  for (const t of s.sails.main.telltales) if (!low || -t.pos.z < -low.pos.z) low = t;
  return low;
}

/** How much a leech telltale streams, 0 (stalled behind the leech) … 1 (streaming); fluttering counts 0. */
export function leechStreaming(t: Telltale | null): number {
  if (!t || t.state === 'fluttering') return 0;
  return 1 - Math.min(1, Math.max(0, t.intensity));
}

// ---- spinnaker -------------------------------------------------------------------------------------

export interface KiteReading { hoist: number; up: boolean; collapsed: number; curl: number; poleDeg: number; full: boolean }

export function kiteOf(s: SimSnapshot): KiteReading {
  const k = s.sails.spinnaker;
  return {
    hoist: k.hoist,
    up: k.hoist >= 0.95,
    collapsed: k.collapsed,
    curl: k.curl,
    poleDeg: toDeg(k.poleAngle),
    full: k.hoist >= 0.95 && k.collapsed < 0.05,
  };
}

/** Pole angle minus the "square to the apparent wind" rule (pole = AWA − 90°), deg. */
export const poleError = (s: SimSnapshot): number => kiteOf(s).poleDeg - Math.max(0, absAwa(s) - 90);

// ---- polars ----------------------------------------------------------------------------------------

export const POLARS = polarData as PolarTable;
/** Best upwind angle, speed and VMG for a wind speed (kn, deg). */
export const bestBeat = (twsKnots: number): PolarPoint => optimalVmg(POLARS, twsKnots, true);
/** Best downwind angle, speed and VMG (VMG negative: away from the wind). */
export const bestRun = (twsKnots: number): PolarPoint => optimalVmg(POLARS, twsKnots, false);
export const polarSpeed = (twsKnots: number, twaAbsDeg: number): number => targetSpeed(POLARS, twsKnots, twaAbsDeg);
