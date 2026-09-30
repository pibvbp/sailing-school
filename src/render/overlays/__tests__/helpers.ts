// Shared fixtures for the overlay tests: a real Simulation + AutoCrew sailed to steady state.
import { Simulation, DT } from '../../../sim/simulation';
import { AutoCrew } from '../../../sim/autocrew';
import { DEG, KN } from '../../../shared/math';
import type { Controls, SimSnapshot } from '../../../sim/types';

export interface Sailed { sim: Simulation; snap: SimSnapshot }

/** Sail at a true wind angle for `seconds` (auto-crew trimming unless controls override it). */
export function sail(twsKn: number, twaDeg: number, opts: { spin?: boolean; seconds?: number; gust?: number; twdDeg?: number; controls?: Partial<Controls>; crew?: boolean } = {}): Sailed {
  const twd = (opts.twdDeg ?? 250) * DEG;
  const sim = new Simulation({
    wind: { tws: twsKn * KN, twd, gustiness: opts.gust ?? 0, shiftAmplitude: 0, shiftPeriod: 150, seed: 11 },
    boat: { psi: (((twd - twaDeg * DEG) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), u: 2.5 },
    spinnakerSet: opts.spin ?? false,
    controls: { helmMode: 'twa', helmTarget: twaDeg * DEG, ...opts.controls },
  });
  if (opts.crew !== false) sim.crew = new AutoCrew();
  const steps = Math.round((opts.seconds ?? 30) / DT);
  for (let i = 0; i < steps; i++) sim.step();
  return { sim, snap: sim.snapshot() };
}

/** Best mean cost (ms) of `fn` over several batches — robust to scheduler noise. */
export function bestMeanMs(fn: () => void, iterations = 20, batches = 8): number {
  for (let i = 0; i < iterations; i++) fn();
  let best = Number.POSITIVE_INFINITY;
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    best = Math.min(best, (performance.now() - t0) / iterations);
  }
  return best;
}
