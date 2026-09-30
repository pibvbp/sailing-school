// Test harness for the curriculum suites: a small App backed by the real Simulation + AutoCrew, a fake lesson
// panel, a frame driver, and the idle windows and "Show me" budgets every task step is held to.
import { expect } from 'vitest';
import { Simulation } from '../../sim/simulation';
import { AutoCrew } from '../../sim/autocrew';
import type { ScenarioInit, SimEvent, WindSettings } from '../../sim/types';
import { LessonRunner } from '../engine';
import {
  OVERLAY_KEYS,
  type AppApi, type CameraKey, type Lesson, type LessonActions, type LessonView, type LessonViewModel, type OverlayKey,
  type MarkSpec, type Step, type TaskStatus,
} from '../types';
import { CURRICULUM } from '../curriculum';
import { sailing } from '../curriculum/helpers';

/** The spec §11.2 order. */
export const SPEC_ORDER = [
  'meet-the-boat', 'finding-the-wind', 'points-of-sail', 'apparent-wind', 'sail-is-a-wing', 'drive-and-heel',
  'jib-telltales', 'mainsail-trim', 'main-and-jib', 'keel-and-balance', 'tacking', 'out-of-irons', 'gybing',
  'running', 'spinnaker-basics', 'spinnaker-reaching-running', 'spinnaker-gybe-douse', 'sailing-smart',
];

/**
 * Lessons whose "Show me" run is blocked only by a known sim defect (lesson id → finding id); their playthroughs
 * are skipped until the fix is in. Empty since the 2026-09-30 physics fix round (C1, lesson 14, is fixed).
 */
export const PENDING_SIM_FIX: Readonly<Record<string, string>> = {};

export const FRAME = 1 / 60;
/** Idle stretches run at 30 Hz: the check still runs every frame, the sim still steps at 120 Hz. */
export const IDLE_FRAME = 1 / 30;
/** A narrative step is read for this long before Next. */
export const READ_S = 5;
/** An idle learner must not complete a task within max(60 s, holdSeconds + 60 s) … */
export const MIN_IDLE_S = 60;
/** … or longer, for tasks that naturally take longer. Keys: `lesson id › step title`. */
export const LONG_IDLE_S: Readonly<Record<string, number>> = {
  'tacking › Three good tacks': 120, // three tacks take about 40 s
  'gybing › Two clean gybes': 120, // two gybes take about 35 s
  'spinnaker-reaching-running › Reach, run, reach': 120,
  'sailing-smart › Race to the windward mark': 600, // one long tack never reaches a mark dead upwind
};
/** "Show me" must complete a task within this much sim time … */
export const SHOW_ME_S = 90;
/** … except where stated. */
export const LONG_SHOW_ME_S: Readonly<Record<string, number>> = {
  'sailing-smart › Race to the windward mark': 420, // 500 m to windward in shifty wind; see the lesson 18 tests
};

export const stepKey = (l: Lesson, st: Step): string => `${l.id} › ${st.title}`;
export const idleWindow = (l: Lesson, st: Step): number =>
  LONG_IDLE_S[stepKey(l, st)] ?? Math.max(MIN_IDLE_S, (st.task?.holdSeconds ?? 0) + 60);
export const showMeBudget = (l: Lesson, st: Step): number => LONG_SHOW_ME_S[stepKey(l, st)] ?? SHOW_ME_S;

// ---- a small App backed by the real simulation ------------------------------------------------------

export class SimApp implements AppApi {
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
  marks: readonly MarkSpec[] = [];
  setMarks(m: readonly MarkSpec[]): void { this.marks = m; }
}

export class Panel implements LessonView {
  actions!: LessonActions;
  model: LessonViewModel | null = null;
  task: TaskStatus | null = null;
  readonly hints: string[] = [];
  bind(a: LessonActions): void { this.actions = a; }
  render(m: LessonViewModel): void { this.model = m; }
  setTask(s: TaskStatus): void { this.task = s; }
  setHint(t: string | null): void { if (t !== null) this.hints.push(t); }
}

export class Driver {
  /** Every sim event seen, in order. */
  readonly events: SimEvent[] = [];
  constructor(readonly app: SimApp, readonly runner: LessonRunner) {}

  frame(dt = FRAME): void {
    const sim = this.app.sim;
    for (let i = Math.round(dt * 120); i > 0; i--) sim.step();
    const snap = sim.snapshot();
    this.events.push(...snap.events);
    this.runner.update(snap, dt);
  }

  /** Run up to `seconds` of simulated time; returns the time at which `stop()` became true, else null. */
  run(seconds: number, stop?: () => boolean, dt = FRAME): number | null {
    const n = Math.round(seconds / dt);
    for (let i = 1; i <= n; i++) {
      this.frame(dt);
      if (stop?.()) return i * dt;
    }
    return null;
  }
}

export function startLesson(lesson: Lesson): { app: SimApp; panel: Panel; runner: LessonRunner; drive: Driver } {
  const app = new SimApp(sailing({ twsKn: 10, twa: 90 }));
  const panel = new Panel();
  const runner = new LessonRunner([lesson], app, panel, { storage: null, advanceDelay: 0.25, hintAfter: 1e9 });
  const drive = new Driver(app, runner);
  runner.start(lesson.id);
  drive.frame(); // the first snapshot starts the lesson: setup + step 1
  return { app, panel, runner, drive };
}

/**
 * The learner does nothing for the step's idle window: the task must not complete. Then "Show me" must
 * complete it within the step's budget. Returns the Show-me time.
 */
export function idleThenShowMe(lesson: Lesson, i: number, panel: Panel, runner: LessonRunner, drive: Driver): number {
  const st = lesson.steps[i]!;
  const where = `${lesson.id} step ${i + 1} "${st.title}"`;
  const idle = idleWindow(lesson, st);
  const early = drive.run(idle, () => panel.task?.done === true, IDLE_FRAME);
  expect(early, `${where}: completed after ${early?.toFixed(1)} s without the learner doing anything`).toBeNull();
  runner.showMe();
  const budget = showMeBudget(lesson, st);
  const t = drive.run(budget, () => panel.task?.done === true);
  expect(t, `${where}: "Show me" did not complete the task within ${budget} s`).not.toBeNull();
  return t!;
}

/** Play a lesson like a learner who reads each step, idles on every task, then presses Show me. */
export function playLesson(lesson: Lesson): { hints: string[]; app: SimApp } {
  const { app, panel, runner, drive } = startLesson(lesson);
  lesson.steps.forEach((st, i) => {
    const where = `${lesson.id} step ${i + 1} "${st.title}"`;
    expect(runner.activeStepIndex, `${where}: not the active step`).toBe(i);
    runner.requestHint(); // from now on the step's hint() is re-evaluated every second
    if (!st.task) {
      drive.run(READ_S);
      expect(runner.activeStepIndex, `${where}: a narrative step advanced by itself`).toBe(i);
      runner.next();
      return;
    }
    idleThenShowMe(lesson, i, panel, runner, drive);
    const moved = drive.run(2, () => runner.activeStepIndex !== i);
    expect(moved, `${where}: the runner did not move on after success`).not.toBeNull();
  });
  expect(runner.currentPhase).toBe(lesson.quiz?.length ? 'quiz' : 'complete');
  return { hints: panel.hints, app };
}

// ---- tests ---------------------------------------------------------------------------------------------

/** Skip straight past the first `k` steps (pressing Next after 1 s each), then idle and press Show me. */
export function afterSkipping(lesson: Lesson, k: number): void {
  const { panel, runner, drive } = startLesson(lesson);
  for (let i = 0; i < k; i++) {
    drive.run(1);
    runner.next();
  }
  expect(runner.activeStepIndex).toBe(k);
  idleThenShowMe(lesson, k, panel, runner, drive);
}

/** Start a lesson and press Next until the step titled `title` is active. */
export function gotoStep(lessonId: string, title: string): ReturnType<typeof startLesson> & { lesson: Lesson; index: number } {
  const lesson = CURRICULUM.find((l) => l.id === lessonId)!;
  const index = lesson.steps.findIndex((st) => st.title === title);
  expect(index, `${lessonId}: step "${title}"`).toBeGreaterThanOrEqual(0);
  const ctx = startLesson(lesson);
  for (let i = 0; i < index; i++) ctx.runner.next();
  ctx.drive.frame();
  expect(ctx.runner.activeStepIndex).toBe(index);
  return { ...ctx, lesson, index };
}
