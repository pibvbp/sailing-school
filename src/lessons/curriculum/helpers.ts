// Shared building blocks for the curriculum (spec §11): snapshot readings in knots/degrees, scenario
// presets, overlay sets, manoeuvre detectors, and the `step()` builder that wires "Show me" demos.
//
// A "Show me" is a one-shot call, but some demonstrations take several phases (get out of irons, tack three
// times, trim to the spinnaker's curl). `step()` therefore lets `showMe` return a Demo: a small driver the
// step's task check runs every frame (the check is the only per-frame hook a step has) until the task is done
// or the learner leaves the step.
import { wrapPi } from '../../shared/math';
import { fromDeg, fromKn, toDeg, toKn } from '../../shared/units';
import type { Controls, HelmMode, SailState, ScenarioInit, SimEventType, SimSnapshot, Telltale, WindSettings } from '../../sim/types';
import { optimalVmg, targetSpeed, type PolarPoint, type PolarTable } from '../../sim/polarTable';
import polarData from '../../sim/data/polars.json';
import { OVERLAY_KEYS, type LessonCtx, type OverlayKey, type Step, type StepTask } from '../types';

export { fromDeg, fromKn, toDeg, toKn };

// ---- snapshot readings (knots, degrees) ------------------------------------------------------

export const speedKn = (s: SimSnapshot): number => toKn(s.boat.speed);
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

/** The mainsail's highest leech telltale (top batten). */
export function topLeechTelltale(s: SimSnapshot): Telltale | null {
  let top: Telltale | null = null;
  for (const t of s.sails.main.telltales) if (!top || -t.pos.z > -top.pos.z) top = t;
  return top;
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
export const polarSpeed = (twsKnots: number, twaAbsDeg: number): number => targetSpeed(POLARS, twsKnots, twaAbsDeg);

// ---- scenarios ---------------------------------------------------------------------------------------

export interface WindOpts { gustiness?: number; shiftDeg?: number; shiftPeriod?: number; seed?: number }

export function wind(twsKnots: number, twdDeg: number, o: WindOpts = {}): WindSettings {
  return {
    tws: fromKn(twsKnots),
    twd: fromDeg(((twdDeg % 360) + 360) % 360),
    gustiness: o.gustiness ?? 0,
    shiftAmplitude: fromDeg(o.shiftDeg ?? 0),
    shiftPeriod: o.shiftPeriod ?? 120,
    seed: o.seed ?? 7,
  };
}

export const autoTrim = (main: boolean, jib: boolean, spinnaker: boolean): Controls['autoTrim'] => ({ main, jib, spinnaker });

export interface SailingOpts extends WindOpts {
  twsKn: number;
  /** Signed true wind angle (deg), + = starboard tack. */
  twa: number;
  /** Direction the wind blows from (deg); default 200. */
  twdDeg?: number;
  /** Starting speed (kn); default 80 % of the polar target. */
  speedKn?: number;
  /** Helm mode; the autopilot targets are set from `twa` / the heading. Default 'twa'. */
  helm?: HelmMode;
  controls?: Partial<Controls>;
  spinnaker?: boolean;
  /** Sail lab: tow the boat at this speed (kn), heading held. */
  towedKn?: number;
}

/** A boat sailing at a given true wind angle — the starting point of almost every lesson. */
export function sailing(o: SailingOpts): ScenarioInit {
  const twd = o.twdDeg ?? 200;
  const heading = (((twd - o.twa) % 360) + 360) % 360; // TWA = TWD − heading
  const helm = o.helm ?? 'twa';
  const speed = o.speedKn ?? 0.8 * polarSpeed(o.twsKn, Math.abs(o.twa));
  return {
    wind: wind(o.twsKn, twd, o),
    boat: { psi: fromDeg(heading), u: fromKn(o.towedKn ?? speed) },
    controls: {
      helmMode: helm,
      helmTarget: helm === 'twa' ? fromDeg(o.twa) : helm === 'heading' ? fromDeg(heading) : 0,
      ...o.controls,
    },
    spinnakerSet: o.spinnaker ?? false,
    towed: o.towedKn !== undefined ? { speed: fromKn(o.towedKn) } : null,
  };
}

/** Overlay set for a step: exactly these on, every other teaching overlay off. */
export function view(...on: OverlayKey[]): Record<OverlayKey, boolean> {
  const out = {} as Record<OverlayKey, boolean>;
  for (const k of OVERLAY_KEYS) out[k] = on.includes(k);
  return out;
}

// ---- helm -------------------------------------------------------------------------------------------

/** Autopilot: hold a true wind angle (unsigned deg) on the current tack, or on `side`. */
export function holdTwa(c: LessonCtx, absDeg: number, side: 1 | -1 = tackOf(c.snap)): void {
  const k = c.app.controls;
  k.helmMode = 'twa';
  k.helmTarget = fromDeg(side * absDeg);
}

export function holdHeading(c: LessonCtx, heading: number): void {
  const k = c.app.controls;
  k.helmMode = 'heading';
  k.helmTarget = fromDeg(((heading % 360) + 360) % 360);
}

/** Hand the tiller to the learner (centred). */
export function manualHelm(c: LessonCtx): void {
  const k = c.app.controls;
  k.helmMode = 'manual';
  k.tiller = 0;
}

/** Signed autopilot target (deg) when the autopilot holds a wind angle, else null. */
export function pilotTwa(c: LessonCtx): number | null {
  const k = c.app.controls;
  return k.helmMode === 'twa' ? toDeg(k.helmTarget) : null;
}

// ---- the step builder ---------------------------------------------------------------------------------

/** Runs every frame while its step's task is being checked (after "Show me" started it). */
export type Demo = (c: LessonCtx) => void;

export interface StepDef extends Omit<Step, 'body' | 'showMe' | 'hint'> {
  /** Trusted HTML; a function is evaluated whenever the panel renders the step (e.g. to show recorded numbers). */
  body: string | (() => string);
  hint?(c: LessonCtx): string | null;
  /** Set the controls at once; return a Demo for demonstrations that take several phases. */
  showMe?(c: LessonCtx): Demo | void;
}

const DEMO = '__demo';
const SCRATCH = '__step';

interface DemoSlot { owner: object; drive: Demo }

/** Build a Step: clears the per-step scratch and any demo on entry, and runs this step's demo from its check. */
export function step(d: StepDef): Step {
  const owner = {};
  const out: Step = {
    title: d.title,
    body: '',
    onEnter: (c) => {
      c.data[DEMO] = undefined;
      c.data[SCRATCH] = {};
      d.onEnter?.(c);
    },
    onExit: (c) => {
      c.data[DEMO] = undefined;
      d.onExit?.(c);
    },
  };
  const body = d.body;
  Object.defineProperty(out, 'body', { enumerable: true, get: () => (typeof body === 'function' ? body() : body) });
  if (d.camera) out.camera = d.camera;
  if (d.overlays) out.overlays = d.overlays;
  if (d.controls) out.controls = d.controls;
  if (d.autoTrim) out.autoTrim = d.autoTrim;
  if (d.hint) out.hint = d.hint;
  if (d.task) {
    const t: StepTask = d.task;
    out.task = {
      label: t.label,
      ...(t.holdSeconds !== undefined ? { holdSeconds: t.holdSeconds } : {}),
      check: (c) => {
        const slot = c.data[DEMO] as DemoSlot | undefined;
        if (slot && slot.owner === owner) slot.drive(c);
        return t.check(c);
      },
    };
  }
  if (d.showMe) {
    const show = d.showMe;
    out.showMe = (c) => {
      const drive = show(c);
      c.data[DEMO] = drive ? ({ owner, drive } satisfies DemoSlot) : undefined;
    };
  }
  return out;
}

/** Per-step scratch state (reset each time the step is entered). */
export function mem<T>(c: LessonCtx, key: string, init: () => T): T {
  let bag = c.data[SCRATCH] as Record<string, unknown> | undefined;
  if (!bag) { bag = {}; c.data[SCRATCH] = bag; }
  if (!(key in bag)) bag[key] = init();
  return bag[key] as T;
}

/** Per-step scratch value if a check has created it already (hints use this: they may run first). */
export function peek<T>(c: LessonCtx, key: string): T | undefined {
  const bag = c.data[SCRATCH] as Record<string, unknown> | undefined;
  return bag?.[key] as T | undefined;
}

/** Latch: true from the first frame `cond` held during this step. */
export function latch(c: LessonCtx, key: string, cond: boolean): boolean {
  const box = mem(c, key, () => ({ on: false }));
  if (cond) box.on = true;
  return box.on;
}

/** Simulated seconds since the previous call with this key during this step (0 on the first call). */
export function frameDt(c: LessonCtx, key = 'dt'): number {
  const box = mem(c, key, () => ({ t: c.t }));
  const dt = Math.max(0, c.t - box.t);
  box.t = c.t;
  return Math.min(dt, 0.25);
}

// ---- manoeuvre detectors ------------------------------------------------------------------------------

export interface TackResult { entry: number; min: number; ratio: number }

/**
 * Detects tacks however they are sailed (T key, autopilot or tiller): the bow turns through the wind from
 * one close-hauled side to the other. `entry` is the speed when the turn began, `min` the lowest speed
 * before the boat accelerates again on the new tack.
 */
export class TackWatch {
  private side: 0 | 1 | -1 = 0;
  private entry = 0;
  private turning = false;
  private crossed = false;
  private crossT = 0;
  private min = Infinity;

  update(s: SimSnapshot): TackResult | null {
    const twa = twaDeg(s), a = Math.abs(twa), v = speedKn(s);
    const side: 1 | -1 = twa >= 0 ? 1 : -1;
    if (a > 100) { this.turning = false; this.side = 0; return null; }
    if (!this.turning) {
      if (a >= 32 || this.side === 0) { this.side = side; this.entry = v; }
      if (a < 32) { this.turning = true; this.crossed = false; this.min = v; }
      return null;
    }
    this.min = Math.min(this.min, v);
    if (!this.crossed && side !== this.side) { this.crossed = true; this.crossT = s.t; }
    if (a < 30) return null;
    if (!this.crossed || side === this.side) {
      // Turned back to the old tack without going through the wind.
      this.turning = false; this.side = side; this.entry = v;
      return null;
    }
    // On the new tack: wait until the boat accelerates again (or 5 s) so `min` is the real low point.
    if (v < this.min + 0.1 && s.t - this.crossT < 5) return null;
    const res = { entry: this.entry, min: this.min, ratio: this.entry > 0.1 ? this.min / this.entry : 0 };
    this.turning = false; this.side = side; this.entry = v;
    return res;
  }
}

export interface GybeResult { crashed: boolean }

/**
 * Detects gybes: the stern turns through the wind (TWA passes 180°) and the boom comes to rest on the new
 * side. `crashed` is true when the sim reported a crash gybe on the way — the crash is reported when the
 * boom slams into the end of its sheet, so the gybe only counts once the boom has stopped swinging.
 */
export class GybeWatch {
  private side: 0 | 1 | -1 = 0;
  private pending = false;
  private crashed = false;
  private flipT = 0;

  update(s: SimSnapshot): GybeResult | null {
    const twa = twaDeg(s), a = Math.abs(twa);
    const side: 1 | -1 = twa >= 0 ? 1 : -1;
    if (this.pending && hasEvent(s, 'crashGybe')) this.crashed = true;
    if (this.side === 0) { this.side = side; return null; }
    if (side !== this.side) {
      this.side = side;
      if (a < 90 || this.pending) { this.pending = false; return null; } // a tack, or back out of a gybe
      this.pending = true;
      this.crashed = hasEvent(s, 'crashGybe');
      this.flipT = s.t;
      return null;
    }
    if (!this.pending) return null;
    const main = s.sails.main;
    const boom = toDeg(main.boomAngle);
    if (Math.sign(boom) === side && Math.abs(boom) > 15 && Math.abs(main.boomRate) < 0.3) {
      this.pending = false;
      return { crashed: this.crashed };
    }
    if (s.t - this.flipT > 25) this.pending = false; // sailing by the lee without gybing: not a gybe
    return null;
  }
}

// ---- demos shared by several lessons ----------------------------------------------------------------

type RampKey = 'mainSheet' | 'jibSheet' | 'traveler' | 'spinSheet' | 'spinPole' | 'vang' | 'outhaul' | 'cunningham' | 'backstay' | 'jibLead';

/** Move controls toward targets at a hand-trimming rate (units per second), like a crew hauling a sheet. */
export function ramp(targets: Partial<Record<RampKey, number>>, rate = 0.35): Demo {
  return (c) => {
    const k = c.app.controls;
    const d = rate * frameDt(c, 'rampDt');
    for (const [key, target] of Object.entries(targets) as [RampKey, number][]) {
      k[key] += Math.max(-d, Math.min(d, target - k[key]));
    }
  };
}

/** Run several demos together. */
export const together = (...demos: Demo[]): Demo => (c) => { for (const d of demos) d(c); };

/**
 * Get the boat sailing at `absTwa` from wherever it is — including stopped head to wind: back the jib (it
 * pushes the bow away from the side it is held on) and steer in reverse while drifting astern; once the bow
 * is well off the wind, release the jib and let the autopilot take the new course.
 */
export function sailAway(absTargetTwa: number, opts: { releaseAt?: number } = {}): Demo {
  const releaseAt = opts.releaseAt ?? 50;
  let phase: 'turn' | 'sail' = 'turn';
  const sail = (c: LessonCtx): void => {
    const k = c.app.controls;
    k.jibBacked = false;
    k.autoTrim.main = true;
    k.autoTrim.jib = true;
    holdTwa(c, absTargetTwa);
  };
  return (c) => {
    const s = c.snap;
    const a = absTwa(s);
    if (phase === 'turn' && a >= releaseAt) phase = 'sail';
    // Still carrying way and already off to one side: simply steer away.
    if (phase === 'sail' || (s.boat.u > 0.9 && a > 12)) { sail(c); return; }
    // Back the jib: its old sheet stays pulled tight (the crew stops trimming it).
    const k = c.app.controls;
    k.jibBacked = true;
    k.autoTrim.jib = false;
    k.jibSheet = 1;
    k.helmMode = 'manual';
    // Clew held to port (+) pushes the bow to starboard. Going astern the rudder works in reverse, so the
    // tiller command that normally turns the bow to port now helps it to starboard.
    const clewSide = Math.sign(s.sails.jib.clewAngle) || 1;
    k.tiller = s.boat.u < -0.05 ? -clewSide : 0;
  };
}

