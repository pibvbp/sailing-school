// Robustness of the full simulation (sim fix round 1): the whisker pole on a run (C1), a randomized control-abuse
// soak (C1), the finite-state guard (C1) and holding a dead run without the rig flickering side to side (C3).
import { describe, it, expect, vi } from 'vitest';
import { Simulation, DT } from '../simulation';
import { AutoCrew } from '../autocrew';
import { mulberry32 } from '../rng';
import { DEG, KN } from '../../shared/math';
import type { Controls, HelmMode, ScenarioInit } from '../types';

// Minutes of simulated sailing per test: allow for a heavily loaded machine.
vi.setConfig({ testTimeout: 120_000 });

const wind =(tws: number, twdDeg: number, gustiness = 0, seed = 9) =>
  ({ tws: tws * KN, twd: twdDeg * DEG, gustiness, shiftAmplitude: 0, shiftPeriod: 120, seed });

function stateFinite(sim: Simulation): boolean {
  const b = sim.boat;
  return [b.e, b.n, b.psi, b.u, b.v, b.r, b.phi, b.p, b.rudder, b.crewY, sim.main.beta, sim.main.betaDot,
    sim.jib.gamma, sim.jib.gammaDot, sim.spin.psi, sim.twa, sim.awa, sim.aws, sim.speed].every(Number.isFinite);
}

/** Run a whisker scenario for 60 s; report finiteness, the fastest clew swing and the guard's fault count. */
function whiskerRun(tws: number, twa: number, crew: boolean, toggleAt: number | null): { finite: boolean; maxRate: number; faults: number } {
  const sim = new Simulation({
    wind: wind(tws, twa),
    boat: { u: 2.5 },
    controls: { helmMode: 'twa', helmTarget: twa * DEG, jibWhisker: toggleAt === null },
  });
  if (crew) sim.crew = new AutoCrew();
  let maxRate = 0;
  const toggleStep = toggleAt === null ? -1 : Math.round(toggleAt / DT);
  for (let i = 0; i < Math.round(60 / DT); i++) {
    if (i === toggleStep) sim.controls.jibWhisker = true;
    sim.step();
    if (!stateFinite(sim)) return { finite: false, maxRate: Infinity, faults: sim.faults };
    maxRate = Math.max(maxRate, Math.abs(sim.jib.gammaDot));
  }
  return { finite: true, maxRate, faults: sim.faults };
}

describe('whisker pole on a run (C1)', () => {
  for (const tws of [6, 12, 20]) {
    it(`${tws} kn: poled out at t = 20 s at TWA 150/170/180, with and without the crew — finite, |γ̇| < 5 rad/s, no faults`, () => {
      for (const twa of [150, 170, 180]) {
        for (const crew of [true, false]) {
          const r = whiskerRun(tws, twa, crew, 20);
          const tag = `TWA ${twa} crew ${crew}`;
          expect(r.finite, tag).toBe(true);
          expect(r.maxRate, tag).toBeLessThan(5);
          expect(r.faults, tag).toBe(0);
        }
      }
    });
  }

  it('starting with the pole already set at TWA 170–180 (12 kn) — finite, |γ̇| < 5 rad/s, no faults', () => {
    for (const twa of [170, 175, 178, 180]) {
      for (const crew of [true, false]) {
        const r = whiskerRun(12, twa, crew, null);
        const tag = `TWA ${twa} crew ${crew}`;
        expect(r.finite, tag).toBe(true);
        expect(r.maxRate, tag).toBeLessThan(5);
        expect(r.faults, tag).toBe(0);
      }
    }
  });
});

describe('randomized control abuse (C1)', () => {
  it('10 min of random slider jumps, toggles and helm changes in 6–25 kn: finite, no faults, < 15 m/s', () => {
    const rand = mulberry32(20260929);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const sliders = ['mainSheet', 'jibSheet', 'spinSheet', 'spinPole', 'spinPoleHeight', 'vang', 'outhaul', 'cunningham', 'backstay', 'jibFurl'] as const;
    const modes: HelmMode[] = ['manual', 'heading', 'twa', 'awa'];
    let total = 0, maxSpeed = 0;
    for (let run = 0; run < 5; run++) {
      const tws = 6 + 19 * rand();
      const sim = new Simulation({
        wind: wind(tws, 360 * rand(), rand() < 0.5 ? 0 : rand(), 1 + run),
        boat: { u: 2 * rand(), psi: 2 * Math.PI * rand() },
        spinnakerSet: rand() < 0.3,
        controls: { helmMode: 'twa', helmTarget: (40 + 140 * rand()) * DEG * (rand() < 0.5 ? -1 : 1) },
      });
      sim.crew = new AutoCrew();
      let next = 0;
      for (let i = 0; i < Math.round(120 / DT); i++) {
        const t = i * DT;
        if (t >= next) {
          next = t + 0.3 + 3 * rand();
          const c: Controls = sim.controls;
          const kind = rand();
          if (kind < 0.45) (c as unknown as Record<string, number>)[pick(sliders)] = rand();
          else if (kind < 0.55) c.traveler = 2 * rand() - 1;
          else if (kind < 0.62) c.jibWhisker = !c.jibWhisker;
          else if (kind < 0.69) c.spinHoist = !c.spinHoist;
          else if (kind < 0.72) c.jibBacked = !c.jibBacked;
          else if (kind < 0.76) c.boomPush = c.boomPush !== 0 ? 0 : 2 * rand() - 1;
          else if (kind < 0.8) c.jibFurl = c.jibFurl > 0.5 ? 0 : 1;
          else if (kind < 0.88) {
            c.helmMode = pick(modes);
            c.helmTarget = c.helmMode === 'heading' ? 2 * Math.PI * rand() : (2 * rand() - 1) * Math.PI;
          } else if (kind < 0.94) { c.helmMode = 'manual'; c.tiller = 2 * rand() - 1; }
          else if (kind < 0.97) c.command = pick(['tack', 'gybe'] as const);
          else c.autoTrim = { main: rand() < 0.5, jib: rand() < 0.5, spinnaker: rand() < 0.5 };
        }
        sim.step();
        if (i % 12 === 0) {
          sim.snapshot(); // drains events, exercises the snapshot path
          expect(stateFinite(sim), `run ${run} t ${t.toFixed(2)}`).toBe(true);
        }
        maxSpeed = Math.max(maxSpeed, sim.speed);
      }
      expect(stateFinite(sim)).toBe(true);
      expect(sim.faults, `run ${run}`).toBe(0);
      total += 120;
    }
    expect(total).toBe(600);
    expect(maxSpeed).toBeLessThan(15);
  });
});

describe('finite-state guard (C1, defence in depth)', () => {
  it('a non-finite step is undone: previous state, rates zeroed, counted, warned once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sim = new Simulation({ wind: wind(12, 60), boat: { u: 3 }, controls: { helmMode: 'twa', helmTarget: 60 * DEG } });
    for (let i = 0; i < 240; i++) sim.step();
    const before = { ...sim.boat };
    sim.controls.mainSheet = Number.NaN; // a broken input poisons the next step
    sim.step();
    expect(sim.faults).toBe(1);
    expect(stateFinite(sim)).toBe(true);
    expect(sim.boat.u).toBe(before.u);
    expect(sim.boat.phi).toBe(before.phi);
    expect(sim.boat.r).toBe(0);
    expect(sim.boat.p).toBe(0);
    expect(Number.isFinite(sim.controls.mainSheet)).toBe(true);
    for (let i = 0; i < 120; i++) sim.step();
    expect(stateFinite(sim)).toBe(true);
    sim.controls.jibSheet = Number.POSITIVE_INFINITY; // clamped harmlessly
    sim.step();
    expect(sim.faults).toBe(1);
    sim.controls.jibSheet = Number.NaN;
    sim.step();
    expect(sim.faults).toBe(2);
    expect(stateFinite(sim)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/** Hold a dead run for 60 s and count how often each sail changes side. */
function deadRun(twa: number, rig: 'spinnaker' | 'jib' | 'whisker') {
  const init: ScenarioInit = {
    wind: wind(12, twa),
    boat: { u: 2.5 },
    spinnakerSet: rig === 'spinnaker',
    controls: { helmMode: 'twa', helmTarget: twa * DEG, jibWhisker: rig === 'whisker' },
  };
  const sim = new Simulation(init);
  sim.crew = new AutoCrew();
  const flips = { main: 0, jib: 0, spin: 0, whisker: 0, working: 0 };
  let prev = { main: sim.main.tackSign, jib: sim.jib.tackSide, spin: sim.spin.windwardSide, whisker: sim.jib.whiskerSide, working: sim.jib.workingSide };
  let poleOff = 0;
  for (let i = 0; i < Math.round(60 / DT); i++) {
    sim.step();
    const now = { main: sim.main.tackSign, jib: sim.jib.tackSide, spin: sim.spin.windwardSide, whisker: sim.jib.whiskerSide, working: sim.jib.workingSide };
    for (const k of Object.keys(flips) as (keyof typeof flips)[]) if (now[k] !== prev[k]) flips[k]++;
    prev = now;
    if (!sim.spin.poleOn) poleOff += DT;
  }
  return { flips, poleOn: 1 - poleOff / 60, sim };
}

describe('holding a dead run (C3)', () => {
  for (const twa of [180, 178, 175]) {
    it(`TWA ${twa}°, 12 kn, autopilot + crew: every sail changes side at most once, pole on ≥ 95 %`, () => {
      for (const rig of ['spinnaker', 'jib', 'whisker'] as const) {
        const r = deadRun(twa, rig);
        const tag = `${rig} TWA ${twa}: ${JSON.stringify(r.flips)}`;
        for (const k of ['main', 'jib', 'spin', 'whisker'] as const) expect(r.flips[k], tag).toBeLessThanOrEqual(1);
        // The jib sheet is never released and re-hauled over and over.
        expect(r.flips.working, tag).toBeLessThanOrEqual(1);
        if (rig === 'spinnaker') expect(r.poleOn, tag).toBeGreaterThanOrEqual(0.95);
        expect(r.sim.faults).toBe(0);
      }
    });
  }
});
