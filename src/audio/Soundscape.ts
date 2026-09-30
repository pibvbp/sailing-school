// The procedural soundscape (spec §10): wind, water, sail flogging, spinnaker, boom-crash and sheet-trimming sounds,
// all synthesised with WebAudio (no assets) from the SimSnapshot.
//
//   const sound = new Soundscape();          // silent; nothing exists yet
//   sound.startOnFirstGesture();             // or `await sound.start()` from any click / key handler
//   ...every frame:  sound.update(snapshot, cameraYaw, dt)
//
// `cameraYaw` is the compass bearing (rad, clockwise from north — the convention of `boat.heading`) the camera looks
// along; `cameraYawFromBasis(forward, up)` makes it from the camera's world axes (it also copes with the top view).
// `snapshot.t` must advance while the simulation runs: a snapshot whose `t` stands still for a third of a second is
// treated as "paused" and the sound ducks away. Everything that changes continuously glides (exponentially) so nothing
// clicks; the master chain ends in a soft limiter, so the output never exceeds 0.95.
//
// Run state: sound is audible only while it is unmuted, the tab is visible, the simulation is running and `update` is
// being called. Each way of becoming inaudible first fades (master or duck gain) and only then — a third of a second to
// a second and a half later — suspends the real-time context, which costs no audio-thread CPU while asleep; becoming
// audible again resumes it at once. Only a suspension we made ourselves is ever undone; one the browser made (a phone
// call, a locked screen) is retried and the gesture listeners re-armed.
//
// Deliberate deviations from spec §10: the snapshot carries no pitch, so the water's "splash modulation" is the bow-wave
// swoosh driven by roll rate and heel; and the hull rush rises as speed^2.2, not linearly (a hull at 2 kn is nearly
// silent, at hull speed it hisses).
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
/** The master fade has settled after this long (s of audio time): the layer work can stop. */
const MASTER_SETTLED = 1.3;
/**
 * Wall-clock delays (ms) between the sound becoming inaudible and the context being suspended: long enough for the fade
 * that silences it (master: time constant 0.12 s; duck: 0.15 s), and for a pause to end without a hiccup.
 */
const MUTE_SUSPEND_MS = 1300;
const HIDDEN_SUSPEND_MS = 300;
const DUCK_SUSPEND_MS = 1600;

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
  private gestureCleanup: (() => void) | null = null;
  private gestureTarget: EventTarget | null = null;

  // Why the sound is or is not audible, and whether we have put the context to sleep.
  private hidden = false;
  private paused = false;
  private stale = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendDue = Infinity;
  private suspendedByUs = false;

  private readonly onVisibility = (): void => {
    if (this.disposed) return;
    this.hidden = typeof document !== 'undefined' && document.hidden === true;
    // Fade first; the context is put to sleep a moment later, and woken (with the duck still down) when visible again.
    if (this.hidden && this.graph && this.ctx) this.graph.duck.to(0, this.ctx.currentTime);
    this.syncRun();
  };

  /** The browser (not us) stopped the context — a phone call, a locked screen. Ask again, and again on the next gesture. */
  private readonly onStateChange = (): void => {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || this.disposed || this.suspendedByUs || !this.audible) return;
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    void ctx.resume().catch(() => undefined);
    if (this.gestureTarget) this.startOnFirstGesture(this.gestureTarget);
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

  /** True while sound is meant to be heard: unmuted, tab visible, simulation running and `update` being called. */
  get audible(): boolean {
    return this.enabled && !this.hidden && !this.paused && !this.stale;
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
    // (A context we put to sleep ourselves — muted — stays asleep: waking it is setEnabled(true)'s business.)
    const resumed = this.offline || ctx.state === 'running' || this.suspendedByUs ? null : (ctx as AudioContext).resume().catch(() => undefined);
    if (!this.graph) await (this.building ??= this.build());
    await resumed;
  }

  /** Arm one-shot listeners that call start() on the first click, key press or touch (spec: "starts on first interaction"). */
  startOnFirstGesture(target: EventTarget = window): void {
    if (this.gestureCleanup || this.disposed) return;
    this.gestureTarget = target;
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

  /** Mute / unmute with a short fade. A muted real-time context is put to sleep once the fade is over. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyMaster();
    this.syncRun();
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
   * Feed one simulation frame. Cost ≈ a few dozen AudioParam calls, no allocation. Never throws: if the browser
   * refuses something, the sound is shut down (one warning) rather than taking the frame loop with it.
   * @param s          the latest snapshot
   * @param cameraYaw  compass bearing (rad) the camera looks along
   * @param dt         seconds since the previous call
   */
  update(s: SimSnapshot, cameraYaw: number, dt: number): void {
    const g = this.graph;
    const ctx = this.ctx;
    if (!g || !ctx || this.disposed) return;
    try {
      this.advance(g, ctx, s, cameraYaw, dt);
    } catch (err) {
      this.fail(err);
    }
  }

  private advance(g: Graph, ctx: BaseAudioContext, s: SimSnapshot, cameraYaw: number, dt: number): void {
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
    if (paused !== this.paused || this.stale) {
      this.paused = paused;
      this.stale = false; // we are being called again
      this.syncRun();
    }
    g.duck.to(paused || this.hidden ? 0 : 1, now);

    const w = s.wind;
    const b = s.boat;
    const aws = Math.min(60, Math.max(0, finiteOr(w.aws, 0)));

    // Events: only new ones play (the same snapshot may be delivered twice), never while silent.
    const events = s.events;
    for (let i = 0; i < events.length; i++) this.onEvent(events[i]!, now, aws, paused);

    // Silent anyway (paused; asleep; muted and the fade is over): skip the work. The muted test uses the audio clock,
    // which stops once the context is asleep — `suspendedByUs` covers that case.
    if (paused || this.suspendedByUs || (this.mutedAt !== null && now - this.mutedAt > MASTER_SETTLED)) return;

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
    this.teardown();
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

  /** Something the browser would not do: warn once and go silent for good (closing a context we made ourselves). */
  private fail(err: unknown): void {
    if (this.unsupported) return;
    this.unsupported = true;
    console.warn('[soundscape] audio disabled:', err);
    this.teardown();
  }

  /** Stop everything and let go: timers, listeners, the graph, and a context that is ours. Safe to call twice. */
  private teardown(): void {
    this.gestureCleanup?.();
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    this.clearSuspendTimer();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    const ctx = this.ctx;
    if (ctx && !this.offline) ctx.onstatechange = null;
    const g = this.graph;
    this.graph = null;
    if (g) {
      g.master.gain.cancelScheduledValues(0);
      g.master.gain.value = 0;
      g.master.disconnect();
    }
    if (ctx && this.ownsContext) void (ctx as AudioContext).close().catch(() => undefined);
    this.ctx = null;
  }

  private clearSuspendTimer(): void {
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    this.suspendDue = Infinity;
  }

  /**
   * Bring a real-time context's run state in line with `audible`: wake it at once when sound is wanted, put it to sleep
   * once the fade that silenced the sound has finished (`immediate`: nothing was ever audible, so now). Call it whenever
   * something that decides audibility changes; it is idempotent.
   */
  private syncRun(immediate = false): void {
    if (!this.ctx || !this.graph || this.offline || this.disposed) return;
    if (this.audible) {
      this.clearSuspendTimer();
      this.resumeNow();
      return;
    }
    if (this.suspendedByUs) return;
    if (immediate) {
      this.suspendNow();
      return;
    }
    const delay = Math.min(
      this.enabled ? Infinity : MUTE_SUSPEND_MS,
      this.hidden ? HIDDEN_SUSPEND_MS : Infinity,
      this.paused || this.stale ? DUCK_SUSPEND_MS : Infinity,
    );
    const due = performance.now() + delay;
    if (due >= this.suspendDue) return; // a sleep is already due sooner (a second reason for silence must not postpone it)
    this.clearSuspendTimer();
    this.suspendDue = due;
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      this.suspendDue = Infinity;
      if (!this.audible) this.suspendNow();
    }, delay);
  }

  private suspendNow(): void {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || this.suspendedByUs) return;
    this.suspendedByUs = true;
    void ctx.suspend().catch(() => undefined);
  }

  private resumeNow(): void {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || !this.suspendedByUs) return;
    this.suspendedByUs = false;
    void ctx.resume().catch(() => undefined);
  }

  /** The watchdog: `update` has gone quiet (a stalled loop, a hidden tab) — fade out, and sleep if it stays that way. */
  private checkStale(): void {
    const g = this.graph;
    const ctx = this.ctx;
    if (!g || !ctx || this.stale || performance.now() - this.lastUpdateMs <= STALE_MS) return;
    this.stale = true;
    g.duck.to(0, ctx.currentTime);
    this.syncRun();
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
        this.hidden = typeof document !== 'undefined' && document.hidden === true; // (an offline render does not care about the tab)
        this.watchdog = setInterval(() => this.checkStale(), 250);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
        ctx.onstatechange = this.onStateChange;
        // Muted (or hidden) before the graph even existed: nothing has been audible, so sleep at once.
        this.syncRun(true);
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
