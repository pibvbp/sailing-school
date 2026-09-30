// Steady-state performance (spec §7.8). The boat is sailed to equilibrium by the same simulation the app
// uses — autopilot holding the true wind angle, the auto-crew trimming — so the polar is exactly what a
// well-sailed Kestrel 25 achieves in this model (no separate, drifting force model).
import { Simulation, DT } from './simulation';
import { AutoCrew } from './autocrew';
import { DEG, KN, wrapPi } from '../shared/math';

export interface SteadyResult {
  /**
   * True when the speed had settled (< 0.2 %/s for 5 s) with the boat on the requested angle (within 1°). When
   * false, the values are averages over the last 10 s of the run rather than one sample.
   */
  converged: boolean;
  /** m/s */
  speed: number;
  leeway: number;
  heel: number;
  rudder: number;
  awa: number;
  aws: number;
  /** m/s toward (+) or away from (−) the wind. */
  vmg: number;
  /** True wind angle actually sailed at the end (rad). */
  twa?: number;
}

export interface SteadyOptions { spinnaker?: boolean; maxSeconds?: number }

/** The boat must hold the requested angle this closely before its speed counts as steady. */
const TWA_TOLERANCE = 1 * DEG;
/** An unsettled run is reported as its average over this window (long enough to span a slow crew–helm cycle). */
const WINDOW_S = 20;
/** An unsettled run still counts as sailing the angle if it held it this closely on average. */
const HELD_ON_AVERAGE = 3 * DEG;

/** Sail at `twa` (rad, + starboard tack) in `tws` (m/s) until speed stops changing. */
export function solveSteady(tws: number, twa: number, opt: SteadyOptions = {}): SteadyResult {
  const spinnaker = opt.spinnaker ?? false;
  const sim = new Simulation({
    wind: { tws, twd: twa, gustiness: 0, shiftAmplitude: 0, shiftPeriod: 120, seed: 1 },
    boat: { u: Math.min(3, 0.45 * tws + 0.8) },
    spinnakerSet: spinnaker,
    controls: { helmMode: 'twa', helmTarget: twa },
  });
  sim.crew = new AutoCrew();
  const perSecond = Math.round(1 / DT);
  const max = opt.maxSeconds ?? 120;
  let prev = sim.speed;
  let calm = 0;
  let converged = false;
  const window: Omit<SteadyResult, 'converged'>[] = [];
  for (let s = 0; s < max; s++) {
    for (let i = 0; i < perSecond; i++) sim.step();
    const change = Math.abs(sim.speed - prev) / Math.max(prev, 0.3);
    prev = sim.speed;
    const onAngle = Math.abs(wrapPi(sim.twa - twa)) < TWA_TOLERANCE;
    calm = change < 0.002 && onAngle && s > 10 ? calm + 1 : 0;
    window.push(sample(sim));
    if (window.length > WINDOW_S) window.shift();
    if (calm >= 5) { converged = true; break; }
  }
  if (converged) return { converged, ...sample(sim) };
  // Not settled (oscillating, or unable to hold the angle): report the recent average, flagged.
  const avg = (f: (r: Omit<SteadyResult, 'converged'>) => number) => window.reduce((a, r) => a + f(r), 0) / window.length;
  return {
    converged,
    speed: avg((r) => r.speed),
    leeway: avg((r) => r.leeway),
    heel: avg((r) => r.heel),
    rudder: avg((r) => r.rudder),
    awa: avg((r) => r.awa),
    aws: avg((r) => r.aws),
    vmg: avg((r) => r.vmg),
    twa: twa + avg((r) => wrapPi(r.twa! - twa)),
  };
}

function sample(sim: Simulation): Omit<SteadyResult, 'converged'> {
  const snap = sim.snapshot();
  return {
    speed: snap.boat.speed,
    leeway: snap.boat.leeway,
    heel: snap.boat.heel,
    rudder: snap.boat.rudder,
    awa: snap.wind.awa,
    aws: snap.wind.aws,
    vmg: snap.boat.vmg,
    twa: snap.wind.twa,
  };
}

export interface BestResult extends SteadyResult { sails: 'jib' | 'spinnaker' }

/** Spinnaker ceiling for a prudent training crew (m/s): above ~20 kn the kite comes down. */
export const SPINNAKER_MAX_TWS = 20.5 * KN;

/** A steady run, retried for twice as long if it had not settled. */
function settled(tws: number, twa: number, sails: BestResult['sails']): BestResult {
  const spinnaker = sails === 'spinnaker';
  const r = solveSteady(tws, twa, { spinnaker });
  if (r.converged) return { ...r, sails };
  return { ...solveSteady(tws, twa, { spinnaker, maxSeconds: 240 }), sails };
}

/** Did the run sail the requested angle — settled on it, or at least on it on average? */
const heldAngle = (r: SteadyResult, twa: number): boolean =>
  r.converged || Math.abs(wrapPi((r.twa ?? twa) - twa)) < HELD_ON_AVERAGE;

/**
 * Faster of jib and (from 80° TWA, up to 20 kn of wind) spinnaker (M7). A sail set that could not hold the angle
 * (the boat settled somewhere else) does not compete with one that could; the result keeps `converged: false`
 * when the winner never settled, so the polar can flag the point.
 */
export function bestSpeed(tws: number, twa: number): BestResult {
  const jib = settled(tws, twa, 'jib');
  if (Math.abs(twa) < 80 * DEG || tws > SPINNAKER_MAX_TWS) return jib;
  const spin = settled(tws, twa, 'spinnaker');
  const hs = heldAngle(spin, twa), hj = heldAngle(jib, twa);
  if (hs !== hj) return hs ? spin : jib;
  return spin.speed > jib.speed ? spin : jib;
}
