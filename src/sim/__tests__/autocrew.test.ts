import { describe, it, expect } from 'vitest';
import { Simulation, DT } from '../simulation';
import { AutoCrew } from '../autocrew';
import { DEG, KN } from '../../shared/math';
import type { ScenarioInit, SimEvent } from '../types';

const wind = (tws: number, twdDeg: number) => ({ tws: tws * KN, twd: twdDeg * DEG, gustiness: 0, shiftAmplitude: 0, shiftPeriod: 120, seed: 5 });

function crewSim(init: ScenarioInit): Simulation {
  const s = new Simulation(init);
  s.crew = new AutoCrew();
  return s;
}

function run(sim: Simulation, seconds: number, each?: (t: number) => void): SimEvent[] {
  const events: SimEvent[] = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    each?.(i * DT);
    sim.step();
    if (i % 60 === 0) events.push(...sim.snapshot().events);
  }
  events.push(...sim.snapshot().events);
  return events;
}

const beating = (tws = 12): ScenarioInit => ({ wind: wind(tws, 45), boat: { u: 2.5 }, controls: { helmMode: 'twa', helmTarget: 45 * DEG } });

describe('autopilot + auto-trim', () => {
  it('holds 45° TWA upwind in 12 kn at a sensible speed', () => {
    const sim = crewSim(beating());
    run(sim, 60);
    expect(Math.abs(sim.twa - 45 * DEG)).toBeLessThan(3 * DEG);
    expect(sim.speed / KN).toBeGreaterThan(4.5);
  });

  it('keeps the crew on the windward rail when heeled', () => {
    const sim = crewSim(beating(16));
    run(sim, 30);
    expect(Math.abs(sim.boat.phi)).toBeGreaterThan(10 * DEG);
    expect(sim.boat.crewY).toBeGreaterThan(0.8); // wind from starboard → starboard rail
  });
});

describe('manoeuvres', () => {
  it('tacks onto the mirrored angle, jib across, keeping most of its speed', () => {
    const sim = crewSim(beating());
    run(sim, 40);
    const entry = sim.speed;
    sim.controls.command = 'tack';
    const events = run(sim, 20);
    expect(Math.abs(sim.twa - -45 * DEG)).toBeLessThan(5 * DEG);
    expect(sim.jib.workingSide).toBe(-1);
    expect(events.filter((e) => e.type === 'tackComplete').length).toBe(1);
    run(sim, 10);
    expect(sim.speed).toBeGreaterThan(0.6 * entry);
  });

  it('gybes from 150° to −150° without a crash gybe', () => {
    const sim = crewSim({ wind: wind(12, 150), boat: { u: 3 }, controls: { helmMode: 'twa', helmTarget: 150 * DEG } });
    run(sim, 20);
    sim.controls.command = 'gybe';
    const events = run(sim, 40);
    expect(Math.abs(sim.twa - -150 * DEG)).toBeLessThan(8 * DEG);
    expect(events.some((e) => e.type === 'gybeComplete')).toBe(true);
    expect(events.some((e) => e.type === 'crashGybe')).toBe(false);
    expect(sim.main.beta).toBeLessThan(0); // boom now out to starboard
  });

  it('ignores a tack request during a gybe', () => {
    const sim = crewSim({ wind: wind(12, 150), boat: { u: 3 }, controls: { helmMode: 'twa', helmTarget: 150 * DEG } });
    run(sim, 10);
    sim.controls.command = 'gybe';
    const events = run(sim, 40, (t) => { if (Math.abs(t - 2) < DT / 2) sim.controls.command = 'tack'; });
    expect(events.some((e) => e.type === 'tackComplete')).toBe(false);
    expect(events.some((e) => e.type === 'gybeComplete')).toBe(true);
  });

  it('refuses to tack without speed and explains why', () => {
    const sim = crewSim({ wind: wind(12, 45), controls: { helmMode: 'manual' } });
    const crew = sim.crew as AutoCrew;
    sim.controls.command = 'tack';
    run(sim, 0.1);
    expect(crew.maneuver).toBe(null);
    expect(crew.refused).toMatch(/speed/);
  });

  it('ends a hoist/douse toggle burst in the last requested state', () => {
    const sim = crewSim({ wind: wind(12, 140), boat: { u: 3 }, controls: { helmMode: 'twa', helmTarget: 140 * DEG } });
    run(sim, 2, (t) => { const k = Math.floor(t / 0.2); sim.controls.spinHoist = k % 2 === 0; });
    sim.controls.spinHoist = true;
    run(sim, 10);
    expect(sim.spin.hoist).toBe(1);
    const b = sim.boat;
    for (const v of [b.u, b.v, b.r, b.phi, b.psi]) expect(Number.isFinite(v)).toBe(true);
  });

  it('flies the spinnaker on a broad reach without collapsing, pole square to the apparent wind', () => {
    const sim = crewSim({ wind: wind(12, 135), boat: { u: 3 }, spinnakerSet: true, controls: { helmMode: 'twa', helmTarget: 135 * DEG } });
    run(sim, 15);
    const events = run(sim, 60);
    expect(events.some((e) => e.type === 'spinCollapse')).toBe(false);
    const pole = sim.controls.spinPole * 90;
    expect(Math.abs(pole - (Math.abs(sim.awa) / DEG - 90))).toBeLessThan(10);
    expect(sim.speed / KN).toBeGreaterThan(5);
  });
});
