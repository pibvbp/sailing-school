// Lesson runner (spec §11.1). Pure logic — no DOM: the panel is any `LessonView`.
//  • start(id) runs the lesson's setup, then enters step 0 (camera, overlays, auto-trim, live controls, onEnter).
//  • update(snap, dt) evaluates the active task every frame; the check must hold for `holdSeconds` of
//    simulated time (paused = no progress), then the step is marked done and advances after a short pause.
//  • Hints: shown on request, after `hintAfter` simulated seconds without progress, or at once when the sim
//    reports a mistake event (crash gybe, in irons, …). While shown they are re-evaluated once a second.
//  • Quiz after the last step; completion and best quiz scores persist in localStorage (all access in try/catch).
import type { SimEventType, SimSnapshot } from '../sim/types';
import {
  CONTROL_GROUPS, CONTROL_KEYS,
  type AppApi, type CatalogEntry, type ControlKey, type Lesson, type LessonActions, type LessonCtx,
  type LessonInfo, type LessonView, type LessonViewModel, type Step, type StorageLike, type TaskStatus,
} from './types';

export const PROGRESS_KEY = 'sailing-school:progress:v1';

/** Sim events that count as a learner mistake: they trigger the step's hint immediately. */
export const MISTAKE_EVENTS: ReadonlySet<SimEventType> = new Set<SimEventType>([
  'crashGybe', 'inIrons', 'spinCollapse', 'roundUp', 'backwinded',
]);

/** Fallback hint text for mistake events when the step's own hint() has nothing to say. */
export const EVENT_HINTS: Readonly<Partial<Record<SimEventType, string>>> = {
  crashGybe: 'That was an accidental [[gybe]]: the wind got behind the mainsail. Steer less deep or sheet the main in before turning the stern through the wind.',
  inIrons: 'You are [[in-irons]] — pointing into the wind, the sails cannot fill. Back the jib and steer away until they draw.',
  spinCollapse: 'The [[spinnaker]] collapsed: trim its sheet a little or bear away until the luff stops folding.',
  roundUp: 'Too much [[heel]] — the rudder lost its grip and the boat rounded up. Ease the main to depower.',
  backwinded: 'The jib is [[backwinding]] the main: ease the jib a little or trim the main in.',
};

export interface RunnerOptions {
  /** Where progress is kept; default: localStorage when accessible, else memory only. */
  storage?: StorageLike | null;
  storageKey?: string;
  /** Seconds (real time) between a step's success and the next step. Default 1.4. */
  advanceDelay?: number;
  /** Simulated seconds without progress before an automatic hint. Default 25. */
  hintAfter?: number;
}

type Phase = 'idle' | 'step' | 'quiz' | 'complete';

const MAX_SIM_DT = 0.25;
const HINT_REFRESH_S = 1;
const EVENT_HINT_SECONDS = 12;

/** localStorage if it can be touched at all (it throws in some sandboxed / privacy modes). */
export function safeLocalStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/** Expand step control names (keys and CONTROL_GROUPS names) into a set of ControlKeys. */
export function expandControls(names: readonly string[]): Set<ControlKey> {
  const out = new Set<ControlKey>();
  for (const n of names) {
    const group = CONTROL_GROUPS[n];
    if (group) group.forEach((k) => out.add(k));
    else if ((CONTROL_KEYS as readonly string[]).includes(n)) out.add(n as ControlKey);
    else console.warn(`[lessons] unknown control "${n}"`);
  }
  return out;
}

interface ProgressData {
  v: 1;
  completed: Record<string, true>;
  quiz: Record<string, { best: number; total: number }>;
  last: string | null;
}

const emptyProgress = (): ProgressData => ({ v: 1, completed: {}, quiz: {}, last: null });

/** Completion + quiz bests; survives storage that is missing, full, corrupt or throwing. */
export class ProgressStore {
  private data: ProgressData;

  constructor(private readonly storage: StorageLike | null, private readonly key = PROGRESS_KEY) {
    this.data = this.load();
  }

  isDone(id: string): boolean { return this.data.completed[id] === true; }
  quizBest(id: string): { best: number; total: number } | null { return this.data.quiz[id] ?? null; }
  get last(): string | null { return this.data.last; }

  markDone(id: string): void { this.data.completed[id] = true; this.save(); }

  recordQuiz(id: string, correct: number, total: number): void {
    const prev = this.data.quiz[id];
    if (!prev || correct > prev.best || prev.total !== total) this.data.quiz[id] = { best: correct, total };
    this.save();
  }

  setLast(id: string | null): void { this.data.last = id; this.save(); }

  reset(): void {
    this.data = emptyProgress();
    try { this.storage?.removeItem(this.key); } catch { /* blocked storage: memory is already clear */ }
  }

  private load(): ProgressData {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return emptyProgress();
      const d = JSON.parse(raw) as Partial<ProgressData>;
      if (d?.v !== 1 || typeof d.completed !== 'object' || d.completed === null) return emptyProgress();
      return {
        v: 1,
        completed: { ...d.completed },
        quiz: typeof d.quiz === 'object' && d.quiz !== null ? { ...d.quiz } : {},
        last: typeof d.last === 'string' ? d.last : null,
      };
    } catch {
      return emptyProgress();
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.data));
    } catch {
      // Quota exceeded or storage blocked: progress stays in memory for this session.
    }
  }
}

export class LessonRunner {
  private readonly lessons: Lesson[];
  private readonly byId = new Map<string, Lesson>();
  private readonly store: ProgressStore;
  private readonly advanceDelay: number;
  private readonly hintAfter: number;
  private readonly ctx: LessonCtx;
  private hasSnap = false;
  private pending: string | null = null;

  private lesson: Lesson | null = null;
  private phase: Phase = 'idle';
  private stepIndex = 0;
  private stepDone: boolean[] = [];
  private framesInStep = 0;
  private hold = 0;
  private done = false;
  private advanceTimer = 0;
  private best = 0;
  private idle = 0;
  private lastStatus: TaskStatus = { progress: 0, held: null, done: false };

  private hintOn = false;
  private hintReason: 'button' | 'idle' | SimEventType = 'button';
  private hintAge = 0;
  private hintPoll = 0;
  private hintText: string | null = null;

  private quizIndex = 0;
  private quizCorrect = 0;
  private quizAnswer: number | null = null;

  private live: Set<ControlKey> | null = null;
  private lastSimT: number | null = null;
  private readonly seenEvents = new Set<string>();
  private lastError = '';

  constructor(lessons: Lesson[], private readonly app: AppApi, private readonly panel: LessonView, opts: RunnerOptions = {}) {
    this.lessons = lessons.slice();
    for (const l of lessons) {
      if (this.byId.has(l.id)) console.warn(`[lessons] duplicate lesson id "${l.id}"`);
      this.byId.set(l.id, l);
    }
    this.store = new ProgressStore(opts.storage === undefined ? safeLocalStorage() : opts.storage, opts.storageKey);
    this.advanceDelay = opts.advanceDelay ?? 1.4;
    this.hintAfter = opts.hintAfter ?? 25;
    this.ctx = { app, snap: null as unknown as SimSnapshot, t: 0, data: {} };
    const actions: LessonActions = {
      next: () => this.next(),
      back: () => this.back(),
      hint: () => this.requestHint(),
      showMe: () => this.showMe(),
      select: (id) => this.app.startLesson(id),
      restart: () => { if (this.lesson) this.start(this.lesson.id); },
      exit: () => this.exit(),
      answer: (i) => this.answer(i),
      resetProgress: () => this.resetProgress(),
    };
    panel.bind(actions);
    this.render();
  }

  // ---- public API --------------------------------------------------------------------------

  /** Start (or restart) a lesson. Deferred until the first snapshot arrives. */
  start(id: string): void {
    if (!this.byId.has(id)) {
      console.warn(`[lessons] unknown lesson "${id}"`);
      return;
    }
    if (!this.hasSnap) {
      this.pending = id;
      return;
    }
    this.begin(id);
  }

  update(snap: SimSnapshot, dt: number): void {
    const simDt = this.simDelta(snap.t);
    this.ctx.snap = snap;
    this.hasSnap = true;
    if (this.pending !== null) {
      const id = this.pending;
      this.pending = null;
      this.begin(id);
      return;
    }
    if (!this.lesson || this.phase !== 'step') return;
    const step = this.lesson.steps[this.stepIndex]!;
    this.ctx.t += simDt;
    this.framesInStep++;
    this.scanEvents(snap);
    if (this.done) {
      this.advanceTimer += Math.max(0, dt);
      if (this.advanceTimer >= this.advanceDelay) this.next();
      return;
    }
    if (step.task) this.evaluate(step, simDt);
    this.tickHint(step, dt, simDt);
  }

  /** Completion per lesson id (every lesson in the catalogue appears). */
  progress(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const l of this.lessons) out[l.id] = this.store.isDone(l.id);
    return out;
  }

  /** Whether a control is live in the current step (always true outside a lesson step). */
  isLive(key: ControlKey): boolean {
    return this.live === null || this.live.has(key);
  }

  get activeLessonId(): string | null { return this.lesson?.id ?? null; }
  get activeStepIndex(): number { return this.phase === 'step' ? this.stepIndex : -1; }
  get currentPhase(): Phase { return this.phase; }

  next(): void {
    if (!this.lesson) return;
    if (this.phase === 'step') {
      if (this.stepIndex < this.lesson.steps.length - 1) this.gotoStep(this.stepIndex + 1);
      else this.afterSteps();
    } else if (this.phase === 'quiz') {
      if (this.quizAnswer === null) return;
      const count = this.lesson.quiz?.length ?? 0;
      if (this.quizIndex < count - 1) {
        this.quizIndex++;
        this.quizAnswer = null;
        this.render();
      } else {
        this.finish();
      }
    } else if (this.phase === 'complete') {
      const nextId = this.nextLessonId();
      if (nextId) this.app.startLesson(nextId);
    }
  }

  back(): void {
    if (!this.lesson) return;
    if (this.phase === 'step' && this.stepIndex > 0) this.gotoStep(this.stepIndex - 1);
    else if (this.phase === 'quiz' && this.lesson.steps.length > 0) {
      this.phase = 'step';
      this.enterStep(this.lesson.steps.length - 1);
    }
  }

  answer(index: number): void {
    const quiz = this.lesson?.quiz;
    if (this.phase !== 'quiz' || !quiz || this.quizAnswer !== null) return;
    const q = quiz[this.quizIndex]!;
    if (!Number.isInteger(index) || index < 0 || index >= q.options.length) return;
    this.quizAnswer = index;
    if (index === q.correct) this.quizCorrect++;
    this.render();
  }

  requestHint(): void {
    if (this.phase !== 'step') return;
    this.activateHint('button');
  }

  showMe(): void {
    const step = this.currentStep();
    if (step?.showMe) this.safely(() => step.showMe!(this.ctx));
  }

  exit(): void {
    this.pending = null;
    this.leaveStep();
    this.lesson = null;
    this.phase = 'idle';
    this.live = null;
    this.render();
  }

  resetProgress(): void {
    this.store.reset();
    if (this.lesson) this.store.setLast(this.lesson.id);
    this.render();
  }

  // ---- flow ----------------------------------------------------------------------------------

  private begin(id: string): void {
    this.leaveStep();
    const lesson = this.byId.get(id)!;
    this.lesson = lesson;
    this.ctx.data = {};
    this.ctx.t = 0;
    this.stepDone = lesson.steps.map(() => false);
    this.quizIndex = 0;
    this.quizCorrect = 0;
    this.quizAnswer = null;
    this.store.setLast(id);
    this.safely(() => lesson.setup(this.ctx));
    if (lesson.steps.length === 0) {
      this.afterSteps();
      return;
    }
    this.phase = 'step';
    this.enterStep(0);
  }

  private gotoStep(i: number): void {
    this.leaveStep();
    this.enterStep(i);
  }

  private enterStep(i: number): void {
    const lesson = this.lesson!;
    const step = lesson.steps[i]!;
    this.phase = 'step';
    this.stepIndex = i;
    this.ctx.t = 0;
    this.framesInStep = 0;
    this.hold = 0;
    this.done = false;
    this.advanceTimer = 0;
    this.best = 0;
    this.idle = 0;
    this.hintOn = false;
    this.hintText = null;
    if (step.camera) this.app.setCamera(step.camera);
    if (step.overlays) {
      for (const [k, on] of Object.entries(step.overlays)) {
        if (on !== undefined) this.app.setOverlay(k as keyof typeof step.overlays, on);
      }
    }
    if (step.autoTrim) {
      const at = this.app.controls.autoTrim;
      if (step.autoTrim.main !== undefined) at.main = step.autoTrim.main;
      if (step.autoTrim.jib !== undefined) at.jib = step.autoTrim.jib;
      if (step.autoTrim.spinnaker !== undefined) at.spinnaker = step.autoTrim.spinnaker;
    }
    this.live = step.controls ? expandControls(step.controls) : null;
    this.lastError = '';
    this.safely(() => step.onEnter?.(this.ctx));
    this.render();
    this.panel.setHint(null);
    this.lastStatus = { progress: 0, held: step.task?.holdSeconds ? 0 : null, done: false };
    this.panel.setTask(this.lastStatus);
  }

  private leaveStep(): void {
    if (this.phase !== 'step' || !this.lesson) return;
    const step = this.lesson.steps[this.stepIndex];
    if (step?.onExit) this.safely(() => step.onExit!(this.ctx));
  }

  private afterSteps(): void {
    this.leaveStep();
    const quiz = this.lesson?.quiz;
    if (quiz && quiz.length > 0) {
      this.phase = 'quiz';
      this.quizIndex = 0;
      this.quizCorrect = 0;
      this.quizAnswer = null;
      this.live = null;
      this.render();
    } else {
      this.finish();
    }
  }

  private finish(): void {
    const lesson = this.lesson!;
    this.phase = 'complete';
    this.live = null;
    if (this.passed()) this.store.markDone(lesson.id);
    if (lesson.quiz && lesson.quiz.length > 0) this.store.recordQuiz(lesson.id, this.quizCorrect, lesson.quiz.length);
    this.render();
  }

  private passed(): boolean {
    const lesson = this.lesson!;
    return lesson.steps.every((s, i) => !s.task || this.stepDone[i]);
  }

  // ---- per-frame task evaluation ------------------------------------------------------------

  private evaluate(step: Step, simDt: number): void {
    // The first snapshot after entering a step can predate the step's scenario/setup: skip it.
    if (this.framesInStep < 2) return;
    const task = step.task!;
    let r: boolean | number = false;
    try {
      r = task.check(this.ctx);
    } catch (err) {
      this.report(err);
    }
    const p = r === true ? 1 : r === false ? 0 : Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
    const need = Math.max(0, task.holdSeconds ?? 0);
    this.hold = p >= 1 ? this.hold + simDt : 0;
    const shown = need > 0 ? (p >= 1 ? Math.min(1, this.hold / need) : 0) : p;
    const success = p >= 1 && this.hold >= need - 1e-6;

    if (shown > this.best + 0.01) {
      this.best = shown;
      this.idle = 0;
    } else {
      this.idle += simDt;
    }

    if (success) {
      this.done = true;
      this.stepDone[this.stepIndex] = true;
      this.advanceTimer = 0;
      this.hintOn = false;
      if (this.hintText !== null) {
        this.hintText = null;
        this.panel.setHint(null);
      }
      this.pushStatus({ progress: 1, held: need > 0 ? need : null, done: true });
      return;
    }
    this.pushStatus({ progress: shown, held: need > 0 ? Math.min(this.hold, need) : null, done: false });
  }

  private pushStatus(s: TaskStatus): void {
    const l = this.lastStatus;
    if (l.done === s.done && Math.abs(l.progress - s.progress) < 1e-4 && l.held === s.held) return;
    this.lastStatus = s;
    this.panel.setTask(s);
  }

  // ---- hints ---------------------------------------------------------------------------------

  private scanEvents(snap: SimSnapshot): void {
    for (const e of snap.events) {
      const key = `${e.t}:${e.type}`;
      if (this.seenEvents.has(key)) continue;
      if (this.seenEvents.size > 64) this.seenEvents.clear();
      this.seenEvents.add(key);
      if (!this.done && MISTAKE_EVENTS.has(e.type)) this.activateHint(e.type);
    }
  }

  private tickHint(step: Step, dt: number, simDt: number): void {
    if (!this.hintOn && step.task && this.idle >= this.hintAfter) this.activateHint('idle');
    if (!this.hintOn) return;
    this.hintAge += simDt;
    this.hintPoll += Math.max(0, dt);
    if (this.hintPoll >= HINT_REFRESH_S) this.refreshHint();
  }

  private activateHint(reason: 'button' | 'idle' | SimEventType): void {
    this.hintOn = true;
    this.hintReason = reason;
    this.hintAge = 0;
    this.refreshHint();
  }

  private refreshHint(): void {
    this.hintPoll = 0;
    const step = this.currentStep();
    if (!step) return;
    let text: string | null = null;
    if (step.hint) {
      try {
        text = step.hint(this.ctx);
      } catch (err) {
        this.report(err);
      }
    }
    if (text === null) {
      const r = this.hintReason;
      if (r === 'button' || r === 'idle') {
        text = step.task ? `Goal: ${step.task.label}.` : 'Read the step, then press Next when you are ready.';
      } else if (this.hintAge < EVENT_HINT_SECONDS) {
        text = EVENT_HINTS[r] ?? null;
      }
    }
    if (text !== this.hintText) {
      this.hintText = text;
      this.panel.setHint(text);
    }
  }

  // ---- helpers -------------------------------------------------------------------------------

  private currentStep(): Step | null {
    return this.phase === 'step' && this.lesson ? this.lesson.steps[this.stepIndex] ?? null : null;
  }

  /** Simulated time since the previous update; 0 on the first frame, while paused, or after a sim reset. */
  private simDelta(t: number): number {
    const last = this.lastSimT;
    this.lastSimT = t;
    if (last === null || !(t >= last)) {
      if (last !== null) this.seenEvents.clear();
      return 0;
    }
    return Math.min(t - last, MAX_SIM_DT);
  }

  private nextLessonId(): string | null {
    if (!this.lesson) return null;
    const i = this.lessons.indexOf(this.lesson);
    for (let j = i + 1; j < this.lessons.length; j++) {
      if (!this.store.isDone(this.lessons[j]!.id)) return this.lessons[j]!.id;
    }
    return this.lessons[i + 1]?.id ?? null;
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.report(err);
    }
  }

  private report(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === this.lastError) return;
    this.lastError = msg;
    console.error(`[lessons] ${this.lesson?.id ?? '?'} step ${this.stepIndex + 1}:`, err);
  }

  private catalog(): CatalogEntry[] {
    return this.lessons.map((l) => {
      const q = this.store.quizBest(l.id);
      return {
        id: l.id, module: l.module, title: l.title, summary: l.summary,
        done: this.store.isDone(l.id),
        active: this.lesson?.id === l.id,
        quizBest: q ? { correct: q.best, total: q.total } : null,
      };
    });
  }

  private info(l: Lesson): LessonInfo {
    return { id: l.id, module: l.module, title: l.title, summary: l.summary, number: this.lessons.indexOf(l) + 1, count: this.lessons.length };
  }

  private render(): void {
    this.panel.render(this.model());
  }

  private model(): LessonViewModel {
    const catalog = this.catalog();
    const lesson = this.lesson;
    if (!lesson || this.phase === 'idle') {
      const last = this.store.last;
      const resume = last && this.byId.has(last) && !this.store.isDone(last)
        ? last
        : this.lessons.find((l) => !this.store.isDone(l.id))?.id ?? null;
      return { kind: 'idle', catalog, resumeId: resume };
    }
    const info = this.info(lesson);
    if (this.phase === 'step') {
      const step = lesson.steps[this.stepIndex]!;
      return {
        kind: 'step', catalog, lesson: info, index: this.stepIndex, count: lesson.steps.length,
        hasQuiz: (lesson.quiz?.length ?? 0) > 0,
        step: {
          title: step.title,
          body: step.body,
          taskLabel: step.task?.label ?? null,
          holdSeconds: step.task?.holdSeconds ?? 0,
          canShowMe: typeof step.showMe === 'function',
          completed: this.stepDone[this.stepIndex] === true,
        },
      };
    }
    if (this.phase === 'quiz') {
      const quiz = lesson.quiz!;
      const q = quiz[this.quizIndex]!;
      const a = this.quizAnswer;
      return {
        kind: 'quiz', catalog, lesson: info, index: this.quizIndex, count: quiz.length,
        question: { q: q.q, options: q.options.slice() },
        answered: a === null ? null : { choice: a, correct: a === q.correct, correctIndex: q.correct, why: q.why },
        score: this.quizCorrect,
      };
    }
    const skipped = lesson.steps.filter((s, i) => s.task && !this.stepDone[i]).length;
    return {
      kind: 'complete', catalog, lesson: info,
      passed: skipped === 0,
      skipped,
      quiz: lesson.quiz && lesson.quiz.length > 0 ? { correct: this.quizCorrect, total: lesson.quiz.length } : null,
      nextId: this.nextLessonId(),
    };
  }
}
