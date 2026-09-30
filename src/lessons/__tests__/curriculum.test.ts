// Curriculum tests (spec §11, Task 18). Every lesson runs in the real lessons engine against the real
// simulation and auto-crew (no rendering), the way a learner meets it:
//  • setup, and every step's onEnter / tick / check / hint, run without throwing (the engine reports errors via
//    console);
//  • a learner who does nothing never completes a task: idle for at least 60 s (longer for long tasks, below);
//  • pressing "Show me" then completes every task step (holdSeconds included) within 90 s of simulated time
//    (longer only where stated) — proof that each task is achievable in the actual physics;
//  • the same two checks hold when the learner skipped the steps before it (curriculum-skip.test.ts).
// Plus static checks (ids, order, texts, glossary references, controls/cameras/overlays, quizzes) and focused
// tests of the manoeuvre detectors, Show-me takeover, lessons 5, 16 and 18. The harness is curriculum-harness.ts.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Simulation } from '../../sim/simulation';
import type { ScenarioInit, SimSnapshot } from '../../sim/types';
import { optimalVmg, type PolarTable } from '../../sim/polarTable';
import polars from '../../sim/data/polars.json';
import { glossaryRefs } from '../glossary';
import { CAMERA_KEYS, CONTROL_GROUPS, CONTROL_KEYS, OVERLAY_KEYS } from '../types';
import { CURRICULUM } from '../curriculum';
import { LAB_SCENARIO, inMaxDriveWindow } from '../curriculum/05-sail-is-a-wing';
import { fromDeg, fromKn, TackWatch, type TackResult } from '../curriculum/helpers';
import { MARK_DISTANCE, REACHED_M, TARGET_TIME, TWD } from '../curriculum/18-sailing-smart';
import {
  IDLE_FRAME, LONG_IDLE_S, LONG_SHOW_ME_S, PENDING_SIM_FIX, SPEC_ORDER, gotoStep, playLesson, stepKey,
} from './curriculum-harness';

describe('curriculum: structure and texts', () => {
  it('has the 18 lessons of spec §11.2, in order, with unique kebab-case ids', () => {
    expect(CURRICULUM.map((l) => l.id)).toEqual(SPEC_ORDER);
    expect(new Set(CURRICULUM.map((l) => l.id)).size).toBe(CURRICULUM.length);
    for (const l of CURRICULUM) expect(l.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it('gives every lesson a module, title, summary and steps; every step a title and a body', () => {
    for (const l of CURRICULUM) {
      expect(l.module.trim(), l.id).not.toBe('');
      expect(l.title.trim(), l.id).not.toBe('');
      expect(l.summary.trim(), l.id).not.toBe('');
      expect(l.steps.length, l.id).toBeGreaterThan(1);
      l.steps.forEach((s, i) => {
        expect(s.title.trim(), `${l.id} step ${i + 1}`).not.toBe('');
        expect(s.body.trim().length, `${l.id} step ${i + 1} body`).toBeGreaterThan(40);
      });
    }
  });

  it('gives every task a label, a hint and a Show me, and every lesson at least one task', () => {
    for (const l of CURRICULUM) {
      expect(l.steps.some((s) => s.task), l.id).toBe(true);
      l.steps.forEach((s, i) => {
        if (!s.task) return;
        const where = `${l.id} step ${i + 1}`;
        expect(s.task.label.trim(), where).not.toBe('');
        expect(typeof s.hint, where).toBe('function');
        expect(typeof s.showMe, where).toBe('function');
        if (s.task.holdSeconds !== undefined) expect(s.task.holdSeconds, where).toBeGreaterThan(0);
      });
    }
  });

  it('uses only known cameras, overlays and control names', () => {
    const controlNames = new Set<string>([...CONTROL_KEYS, ...Object.keys(CONTROL_GROUPS)]);
    for (const l of CURRICULUM) {
      l.steps.forEach((s, i) => {
        const where = `${l.id} step ${i + 1}`;
        if (s.camera) expect(CAMERA_KEYS, where).toContain(s.camera);
        for (const k of Object.keys(s.overlays ?? {})) expect(OVERLAY_KEYS, where).toContain(k);
        for (const c of s.controls ?? []) expect(controlNames.has(c), `${where}: control "${c}"`).toBe(true);
      });
    }
  });

  it('resolves every [[glossary]] reference in bodies, task labels and quizzes', () => {
    for (const l of CURRICULUM) {
      const texts = [l.summary, ...l.steps.flatMap((s) => [s.body, s.task?.label ?? ''])];
      for (const q of l.quiz ?? []) texts.push(q.q, q.why, ...q.options);
      for (const t of texts) for (const r of glossaryRefs(t)) expect(r.entry, `${l.id}: [[${r.key}]]`).toBeDefined();
    }
  });

  it('has well-formed quizzes', () => {
    for (const l of CURRICULUM) {
      for (const q of l.quiz ?? []) {
        expect(q.options.length, `${l.id}: ${q.q}`).toBeGreaterThanOrEqual(2);
        expect(Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length, `${l.id}: ${q.q}`).toBe(true);
        expect(q.why.trim(), `${l.id}: ${q.q}`).not.toBe('');
      }
    }
  });
});

describe('curriculum: every lesson is playable in the real simulation', () => {
  let errors: MockInstance;
  let warnings: MockInstance;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
    warnings.mockRestore();
  });

  for (const lesson of CURRICULUM) {
    const pending = PENDING_SIM_FIX[lesson.id];
    const title = `${lesson.id}: setup, steps and hints run; every Show me completes its task${pending ? ` (pending sim fix ${pending})` : ''}`;
    (pending ? it.skip : it)(title, () => {
      const { hints, app } = playLesson(lesson);
      expect(errors.mock.calls.map((c) => c.map(String).join(' ')), `${lesson.id}: errors thrown inside the lesson`).toEqual([]);
      expect(warnings.mock.calls.map((c) => String(c[0])), `${lesson.id}: engine warnings`).toEqual([]);
      for (const h of hints) for (const r of glossaryRefs(h)) expect(r.entry, `${lesson.id} hint: [[${r.key}]]`).toBeDefined();
      const b = app.sim.boat;
      for (const v of [b.e, b.n, b.psi, b.u, b.v, b.r, b.phi, b.p]) expect(Number.isFinite(v), `${lesson.id}: sim state`).toBe(true);
    }, 120_000);
  }

  it('lists long idle windows and budgets only for steps that exist', () => {
    const keys = new Set(CURRICULUM.flatMap((l) => l.steps.map((st) => stepKey(l, st))));
    for (const k of [...Object.keys(LONG_IDLE_S), ...Object.keys(LONG_SHOW_ME_S)]) expect(keys.has(k), k).toBe(true);
  });
});

describe('TackWatch', () => {
  /** Just the snapshot fields TackWatch reads. */
  const at = (t: number, twaDeg: number, kn: number): SimSnapshot =>
    ({ t, wind: { twa: fromDeg(twaDeg) }, boat: { speed: fromKn(kn) } }) as unknown as SimSnapshot;

  it('takes the entry speed from before a slow pinch into the tack, so pinching is not flattered', () => {
    const w = new TackWatch();
    let t = 0;
    const feed = (dur: number, twa0: number, twa1: number, v0: number, v1: number) => {
      let r: TackResult | null = null;
      for (let i = 0; i <= dur * 10; i++) {
        const f = i / (dur * 10);
        r = w.update(at(t, twa0 + (twa1 - twa0) * f, v0 + (v1 - v0) * f)) ?? r;
        t += 0.1;
      }
      return r;
    };
    feed(10, 45, 45, 5.5, 5.5); // settled close-hauled
    feed(6, 45, 33, 5.5, 4.2); // pinching slowly up toward the wind
    expect(feed(4, 33, -35, 4.2, 3.2)).toBeNull(); // through the wind
    const r = feed(6, -35, -45, 3.2, 4.5); // accelerating on the new tack
    expect(r).not.toBeNull();
    expect(r!.entry).toBeCloseTo(5.5, 1);
    expect(r!.min).toBeCloseTo(3.2, 1);
    expect(r!.ratio).toBeLessThan(0.6);
  });
});

describe('Show me hands the controls back', () => {
  it('stops demonstrating as soon as the learner takes the helm', () => {
    const { app, panel, runner, drive } = gotoStep('tacking', 'Three good tacks');
    runner.showMe();
    // Let the crew tack once, then grab the tiller between tacks.
    let tacked = false;
    drive.run(60, () => {
      const m = app.sim.snapshot().maneuver;
      if (m === 'tack') tacked = true;
      return tacked && m === null;
    });
    expect(tacked).toBe(true);
    app.controls.helmMode = 'manual';
    app.controls.tiller = 0;
    let tackedAgain = false;
    drive.run(40, () => { tackedAgain ||= app.sim.snapshot().maneuver === 'tack'; return false; });
    expect(tackedAgain, 'the demo kept tacking after the learner took the helm').toBe(false);
    expect(panel.task?.done).toBe(false);
  }, 30_000);
});

describe('lesson 18: the race to the windward mark', () => {
  const RACE = 'Race to the windward mark';

  it('places a windward mark 500 m dead upwind of the start, turns the laylines on, and derives the target time from the polar', () => {
    const { app } = gotoStep('sailing-smart', RACE);
    expect(app.marks.length).toBe(1);
    const m = app.marks[0]!;
    expect(m.kind).toBe('windward');
    expect(Math.hypot(m.e, m.n)).toBeCloseTo(MARK_DISTANCE, 6);
    expect(Math.atan2(m.e, m.n)).toBeCloseTo(fromDeg(TWD - 360), 6); // dead upwind: along the wind's direction
    expect(app.overlayState.laylines).toBe(true);
    expect(REACHED_M).toBe(25);
    const bestVmg = fromKn(optimalVmg(polars as PolarTable, 12, true).vmg);
    expect(TARGET_TIME).toBe(Math.ceil((1.35 * MARK_DISTANCE) / bestVmg));
  });

  it('sends a boat that runs out of time back to the start for another attempt', () => {
    const { app, panel, runner, drive } = gotoStep('sailing-smart', RACE);
    // Reach across the course instead of beating: no progress toward the mark.
    app.controls.helmMode = 'twa';
    app.controls.helmTarget = fromDeg(95);
    const firstSim = app.sim;
    drive.run(TARGET_TIME + 3, undefined, IDLE_FRAME);
    expect(app.sim).not.toBe(firstSim);
    expect(Math.hypot(app.sim.boat.e, app.sim.boat.n)).toBeLessThan(40);
    expect(app.marks.length).toBe(1);
    expect(panel.task?.done).toBe(false);
    runner.requestHint();
    expect(panel.hints[panel.hints.length - 1]).toMatch(/attempt 2/);
  }, 60_000);

  // The idle learner — autopilot on the beating angle, never tacking — is the playthrough's 600 s idle window
  // for this step (LONG_IDLE_S): one long tack sails past a mark dead upwind.
});

describe('lesson 16: the broach demonstration', () => {
  it('rounds up on its own, and Back to the task restores the 10 kn breeze with the spinnaker flying', () => {
    const { app, runner, drive } = gotoStep('spinnaker-reaching-running', 'Broaching');
    const from = drive.events.length;
    drive.run(15, () => drive.events.slice(from).some((e) => e.type === 'roundUp'));
    expect(drive.events.slice(from).some((e) => e.type === 'roundUp'), 'a roundUp event after entering the step').toBe(true);
    runner.back();
    drive.run(10);
    expect(app.sim.wind.settings.tws).toBeCloseTo(fromKn(10), 6);
    const k = app.sim.snapshot().sails.spinnaker;
    expect(k.hoist).toBeGreaterThan(0.95);
    expect(k.collapsed).toBeLessThan(0.05);
  }, 30_000);
});

describe('lesson 5: the "maximum drive" window really is the maximum', () => {
  it('every trim that passes the check makes at least 90 % of the best drive on the lab beam reach', () => {
    const rows: { sheet: number; drive: number; ok: boolean }[] = [];
    for (let sheet = 0.25; sheet <= 0.6 + 1e-9; sheet += 0.01) {
      const init: ScenarioInit = { ...LAB_SCENARIO, controls: { ...LAB_SCENARIO.controls, mainSheet: sheet } };
      const sim = new Simulation(init);
      for (let i = 0; i < 8 * 120; i++) sim.step();
      const s = sim.snapshot();
      rows.push({ sheet, drive: s.sails.main.drive, ok: inMaxDriveWindow(s) });
    }
    const best = Math.max(...rows.map((r) => r.drive));
    const inWindow = rows.filter((r) => r.ok);
    expect(inWindow.length).toBeGreaterThan(0);
    for (const r of inWindow) expect(r.drive, `sheet ${r.sheet.toFixed(2)}`).toBeGreaterThanOrEqual(0.9 * best);
    expect(LAB_SCENARIO.towed?.speed).toBeCloseTo(fromKn(5));
  }, 30_000);
});
