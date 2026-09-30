// Steady-state performance (spec §7.8). The boat is sailed to equilibrium by the same simulation the app
// uses — autopilot holding the true wind angle, the auto-crew trimming — so the polar is exactly what a
// well-sailed Kestrel 25 achieves in this model (no separate, drifting force model).
import { Simulation, DT } from './simulation';
import { AutoCrew } from './autocrew';
import { DEG } from '../shared/math';

export interface SteadyResult {
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
}

export interface SteadyOptions { spinnaker?: boolean; maxSeconds?: number }

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
  for (let s = 0; s < max; s++) {
    for (let i = 0; i < perSecond; i++) sim.step();
    const change = Math.abs(sim.speed - prev) / Math.max(prev, 0.3);
    prev = sim.speed;
    calm = change < 0.002 && s > 10 ? calm + 1 : 0;
    if (calm >= 5) { converged = true; break; }
  }
  const snap = sim.snapshot();
  return {
    converged,
    speed: snap.boat.speed,
    leeway: snap.boat.leeway,
    heel: snap.boat.heel,
    rudder: snap.boat.rudder,
    awa: snap.wind.awa,
    aws: snap.wind.aws,
    vmg: snap.boat.vmg,
  };
}

export interface BestResult extends SteadyResult { sails: 'jib' | 'spinnaker' }

/** Spinnaker ceiling for a prudent training crew (m/s): above ~20 kn the kite comes down. */
export const SPINNAKER_MAX_TWS = 20.5 * 0.514444;

/** Faster of jib and (from 80° TWA, up to 20 kn of wind) spinnaker. */
export function bestSpeed(tws: number, twa: number): BestResult {
  const jib: BestResult = { ...solveSteady(tws, twa), sails: 'jib' };
  if (Math.abs(twa) < 80 * DEG || tws > SPINNAKER_MAX_TWS) return jib;
  const spin: BestResult = { ...solveSteady(tws, twa, { spinnaker: true }), sails: 'spinnaker' };
  return spin.speed > jib.speed ? spin : jib;
}
