import { describe, it, expect } from 'vitest';
import { Simulation, DT } from '../simulation';
import { DEG, KN } from '../../shared/math';
import type { ScenarioInit, SimEvent } from '../types';

const wind = (tws: number, twdDeg: number) => ({ tws: tws * KN, twd: twdDeg * DEG, gustiness: 0, shiftAmplitude: 0, shiftPeriod: 120, seed: 3 });

function run(sim: Simulation, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    sim.step();
    if (i % 120 === 0) events.push(...sim.snapshot().events);
  }
  events.push(...sim.snapshot().events);
  return events;
}

const reach: ScenarioInit = {
  wind: wind(12, 90),
  boat: { u: 2.5 },
  controls: { helmMode: 'twa', helmTarget: 90 * DEG, mainSheet: 0.35, jibSheet: 0.1, autoTrim: { main: false, jib: false, spinnaker: false } },
};

describe('simulation', () => {
  it('beam reach in 12 kn: plausible speed, heels and slides to leeward, balanced helm', () => {
    const sim = new Simulation(reach);
    run(sim, 60);
    const s = sim.snapshot();
    const kn = s.boat.speed / KN;
    expect(kn).toBeGreaterThan(5.5);
    expect(kn).toBeLessThan(7.5);
    expect(s.boat.heel).toBeLessThan(0);          // wind from starboard → heel to port
    expect(s.boat.leeway).toBeLessThan(0);        // sliding to port
    expect(Math.abs(s.boat.rudder)).toBeLessThan(8 * DEG);
    expect(Math.abs(s.wind.twa - 90 * DEG)).toBeLessThan(4 * DEG);
  });

  it('close-hauled in 12 kn: heels 10–25°, 2–6° leeway and weather helm', () => {
    const sim = new Simulation({
      wind: wind(12, 42),
      boat: { u: 2.5 },
      controls: { helmMode: 'twa', helmTarget: 42 * DEG, mainSheet: 0.9, jibSheet: 0.95, autoTrim: { main: false, jib: false, spinnaker: false } },
    });
    run(sim, 60);
    const s = sim.snapshot();
    expect(s.boat.heel / DEG).toBeLessThan(-10);
    expect(s.boat.heel / DEG).toBeGreaterThan(-25);
    expect(s.boat.leeway / DEG).toBeLessThan(-2);
    expect(s.boat.leeway / DEG).toBeGreaterThan(-6);
    expect(s.boat.rudder).toBeLessThan(0);        // weather helm: rudder turns the bow away from the wind
    expect(s.forces.heelingMoment).toBeLessThan(0);
    expect(s.forces.rightingMoment).toBeGreaterThan(0);
  });

  it('positive tiller turns the bow to starboard', () => {
    const sim = new Simulation({ wind: wind(12, 60), boat: { u: 2.6 }, controls: { tiller: 1, autoTrim: { main: false, jib: false, spinnaker: false } } });
    run(sim, 1.5);
    expect(sim.boat.r).toBeGreaterThan(0.05);
  });

  it('drifts backwards in irons', () => {
    const sim = new Simulation({ wind: wind(12, 0), controls: { autoTrim: { main: false, jib: false, spinnaker: false } } });
    const events = run(sim, 10);
    expect(sim.boat.u).toBeLessThan(-0.05);
    expect(events.some((e) => e.type === 'inIrons')).toBe(true);
  });

  it('broaches — and stays finite — when over-powered with the spinnaker in 25 kn', () => {
    const sim = new Simulation({
      wind: wind(25, 100),
      boat: { u: 3 },
      spinnakerSet: true,
      controls: { helmMode: 'twa', helmTarget: 100 * DEG, mainSheet: 1, spinSheet: 1, spinPole: 0.1, autoTrim: { main: false, jib: false, spinnaker: false } },
    });
    const events = run(sim, 120);
    const b = sim.boat;
    for (const v of [b.e, b.n, b.psi, b.u, b.v, b.r, b.phi, b.p, b.rudder]) expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(b.phi)).toBeLessThan(90 * DEG);
    expect(events.some((e) => e.type === 'roundUp')).toBe(true);
  });

  it('is deterministic', () => {
    const a = new Simulation({ ...reach, wind: { ...reach.wind, gustiness: 0.8, seed: 11 } });
    const b = new Simulation({ ...reach, wind: { ...reach.wind, gustiness: 0.8, seed: 11 } });
    run(a, 30);
    run(b, 30);
    expect(a.boat).toEqual(b.boat);
  });

  it('steps fast enough (≤ 50 µs per step)', () => {
    const sim = new Simulation(reach);
    for (let i = 0; i < 500; i++) sim.step();
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) sim.step();
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
