import { describe, it, expect, vi } from 'vitest';
import { Simulation, DT } from '../simulation';
import { AutoCrew, PHASE_TIMEOUT } from '../autocrew';

// Manoeuvres take tens of simulated seconds each: allow for a heavily loaded machine.
vi.setConfig({ testTimeout: 60_000 });
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

describe('tacking in a breeze (I2)', () => {
  for (const tws of [18, 20, 22, 25]) {
    for (const gustiness of [0, 0.5]) {
      it(`${tws} kn${gustiness ? ', gusty' : ''}: no crash gybe, settled on the new tack within 12 s`, () => {
        const sim = crewSim({ wind: { ...wind(tws, 45), gustiness, seed: 2 }, boat: { u: 3 }, controls: { helmMode: 'twa', helmTarget: 45 * DEG } });
        run(sim, 30);
        sim.controls.command = 'tack';
        const events: SimEvent[] = [];
        const t0 = sim.t;
        let doneT = -1, twaAtDone = 0;
        for (let i = 0; i < Math.round(20 / DT); i++) {
          sim.step();
          const s = sim.snapshot();
          events.push(...s.events);
          if (doneT < 0 && s.events.some((e) => e.type === 'tackComplete')) { doneT = sim.t - t0; twaAtDone = sim.twa; }
        }
        expect(events.some((e) => e.type === 'crashGybe')).toBe(false);
        expect(doneT).toBeGreaterThan(0);
        expect(doneT).toBeLessThan(12);
        // Completed by settling on the target, not by a phase timeout.
        expect(Math.abs(twaAtDone - -45 * DEG)).toBeLessThan(5 * DEG);
      });
    }
  }
});

describe('backing the jib out of irons (I4)', () => {
  for (const side of [1, -1] as const) {
    it(`head to wind and stopped in 12 kn (${side > 0 ? 'starboard' : 'port'} side): the backed jib turns the bow away from its clew`, () => {
      // Tiller centred, no crew: the jib alone has to do it.
      const sim = new Simulation({ wind: wind(12, side * 2), boat: { u: 0 }, controls: { helmMode: 'manual', tiller: 0, jibBacked: true } });
      let passT = -1;
      for (let i = 0; i < Math.round(20 / DT); i++) {
        sim.step();
        if (i === 240) expect(Math.sign(sim.jib.gamma)).toBe(-side); // clew held to windward
        if (passT < 0 && Math.abs(sim.twa) > 50 * DEG) passT = sim.t;
      }
      expect(passT).toBeGreaterThan(0);
      expect(passT).toBeLessThan(20);
      expect(Math.sign(sim.twa)).toBe(side); // the bow went away from the clew's side
    });
  }

  // Boom held out to port (boomPush > 0), head to wind: the backed main is pushed aft and to starboard, away from
  // the side it is held on, at a centre of effort on the port side — the stern swings to starboard, the bow to port,
  // so the wind comes onto the starboard bow: starboard tack (TWA > 0). The jib backed to starboard pushes the bow
  // away from its side — to port — too. Mirrored for the other side.
  for (const side of [1, -1] as const) {
    it(`backing the main by hand (boom ${side > 0 ? 'to port' : 'to starboard'}) with the jib backed to the other side: sternway, then ${side > 0 ? 'starboard' : 'port'} tack`, () => {
      const sim = crewSim({
        wind: wind(8, side * 2),
        boat: { u: 0 },
        controls: { helmMode: 'manual', tiller: 0, mainSheet: 0.1, boomPush: side, jibBacked: true },
      });
      let sternT = -1;
      for (let i = 0; i < Math.round(15 / DT); i++) {
        sim.step();
        if (sternT < 0 && sim.boat.u < -0.3) sternT = sim.t;
      }
      expect(Math.sign(sim.main.beta)).toBe(side);   // held out where the crew pushes it
      expect(Math.sign(sim.jib.gamma)).toBe(-side);  // jib backed on the other side
      expect(sternT).toBeGreaterThan(0);
      expect(sternT).toBeLessThan(10);
      expect(sim.twa * side).toBeGreaterThan(30 * DEG);
      expect(sim.controls.mainSheet).toBe(0.1);      // main auto-trim did not fight the crew
    });
  }

  it('a crew-run tack or gybe lets go of the boom when it starts', () => {
    const sim = crewSim(beating());
    run(sim, 30);
    sim.controls.boomPush = 0.4;
    sim.controls.command = 'tack';
    run(sim, 0.1);
    expect(sim.controls.boomPush).toBe(0);
  });

  it('jib auto-trim leaves a backed jib alone', () => {
    const sim = crewSim({ wind: wind(12, 3), controls: { helmMode: 'manual', jibBacked: true, jibSheet: 0.5 } });
    run(sim, 5);
    expect(sim.controls.jibSheet).toBe(0.5);
  });
});

describe('the learner keeps the helm during a manoeuvre (I6)', () => {
  it('moving the tiller mid-tack takes the helm at once; the crew still does the sheets', () => {
    const sim = crewSim({ wind: wind(12, -45), boat: { u: 2.5 }, controls: { helmMode: 'twa', helmTarget: -45 * DEG } });
    const crew = sim.crew as AutoCrew;
    run(sim, 30);
    sim.controls.helmMode = 'manual';
    sim.controls.tiller = 0;
    sim.controls.command = 'tack';
    run(sim, 1);
    expect(crew.maneuver).toBe('tack');
    expect(sim.rudderOverride).not.toBe(null);
    // The learner puts the tiller over (bow to port, the way the boat is already turning).
    sim.controls.tiller = -0.5;
    const before = sim.boat.rudder;
    sim.step();
    expect(sim.rudderOverride).toBe(null);
    expect(crew.learnerHelm).toBe(true);
    const target = -0.5 * 35 * DEG;
    expect(Math.abs(sim.boat.rudder - target)).toBeLessThan(Math.abs(before - target)); // following the tiller
    // The learner steers round and settles; the crew hauls the new jib sheet and completes the tack.
    const events: SimEvent[] = [];
    for (let i = 0; i < Math.round(25 / DT); i++) {
      sim.controls.tiller = sim.twa > 35 * DEG ? 0 : -0.5;
      sim.step();
      events.push(...sim.snapshot().events);
      expect(sim.rudderOverride).toBe(null); // never taken back
    }
    expect(sim.jib.workingSide).toBe(1);
    expect(sim.jib.sheetPort).toBeGreaterThan(0.5);
    expect(events.some((e) => e.type === 'tackComplete')).toBe(true);
    expect(sim.controls.helmMode).toBe('manual');
  });

  it('a tiller springing back to centre after T is not a takeover: the crew completes the tack (N1)', () => {
    const sim = crewSim({ wind: wind(12, -45), boat: { u: 2.5 }, controls: { helmMode: 'twa', helmTarget: -45 * DEG } });
    const crew = sim.crew as AutoCrew;
    run(sim, 30);
    sim.controls.helmMode = 'manual';
    sim.controls.tiller = -0.6; // the learner is putting the tiller over…
    sim.controls.command = 'tack'; // …presses T…
    sim.step();
    expect(crew.maneuver).toBe('tack');
    const events: SimEvent[] = [];
    // …and lets go of the key: the keyboard tiller self-centres over ~0.3 s.
    for (let i = 0; i < Math.round(20 / DT); i++) {
      sim.controls.tiller = Math.min(0, sim.controls.tiller + (DT / 0.3) * 0.6);
      sim.step();
      events.push(...sim.snapshot().events);
    }
    expect(crew.learnerHelm).toBe(false);
    expect(events.some((e) => e.type === 'tackComplete')).toBe(true);
    expect(sim.twa).toBeGreaterThan(0); // on the new tack
  });

  it('changing the helm mode mid-gybe takes the helm too', () => {
    const sim = crewSim({ wind: wind(12, 150), boat: { u: 3 }, controls: { helmMode: 'twa', helmTarget: 150 * DEG } });
    const crew = sim.crew as AutoCrew;
    run(sim, 10);
    sim.controls.command = 'gybe';
    run(sim, 2);
    sim.controls.helmMode = 'heading';
    sim.controls.helmTarget = sim.boat.psi;
    sim.step();
    expect(crew.learnerHelm).toBe(true);
    run(sim, 20);
    expect(sim.controls.helmMode).toBe('heading'); // the crew never switches it back
    expect(sim.rudderOverride).toBe(null);
  });

  it('every phase has a timeout: a 3 kn tack with the tiller held centred ends with every override released', () => {
    const sim = crewSim({ wind: wind(3, 40), boat: { u: 1.4 }, controls: { helmMode: 'twa', helmTarget: 40 * DEG } });
    const crew = sim.crew as AutoCrew;
    run(sim, 3);
    sim.controls.helmMode = 'manual';
    sim.controls.tiller = 0;
    sim.controls.command = 'tack';
    sim.step();
    expect(crew.maneuver).toBe('tack');
    let endT = -1;
    for (let i = 0; i < Math.round((PHASE_TIMEOUT.turn + PHASE_TIMEOUT.settle + 2) / DT); i++) {
      sim.controls.tiller = 0; // held centred throughout
      sim.step();
      if (crew.maneuver === null) { endT = i * DT; break; }
    }
    expect(endT).toBeGreaterThan(0);
    expect(sim.rudderOverride).toBe(null);
    expect(sim.controls.helmMode).toBe('manual');
  });
});

describe('furling with the jib on auto-trim (I7)', () => {
  it('the learner\'s furl stands; the crew only furls/unfurls on a hoist or douse', () => {
    const sim = crewSim({ wind: wind(12, 140), boat: { u: 3 }, controls: { helmMode: 'twa', helmTarget: 140 * DEG } });
    run(sim, 2);
    sim.controls.jibFurl = 1;
    run(sim, 30);
    expect(sim.controls.jibFurl).toBe(1);
    expect(sim.jib.furl).toBeGreaterThan(0.97);
    // Unfurl, hoist: the crew rolls the jib away under the kite …
    sim.controls.jibFurl = 0;
    run(sim, 5);
    sim.controls.spinHoist = true;
    run(sim, 10);
    expect(sim.spin.hoist).toBe(1);
    expect(sim.controls.jibFurl).toBe(1);
    // … and out again for the drop.
    sim.controls.spinHoist = false;
    run(sim, 8);
    expect(sim.spin.hoist).toBe(0);
    expect(sim.controls.jibFurl).toBe(0);
    // After the douse the learner's furl wins again.
    sim.controls.jibFurl = 1;
    run(sim, 10);
    expect(sim.controls.jibFurl).toBe(1);
  });
});

describe('crash gybe events (M12)', () => {
  for (const tws of [8, 12]) {
    it(`${tws} kn: steering by the lee without calling a gybe slams the boom across — a crash gybe`, () => {
      for (const target of [-172, -160]) {
        const sim = crewSim({ wind: { ...wind(tws, 160), seed: 4 }, boat: { u: 3 }, controls: { helmMode: 'twa', helmTarget: 160 * DEG } });
        run(sim, 20);
        sim.controls.helmTarget = target * DEG;
        const events = run(sim, 30);
        expect(events.some((e) => e.type === 'crashGybe'), `to ${target}`).toBe(true);
      }
    });
  }

  for (const tws of [12, 20]) {
    it(`${tws} kn: a crew-controlled gybe is not a crash gybe`, () => {
      const sim = crewSim({ wind: wind(tws, 150), boat: { u: 3 }, controls: { helmMode: 'twa', helmTarget: 150 * DEG } });
      run(sim, 20);
      sim.controls.command = 'gybe';
      const events = run(sim, 40);
      expect(events.some((e) => e.type === 'gybeComplete')).toBe(true);
      expect(events.some((e) => e.type === 'crashGybe')).toBe(false);
    });
  }
});
