// Curriculum tests (spec §11, Task 18). Every lesson runs in the real lessons engine against the real
// simulation and auto-crew (no rendering), the way a learner meets it:
//  • setup, and every step's onEnter / check / hint, run without throwing (the engine reports errors via console);
//  • a task step is never completed by a learner who does nothing for 5 s;
//  • pressing "Show me" completes every task step (holdSeconds included) within 90 s of simulated time —
//    proof that each task is achievable in the actual physics.
// Plus static checks: ids, order, texts, glossary references, controls/cameras/overlays, quizzes.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Simulation } from '../../sim/simulation';
import { AutoCrew } from '../../sim/autocrew';
import type { ScenarioInit, WindSettings } from '../../sim/types';
import { LessonRunner } from '../engine';
import { glossaryRefs } from '../glossary';
import {
  CAMERA_KEYS, CONTROL_GROUPS, CONTROL_KEYS, OVERLAY_KEYS,
  type AppApi, type CameraKey, type Lesson, type LessonActions, type LessonView, type LessonViewModel, type OverlayKey,
  type TaskStatus,
} from '../types';
import { CURRICULUM } from '../curriculum';
import { LAB_SCENARIO, inMaxDriveWindow } from '../curriculum/05-sail-is-a-wing';
import { fromDeg, fromKn, sailing } from '../curriculum/helpers';
import { RACE_TIME } from '../curriculum/18-sailing-smart';

/** The spec §11.2 order. */
const SPEC_ORDER = [
  'meet-the-boat', 'finding-the-wind', 'points-of-sail', 'apparent-wind', 'sail-is-a-wing', 'drive-and-heel',
  'jib-telltales', 'mainsail-trim', 'main-and-jib', 'keel-and-balance', 'tacking', 'out-of-irons', 'gybing',
  'running', 'spinnaker-basics', 'spinnaker-reaching-running', 'spinnaker-gybe-douse', 'sailing-smart',
];

/**
 * Lessons whose "Show me" run is blocked only by a known sim defect from the lead's 2026-09-29 review
 * (a fix round is landing separately). Re-enable each one when its fix is in main.
 */
const PENDING_SIM_FIX: Readonly<Record<string, string>> = {
  // C1: switching the whisker pole on while running yanks the jib across; the sim blows up to NaN within ~2 s.
  running: 'C1',
};

const FRAME = 1 / 60;
const IDLE_S = 5;
const SHOW_ME_S = 90;

// ---- a small App backed by the real simulation ------------------------------------------------------

class SimApp implements AppApi {
  sim: Simulation;
  camera: CameraKey = 'chase';
  readonly overlayState = Object.fromEntries(OVERLAY_KEYS.map((k) => [k, false])) as Record<OverlayKey, boolean>;

  constructor(init: ScenarioInit) {
    this.sim = SimApp.make(init);
  }

  private static make(init: ScenarioInit): Simulation {
    const s = new Simulation(init);
    s.crew = new AutoCrew();
    return s;
  }

  get controls() { return this.sim.controls; }
  set controls(c) { this.sim.controls = c; }
  setMode(): void {}
  setCamera(c: CameraKey): void { this.camera = c; }
  setOverlay(k: OverlayKey, on: boolean): void { this.overlayState[k] = on; }
  overlays(): Record<OverlayKey, boolean> { return { ...this.overlayState }; }
  setWind(p: Partial<WindSettings>): void { this.sim.setWind(p); }
  setTimeOfDay(): void {}
  setTimeScale(): void {}
  togglePause(): void {}
  setQuality(): void {}
  setSound(): void {}
  scenario(init: ScenarioInit): void { this.sim = SimApp.make(init); }
  startLesson(): void {}
}

class Panel implements LessonView {
  actions!: LessonActions;
  model: LessonViewModel | null = null;
  task: TaskStatus | null = null;
  readonly hints: string[] = [];
  bind(a: LessonActions): void { this.actions = a; }
  render(m: LessonViewModel): void { this.model = m; }
  setTask(s: TaskStatus): void { this.task = s; }
  setHint(t: string | null): void { if (t !== null) this.hints.push(t); }
}

class Driver {
  constructor(readonly app: SimApp, readonly runner: LessonRunner) {}

  frame(): void {
    const sim = this.app.sim;
    sim.step();
    sim.step();
    this.runner.update(sim.snapshot(), FRAME);
  }

  /** Run up to `seconds` of simulated time; returns the time at which `stop()` became true, else null. */
  run(seconds: number, stop?: () => boolean): number | null {
    const n = Math.round(seconds / FRAME);
    for (let i = 1; i <= n; i++) {
      this.frame();
      if (stop?.()) return i * FRAME;
    }
    return null;
  }
}

/** Play a lesson like a learner who reads each step for 5 s, then presses Show me on every task. */
function playLesson(lesson: Lesson): { hints: string[]; app: SimApp } {
  const app = new SimApp(sailing({ twsKn: 10, twa: 90 }));
  const panel = new Panel();
  const runner = new LessonRunner([lesson], app, panel, { storage: null, advanceDelay: 0.25, hintAfter: 1e9 });
  const drive = new Driver(app, runner);
  runner.start(lesson.id);
  drive.frame(); // the first snapshot starts the lesson: setup + step 1

  lesson.steps.forEach((st, i) => {
    const where = `${lesson.id} step ${i + 1} "${st.title}"`;
    expect(runner.activeStepIndex, `${where}: not the active step`).toBe(i);
    runner.requestHint(); // from now on the step's hint() is re-evaluated every second
    if (!st.task) {
      drive.run(IDLE_S);
      expect(runner.activeStepIndex, `${where}: a narrative step advanced by itself`).toBe(i);
      runner.next();
      return;
    }
    const idle = drive.run(IDLE_S, () => panel.task?.done === true);
    expect(idle, `${where}: completed without the learner doing anything`).toBeNull();
    runner.showMe();
    const t = drive.run(SHOW_ME_S, () => panel.task?.done === true);
    expect(t, `${where}: "Show me" did not complete the task within ${SHOW_ME_S} s`).not.toBeNull();
    const moved = drive.run(2, () => runner.activeStepIndex !== i);
    expect(moved, `${where}: the runner did not move on after success`).not.toBeNull();
  });

  expect(runner.currentPhase).toBe(lesson.quiz?.length ? 'quiz' : 'complete');
  return { hints: panel.hints, app };
}

// ---- tests ---------------------------------------------------------------------------------------------

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
    }, 60_000);
  }
});

/** Skip straight past the first `k` steps (pressing Next after 1 s each), then press Show me on step k. */
function showMeAfterSkipping(lesson: Lesson, k: number): number | null {
  const app = new SimApp(sailing({ twsKn: 10, twa: 90 }));
  const panel = new Panel();
  const runner = new LessonRunner([lesson], app, panel, { storage: null, advanceDelay: 0.25, hintAfter: 1e9 });
  const drive = new Driver(app, runner);
  runner.start(lesson.id);
  drive.frame();
  for (let i = 0; i < k; i++) {
    drive.run(1);
    runner.next();
  }
  expect(runner.activeStepIndex).toBe(k);
  drive.run(0.5);
  runner.showMe();
  return drive.run(SHOW_ME_S, () => panel.task?.done === true);
}

describe('curriculum: every Show me also works after skipping the steps before it', () => {
  for (const lesson of CURRICULUM) {
    const pending = PENDING_SIM_FIX[lesson.id];
    lesson.steps.forEach((st, k) => {
      if (!st.task || k === 0) return;
      (pending ? it.skip : it)(`${lesson.id} step ${k + 1} "${st.title}"${pending ? ` (pending sim fix ${pending})` : ''}`, () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const t = showMeAfterSkipping(lesson, k);
          expect(t, `${lesson.id} step ${k + 1}: Show me did not complete the task within ${SHOW_ME_S} s after skipping`).not.toBeNull();
          expect(errors.mock.calls.length, `${lesson.id} step ${k + 1}: errors`).toBe(0);
        } finally {
          errors.mockRestore();
        }
      }, 30_000);
    });
  }
});

describe('lesson 18: the race', () => {
  it('sends a boat that runs out of time back to the start line for another attempt', () => {
    const lesson = CURRICULUM.find((l) => l.id === 'sailing-smart')!;
    const raceStep = lesson.steps.findIndex((st) => st.title.startsWith('Race'));
    const app = new SimApp(sailing({ twsKn: 10, twa: 90 }));
    const panel = new Panel();
    const runner = new LessonRunner([lesson], app, panel, { storage: null, advanceDelay: 0.25, hintAfter: 1e9 });
    const drive = new Driver(app, runner);
    runner.start(lesson.id);
    drive.frame();
    for (let i = 0; i < raceStep; i++) runner.next();
    drive.run(1);
    // Reach across the course instead of beating: no progress upwind.
    app.controls.helmMode = 'twa';
    app.controls.helmTarget = fromDeg(95);
    const firstSim = app.sim;
    drive.run(RACE_TIME + 3);
    expect(app.sim).not.toBe(firstSim);
    expect(Math.hypot(app.sim.boat.e, app.sim.boat.n)).toBeLessThan(40);
    expect(panel.task?.done).toBe(false);
    runner.requestHint();
    expect(panel.hints[panel.hints.length - 1]).toMatch(/attempt 2/);
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
