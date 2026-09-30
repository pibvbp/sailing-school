// The procedural soundscape (spec §10): wind, water, sail flogging, spinnaker, boom-crash and sheet-trimming sounds,
// all synthesised with WebAudio (no assets) from the SimSnapshot.
//
//   const sound = new Soundscape();          // silent; nothing exists yet
//   sound.startOnFirstGesture();             // or `await sound.start()` from any click / key handler
//   ...every frame:  sound.update(snapshot, cameraYaw, dt)
//
// `cameraYaw` is the compass bearing (rad, clockwise from north — the convention of `boat.heading`) the camera looks
// along; `cameraYawFromForward(x, z)` converts a three.js forward vector. `snapshot.t` must advance while the
// simulation runs: a snapshot whose `t` stands still for a third of a second is treated as "paused" and the sound
// ducks away. Everything that changes continuously glides (exponentially) so nothing clicks; the master chain ends in
// a soft limiter, so the output never exceeds ~0.95.
import type { SimEvent, SimSnapshot } from '../sim/types';
import { GLIDE, clamp01, collapseLevel, crashLevel, finiteOr, meanLuffing, refillLevel, spinRustleDrive, waterRushLevel, windRoarLevel } from './mapping';
import { Glide, NoiseBank, gainNode } from './nodes';
import { Rng } from './noise';
import { ImpactsLayer } from './impacts';
import { SailsLayer } from './sails';
import { TrimLayer } from './trim';
import { WaterLayer } from './water';
import { WindLayer } from './wind';

export type LayerName = 'wind' | 'water' | 'sails' | 'impacts' | 'trim';

export interface SoundscapeOptions {
  /** Use this context instead of creating an AudioContext in start() (tests inject an OfflineAudioContext). */
  context?: BaseAudioContext;
  /** Seed of the noise and of the flogging pattern. */
  seed?: number;
}

/** The latest drive values, updated in place every frame (for the demo read-out and tests). */
export interface SoundDrives {
  windRoar: number;
  water: number;
  /** Loudness of the flogging (max of main and jib), 0 = not flogging. */
  flog: number;
  flutterHz: number;
  spinRustle: number;
  /** Where the wind sits in the stereo field, −1 (left) … +1 (right). */
  windPan: number;
  /** True while the sound is ducked because the simulation is paused. */
  ducked: boolean;
}

interface Graph {
  master: GainNode;
  masterGlide: Glide;
  duck: Glide;
  buses: Record<LayerName, GainNode>;
  wind: WindLayer;
  water: WaterLayer;
  sails: SailsLayer;
  impacts: ImpactsLayer;
  trim: TrimLayer;
  analyser: AnalyserNode | null;
}

/** Soft limiter: unity gain for small signals, a smooth knee, and a hard ceiling that nothing can exceed. */
const CEILING = 0.95;
const PRE_GAIN = 0.5;
const KNEE = 2.05;

function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const norm = CEILING / Math.tanh(KNEE);
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1; // the shaper's input range is −1…1, which is ±2 on the bus after PRE_GAIN
    curve[i] = norm * Math.tanh(KNEE * u);
  }
  return curve;
}

/** Sound events start this long after "now" (s): a scheduling margin so an envelope never starts in the past. */
const EVENT_DELAY = 0.006;
/** `update` silent for this long (ms) → fade out (a stalled frame loop must not leave a wind loop droning). */
const STALE_MS = 700;
/** A frozen snapshot clock for this long (s) means the simulation is paused. */
const PAUSED_AFTER = 0.3;
/** The master fade has settled after this long (s). */
const MASTER_SETTLED = 1.3;

const EV_CRASH = 0;
const EV_REFILL = 1;
const EV_COLLAPSE = 2;

interface AudioGlobals {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

export class Soundscape {
  readonly drives: SoundDrives = { windRoar: 0, water: 0, flog: 0, flutterHz: 3, spinRustle: 0, windPan: 0, ducked: false };

  private ctx: BaseAudioContext | null;
  private readonly ownsContext: boolean;
  private readonly offline: boolean;
  private readonly seed: number;
  private graph: Graph | null = null;
  private building: Promise<boolean> | null = null;
  private enabled = true;
  private volume = 0.8;
  private mutedAt: number | null = null;
  private disposed = false;
  private unsupported = false;

  private prevT = Number.NaN;
  private stillFor = 0;
  private readonly lastEvent = new Float64Array(3).fill(-Infinity);
  private lastUpdateMs = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private gestureCleanup: (() => void) | null = null;

  private readonly onVisibility = (): void => {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || this.disposed) return;
    if (document.hidden) void ctx.suspend().catch(() => undefined);
    else if (this.enabled) void ctx.resume().catch(() => undefined);
  };

  constructor(options: SoundscapeOptions = {}) {
    this.ctx = options.context ?? null;
    this.ownsContext = !options.context;
    this.offline = options.context !== undefined && 'startRendering' in options.context;
    this.seed = options.seed ?? 0x5a11;
  }

  /** True once the audio graph exists and the context is running (i.e. sound can actually come out). */
  get running(): boolean {
    return this.graph !== null && this.ctx !== null && (this.offline || this.ctx.state === 'running');
  }

  /** The underlying context (null until start()). */
  get context(): BaseAudioContext | null {
    return this.ctx;
  }

  /**
   * Create the context and resume it, then build the graph (first call). Call it from a user gesture (click, key,
   * touch): browsers keep an AudioContext silent until then. Safe to call repeatedly and concurrently.
   */
  async start(): Promise<void> {
    if (this.disposed || this.unsupported) return;
    // What browsers require inside the gesture is synchronous — creating the context and asking it to resume —
    // so it happens before the first await. Generating the noise takes a moment and yields between buffers.
    const ctx = this.ensureContext();
    if (!ctx) return;
    const resumed = this.offline || ctx.state === 'running' ? null : (ctx as AudioContext).resume().catch(() => undefined);
    if (!this.graph) await (this.building ??= this.build());
    await resumed;
  }

  /** Arm one-shot listeners that call start() on the first click, key press or touch (spec: "starts on first interaction"). */
  startOnFirstGesture(target: EventTarget = window): void {
    if (this.gestureCleanup || this.disposed) return;
    const events = ['pointerdown', 'pointerup', 'keydown', 'touchend'];
    const handler = (): void => {
      void this.start().then(() => {
        if (this.running) cleanup();
      });
    };
    const cleanup = (): void => {
      for (const e of events) target.removeEventListener(e, handler, true);
      this.gestureCleanup = null;
    };
    for (const e of events) target.addEventListener(e, handler, true);
    this.gestureCleanup = cleanup;
  }

  /** Mute / unmute with a short fade. While muted the audio context is suspended after the fade to save CPU. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyMaster();
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || !this.graph || this.offline || this.disposed) return;
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    if (on) void ctx.resume().catch(() => undefined);
    else this.suspendTimer = setTimeout(() => { if (!this.enabled) void ctx.suspend().catch(() => undefined); }, 1000 * MASTER_SETTLED);
  }

  /** Master volume 0…1 (perceptual: gain = v²). */
  setVolume(v: number): void {
    this.volume = clamp01(finiteOr(v, this.volume));
    this.applyMaster();
  }

  /** Scale one layer against the others (1 = as calibrated) — for mix tweaks and tests. */
  setLayerLevel(layer: LayerName, gain: number): void {
    const g = this.graph;
    if (g && this.ctx) g.buses[layer].gain.setTargetAtTime(Math.max(0, finiteOr(gain, 1)), this.ctx.currentTime, 0.05);
  }

  /** A tap on the master output for meters and spectrum displays (created on first use). */
  analyser(): AnalyserNode | null {
    const g = this.graph;
    if (!g || !this.ctx) return null;
    if (!g.analyser) {
      g.analyser = this.ctx.createAnalyser();
      g.analyser.fftSize = 2048;
      g.analyser.smoothingTimeConstant = 0.6;
      g.master.connect(g.analyser);
    }
    return g.analyser;
  }

  /**
   * Feed one simulation frame. Cost ≈ a few dozen AudioParam calls, no allocation.
   * @param s          the latest snapshot
   * @param cameraYaw  compass bearing (rad) the camera looks along
   * @param dt         seconds since the previous call
   */
  update(s: SimSnapshot, cameraYaw: number, dt: number): void {
    const g = this.graph;
    const ctx = this.ctx;
    if (!g || !ctx || this.disposed) return;
    const now = ctx.currentTime;
    this.lastUpdateMs = performance.now();
    dt = Math.min(2, Math.max(0, finiteOr(dt, 1 / 60)));

    // The simulation clock: it went backwards → a new scenario (forget which events were already played);
    // it stood still → paused.
    const t = finiteOr(s.t, 0);
    if (t < this.prevT - 1e-6) {
      this.lastEvent.fill(-Infinity);
      g.sails.reset();
    }
    this.stillFor = t === this.prevT ? this.stillFor + dt : 0;
    this.prevT = t;
    const paused = this.stillFor > PAUSED_AFTER;
    this.drives.ducked = paused;
    g.duck.to(paused ? 0 : 1, now);

    const w = s.wind;
    const b = s.boat;
    const aws = Math.min(60, Math.max(0, finiteOr(w.aws, 0)));

    // Events: only new ones play (the same snapshot may be delivered twice), never while silent.
    const events = s.events;
    for (let i = 0; i < events.length; i++) this.onEvent(events[i]!, now, aws, paused);

    if (paused || (this.mutedAt !== null && now - this.mutedAt > MASTER_SETTLED)) return; // silent anyway: skip the work

    const awa = finiteOr(w.awa, 0);
    const heading = finiteOr(b.heading, 0);
    const yaw = finiteOr(cameraYaw, 0);
    const speed = Math.min(30, Math.max(0, finiteOr(b.speed, 0)));
    const heel = finiteOr(b.heel, 0);

    const sails = s.sails;
    const mainLuff = sails.main.set ? meanLuffing(sails.main.sections) : 0;
    const jibLuff = sails.jib.set ? meanLuffing(sails.jib.sections) : 0;
    const spin = sails.spinnaker;
    const spinRustle = spin.set ? spinRustleDrive(clamp01(finiteOr(spin.collapsed, 0)), clamp01(finiteOr(spin.curl, 0)), aws) : 0;

    g.wind.update(now, dt, aws, awa, heading, yaw);
    g.water.update(now, dt, speed, heel, finiteOr(b.rollRate, 0), heading, yaw);
    g.sails.update(now, dt, aws, mainLuff, jibLuff, spinRustle, heading, awa, yaw);
    g.trim.update(now, dt, aws, finiteOr(sails.main.boomAngle, 0), finiteOr(sails.main.boomRate, 0), finiteOr(sails.jib.clewAngle, 0), sails.jib.set);

    const d = this.drives;
    d.windRoar = windRoarLevel(aws);
    d.water = waterRushLevel(speed);
    d.flog = g.sails.flogLevel;
    d.flutterHz = g.sails.flutterHz;
    d.spinRustle = spinRustle;
    d.windPan = g.wind.panNow;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gestureCleanup?.();
    if (this.watchdog !== null) clearInterval(this.watchdog);
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.watchdog = this.suspendTimer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    const g = this.graph;
    this.graph = null;
    if (g) {
      g.master.gain.cancelScheduledValues(0);
      g.master.gain.value = 0;
      g.master.disconnect();
    }
    if (this.ctx && this.ownsContext) void (this.ctx as AudioContext).close().catch(() => undefined);
    this.ctx = null;
  }

  // ------------------------------------------------------------------------------------------------ internals

  private onEvent(e: SimEvent, now: number, aws: number, silent: boolean): void {
    let kind: number;
    switch (e.type) {
      case 'crashGybe': kind = EV_CRASH; break;
      case 'spinRefill': kind = EV_REFILL; break;
      case 'spinCollapse': kind = EV_COLLAPSE; break;
      default: return;
    }
    if (!(e.t > this.lastEvent[kind]!)) return;
    this.lastEvent[kind] = e.t;
    if (silent || !this.enabled) return;
    const impacts = this.graph!.impacts;
    const at = now + EVENT_DELAY;
    if (kind === EV_CRASH) impacts.crash(at, crashLevel(e.data?.rate ?? 2));
    else if (kind === EV_REFILL) impacts.refill(at, refillLevel(aws));
    else impacts.collapse(at, collapseLevel(aws));
  }

  private applyMaster(): void {
    const g = this.graph;
    const ctx = this.ctx;
    if (!g || !ctx) return;
    const now = ctx.currentTime;
    g.masterGlide.to(this.enabled ? this.volume * this.volume : 0, now, this.enabled ? GLIDE.master : GLIDE.mute);
    if (!this.enabled) this.mutedAt ??= now;
    else this.mutedAt = null;
  }

  private ensureContext(): BaseAudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const globals = globalThis as unknown as AudioGlobals;
      const Ctor = globals.AudioContext ?? globals.webkitAudioContext;
      if (!Ctor) throw new Error('WebAudio is not available in this browser');
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      this.fail(err);
    }
    return this.ctx;
  }

  private fail(err: unknown): void {
    this.unsupported = true;
    console.warn('[soundscape] audio disabled:', err);
  }

  private async build(): Promise<boolean> {
    try {
      const ctx = this.ctx!;
      const bank = await NoiseBank.create(ctx, this.seed);
      if (this.disposed) return false;
      const rng = new Rng(this.seed ^ 0x9e3779b9);

      // dry buses → duck → soft limiter → master (volume / mute) → speakers
      const master = gainNode(ctx, 0);
      const shaper = ctx.createWaveShaper();
      shaper.curve = softClipCurve();
      const duck = gainNode(ctx, 1);
      duck.connect(gainNode(ctx, PRE_GAIN)).connect(shaper).connect(master).connect(ctx.destination);
      const bus = (): GainNode => {
        const n = gainNode(ctx, 1);
        n.connect(duck);
        return n;
      };
      const buses: Record<LayerName, GainNode> = { wind: bus(), water: bus(), sails: bus(), impacts: bus(), trim: bus() };
      const impacts = new ImpactsLayer(ctx, bank, buses.impacts, rng);
      this.graph = {
        master,
        masterGlide: new Glide(master.gain, GLIDE.master, 1e-5),
        duck: new Glide(duck.gain, GLIDE.duck, 1e-3),
        buses,
        wind: new WindLayer(ctx, bank, buses.wind, rng),
        water: new WaterLayer(ctx, bank, buses.water, rng),
        sails: new SailsLayer(ctx, bank, buses.sails, rng, impacts),
        impacts,
        trim: new TrimLayer(ctx, bank, buses.trim, rng),
        analyser: null,
      };
      this.applyMaster();
      this.lastUpdateMs = performance.now();
      if (!this.offline) {
        this.watchdog = setInterval(() => {
          const g = this.graph;
          if (g && this.ctx && performance.now() - this.lastUpdateMs > STALE_MS) g.duck.to(0, this.ctx.currentTime);
        }, 250);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
      }
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    } finally {
      this.building = null;
    }
  }
}
