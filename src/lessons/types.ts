// Contracts shared by the UI shell (src/ui), the lessons engine and the App (Task 16).
// Kept free of DOM and three.js so the engine, curriculum and their tests run in Node.
// `src/ui/Hud.ts` re-exports the app-facing names (AppApi, OverlayKey, CameraKey, AppMode).
import type { Controls, ScenarioInit, SimSnapshot, WindSettings } from '../sim/types';
import type { QualitySettings } from '../render/core/types';

export type AppMode = 'lessons' | 'free' | 'lab';

export type CameraKey = 'chase' | 'helm' | 'top' | 'sail' | 'free';
/** Keyboard 1–5 order; `C` cycles through it. */
export const CAMERA_KEYS: readonly CameraKey[] = ['chase', 'helm', 'top', 'sail', 'free'];

export type OverlayKey =
  | 'windTriangle' | 'forces' | 'wheel' | 'flow' | 'flowSlice' | 'aoa'
  | 'xray' | 'labels' | 'laylines' | 'track' | 'telltaleCam';
export const OVERLAY_KEYS: readonly OverlayKey[] = [
  'windTriangle', 'forces', 'wheel', 'flow', 'flowSlice', 'aoa', 'xray', 'labels', 'laylines', 'track', 'telltaleCam',
];

/** A race mark placed by a lesson or mode (world metres east / north of the scenario origin). */
export interface MarkSpec { id: string; e: number; n: number; kind: 'windward' | 'leeward' | 'start' }

/** What the UI, the input controller and lessons may ask of the App. `controls` is read fresh every time. */
export interface AppApi {
  setMode(m: AppMode): void;
  setCamera(c: CameraKey): void;
  setOverlay(k: OverlayKey, on: boolean): void;
  overlays(): Record<OverlayKey, boolean>;
  setWind(p: Partial<WindSettings>): void;
  setTimeOfDay(h: number): void;
  setTimeScale(s: number): void;
  togglePause(): void;
  setQuality(t: QualitySettings['tier'] | 'auto'): void;
  setSound(on: boolean): void;
  scenario(init: ScenarioInit): void;
  startLesson(id: string): void;
  /** Replaces the course marks shown on the water (an empty list clears them). */
  setMarks(marks: readonly MarkSpec[]): void;
  controls: Controls;
}

/**
 * Names a lesson step may list in `Step.controls` (the controls that stay live).
 * Individual keys follow `Controls`; `autoTrim.*` are the per-sail crew toggles; `tack`/`gybe` the commands.
 * Group names (see CONTROL_GROUPS) expand to several keys.
 */
export type ControlKey =
  | 'tiller' | 'helmMode' | 'helmTarget'
  | 'mainSheet' | 'traveler' | 'vang' | 'outhaul' | 'cunningham' | 'backstay'
  | 'jibSheet' | 'jibLead' | 'jibFurl' | 'jibBacked' | 'jibWhisker'
  | 'boomPush'
  | 'spinHoist' | 'spinPole' | 'spinPoleHeight' | 'spinSheet'
  | 'crewHike'
  | 'autoTrim.main' | 'autoTrim.jib' | 'autoTrim.spinnaker'
  | 'tack' | 'gybe';

export const CONTROL_KEYS: readonly ControlKey[] = [
  'tiller', 'helmMode', 'helmTarget',
  'mainSheet', 'traveler', 'vang', 'outhaul', 'cunningham', 'backstay',
  'jibSheet', 'jibLead', 'jibFurl', 'jibBacked', 'jibWhisker',
  'boomPush',
  'spinHoist', 'spinPole', 'spinPoleHeight', 'spinSheet',
  'crewHike',
  'autoTrim.main', 'autoTrim.jib', 'autoTrim.spinnaker',
  'tack', 'gybe',
];

export const CONTROL_GROUPS: Readonly<Record<string, readonly ControlKey[]>> = {
  helm: ['tiller', 'helmMode', 'helmTarget'],
  main: ['mainSheet', 'traveler', 'vang', 'outhaul', 'cunningham', 'backstay', 'boomPush', 'autoTrim.main'],
  mainShape: ['vang', 'outhaul', 'cunningham', 'backstay'],
  jib: ['jibSheet', 'jibLead', 'jibFurl', 'jibBacked', 'jibWhisker', 'autoTrim.jib'],
  spinnaker: ['spinHoist', 'spinPole', 'spinPoleHeight', 'spinSheet', 'autoTrim.spinnaker'],
  crew: ['crewHike'],
  autoTrim: ['autoTrim.main', 'autoTrim.jib', 'autoTrim.spinnaker'],
  manoeuvres: ['tack', 'gybe'],
  all: CONTROL_KEYS,
};

// ---------------------------------------------------------------------------------------------
// Lessons (spec §11.1)

export interface LessonCtx {
  app: AppApi;
  /** Latest snapshot. */
  snap: SimSnapshot;
  /** Simulated seconds since the current step was entered (does not advance while paused). */
  t: number;
  /** Scratch space shared by all steps of the running lesson; reset when a lesson starts. */
  data: Record<string, unknown>;
}

export interface StepTask {
  /** true/false, or progress 0…1 (≥ 1 counts as success). Evaluated every frame. */
  check(c: LessonCtx): boolean | number;
  /** The check must hold continuously this long (simulated seconds) before the step succeeds. */
  holdSeconds?: number;
  /** Short checklist line, e.g. "Sail close-hauled (TWA 40–50°) for 5 s". */
  label: string;
}

export interface Step {
  title: string;
  /** Trusted HTML from the curriculum; glossary terms as [[key]] or [[key|shown text]]. */
  body: string;
  task?: StepTask;
  /** Situation-aware advice (plain text, [[glossary]] markup allowed); null when there is nothing to say. */
  hint?(c: LessonCtx): string | null;
  camera?: CameraKey;
  overlays?: Partial<Record<OverlayKey, boolean>>;
  /** Controls that stay live during this step (ControlKey or CONTROL_GROUPS names); omit for all. */
  controls?: string[];
  /** Per-sail crew auto-trim applied on entering the step (spec §11.1). */
  autoTrim?: Partial<Controls['autoTrim']>;
  /** "Show me": run the auto-crew / autopilot for this step (spec §11.1). The button shows only if present. */
  showMe?(c: LessonCtx): void;
  /**
   * Runs every frame while the step is active (from its second frame on, like the task check) until its task
   * succeeds: multi-phase "Show me" demonstrations, timers, scenario resets. Not called while paused.
   */
  tick?(c: LessonCtx): void;
  onEnter?(c: LessonCtx): void;
  onExit?(c: LessonCtx): void;
}

export interface QuizQuestion {
  q: string;
  options: string[];
  /** Index into `options`. */
  correct: number;
  /** One-line explanation shown after answering. */
  why: string;
}

export interface Lesson {
  id: string;
  module: string;
  title: string;
  summary: string;
  setup(c: LessonCtx): void;
  steps: Step[];
  quiz?: QuizQuestion[];
}

// ---------------------------------------------------------------------------------------------
// Runner ↔ panel (the LessonPanel in src/ui implements LessonView; tests use a fake).

export interface CatalogEntry {
  id: string;
  module: string;
  title: string;
  summary: string;
  done: boolean;
  active: boolean;
  /** Best quiz result, if the lesson has a quiz and it was answered. */
  quizBest: { correct: number; total: number } | null;
}

export interface LessonInfo { id: string; module: string; title: string; summary: string; number: number; count: number }

export interface StepInfo {
  title: string;
  body: string;
  taskLabel: string | null;
  holdSeconds: number;
  canShowMe: boolean;
  /** The step's task was already completed (e.g. after going back). */
  completed: boolean;
}

export type LessonViewModel =
  | { kind: 'idle'; catalog: CatalogEntry[]; resumeId: string | null }
  | { kind: 'step'; catalog: CatalogEntry[]; lesson: LessonInfo; index: number; count: number; step: StepInfo; hasQuiz: boolean }
  | {
    kind: 'quiz'; catalog: CatalogEntry[]; lesson: LessonInfo; index: number; count: number;
    question: { q: string; options: string[] };
    answered: null | { choice: number; correct: boolean; correctIndex: number; why: string };
    score: number;
  }
  | {
    kind: 'complete'; catalog: CatalogEntry[]; lesson: LessonInfo;
    /** Every task step was completed (none skipped). */
    passed: boolean;
    skipped: number;
    quiz: null | { correct: number; total: number };
    nextId: string | null;
  };

export interface TaskStatus {
  /** 0…1 shown on the progress bar. */
  progress: number;
  /** Seconds held so far when the task has holdSeconds (else null). */
  held: number | null;
  done: boolean;
}

export interface LessonActions {
  next(): void;
  back(): void;
  hint(): void;
  showMe(): void;
  /** Start a lesson from the navigator (routes through AppApi.startLesson). */
  select(id: string): void;
  restart(): void;
  exit(): void;
  answer(index: number): void;
  resetProgress(): void;
}

export interface LessonView {
  bind(actions: LessonActions): void;
  render(model: LessonViewModel): void;
  /** Called every frame while a task step is active; implementations should skip unchanged writes. */
  setTask(status: TaskStatus): void;
  setHint(text: string | null): void;
}

/** The subset of the Web Storage API the runner uses (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
