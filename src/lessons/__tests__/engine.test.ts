import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defaultControls, type SailState, type SimEvent, type SimSnapshot } from '../../sim/types';
import { EVENT_HINTS, LessonRunner, PROGRESS_KEY, ProgressStore, expandControls } from '../engine';
import { GLOSSARY, glossaryRefs, lookupTerm, stripGlossary } from '../glossary';
import {
  OVERLAY_KEYS,
  type AppApi, type Lesson, type LessonActions, type LessonView, type LessonViewModel,
  type OverlayKey, type StorageLike, type TaskStatus,
} from '../types';

// ---- fixtures ------------------------------------------------------------------------------

const v3 = () => ({ x: 0, y: 0, z: 0 });
function blankSail<T extends SailState['id']>(id: T): SailState & { id: T } {
  return {
    id, set: true, area: 10, tack: v3(), clew: v3(), head: v3(), sections: [], force: v3(), ce: v3(),
    lift: 0, drag: 0, drive: 0, heelForce: 0, telltales: [],
  };
}

function blankSnapshot(): SimSnapshot {
  return {
    t: 0,
    boat: {
      pos: { x: 0, y: 0 }, heading: 0, heel: 0, yawRate: 0, rollRate: 0, u: 0, v: 0, speed: 0, cog: 0,
      leeway: 0, rudder: 0, vmg: 0, crewHike: 0,
    },
    wind: { tws: 6, twd: 0, twa: 0, aws: 6, awa: 0, awsDeck: 5, awaDeck: 0, puffs: [] },
    sails: {
      main: { ...blankSail('main'), boomAngle: 0, boomRate: 0, twistDeg: 0 },
      jib: { ...blankSail('jib'), clewAngle: 0, furl: 0, backed: false, whisker: false },
      spinnaker: { ...blankSail('spinnaker'), hoist: 0, poleAngle: 0, poleTip: v3(), poleHeight: 0, collapsed: 0, curl: 0 },
    },
    forces: {
      aero: { force: v3(), point: v3() }, drive: 0, sideForce: 0, keel: { force: v3(), point: v3() },
      rudder: { force: v3(), point: v3() }, resistance: 0, heelingMoment: 0, rightingMoment: 0, crewMoment: 0,
      cg: v3(), cb: v3(),
    },
    events: [],
    maneuver: null,
    towed: false,
  };
}

class FakePanel implements LessonView {
  actions!: LessonActions;
  models: LessonViewModel[] = [];
  task: TaskStatus | null = null;
  hints: (string | null)[] = [];
  bind(a: LessonActions): void { this.actions = a; }
  render(m: LessonViewModel): void { this.models.push(m); }
  setTask(s: TaskStatus): void { this.task = s; }
  setHint(t: string | null): void { this.hints.push(t); }
  get last(): LessonViewModel { return this.models[this.models.length - 1]!; }
  get hint(): string | null { return this.hints.length ? this.hints[this.hints.length - 1]! : null; }
}

type MockApp = AppApi & { calls: string[]; runner: LessonRunner | null; overlayState: Record<OverlayKey, boolean> };
function mockApp(): MockApp {
  const calls: string[] = [];
  const overlayState = Object.fromEntries(OVERLAY_KEYS.map((k) => [k, false])) as Record<OverlayKey, boolean>;
  const app: MockApp = {
    controls: defaultControls(),
    calls,
    runner: null,
    overlayState,
    setMode: (m) => { calls.push(`mode:${m}`); },
    setCamera: (c) => { calls.push(`camera:${c}`); },
    setOverlay: (k, on) => { overlayState[k] = on; calls.push(`overlay:${k}=${on}`); },
    overlays: () => ({ ...overlayState }),
    setWind: () => { calls.push('wind'); },
    setTimeOfDay: () => {},
    setTimeScale: () => {},
    togglePause: () => {},
    setQuality: () => {},
    setSound: () => {},
    scenario: () => { calls.push('scenario'); },
    startLesson: (id) => { calls.push(`start:${id}`); app.runner?.start(id); },
    setMarks: (m) => { calls.push(`marks:${m.map((x) => x.id).join(',')}`); },
  };
  return app;
}

class MemStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

class ThrowingStorage implements StorageLike {
  getItem(): string | null { throw new Error('SecurityError: storage disabled'); }
  setItem(): void { throw new Error('QuotaExceededError'); }
  removeItem(): void { throw new Error('SecurityError'); }
}

/** A tiny sim stand-in: the test mutates `s` then calls frame(). */
class Harness {
  readonly s = blankSnapshot();
  constructor(readonly runner: LessonRunner, readonly dt = 0.1) {}
  frame(n = 1, mutate?: (s: SimSnapshot) => void): void {
    for (let i = 0; i < n; i++) {
      this.s.t += this.dt;
      this.s.events = [];
      mutate?.(this.s);
      this.runner.update(this.s, this.dt);
    }
  }
  seconds(sec: number, mutate?: (s: SimSnapshot) => void): void {
    this.frame(Math.round(sec / this.dt), mutate);
  }
}

const KN = 0.514444;

function speedLesson(extra: Partial<Lesson> = {}): Lesson {
  return {
    id: 'speed',
    module: 'Basics',
    title: 'Go fast',
    summary: 'Get moving.',
    setup: (c) => c.app.scenario({ wind: { tws: 6, twd: 0, gustiness: 0, shiftAmplitude: 0, shiftPeriod: 120, seed: 1 } }),
    steps: [
      { title: 'Welcome', body: 'Meet the [[tiller]].' },
      {
        title: 'Speed up',
        body: 'Reach 4 knots.',
        camera: 'chase',
        overlays: { forces: true, wheel: false },
        controls: ['helm', 'jibSheet'],
        autoTrim: { jib: false },
        task: { label: 'Hold 4 kn for 3 s', holdSeconds: 3, check: (c) => c.snap.boat.speed >= 4 * KN },
        hint: (c) => (c.snap.boat.speed < 2 * KN ? 'Bear away to fill the sails.' : null),
      },
    ],
    ...extra,
  };
}

const QUIZ: Lesson['quiz'] = [
  { q: 'Which side is port?', options: ['Left', 'Right'], correct: 0, why: 'Port is left facing forward.' },
  { q: 'Upwind limit?', options: ['0°', '45°', '90°'], correct: 1, why: 'About 45° off the wind.' },
];

function setup(lessons: Lesson[], opts: { storage?: StorageLike | null; advanceDelay?: number; hintAfter?: number } = {}) {
  const app = mockApp();
  const panel = new FakePanel();
  const runner = new LessonRunner(lessons, app, panel, { storage: opts.storage ?? new MemStorage(), advanceDelay: opts.advanceDelay ?? 0.5, hintAfter: opts.hintAfter ?? 20 });
  app.runner = runner;
  const h = new Harness(runner);
  return { app, panel, runner, h };
}

// ---- tests ---------------------------------------------------------------------------------

describe('LessonRunner: starting and step entry', () => {
  it('renders the catalogue when idle', () => {
    const { panel } = setup([speedLesson()]);
    expect(panel.last.kind).toBe('idle');
    expect(panel.last.catalog.map((c) => c.id)).toEqual(['speed']);
  });

  it('defers start until the first snapshot, then runs setup and enters step 0', () => {
    const { app, panel, runner, h } = setup([speedLesson()]);
    runner.start('speed');
    expect(app.calls).not.toContain('scenario');
    h.frame();
    expect(app.calls).toContain('scenario');
    expect(panel.last.kind).toBe('step');
    if (panel.last.kind === 'step') {
      expect(panel.last.index).toBe(0);
      expect(panel.last.step.body).toContain('[[tiller]]');
      expect(panel.last.lesson).toMatchObject({ id: 'speed', number: 1, count: 1 });
    }
    expect(runner.activeLessonId).toBe('speed');
  });

  it('applies camera, overlays, auto-trim and live controls when a step is entered', () => {
    const { app, runner, h } = setup([speedLesson()]);
    h.frame();
    runner.start('speed');
    expect(runner.isLive('mainSheet')).toBe(true); // step 0 lists no controls → all live
    runner.next();
    expect(app.calls).toContain('camera:chase');
    expect(app.overlayState.forces).toBe(true);
    expect(app.calls).toContain('overlay:wheel=false');
    expect(app.controls.autoTrim.jib).toBe(false);
    expect(app.controls.autoTrim.main).toBe(true);
    expect(runner.isLive('tiller')).toBe(true);
    expect(runner.isLive('helmMode')).toBe(true);
    expect(runner.isLive('jibSheet')).toBe(true);
    expect(runner.isLive('mainSheet')).toBe(false);
    expect(runner.isLive('tack')).toBe(false);
    runner.exit();
    expect(runner.isLive('mainSheet')).toBe(true);
  });

  it('ignores unknown lesson ids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runner, h } = setup([speedLesson()]);
    h.frame();
    runner.start('nope');
    expect(runner.activeLessonId).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('calls onEnter/onExit in order and shares ctx.data across steps, reset per lesson', () => {
    const log: string[] = [];
    const lesson: Lesson = {
      id: 'l', module: 'M', title: 'T', summary: 'S',
      setup: (c) => { log.push(`setup:${JSON.stringify(c.data)}`); },
      steps: [
        { title: 'a', body: '', onEnter: (c) => { c.data['n'] = 1; log.push('enter:a'); }, onExit: () => log.push('exit:a') },
        { title: 'b', body: '', onEnter: (c) => { log.push(`enter:b:${String(c.data['n'])}`); }, onExit: () => log.push('exit:b') },
      ],
    };
    const { runner, h } = setup([lesson]);
    h.frame();
    runner.start('l');
    runner.next();
    runner.back();
    runner.start('l');
    expect(log).toEqual(['setup:{}', 'enter:a', 'exit:a', 'enter:b:1', 'exit:b', 'enter:a', 'exit:a', 'setup:{}', 'enter:a']);
  });
});

describe('LessonRunner: tasks', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup([speedLesson()]);
    ctx.h.frame();
    ctx.runner.start('speed');
    ctx.runner.next(); // → the task step
  });

  it('advances on success only after holdSeconds of continuous success', () => {
    const { panel, runner, h } = ctx;
    const fast = (s: SimSnapshot) => { s.boat.speed = 4.5 * KN; };
    const slow = (s: SimSnapshot) => { s.boat.speed = 3 * KN; };
    h.seconds(2, fast);
    expect(panel.task?.done).toBe(false);
    expect(panel.task?.progress).toBeGreaterThan(0.55);
    expect(panel.task?.held).toBeGreaterThan(1.5);
    h.frame(1, slow); // broken: the hold restarts
    expect(panel.task?.progress).toBe(0);
    h.seconds(2.5, fast);
    expect(panel.task?.done).toBe(false);
    h.seconds(0.6, fast);
    expect(panel.task?.done).toBe(true);
    expect(panel.task?.progress).toBe(1);
    expect(runner.currentPhase).toBe('step'); // short celebration pause before advancing
    h.seconds(0.6, fast);
    expect(runner.currentPhase).toBe('complete');
    expect(runner.progress()).toEqual({ speed: true });
  });

  it('does not count paused time (snapshot time frozen)', () => {
    const { panel, runner } = ctx;
    const s = ctx.h.s;
    s.boat.speed = 5 * KN;
    for (let i = 0; i < 100; i++) runner.update(s, 0.1); // t never advances
    expect(panel.task?.done ?? false).toBe(false);
    expect(runner.currentPhase).toBe('step');
  });

  it('supports numeric progress checks and treats ≥ 1 as success', () => {
    let p = 0.25;
    const lesson: Lesson = {
      id: 'n', module: 'M', title: 'T', summary: 'S', setup: () => {},
      steps: [{ title: 'Three tacks', body: '', task: { label: 'Tack three times', check: () => p } }],
    };
    const { panel, runner, h } = setup([lesson], { advanceDelay: 0 });
    h.frame();
    runner.start('n');
    h.frame(2);
    expect(panel.task?.progress).toBeCloseTo(0.25);
    p = 2 / 3;
    h.frame();
    expect(panel.task?.progress).toBeCloseTo(2 / 3);
    p = 1;
    h.frame();
    expect(panel.task?.done).toBe(true);
    h.frame();
    expect(runner.currentPhase).toBe('complete');
  });

  it('does not evaluate the stale snapshot that predates a step', () => {
    const lesson: Lesson = {
      id: 'z', module: 'M', title: 'T', summary: 'S', setup: () => {},
      steps: [{ title: 'Instant', body: '', task: { label: 'x', check: (c) => c.snap.boat.speed > 1 } }],
    };
    const { panel, runner, h } = setup([lesson], { advanceDelay: 0 });
    h.s.boat.speed = 5;
    h.frame();
    runner.start('z');
    h.frame(1);
    expect(panel.task?.done).toBe(false);
    h.frame(1);
    expect(panel.task?.done).toBe(true);
  });

  it('ticks the active step every frame from its second frame until its task succeeds, never while paused', () => {
    const ticks: number[] = [];
    let ok = false;
    const lesson: Lesson = {
      id: 'k', module: 'M', title: 'T', summary: 'S', setup: () => {},
      steps: [
        { title: 'Ticking', body: '', tick: (c) => { ticks.push(c.t); }, task: { label: 'x', check: () => ok } },
        { title: 'Narrative', body: '', tick: () => { ticks.push(-1); } },
      ],
    };
    const { runner, h } = setup([lesson], { advanceDelay: 0 });
    h.frame();
    runner.start('k');
    h.frame(1);
    expect(ticks).toEqual([]); // the first frame of a step may predate it
    h.frame(3);
    expect(ticks.length).toBe(3);
    for (let i = 0; i < 5; i++) runner.update(h.s, 0.1); // paused: snapshot time frozen
    expect(ticks.length).toBe(3);
    ok = true;
    h.frame(1); // success: no tick after this frame's check
    const n = ticks.length;
    h.frame(1); // advances to the narrative step
    h.frame(3);
    expect(ticks.slice(0, n).every((t) => t > 0)).toBe(true);
    expect(ticks.slice(n)).toEqual([-1, -1]);
  });

  it('contains errors thrown by lesson code', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lesson: Lesson = {
      id: 'e', module: 'M', title: 'T', summary: 'S', setup: () => { throw new Error('bad setup'); },
      steps: [{ title: 'x', body: '', task: { label: 'x', check: () => { throw new Error('bad check'); } }, hint: () => { throw new Error('bad hint'); } }],
    };
    const { runner, h, panel } = setup([lesson]);
    h.frame();
    expect(() => runner.start('e')).not.toThrow();
    expect(() => h.frame(30)).not.toThrow();
    expect(() => runner.requestHint()).not.toThrow();
    expect(panel.hint).toBe('Goal: x.');
    expect(err).toHaveBeenCalled();
    // The same error is logged once per step, not every frame.
    expect(err.mock.calls.filter((c) => String(c[1]).includes('bad check')).length).toBe(1);
    err.mockRestore();
  });
});

describe('LessonRunner: hints', () => {
  it('shows the step hint on request, or the goal when hint() has nothing to say', () => {
    const { panel, runner, h } = setup([speedLesson()]);
    h.frame();
    runner.start('speed');
    runner.next();
    h.frame(2, (s) => { s.boat.speed = 1 * KN; });
    panel.actions.hint();
    expect(panel.hint).toBe('Bear away to fill the sails.');
    h.frame(15, (s) => { s.boat.speed = 3 * KN; }); // hint() now returns null → the goal text
    expect(panel.hint).toBe('Goal: Hold 4 kn for 3 s.');
  });

  it('offers a hint automatically after a stretch without progress', () => {
    const { panel, runner, h } = setup([speedLesson()], { hintAfter: 10 });
    h.frame();
    runner.start('speed');
    runner.next();
    h.seconds(9, (s) => { s.boat.speed = 1 * KN; });
    expect(panel.hint).toBeNull();
    h.seconds(1.5, (s) => { s.boat.speed = 1 * KN; });
    expect(panel.hint).toBe('Bear away to fill the sails.');
  });

  it('reacts to mistake events at once, with a fallback text when hint() returns null', () => {
    const lesson = speedLesson();
    lesson.steps[1]!.hint = () => null;
    const { panel, runner, h } = setup([lesson]);
    h.frame();
    runner.start('speed');
    runner.next();
    h.frame(2);
    const gybe: SimEvent = { type: 'crashGybe', t: h.s.t + 0.1 };
    h.frame(1, (s) => { s.events = [gybe]; });
    expect(panel.hint).toBe(EVENT_HINTS.crashGybe);
    // The same event object seen again (same snapshot passed twice) does not re-trigger.
    const before = panel.hints.length;
    runner.update({ ...h.s, events: [gybe] }, 0.1);
    expect(panel.hints.length).toBe(before);
    // Event hints expire.
    h.seconds(14);
    expect(panel.hint).toBeNull();
  });

  it('non-mistake events do not trigger hints', () => {
    const { panel, runner, h } = setup([speedLesson()]);
    h.frame();
    runner.start('speed');
    runner.next();
    h.frame(2);
    h.frame(1, (s) => { s.events = [{ type: 'tackComplete', t: s.t }]; });
    expect(panel.hint).toBeNull();
  });
});

describe('LessonRunner: navigation, skipping, quiz', () => {
  it('skipping a task step finishes the lesson without marking it complete', () => {
    const { panel, runner, h } = setup([speedLesson()]);
    h.frame();
    runner.start('speed');
    runner.next();
    runner.next(); // skip the task
    expect(panel.last.kind).toBe('complete');
    if (panel.last.kind === 'complete') {
      expect(panel.last.passed).toBe(false);
      expect(panel.last.skipped).toBe(1);
    }
    expect(runner.progress()).toEqual({ speed: false });
  });

  it('scores the quiz: one answer per question, why shown, Next needs an answer', () => {
    const storage = new MemStorage();
    const lesson: Lesson = { id: 'q', module: 'M', title: 'Quiz', summary: 'S', setup: () => {}, steps: [{ title: 'read', body: '' }], quiz: QUIZ };
    const { panel, runner, h } = setup([lesson], { storage });
    h.frame();
    runner.start('q');
    runner.next();
    expect(panel.last.kind).toBe('quiz');
    runner.next(); // not answered yet → stays
    expect(panel.last.kind === 'quiz' && panel.last.index).toBe(0);
    panel.actions.answer(0); // correct
    expect(panel.last.kind === 'quiz' && panel.last.answered).toMatchObject({ choice: 0, correct: true, why: 'Port is left facing forward.' });
    panel.actions.answer(1); // second answer ignored
    expect(panel.last.kind === 'quiz' && panel.last.score).toBe(1);
    runner.next();
    panel.actions.answer(2); // wrong
    const m = panel.last;
    expect(m.kind === 'quiz' && m.answered).toMatchObject({ choice: 2, correct: false, correctIndex: 1 });
    expect(m.kind === 'quiz' && m.score).toBe(1);
    runner.next();
    expect(panel.last.kind).toBe('complete');
    if (panel.last.kind === 'complete') {
      expect(panel.last.quiz).toEqual({ correct: 1, total: 2 });
      expect(panel.last.passed).toBe(true); // no task steps
    }
    expect(JSON.parse(storage.getItem(PROGRESS_KEY)!).quiz.q).toEqual({ best: 1, total: 2 });
  });

  it('keeps the best quiz score across attempts', () => {
    const store = new ProgressStore(new MemStorage());
    store.recordQuiz('x', 2, 3);
    store.recordQuiz('x', 1, 3);
    expect(store.quizBest('x')).toEqual({ best: 2, total: 3 });
    store.recordQuiz('x', 3, 3);
    expect(store.quizBest('x')).toEqual({ best: 3, total: 3 });
  });

  it('routes navigator selection through app.startLesson and offers the next lesson when complete', () => {
    const a: Lesson = { id: 'a', module: 'M', title: 'A', summary: '', setup: () => {}, steps: [{ title: 's', body: '' }] };
    const b: Lesson = { id: 'b', module: 'M', title: 'B', summary: '', setup: () => {}, steps: [{ title: 's', body: '' }] };
    const { app, panel, runner, h } = setup([a, b]);
    h.frame();
    panel.actions.select('a');
    expect(app.calls).toContain('start:a');
    expect(runner.activeLessonId).toBe('a');
    runner.next();
    expect(panel.last.kind === 'complete' && panel.last.nextId).toBe('b');
    panel.actions.next();
    expect(app.calls).toContain('start:b');
    expect(runner.activeLessonId).toBe('b');
  });

  it('starting another lesson mid-lesson exits the current step exactly once and resets per-lesson state', () => {
    const log: string[] = [];
    const mk = (id: string): Lesson => ({
      id, module: 'M', title: id, summary: '',
      setup: (c) => { log.push(`setup:${id}:${JSON.stringify(c.data)}`); c.data['x'] = id; },
      steps: [
        { title: 's0', body: '', onEnter: () => log.push(`enter:${id}:0`), onExit: () => log.push(`exit:${id}:0`) },
        { title: 's1', body: '', onEnter: () => log.push(`enter:${id}:1`), onExit: () => log.push(`exit:${id}:1`) },
      ],
    });
    const { runner, h } = setup([mk('A'), mk('B')]);
    h.frame();
    runner.start('A');
    runner.next();
    runner.start('B');
    expect(log).toEqual(['setup:A:{}', 'enter:A:0', 'exit:A:0', 'enter:A:1', 'exit:A:1', 'setup:B:{}', 'enter:B:0']);
    expect(runner.activeStepIndex).toBe(0);
  });

  it('back from the first quiz question returns to the last step and restarts the quiz', () => {
    const lesson: Lesson = { id: 'q', module: 'M', title: 'Q', summary: '', setup: () => {}, steps: [{ title: 'a', body: '' }, { title: 'b', body: '' }], quiz: QUIZ };
    const { panel, runner, h } = setup([lesson]);
    h.frame();
    runner.start('q');
    runner.next();
    runner.next();
    panel.actions.answer(0);
    expect(panel.last.kind).toBe('quiz');
    runner.back();
    expect(panel.last.kind === 'step' && panel.last.index).toBe(1);
    runner.next();
    expect(panel.last).toMatchObject({ kind: 'quiz', index: 0, score: 0, answered: null });
  });

  it('exit before the first snapshot cancels a deferred start', () => {
    const { runner, h } = setup([speedLesson()]);
    runner.start('speed');
    runner.exit();
    h.frame(3);
    expect(runner.activeLessonId).toBeNull();
  });

  it('exit returns to the catalogue and offers to resume the unfinished lesson', () => {
    const { panel, runner, h } = setup([speedLesson()]);
    h.frame();
    runner.start('speed');
    panel.actions.exit();
    expect(runner.activeLessonId).toBeNull();
    expect(panel.last).toMatchObject({ kind: 'idle', resumeId: 'speed' });
  });
});

describe('LessonRunner: progress persistence', () => {
  it('persists completion and restores it in a new runner', () => {
    const storage = new MemStorage();
    const lesson: Lesson = { id: 'p', module: 'M', title: 'P', summary: '', setup: () => {}, steps: [{ title: 's', body: '' }] };
    const first = setup([lesson], { storage });
    first.h.frame();
    first.runner.start('p');
    first.runner.next();
    expect(first.runner.progress()).toEqual({ p: true });
    const second = setup([lesson], { storage });
    expect(second.runner.progress()).toEqual({ p: true });
    expect(second.panel.last.catalog[0]!.done).toBe(true);
  });

  it('keeps working in memory when storage throws on every access', () => {
    const lesson: Lesson = { id: 'p', module: 'M', title: 'P', summary: '', setup: () => {}, steps: [{ title: 's', body: '' }], quiz: QUIZ };
    const { panel, runner, h } = setup([lesson], { storage: new ThrowingStorage() });
    h.frame();
    expect(() => runner.start('p')).not.toThrow();
    runner.next();
    panel.actions.answer(0);
    runner.next();
    panel.actions.answer(1);
    expect(() => runner.next()).not.toThrow();
    expect(runner.progress()).toEqual({ p: true });
    expect(() => panel.actions.resetProgress()).not.toThrow();
    expect(runner.progress()).toEqual({ p: false });
  });

  it('ignores corrupt or foreign data in storage', () => {
    const storage = new MemStorage();
    storage.setItem(PROGRESS_KEY, '{not json');
    expect(() => setup([speedLesson()], { storage })).not.toThrow();
    storage.setItem(PROGRESS_KEY, JSON.stringify({ v: 99, completed: { speed: true } }));
    expect(setup([speedLesson()], { storage }).runner.progress()).toEqual({ speed: false });
  });

  it('works with no storage at all', () => {
    const lesson: Lesson = { id: 'p', module: 'M', title: 'P', summary: '', setup: () => {}, steps: [] };
    const app = mockApp();
    const panel = new FakePanel();
    const runner = new LessonRunner([lesson], app, panel, { storage: null });
    runner.update(blankSnapshot(), 0.1);
    runner.start('p');
    expect(runner.progress()).toEqual({ p: true });
  });
});

describe('expandControls', () => {
  it('expands groups and keys, warns on unknown names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = expandControls(['jib', 'tack', 'bogus']);
    expect([...s].sort()).toEqual(['autoTrim.jib', 'jibBacked', 'jibFurl', 'jibLead', 'jibSheet', 'jibWhisker', 'tack'].sort());
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('glossary', () => {
  const REQUIRED = [
    'luff', 'leech', 'foot', 'tack', 'tack-corner', 'clew', 'head', 'sheet', 'halyard', 'traveler', 'vang', 'outhaul',
    'cunningham', 'backstay', 'telltale', 'windward', 'leeward', 'port', 'starboard', 'bow', 'stern', 'heading-up',
    'bearing-away', 'close-hauled', 'beam-reach', 'broad-reach', 'run', 'no-go-zone', 'apparent-wind', 'true-wind',
    'angle-of-attack', 'lift', 'drag', 'heel', 'leeway', 'weather-helm', 'in-irons', 'gybe', 'tacking',
    'spinnaker-pole', 'guy', 'vmg', 'layline', 'lift-shift', 'header',
  ];

  it('covers every term the curriculum relies on, each with a one-sentence definition', () => {
    for (const k of REQUIRED) expect(lookupTerm(k), k).toBeDefined();
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(40);
    for (const g of GLOSSARY) {
      expect(g.def.length, g.key).toBeGreaterThan(15);
      expect(g.def.trim().endsWith('.'), g.key).toBe(true);
      // One sentence: no full stop followed by a capitalised word inside the definition.
      expect(/[.!?]\s+[A-Z]/.test(g.def.slice(0, -1)), g.key).toBe(false);
    }
  });

  it('has unique keys, and every term and alias resolves to its own entry', () => {
    const keys = new Set(GLOSSARY.map((g) => g.key));
    expect(keys.size).toBe(GLOSSARY.length);
    for (const g of GLOSSARY) {
      expect(lookupTerm(g.term)?.key, g.term).toBe(g.key);
      for (const a of g.aliases ?? []) expect(lookupTerm(a)?.key, a).toBe(g.key);
    }
  });

  it('resolves case, spaces and simple plurals', () => {
    expect(lookupTerm('Telltales')?.key).toBe('telltale');
    expect(lookupTerm('No-Go Zone')?.key).toBe('no-go-zone');
    expect(lookupTerm('beam reach')?.key).toBe('beam-reach');
    expect(lookupTerm('laylines')?.key).toBe('layline');
    expect(lookupTerm('unknown thing')).toBeUndefined();
  });

  it('finds [[references]] in lesson text and strips the markup', () => {
    const text = 'Ease the [[sheet]] until the [[telltale|telltales]] stream; avoid [[irons|being in irons]] and [[nonsense]].';
    const refs = glossaryRefs(text);
    expect(refs.map((r) => r.key)).toEqual(['sheet', 'telltale', 'irons', 'nonsense']);
    expect(refs.map((r) => r.entry?.key)).toEqual(['sheet', 'telltale', 'in-irons', undefined]);
    expect(stripGlossary(text)).toBe('Ease the sheet until the telltales stream; avoid being in irons and nonsense.');
  });

  it('every engine fallback hint references known glossary terms', () => {
    for (const t of Object.values(EVENT_HINTS)) {
      for (const r of glossaryRefs(t!)) expect(r.entry, r.key).toBeDefined();
    }
  });
});
