// The `step()` builder: per-step scratch state, and "Show me" demonstrations that run every frame from the
// step's `tick` until the task succeeds, the learner leaves the step — or the learner takes the controls back.
import type { Controls } from '../../sim/types';
import type { LessonCtx, Step, StepTask } from '../types';

/** Runs every frame (from the step's tick) after "Show me" started it. */
export type Demo = (c: LessonCtx) => void;

export interface StepDef extends Omit<Step, 'body' | 'showMe' | 'hint' | 'tick'> {
  /**
   * Trusted HTML. A function gets the running lesson's `ctx.data` and is evaluated whenever the panel renders
   * the step (e.g. to show numbers recorded in earlier steps).
   */
  body: string | ((data: Readonly<Record<string, unknown>>) => string);
  hint?(c: LessonCtx): string | null;
  /** Set the controls at once; return a Demo for demonstrations that take several phases. */
  showMe?(c: LessonCtx): Demo | void;
  /** The step's own per-frame work (timers, scenario resets), run before any demo. */
  tick?(c: LessonCtx): void;
}

const DEMO = '__demo';
const SCRATCH = '__step';

/** Controls a learner can grab. A change the crew or the sim did not make means the learner took over. */
const WATCHED = [
  'helmMode', 'helmTarget', 'tiller', 'mainSheet', 'traveler', 'vang', 'outhaul', 'cunningham', 'backstay',
  'jibSheet', 'jibLead', 'jibFurl', 'jibBacked', 'jibWhisker', 'spinHoist', 'spinPole', 'spinPoleHeight', 'spinSheet',
] as const;
type Watched = (typeof WATCHED)[number];
const MAIN: ReadonlySet<Watched> = new Set(['mainSheet', 'traveler', 'vang', 'outhaul', 'cunningham', 'backstay']);
const JIB: ReadonlySet<Watched> = new Set(['jibSheet', 'jibLead', 'jibFurl']);
const SPIN: ReadonlySet<Watched> = new Set(['spinSheet', 'spinPole', 'spinPoleHeight']);

interface Seen {
  controls: Controls;
  values: Record<Watched, unknown>;
  auto: Controls['autoTrim'];
  /** A crew tack or gybe was running (the crew steers during those). */
  crewSteering: boolean;
}

interface DemoSlot { owner: object; drive: Demo; seen: Seen | null }

function look(c: LessonCtx): Seen {
  const k = c.app.controls;
  const values = {} as Record<Watched, unknown>;
  for (const key of WATCHED) values[key] = k[key];
  const m = c.snap.maneuver;
  return { controls: k, values, auto: { ...k.autoTrim }, crewSteering: m === 'tack' || m === 'gybe' };
}

/**
 * Did someone other than the demo, the crew or the sim change a control since the demo last ran? The crew
 * trims sails that are on auto-trim and steers during its tacks and gybes; the tiller springs back to centre.
 */
function learnerTookOver(prev: Seen, c: LessonCtx): boolean {
  const k = c.app.controls;
  if (k !== prev.controls) return false; // a new scenario: nothing to compare
  const m = c.snap.maneuver;
  const crewSteering = prev.crewSteering || m === 'tack' || m === 'gybe';
  if (k.autoTrim.main !== prev.auto.main || k.autoTrim.jib !== prev.auto.jib || k.autoTrim.spinnaker !== prev.auto.spinnaker) return true;
  for (const key of WATCHED) {
    const now = k[key], was = prev.values[key];
    if (now === was) continue;
    if (key === 'helmMode' || key === 'helmTarget') { if (!crewSteering) return true; continue; }
    if (key === 'tiller') {
      if (!crewSteering && k.helmMode === 'manual' && Math.abs(now as number) > Math.abs(was as number) + 1e-6) return true;
      continue;
    }
    if (MAIN.has(key)) { if (!k.autoTrim.main) return true; continue; }
    if (JIB.has(key)) { if (!k.autoTrim.jib) return true; continue; }
    if (SPIN.has(key)) { if (!k.autoTrim.spinnaker) return true; continue; }
    return true; // jibBacked, jibWhisker, spinHoist: only people change those
  }
  return false;
}

function runDemo(c: LessonCtx, owner: object): void {
  const slot = c.data[DEMO] as DemoSlot | undefined;
  if (!slot || slot.owner !== owner) return;
  if (slot.seen && learnerTookOver(slot.seen, c)) {
    c.data[DEMO] = undefined; // the learner has the controls again
    return;
  }
  slot.drive(c);
  slot.seen = look(c);
}

/** Whether a "Show me" demonstration of the current step is still running. */
export const demoRunning = (c: LessonCtx): boolean => c.data[DEMO] !== undefined;

/** Build a Step: fresh scratch state and no demo on entry; the demo, if any, runs from `tick`. */
export function step(d: StepDef): Step {
  const owner = {};
  let current: LessonCtx | null = null;
  const out: Step = {
    title: d.title,
    body: '',
    onEnter: (c) => {
      current = c;
      c.data[DEMO] = undefined;
      c.data[SCRATCH] = {};
      d.onEnter?.(c);
    },
    onExit: (c) => {
      c.data[DEMO] = undefined;
      d.onExit?.(c);
    },
    tick: (c) => {
      d.tick?.(c);
      runDemo(c, owner);
    },
  };
  const body = d.body;
  Object.defineProperty(out, 'body', {
    enumerable: true,
    get: () => (typeof body === 'function' ? body(current?.data ?? {}) : body),
  });
  if (d.camera) out.camera = d.camera;
  if (d.overlays) out.overlays = d.overlays;
  if (d.controls) out.controls = d.controls;
  if (d.autoTrim) out.autoTrim = d.autoTrim;
  if (d.hint) out.hint = d.hint;
  if (d.task) {
    const t: StepTask = d.task;
    out.task = { label: t.label, check: t.check, ...(t.holdSeconds !== undefined ? { holdSeconds: t.holdSeconds } : {}) };
  }
  if (d.showMe) {
    const show = d.showMe;
    out.showMe = (c) => {
      const drive = show(c);
      c.data[DEMO] = drive ? ({ owner, drive, seen: null } satisfies DemoSlot) : undefined;
    };
  }
  return out;
}

// ---- per-step scratch state ----------------------------------------------------------------------------

/** Per-step scratch state (reset each time the step is entered). */
export function mem<T>(c: LessonCtx, key: string, init: () => T): T {
  let bag = c.data[SCRATCH] as Record<string, unknown> | undefined;
  if (!bag) { bag = {}; c.data[SCRATCH] = bag; }
  if (!(key in bag)) bag[key] = init();
  return bag[key] as T;
}

/** Per-step scratch value if the step has created it already (hints use this: they may run first). */
export function peek<T>(c: LessonCtx, key: string): T | undefined {
  const bag = c.data[SCRATCH] as Record<string, unknown> | undefined;
  return bag?.[key] as T | undefined;
}

/** Latch: true from the first frame `cond` held during this step. */
export function latch(c: LessonCtx, key: string, cond: boolean): boolean {
  const box = mem(c, key, () => ({ on: false }));
  if (cond) box.on = true;
  return box.on;
}

/** Simulated seconds since the previous call with this key during this step (0 on the first call). */
export function frameDt(c: LessonCtx, key = 'dt'): number {
  const box = mem(c, key, () => ({ t: c.t }));
  const dt = Math.max(0, c.t - box.t);
  box.t = c.t;
  return Math.min(dt, 0.25);
}
