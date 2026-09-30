// A data-only description of a stretch of simulated sailing (so it can cross the Playwright boundary as JSON) and
// the code that turns it into per-frame snapshots. The offline-render harness plays a Scenario through a Soundscape.
import type { SimEventType } from '../../sim/types';
import { FRAME_DEFAULTS, snapshotFrom, event, type Frame } from './fixtures';
import type { SimSnapshot } from '../../sim/types';

export type Patch = Omit<Frame, 'events' | 't'>;

/** From time `t` on, the fields in `set` take these values — instantly, or ramping linearly over `ramp` seconds. */
export interface Key {
  t: number;
  set: Patch;
  ramp?: number;
}

export interface ScenarioEvent {
  t: number;
  type: SimEventType;
  data?: Record<string, number>;
}

export interface Scenario {
  seconds: number;
  sampleRate?: number;
  /** Rate at which update() is called (default 60). */
  frameRate?: number;
  keys: Key[];
  events?: ScenarioEvent[];
  /** A replay: explicit snapshot values for every frame (overrides `keys` and `events`), e.g. recorded from the real sim. */
  frames?: Frame[];
  cameraYaw?: number;
  /** false → construct muted; volume 0…1. */
  enabled?: boolean;
  volume?: number;
  /** Per-layer mix (0 mutes a layer), applied right after start(). */
  layers?: Partial<Record<'wind' | 'water' | 'sails' | 'impacts' | 'trim', number>>;
  /** Do not call start() (the soundscape must stay silent). */
  skipStart?: boolean;
  /** From this time on the snapshot clock stands still (a paused simulation). */
  pauseAt?: number;
  /** setEnabled(false) at this time. */
  muteAt?: number;
  /** Return the right channel too (default: left only — half the data to move out of the browser). */
  stereo?: boolean;
  /** Feed a single snapshot at t = 0 and render straight through (isolates the audio thread's own cost). */
  staticRender?: boolean;
  seed?: number;
}

type Field = keyof Patch;

function fieldAt(keys: readonly Key[], field: Field, tf: number, count = keys.length): number | boolean {
  let value: number | boolean = FRAME_DEFAULTS[field];
  for (let i = 0; i < count; i++) {
    const k = keys[i]!;
    if (k.t > tf) break;
    const target = k.set[field];
    if (target === undefined) continue;
    if (k.ramp && typeof target === 'number' && tf < k.t + k.ramp) {
      const from = fieldAt(keys, field, k.t, i) as number;
      value = from + ((target - from) * (tf - k.t)) / k.ramp;
    } else value = target;
  }
  return value;
}

const FIELDS = Object.keys(FRAME_DEFAULTS).filter((f) => f !== 't') as Field[];

/** The scenario's state at time `tf` as a Frame (without events). */
export function frameAt(scn: Scenario, tf: number): Frame {
  const f: Record<string, number | boolean> = {};
  for (const name of FIELDS) f[name] = fieldAt(scn.keys, name, tf);
  return f as Frame;
}

/** Turns a scenario into successive snapshots: `next(tf)` returns the snapshot for frame time `tf`. */
export class ScenarioPlayer {
  private prev = -Infinity;
  private frozenT: number | null = null;

  constructor(private readonly scn: Scenario) {}

  /** The snapshot for frame time `tf` and the camera yaw to pass along with it. */
  next(tf: number): { snap: SimSnapshot; yaw: number } {
    const scn = this.scn;
    if (scn.frames && scn.frames.length > 0) {
      const i = Math.min(scn.frames.length - 1, Math.round(tf * (scn.frameRate ?? 60)));
      const f = scn.frames[i]!;
      return { snap: snapshotFrom({ t: tf, ...f }), yaw: f.yaw ?? scn.cameraYaw ?? 0 };
    }
    const evs = (scn.events ?? []).filter((e) => e.t > this.prev && e.t <= tf).map((e) => event(e.type, e.t, e.data));
    this.prev = tf;
    let t = tf;
    if (scn.pauseAt !== undefined && tf >= scn.pauseAt) {
      this.frozenT ??= tf;
      t = this.frozenT;
    }
    const f = frameAt(scn, tf);
    return { snap: snapshotFrom({ ...f, t, events: evs }), yaw: f.yaw ?? scn.cameraYaw ?? 0 };
  }
}
