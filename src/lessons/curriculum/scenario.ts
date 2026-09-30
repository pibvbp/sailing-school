// Starting situations for lessons (wind, boat, trim), overlay sets and helm helpers.
import { fromDeg, fromKn, toDeg } from '../../shared/units';
import type { Controls, HelmMode, ScenarioInit, WindSettings } from '../../sim/types';
import { OVERLAY_KEYS, type LessonCtx, type OverlayKey } from '../types';
import { polarSpeed, tackOf } from './readings';

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
