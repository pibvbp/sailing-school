// Soundscape tests, in two parts.
//
// 1. Node (always run): the real Soundscape driven against a strict fake AudioContext (Node has no WebAudio) — graph
//    wiring, robustness to garbage snapshots, event handling, pause/mute logic, allocation and cost per update().
//    Its companions: lifecycle.test.ts (start/suspend/resume/visibility/dispose), graph.test.ts (topology, output
//    ceiling, click-free parameter moves), nodes.test.ts, flog.test.ts, mapping.test.ts, noise.test.ts.
// 2. Chromium (opt-in, `pnpm test:audio`): the real Soundscape rendered offline through a real OfflineAudioContext
//    (harness.html, headless Chromium via playwright-core) — the signal-level requirements: silence before start / when
//    muted, level rising with AWS, flogging energy only while luffing, no clipping, no clicks when parameters jump,
//    stereo placement, event sounds, update() cost. It loads the machine, so the everyday suite leaves it out.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { fileURLToPath } from 'node:url';
import { setPriority } from 'node:os';
import { Soundscape } from '../Soundscape';
import { DEG, KN } from '../../shared/math';
import { perfBudget } from '../../testing/perf';
import { FakeContext, outputChain } from './fakeContext';
import { event, snapshotFrom, type Frame } from './fixtures';
import type { Scenario } from './scenario';
import type { RenderResult } from './harness';
import { bandPower, clickScore, decodeBase64, detectOnsets, intervalStats, peak, peakBandLevel, powerDb, rms, toDb } from './analysis';

// ------------------------------------------------------------------------------------------------ 1. Node, fake context

const live: Soundscape[] = [];
afterEach(() => {
  while (live.length) live.pop()!.dispose();
});

async function started(opts: { enabled?: boolean } = {}): Promise<{ sound: Soundscape; ctx: FakeContext }> {
  const ctx = new FakeContext();
  const sound = new Soundscape({ context: ctx.asContext() });
  live.push(sound);
  if (opts.enabled === false) sound.setEnabled(false);
  await sound.start();
  return { sound, ctx };
}

const frame = (f: Frame = {}) => snapshotFrom(f);

describe('Soundscape (fake context)', () => {
  it('creates nothing and makes no sound before start()', () => {
    const ctx = new FakeContext();
    const sound = new Soundscape({ context: ctx.asContext() });
    live.push(sound);
    sound.update(frame({ aws: 10, mainLuff: 1 }), 0, 1 / 60); // harmless
    sound.setVolume(0.5);
    sound.setEnabled(true);
    expect(ctx.nodes).toHaveLength(0);
    expect(sound.running).toBe(false);
  });

  it('builds a bounded graph on start() and fades in from silence', async () => {
    const { sound, ctx } = await started();
    expect(sound.running).toBe(true);
    expect(ctx.nodes.length).toBeGreaterThan(50);
    expect(ctx.nodes.length).toBeLessThan(250);
    const sources = ctx.nodes.filter((n) => n.kind === 'source' || n.kind === 'osc');
    expect(sources.every((n) => (n as unknown as { started: boolean }).started)).toBe(true);
    // The master gain starts at 0 and is glided to volume² (0.8² by default): a fade-in, never a step.
    const master = ctx.params().find((p) => p.name === 'gain' && p.targets === 1 && Math.abs(p.lastTarget - 0.64) < 1e-9);
    expect(master).toBeDefined();
    expect(master!.value).toBe(0);
    // The last node before the speakers is the master gain, fed by the soft limiter.
    const shaper = ctx.nodes.find((n) => n.kind === 'shaper')!;
    expect((shaper as unknown as { curve: Float32Array }).curve.length).toBeGreaterThan(256);
  });

  it('soft limiter curve: unity for small signals, hard ceiling below 0.99, odd and monotonic', async () => {
    const { ctx } = await started();
    const curve = (ctx.nodes.find((n) => n.kind === 'shaper') as unknown as { curve: Float32Array }).curve;
    const n = curve.length;
    const at = (x: number) => curve[Math.round(((x / 2 + 1) / 2) * (n - 1))]!; // the bus is scaled by 0.5 in front of the shaper
    expect(at(0.1)).toBeCloseTo(0.1, 1);
    expect(at(0.2) / 0.2).toBeGreaterThan(0.97);
    expect(Math.max(...curve)).toBeLessThan(0.96);
    expect(Math.min(...curve)).toBeGreaterThan(-0.96);
    for (let i = 1; i < n; i++) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    expect(curve[0]! + curve[n - 1]!).toBeCloseTo(0, 5);
  });

  it('volume and mute drive the master gain, clamped, ignoring garbage', async () => {
    const { sound, ctx } = await started();
    const master = ctx.params().find((p) => p.name === 'gain' && Math.abs(p.lastTarget - 0.64) < 1e-9)!;
    sound.setVolume(0.5);
    expect(master.lastTarget).toBeCloseTo(0.25, 9);
    sound.setVolume(7);
    expect(master.lastTarget).toBeCloseTo(1, 9);
    sound.setVolume(-3);
    expect(master.lastTarget).toBe(0);
    sound.setVolume(0.5);
    sound.setVolume(NaN);
    expect(master.lastTarget).toBeCloseTo(0.25, 9);
    sound.setEnabled(false);
    expect(master.lastTarget).toBe(0);
    sound.setEnabled(true);
    expect(master.lastTarget).toBeCloseTo(0.25, 9);
  });

  it('constructed muted: the master gain is never raised above 0', async () => {
    const { ctx } = await started({ enabled: false });
    const master = outputChain(ctx).master.gain;
    expect(master.lastTarget).toBe(0);
    expect(master.max).toBe(0);
    expect(master.value).toBe(0);
  });

  it('survives garbage snapshots without throwing or passing a non-finite value to the audio graph', async () => {
    const { sound, ctx } = await started();
    const bad = [NaN, Infinity, -Infinity, -5, 1e12];
    let t = 0;
    for (const v of bad) {
      for (const key of ['aws', 'awa', 'heading', 'speed', 'heel', 'rollRate', 'mainLuff', 'jibLuff', 'spinCollapsed', 'spinCurl', 't'] as const) {
        ctx.currentTime += 1 / 60;
        const snap = frame({ [key]: v, spinSet: true, t: t += 1 / 60 });
        expect(() => sound.update(snap, 0, 1 / 60)).not.toThrow();
        expect(() => sound.update(frame({ t: t += 1 / 60 }), v, v)).not.toThrow();
      }
    }
    // Missing pieces: no sections, no data on an event, unknown event types.
    const s = frame({ t: t += 1 });
    s.sails.main.sections = [];
    s.events = [event('crashGybe', t), { type: 'inIrons', t }, { type: 'luffing', t }];
    expect(() => sound.update(s, 0, 1 / 60)).not.toThrow();
    // Every param was only ever driven inside a sane range (any NaN would have thrown in FakeParam already).
    for (const p of ctx.params()) {
      expect(Number.isFinite(p.min) || p.calls === 0).toBe(true);
      if (p.name === 'gain') { expect(p.min).toBeGreaterThanOrEqual(-1e-9); expect(p.max).toBeLessThanOrEqual(8); }
      if (p.name === 'pan') { expect(p.min).toBeGreaterThanOrEqual(-1); expect(p.max).toBeLessThanOrEqual(1); }
      if (p.name === 'biquad.frequency') { expect(p.min).toBeGreaterThanOrEqual(20); expect(p.max).toBeLessThan(ctx.sampleRate / 2); }
      if (p.name === 'osc.frequency') { expect(p.min).toBeGreaterThan(0); expect(p.max).toBeLessThan(ctx.sampleRate / 2); }
    }
  });

  it('drives every continuous parameter with exponential glides, never with steps (no clicks)', async () => {
    const { sound, ctx } = await started();
    let t = 0;
    for (let i = 0; i < 600; i++) {
      ctx.currentTime = i / 60;
      const aws = (3 + 20 * Math.abs(Math.sin(i / 40))) * KN;
      sound.update(frame({ t: t += 1 / 60, aws, speed: 4 * Math.abs(Math.sin(i / 55)), mainLuff: i % 200 > 120 ? 0.9 : 0, awa: Math.sin(i / 90), heading: i / 100 }), i / 200, 1 / 60);
    }
    // The continuously driven parameters (many updates) have only ever seen setTargetAtTime: no ramps and no steps —
    // except the exact 0 that finishes a fade to silence (so the browser can skip what is behind a silent gain).
    // (Per-snap voice retunes — filters, pans — are one-offs.)
    const glided = ctx.params().filter((p) => p.targets > 30);
    expect(glided.length).toBeGreaterThan(12);
    for (const p of glided) {
      expect(p.ramps).toBe(0);
      expect(p.nonZeroSteps).toBe(0);
    }
  });

  it('plays each new boom crash / refill / collapse once, however often the same snapshot is delivered', async () => {
    const { sound, ctx } = await started();
    const ramps = () => ctx.params().filter((p) => p.name === 'osc.frequency').reduce((n, p) => n + p.ramps, 0);
    const base = ramps();
    const s1 = frame({ t: 5, aws: 8, events: [event('crashGybe', 5, { rate: 3 })] });
    for (let i = 0; i < 5; i++) { ctx.currentTime = 5 + i / 60; sound.update(s1, 0, 1 / 60); }
    expect(ramps() - base).toBe(1);
    const s2 = frame({ t: 6, aws: 8, events: [event('spinRefill', 6), event('spinCollapse', 6)] });
    ctx.currentTime = 6;
    sound.update(s2, 0, 1 / 60);
    sound.update(s2, 0, 1 / 60);
    expect(ramps() - base).toBe(3);
    // Sim time going backwards (a new scenario) forgets what was played.
    ctx.currentTime = 7;
    sound.update(frame({ t: 1, aws: 8, events: [event('crashGybe', 1, { rate: 3 })] }), 0, 1 / 60);
    expect(ramps() - base).toBe(4);
  });

  it('crash loudness follows the impact rate', async () => {
    const peakTarget = async (rate: number) => {
      const { sound, ctx } = await started();
      ctx.currentTime = 1;
      const before = new Map(ctx.params().map((p) => [p, p.max]));
      sound.update(frame({ t: 5, aws: 0, speed: 0, events: [event('crashGybe', 5, { rate })] }), 0, 1 / 60);
      let max = 0;
      for (const p of ctx.params()) if (p.name === 'gain' && p.max > (before.get(p) ?? -Infinity)) max = Math.max(max, p.max);
      sound.dispose();
      return max;
    };
    const soft = await peakTarget(1.6);
    const hard = await peakTarget(5);
    expect(hard).toBeGreaterThan(1.3 * soft);
  });

  it('ducks when the snapshot clock stands still (paused) and comes back when it moves', async () => {
    const { sound, ctx } = await started();
    let t = 0;
    for (let i = 0; i < 30; i++) { ctx.currentTime = i / 60; sound.update(frame({ t: t += 1 / 60, aws: 6 }), 0, 1 / 60); }
    expect(sound.drives.ducked).toBe(false);
    for (let i = 0; i < 40; i++) { ctx.currentTime = 1 + i / 60; sound.update(frame({ t, aws: 6 }), 0, 1 / 60); }
    expect(sound.drives.ducked).toBe(true);
    for (let i = 0; i < 5; i++) { ctx.currentTime = 2 + i / 60; sound.update(frame({ t: t += 1 / 60, aws: 6 }), 0, 1 / 60); }
    expect(sound.drives.ducked).toBe(false);
  });

  it('skips the layer work once muted and settled, and plays no events while muted', async () => {
    const { sound, ctx } = await started();
    let t = 0;
    for (let i = 0; i < 20; i++) { ctx.currentTime = i / 60; sound.update(frame({ t: t += 1 / 60, aws: 8, mainLuff: 1 }), 0, 1 / 60); }
    sound.setEnabled(false);
    ctx.currentTime += 3; // the fade is long over
    const calls = () => ctx.params().reduce((n, p) => n + p.calls, 0);
    const before = calls();
    for (let i = 0; i < 60; i++) { ctx.currentTime += 1 / 60; sound.update(frame({ t: t += 1 / 60, aws: 12, mainLuff: 1, events: i === 5 ? [event('crashGybe', t, { rate: 4 })] : [] }), 0, 1 / 60); }
    expect(calls() - before).toBeLessThan(10);
    sound.setEnabled(true);
    ctx.currentTime += 0.1;
    sound.update(frame({ t: t += 1 / 60, aws: 12, mainLuff: 1 }), 0, 1 / 60);
    expect(calls() - before).toBeGreaterThan(10);
  });

  it('dispose() is idempotent and silences everything; the injected context is left open', async () => {
    const { sound, ctx } = await started();
    sound.dispose();
    sound.dispose();
    expect(() => sound.update(frame(), 0, 1 / 60)).not.toThrow();
    expect(ctx.closed).toBe(false);
    await sound.start(); // no-op after dispose
    expect(sound.running).toBe(false);
  });

  it('closes the context it created itself', async () => {
    const ctx = new FakeContext();
    const g = globalThis as unknown as { AudioContext?: unknown };
    g.AudioContext = function () { return ctx; };
    try {
      const sound = new Soundscape();
      await sound.start();
      expect(ctx.nodes.length).toBeGreaterThan(50);
      sound.dispose();
      expect(ctx.closed).toBe(true);
    } finally {
      delete g.AudioContext;
    }
  });

  it('degrades gracefully where WebAudio is missing', async () => {
    const sound = new Soundscape();
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await expect(sound.start()).resolves.toBeUndefined();
    } finally {
      console.warn = warn;
    }
    expect(sound.running).toBe(false);
    expect(() => sound.update(frame(), 0, 1 / 60)).not.toThrow();
  });

  it('starts on the first user gesture and then stops listening', async () => {
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    const sound = new Soundscape({ context: ctx.asContext() });
    live.push(sound);
    const handlers = new Map<string, Set<() => void>>();
    const target = {
      addEventListener: (type: string, h: () => void) => { (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(h); },
      removeEventListener: (type: string, h: () => void) => { handlers.get(type)?.delete(h); },
    } as unknown as EventTarget;
    sound.startOnFirstGesture(target);
    expect(ctx.nodes).toHaveLength(0); // still silent, still nothing built
    handlers.get('pointerdown')!.forEach((h) => h());
    handlers.get('pointerup')!.forEach((h) => h()); // the rest of the click arrives while the noise is still being generated
    await vi.waitFor(() => expect(sound.running && [...handlers.values()].every((set) => set.size === 0)).toBe(true), { timeout: 5000 });
    expect(ctx.nodes.length).toBeGreaterThan(50);
    expect(ctx.resumes).toBe(1);
    expect(sound.running).toBe(true);
    for (const set of handlers.values()) expect(set.size).toBe(0);
  });

  it('exposes an analyser tap on the master output', async () => {
    const { sound } = await started();
    const a = sound.analyser();
    expect(a).not.toBeNull();
    expect(sound.analyser()).toBe(a);
  });

  it('thuds once when a flogging spell ends, and only after a hard one', async () => {
    const { sound, ctx } = await started();
    const ramps = () => ctx.params().filter((p) => p.name === 'osc.frequency').reduce((n, p) => n + p.ramps, 0);
    const base = ramps();
    let t = 0;
    const run = (seconds: number, f: Frame) => {
      for (let i = 0; i < seconds * 60; i++) { ctx.currentTime += 1 / 60; sound.update(frame({ t: t += 1 / 60, ...f }), 0, 1 / 60); }
    };
    run(1, { aws: 8, mainLuff: 0 });
    run(2, { aws: 8, mainLuff: 0.9 });
    expect(ramps() - base).toBe(0); // still flogging
    run(0.5, { aws: 8, mainLuff: 0 });
    expect(ramps() - base).toBe(1); // it filled: one thud
    run(3, { aws: 8, mainLuff: 0 });
    run(0.2, { aws: 8, mainLuff: 0.9 }); // a flutter …
    run(3, { aws: 8, mainLuff: 0 });
    expect(ramps() - base).toBe(1); // … is not a flogging spell
    run(2, { aws: 8, jibLuff: 0.9 });
    run(0.5, { aws: 8, jibLuff: 0 });
    expect(ramps() - base).toBe(2); // the jib fills too
  });

  it('winch clicks while a sheet is hauled in; silence when idle, easing or swinging fast', async () => {
    const { sound, ctx } = await started();
    let t = 0;
    const cancels = () => ctx.params().reduce((n, p) => n + p.cancels, 0);
    const run = (seconds: number, f: Frame) => {
      const before = cancels();
      for (let i = 0; i < seconds * 60; i++) { ctx.currentTime += 1 / 60; sound.update(frame({ t: t += 1 / 60, aws: 6, ...f }), 0, 1 / 60); }
      return cancels() - before;
    };
    run(1, { boomAngle: 0.3 }); // settle
    const idle = run(2, { boomAngle: 0.3 });
    const hauling = run(2, { boomAngle: 0.3, boomRate: -0.2 });
    const easing = run(2, { boomAngle: 0.3, boomRate: 0.2 });
    const swinging = run(2, { boomAngle: 0.3, boomRate: -2 });
    expect(hauling).toBeGreaterThan(idle + 30);
    expect(easing).toBeLessThan(hauling / 3);
    expect(swinging).toBeLessThan(hauling / 3);
    // Haul the other way on the other tack: a boom at −0.3 rad coming in has a positive rate.
    expect(run(2, { boomAngle: -0.3, boomRate: 0.2 })).toBeGreaterThan(idle + 30);
    // The jib winch: the clew angle closing on the centreline.
    let clew = 0.5;
    const before = cancels();
    for (let i = 0; i < 120; i++) { ctx.currentTime += 1 / 60; clew -= 0.15 / 60; sound.update(frame({ t: t += 1 / 60, aws: 6, clewAngle: clew }), 0, 1 / 60); }
    expect(cancels() - before).toBeGreaterThan(30);
  });

  it('update() allocates nothing per frame', async () => {
    const { sound, ctx } = await started();
    // Quiet the fake: count-only, no recording — the fake itself must not allocate.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const snaps = [frame({ aws: 9, speed: 3, mainLuff: 0.8, jibLuff: 0.5, spinSet: true, spinCollapsed: 0.7 }), frame({ aws: 5, speed: 2, mainLuff: 0 })];
    for (const s of snaps) s.events = [];
    let t = 0;
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        ctx.currentTime += 1 / 60;
        const s = snaps[i & 1]!;
        s.t = t += 1 / 60;
        s.wind.aws = (3 + 10 * Math.abs(Math.sin(i / 50))) ;
        sound.update(s, i / 100, 1 / 60);
      }
    };
    run(3000); // warm up (JIT, one-off lazies)
    gc();
    const before = process.memoryUsage().heapUsed;
    run(30000);
    gc();
    const grown = process.memoryUsage().heapUsed - before;
    expect(grown).toBeLessThan(1.5e6); // 30 000 frames: any per-frame allocation would show up as tens of MB
  });

  it('update() is cheap even in a busy scene', async () => {
    const { sound, ctx } = await started();
    const s = frame({ aws: 10, speed: 3, mainLuff: 1, jibLuff: 1, spinSet: true, spinCollapsed: 1 });
    let t = 0;
    const run = (n: number) => { for (let i = 0; i < n; i++) { ctx.currentTime += 1 / 60; s.t = t += 1 / 60; sound.update(s, 0, 1 / 60); } };
    run(2000);
    const t0 = performance.now();
    run(20000);
    const perUpdate = (performance.now() - t0) / 20000;
    expect(perUpdate).toBeLessThan(perfBudget(0.05)); // ms; the fake is cheaper than a browser, the real cost is asserted in Chromium (pnpm test:audio)
  });
});

// ------------------------------------------------------------------------------------------------ 2. Chromium, real WebAudio

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface Rendered { sr: number; l: Float32Array; r: Float32Array; update: RenderResult['update']; renderMs: number; startMs: number; drives: RenderResult['drives'] }
/** A render that takes longer than this is a hang, not a slow machine (a normal one takes about a second). */
const RENDER_TIMEOUT_MS = 45_000;
interface Harness { render(scn: Scenario): Promise<Rendered>; close(): Promise<void> }

async function openHarness(): Promise<Harness | null> {
  // This file keeps a browser busy for a while. Run it (and Chromium, which inherits the priority) below the other test
  // files so that timing-sensitive tests elsewhere in the suite (e.g. the simulation's µs-per-step check) are not disturbed.
  try {
    setPriority(process.pid, 12);
  } catch {
    /* not permitted here: carry on at normal priority */
  }
  try {
    const { createServer } = await import('vite');
    const { chromium } = await import('playwright-core');
    const server = await createServer({
      root: ROOT, configFile: false, logLevel: 'silent', clearScreen: false,
      server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const port = (server.httpServer!.address() as { port: number }).port;
    let browser;
    try {
      browser = await chromium.launch({ headless: true, channel: 'chromium', timeout: 30000 });
    } catch (err) {
      await server.close();
      throw err;
    }
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/src/audio/__tests__/harness.html`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30000 });
    return {
      async render(scn) {
        const run = page.evaluate((s) => (window as unknown as { audioHarness: { render(x: unknown): Promise<unknown> } }).audioHarness.render(s), scn);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`offline render hung (> ${RENDER_TIMEOUT_MS} ms)`)), RENDER_TIMEOUT_MS); });
        const res = (await Promise.race([run, timeout]).finally(() => clearTimeout(timer))) as RenderResult;
        if (res.error) throw new Error(`render failed: ${res.error}`);
        return { sr: res.sampleRate, l: decodeBase64(res.left), r: decodeBase64(res.right), update: res.update, renderMs: res.renderMs, startMs: res.startMs, drives: res.drives };
      },
      async close() {
        await browser.close();
        await server.close();
      },
    };
  } catch (err) {
    console.warn(`[audio tests] OfflineAudioContext tests skipped — no headless Chromium available (${(err as Error).message.split('\n')[0]}). ` +
      'Run `pnpm exec playwright install chromium` to enable them.');
    return null;
  }
}

// The real-WebAudio suite drives a headless Chromium, which loads the machine enough to disturb timing
// tests elsewhere; it runs only on request: `pnpm test:audio` (AUDIO_BROWSER_TESTS=1).
const harness = process.env.AUDIO_BROWSER_TESTS === '1' ? await openHarness() : null;
/** Measurements worth quoting; printed when AUDIO_TEST_REPORT is set. */
const report: Record<string, number> = {};
const note = (name: string, value: number): number => (report[name] = Math.round(value * 1000) / 1000);
afterAll(async () => {
  await harness?.close();
  if (process.env.AUDIO_TEST_REPORT) console.log(JSON.stringify({ ...report, 'renders': renderCount, 'audio seconds rendered': audioSeconds, 'browser wall (s)': Math.round(renderWall / 100) / 10 }, null, 1));
});

const cache = new Map<string, Promise<Rendered>>();
let renderWall = 0;
let renderCount = 0;
let audioSeconds = 0;
/** Renders are cached; update() is called at 30 Hz unless the scenario says otherwise (plenty for a 90 ms look-ahead). */
const render = (scn: Scenario): Promise<Rendered> => {
  const key = JSON.stringify(scn);
  if (!cache.has(key)) {
    const started = performance.now();
    cache.set(key, harness!.render({ frameRate: 30, ...scn }).then((r) => {
      renderWall += performance.now() - started;
      renderCount++;
      audioSeconds += scn.seconds;
      return r;
    }));
  }
  return cache.get(key)!;
};

/** A steady scenario: `set` from t = 0 for `seconds`. */
const steady = (seconds: number, set: Omit<Frame, 'events' | 't'>, extra: Partial<Scenario> = {}): Scenario => ({ seconds, keys: [{ t: 0, set }], ...extra });
/** A steady scene that needs no time evolution: one update, then render straight through (cheap). */
const staticScene = (seconds: number, set: Omit<Frame, 'events' | 't'>, extra: Partial<Scenario> = {}): Scenario => steady(seconds, set, { staticRender: true, ...extra });
const kn = (k: number) => k * KN;
const SETTLE = 1.5; // seconds to skip while glides settle

const level = (r: Rendered, from = SETTLE) => rms(r.l, Math.floor(from * r.sr)) ;
const HEAVY: Omit<Frame, 'events' | 't'> = { aws: kn(20), speed: kn(6), mainLuff: 1, jibLuff: 1, spinSet: true, spinCollapsed: 1, rollRate: 0.3, heel: 0.4 };

describe.skipIf(!harness)('Soundscape (real WebAudio, offline render in Chromium)', () => {
  // One retry absorbs the odd browser/machine hiccup; a real (deterministic) failure fails twice.
  const T = { timeout: 90_000, retry: 1 };

  describe('silence', () => {
    it('is silent before start()', T, async () => {
      const r = await render(steady(2, HEAVY, { skipStart: true, stereo: true }));
      expect(peak(r.l)).toBe(0);
      expect(peak(r.r)).toBe(0);
    });

    it('is silent when constructed muted, whatever the boat is doing', T, async () => {
      const r = await render(steady(3, HEAVY, { enabled: false, stereo: true, events: [{ t: 1, type: 'crashGybe', data: { rate: 5 } }] }));
      expect(peak(r.l)).toBeLessThan(1e-6);
      expect(peak(r.r)).toBeLessThan(1e-6);
    });

    it('fades out smoothly when muted, to silence', T, async () => {
      const r = await render(steady(6, { aws: kn(16), speed: kn(6), rollRate: 0.2, heel: 0.3 }, { muteAt: 2 }));
      const from = Math.floor(2 * r.sr);
      expect(level(r, 1.5)).toBeGreaterThan(0.01); // it was audible before
      // Gone within ~1.5 s, dead silent afterwards…
      expect(toDb(rms(r.l, Math.floor(3.5 * r.sr)))).toBeLessThan(-80);
      // …by a smooth decay: each 100 ms window is quieter than the last, and the fade itself has no click in it.
      let prev = Infinity;
      for (let t = 2; t < 3; t += 0.1) {
        const w = rms(r.l, Math.floor(t * r.sr), Math.floor((t + 0.1) * r.sr));
        expect(w).toBeLessThan(prev * 1.05);
        prev = w;
      }
      expect(clickScore(r.l, from - 2000, Math.floor(3.5 * r.sr)).score).toBeLessThan(9);
    });

    it('starts from silence: no thump in the first milliseconds', T, async () => {
      const r = await render(staticScene(2, { aws: kn(15), speed: kn(6) }));
      expect(peak(r.l, 0, Math.floor(0.005 * r.sr))).toBeLessThan(0.005);
    });

    it('goes quiet when the simulation is paused', T, async () => {
      const r = await render(steady(6, { ...HEAVY, mainLuff: 0.9 }, { pauseAt: 2 }));
      expect(level(r, 1.5)).toBeGreaterThan(0.005);
      expect(toDb(rms(r.l, Math.floor(4.5 * r.sr)))).toBeLessThan(-70);
    });
  });

  describe('wind and water level', () => {
    it('RMS rises with apparent wind speed, roughly as AWS²', T, async () => {
      const levels: number[] = [];
      for (const k of [4, 8, 16, 22]) levels.push(level(await render(staticScene(4, { aws: kn(k), speed: 0 }))));
      for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThan(levels[i - 1]! * 1.5);
      expect(toDb(levels[3]! / levels[0]!)).toBeGreaterThan(25);
      const ratio = level(await render(staticScene(4, { aws: kn(16), speed: 0 }))) / level(await render(staticScene(4, { aws: kn(8), speed: 0 })));
      expect(ratio).toBeGreaterThan(3);
      expect(ratio).toBeLessThan(6);
    });

    it('gets brighter as the wind builds', T, async () => {
      const lo = await render(staticScene(4, { aws: kn(6), speed: 0 }));
      const hi = await render(staticScene(4, { aws: kn(22), speed: 0 }));
      const share = (r: Rendered) => bandPower(r.l, r.sr, 1000, 8000, SETTLE * r.sr, r.l.length) / bandPower(r.l, r.sr, 50, 8000, SETTLE * r.sr, r.l.length);
      expect(share(hi)).toBeGreaterThan(1.5 * share(lo));
    });

    it('has a whistle above ~15 kn apparent: narrow tones stand out of the broadband hiss', T, async () => {
      const calm = await render(staticScene(6, { aws: kn(12), speed: 0 }));
      const gale = await render(staticScene(6, { aws: kn(25), speed: 0 }));
      const f = kn(25) * 88; // the first wire tone at 25 kn
      const from = 1.5 * gale.sr;
      const peakOverNeighbours = (r: Rendered) => {
        const bp = (lo: number, hi: number) => bandPower(r.l, r.sr, f * lo, f * hi, from, r.l.length, 8192);
        return powerDb(bp(0.98, 1.02) / ((bp(0.9, 0.94) + bp(1.06, 1.1)) / 2));
      };
      expect(note('whistle over neighbours at 25 kn (dB)', peakOverNeighbours(gale))).toBeGreaterThan(3);
      expect(note('whistle over neighbours at 12 kn (dB)', peakOverNeighbours(calm))).toBeLessThan(2);
    });

    it('water noise rises with boat speed', T, async () => {
      const levels: number[] = [];
      for (const k of [1.5, 3, 6]) levels.push(level(await render(staticScene(4, { aws: 0, speed: kn(k) }))));
      expect(levels[1]!).toBeGreaterThan(2 * levels[0]!);
      expect(levels[2]!).toBeGreaterThan(3 * levels[1]!);
    });

    it('the bow swoosh swells with roll rate and heel', T, async () => {
      const calm = level(await render(steady(3, { aws: 0, speed: kn(5), rollRate: 0, heel: 0 })));
      const rolling = level(await render(steady(3, { aws: 0, speed: kn(5), rollRate: 0.25, heel: 0.35 })));
      expect(rolling).toBeGreaterThan(1.5 * calm);
    });
  });

  describe('sail flogging', () => {
    const base = { aws: kn(12), speed: kn(3), heel: 0.25 };
    const FLOG_BAND: [number, number] = [1500, 7000];

    it('has energy in the flogging band only while luffing', T, async () => {
      const power = async (mainLuff: number) => {
        const r = await render(steady(6, { ...base, mainLuff }));
        return bandPower(r.l, r.sr, FLOG_BAND[0], FLOG_BAND[1], SETTLE * r.sr, r.l.length);
      };
      const off = await power(0);
      const belowThreshold = await power(0.15);
      const luffing = await power(0.9);
      expect(note('flog band luffing 0.9 vs 0 (dB)', powerDb(luffing / off))).toBeGreaterThan(6);
      expect(note('flog band luffing 0.15 vs 0 (dB)', Math.abs(powerDb(belowThreshold / off)))).toBeLessThan(0.5); // under the gate: no flogging sound
    });

    it('fires irregular cracks at 3–8 Hz while luffing, and none when not', T, async () => {
      const seconds = 8;
      const window = seconds - SETTLE;
      const onsets = (r: Rendered, ratio = 8) => detectOnsets(r.l.subarray(Math.floor(SETTLE * r.sr)), r.sr, { ratio });
      const sailsOnly = { layers: { wind: 0, water: 0 } };
      // The sails alone: silence, then a train of cracks.
      expect(onsets(await render(steady(seconds, { ...base, mainLuff: 0 }, sailsOnly)))).toHaveLength(0);
      const stats = intervalStats(onsets(await render(steady(seconds, { ...base, mainLuff: 0.9 }, sailsOnly))), window);
      expect(stats.rate).toBeGreaterThan(2.5);
      expect(stats.rate).toBeLessThan(7.5);
      expect(stats.cv).toBeGreaterThan(0.3); // irregular: not a clean tremolo
      // In the full mix (wind and water under it) the cracks still stand out, and the idle mix has no cracks.
      const idle = onsets(await render(steady(seconds, { ...base, mainLuff: 0 })), 12).length / window;
      const busy = onsets(await render(steady(seconds, { ...base, mainLuff: 0.9 })), 12).length / window;
      expect(idle).toBeLessThan(0.5);
      expect(busy).toBeGreaterThan(2.5);
    });

    it('flutters faster in more wind, and is louder', T, async () => {
      const seconds = 7;
      const at = async (k: number) => {
        const r = await render(steady(seconds, { aws: kn(k), speed: kn(3), mainLuff: 0.9 }));
        const only = await render(steady(seconds, { aws: kn(k), speed: kn(3), mainLuff: 0.9 }, { layers: { wind: 0, water: 0 } }));
        return {
          rate: detectOnsets(only.l.subarray(Math.floor(SETTLE * only.sr)), only.sr).length / (seconds - SETTLE),
          band: bandPower(r.l, r.sr, FLOG_BAND[0], FLOG_BAND[1], SETTLE * r.sr, r.l.length),
        };
      };
      const light = await at(6);
      const gale = await at(22);
      expect(gale.rate).toBeGreaterThan(1.4 * light.rate);
      note('crack rate 6 kn (Hz)', light.rate);
      note('crack rate 22 kn (Hz)', gale.rate);
      expect(note('flog band 22 kn vs 6 kn (dB)', powerDb(gale.band / light.band))).toBeGreaterThan(6);
    });

    it('is louder the harder it luffs', T, async () => {
      const band = async (l: number) => {
        const r = await render(steady(6, { ...base, mainLuff: l }));
        return bandPower(r.l, r.sr, FLOG_BAND[0], FLOG_BAND[1], SETTLE * r.sr, r.l.length);
      };
      expect(await band(0.9)).toBeGreaterThan(1.3 * (await band(0.4)));
    });

    it('the jib flogs too, brighter than the main', T, async () => {
      const main = await render(steady(8, { ...base, mainLuff: 0.9 }, { layers: { wind: 0, water: 0 } }));
      const jib = await render(steady(8, { ...base, jibLuff: 0.9 }, { layers: { wind: 0, water: 0 } }));
      const centroid = (r: Rendered) => bandPower(r.l, r.sr, 3500, 12000, SETTLE * r.sr, r.l.length) / bandPower(r.l, r.sr, 300, 3500, SETTLE * r.sr, r.l.length);
      expect(centroid(jib)).toBeGreaterThan(centroid(main));
      expect(detectOnsets(jib.l.subarray(Math.floor(SETTLE * jib.sr)), jib.sr).length).toBeGreaterThan(15);
    });

    it('is placed on the leeward side', T, async () => {
      const side = async (awa: number) => {
        const r = await render(steady(8, { ...base, awa, mainLuff: 0.9, jibLuff: 0.9 }, { layers: { wind: 0, water: 0 }, stereo: true }));
        return toDb(rms(r.r, SETTLE * r.sr) / rms(r.l, SETTLE * r.sr));
      };
      expect(await side(0.6)).toBeLessThan(-0.3); // wind from starboard → sails to port → louder in the left ear
      expect(await side(-0.6)).toBeGreaterThan(0.3);
    });
  });

  describe('spinnaker and impacts', () => {
    const lull = { aws: kn(10), speed: kn(4), spinSet: true };

    it('rustles while collapsed and is quiet when full', T, async () => {
      const full = level(await render(steady(5, { ...lull, spinCollapsed: 0 })));
      const collapsed = level(await render(steady(5, { ...lull, spinCollapsed: 1, spinCurl: 1 })));
      expect(collapsed).toBeGreaterThan(full * 1.15);
      const hf = (r: Rendered) => bandPower(r.l, r.sr, 2000, 8000, SETTLE * r.sr, r.l.length);
      expect(note('spin rustle HF vs full (dB)', powerDb(hf(await render(steady(5, { ...lull, spinCollapsed: 1, spinCurl: 1 }))) / hf(await render(steady(5, { ...lull, spinCollapsed: 0})))))).toBeGreaterThan(2);
    });

    it('makes a deep whump when the spinnaker refills', T, async () => {
      const r = await render({ seconds: 4, keys: [{ t: 0, set: { aws: kn(10), speed: kn(4), spinSet: true, spinCollapsed: 0 } }], events: [{ t: 2, type: 'spinRefill' }] });
      const at = Math.floor(2 * r.sr);
      const before = bandPower(r.l, r.sr, 40, 300, at - 8192, at, 4096);
      const after = bandPower(r.l, r.sr, 40, 300, at, at + 8192, 4096);
      expect(note('refill whump LF vs before (dB)', powerDb(after / before))).toBeGreaterThan(10);
      // It starts right away (well within a frame or two of the event).
      const early = rms(r.l, at + Math.floor(0.03 * r.sr), at + Math.floor(0.08 * r.sr));
      expect(early).toBeGreaterThan(3 * rms(r.l, at - Math.floor(0.05 * r.sr), at));
    });

    it('a boom crash is a heavy thump plus rattle, louder with the impact rate', T, async () => {
      const crash = async (rate: number | null) => {
        const events = rate === null ? [] : [{ t: 2, type: 'crashGybe' as const, data: { rate } }];
        const r = await render({ seconds: 4, keys: [{ t: 0, set: { aws: kn(8), speed: kn(4), awa: 2.8, mainLuff: 0 } }], events });
        const at = Math.floor(2 * r.sr);
        return {
          thump: bandPower(r.l, r.sr, 40, 600, at, at + 6144, 2048),
          // The rig rattle: metallic ticks in the 1–6 kHz band, 0.1–0.8 s after the impact itself.
          rattle: peakBandLevel(r.l, r.sr, 2450, 0.5, at + Math.floor(0.1 * r.sr), at + Math.floor(0.8 * r.sr)),
          peak: peak(r.l, at, at + Math.floor(0.5 * r.sr)),
        };
      };
      const none = await crash(null);
      const soft = await crash(1.6);
      const hard = await crash(5);
      expect(note('crash thump vs none (dB)', powerDb(hard.thump / none.thump))).toBeGreaterThan(15);
      expect(note('crash thump hard vs soft (dB)', powerDb(hard.thump / soft.thump))).toBeGreaterThan(2);
      expect(hard.peak).toBeGreaterThan(1.3 * soft.peak);
      expect(note('crash rattle peak vs none (dB)', toDb(hard.rattle / none.rattle))).toBeGreaterThan(8); // the rig rattles on
    });
  });

  describe('trimming', () => {
    const still = { aws: kn(10), speed: kn(4), boomAngle: 0.35, clewAngle: 0.3 };
    const CLICK_BAND = { lo: 1800, hi: 6000, ratio: 12 };
    /** Idle, a slow haul, a hard grind, easing, then a fast swing across. */
    const hauling = (set: Omit<Frame, 'events' | 't'>): Scenario => ({
      seconds: 15,
      keys: [
        { t: 0, set },
        { t: 3.5, set: { boomRate: -0.1 } }, { t: 5.5, set: { boomRate: 0 } },
        { t: 6.5, set: { boomRate: -0.4 } }, { t: 8.5, set: { boomRate: 0 } },
        { t: 9.5, set: { boomRate: 0.3 } }, { t: 11.5, set: { boomRate: 0 } },
        { t: 12.5, set: { boomRate: -2 } }, { t: 14.5, set: { boomRate: 0 } },
      ],
    });
    const clicksPerSecond = (r: Rendered, a: number, b: number) => detectOnsets(r.l.subarray(Math.floor(a * r.sr), Math.floor(b * r.sr)), r.sr, CLICK_BAND).length / (b - a);

    it('ratchets while a sheet is hauled in, faster the harder it is hauled, and is silent otherwise', T, async () => {
      const r = await render(hauling(still));
      const idle = note('trim clicks/s idle', clicksPerSecond(r, 2, 3.4));
      const slow = note('trim clicks/s slow haul', clicksPerSecond(r, 3.7, 5.5));
      const hard = note('trim clicks/s hard haul', clicksPerSecond(r, 6.7, 8.5));
      const easing = note('trim clicks/s easing', clicksPerSecond(r, 9.7, 11.5));
      const swing = note('trim clicks/s steady swing', clicksPerSecond(r, 13, 14.4));
      expect(idle).toBeLessThan(0.5);
      expect(slow).toBeGreaterThan(4);
      expect(hard).toBeGreaterThan(1.8 * slow);
      expect(easing).toBeLessThan(1.5);
      expect(swing).toBeLessThan(1.5);
    });

    it('is still audible over a fresh breeze', T, async () => {
      const r = await render(hauling({ ...still, aws: kn(20), speed: kn(7) }));
      expect(note('trim clicks/s slow haul, 20 kn', clicksPerSecond(r, 3.7, 5.5))).toBeGreaterThan(3);
      expect(clicksPerSecond(r, 2, 3.4)).toBeLessThan(0.5);
    });
  });

  describe('safety', () => {
    it('never clips, even with everything at once', T, async () => {
      const r = await render({
        seconds: 8,
        keys: [{ t: 0, set: { aws: kn(45), speed: kn(12), mainLuff: 1, jibLuff: 1, spinSet: true, spinCollapsed: 1, spinCurl: 1, rollRate: 0.5, heel: 0.6 } }],
        events: [
          { t: 2, type: 'crashGybe', data: { rate: 9 } }, { t: 2.2, type: 'crashGybe', data: { rate: 9 } }, { t: 2.4, type: 'spinRefill' },
          { t: 2.5, type: 'spinCollapse' }, { t: 3, type: 'crashGybe', data: { rate: 12 } },
        ],
        volume: 1,
        stereo: true,
      });
      expect(peak(r.l, 0)).toBeLessThan(0.99);
      expect(peak(r.r, 0)).toBeLessThan(0.99);
      expect(toDb(level(r))).toBeGreaterThan(-25); // and it really was loud
    });

    it('is repeatable: the same scenario renders the same samples (seeded)', T, async () => {
      const scn = steady(3, { aws: kn(14), speed: kn(4), mainLuff: 0.8 });
      const a = await harness!.render(scn);
      const b = await harness!.render(scn);
      let diff = 0;
      for (let i = 0; i < a.l.length; i++) diff = Math.max(diff, Math.abs(a.l[i]! - b.l[i]!));
      expect(diff).toBeLessThan(1e-5); // identical up to float rounding in the browser's mixer
    });

    it('update() costs far less than 0.3 ms, in a quiet scene and in the busiest one', T, async () => {
      for (const set of [{ aws: kn(8), speed: kn(4) }, HEAVY]) {
        const r = await render(steady(6, set, { events: [{ t: 2, type: 'crashGybe', data: { rate: 4 } }] }));
        expect(r.update.meanMs).toBeLessThan(0.3);
        expect(r.update.p95Ms).toBeLessThan(0.3);
      }
    });

    it('the audio graph is light: 10 s of the busiest scene render in well under a fifth of the time', T, async () => {
      const r = await render(steady(10, HEAVY, { staticRender: true }));
      expect(r.renderMs).toBeLessThan(2000); // ≈ 20× real time here (about 4 % of a core); allow 5× slower machines
    });

    it('start() builds the graph quickly (it runs inside the first click)', T, async () => {
      const r = await render(steady(1, { aws: kn(8) }, { staticRender: true }));
      expect(r.startMs).toBeLessThan(250);
    });
  });

  describe('no clicks when parameters jump', () => {
    /** Largest first-difference outlier and absolute step in [from, to) seconds of either channel. */
    const clicks = (r: Rendered, from: number, to: number) => {
      const a = clickScore(r.l, Math.floor(from * r.sr), Math.floor(to * r.sr));
      const b = r.r.length ? clickScore(r.r, Math.floor(from * r.sr), Math.floor(to * r.sr)) : a;
      return { score: Math.max(a.score, b.score), step: Math.max(a.maxStep, b.maxStep) };
    };

    it('wind speed, boat speed, heel, heading and camera all jump with no click', T, async () => {
      const r = await render({
        seconds: 9,
        stereo: true,
        keys: [
          { t: 0, set: { aws: kn(3), speed: 0, heel: 0, awa: 0.5 } },
          { t: 2, set: { aws: kn(22) } },
          { t: 3, set: { speed: kn(8) } },
          { t: 3.5, set: { heel: 0.5, rollRate: 0.3 } },
          { t: 4.5, set: { awa: -2.5, heading: 3 } },
          { t: 5.5, set: { aws: kn(4), speed: kn(1), heel: 0, rollRate: 0 } },
          { t: 6.5, set: { yaw: 2.4 } },
          { t: 7.5, set: { awa: 0.4, yaw: -2.4 } },
        ],
      });
      const c = clicks(r, 0.3, 9);
      expect(c.score).toBeLessThan(9); // a step or spike would stand out by ≫ 9× the local noise
      expect(c.step).toBeLessThan(0.5);
    });

    it('a sail gate switching on and off fades in and out; the crumple layer alone makes no click', T, async () => {
      // Luffing just under and just over the gate: crack trains start/stop, the continuous layers glide.
      const r = await render({
        seconds: 8,
        keys: [{ t: 0, set: { aws: kn(12), speed: kn(3), mainLuff: 0 } }, { t: 3, set: { mainLuff: 0.9 } }, { t: 5, set: { mainLuff: 0 } }],
        layers: { wind: 0, water: 0 },
      });
      // Right after the stop, the tail rings out and dies away (no truncated snap).
      expect(toDb(rms(r.l, Math.floor(6.6 * r.sr)))).toBeLessThan(-55);
      // And nothing sharper than the snaps themselves happens at the switch-off instant.
      const off = clicks(r, 5.2, 6.5);
      expect(off.step).toBeLessThan(0.05);
    });

    it('spinnaker collapse and refill levels glide', T, async () => {
      const r = await render({
        seconds: 8,
        keys: [{ t: 0, set: { aws: kn(10), speed: kn(4), spinSet: true, spinCollapsed: 0 } }, { t: 3, set: { spinCollapsed: 1, spinCurl: 1 } }, { t: 5.5, set: { spinCollapsed: 0, spinCurl: 0 } }],
        layers: { sails: 1, wind: 0.3, water: 0.3 },
      });
      const c = clicks(r, 0.3, 8);
      expect(c.step).toBeLessThan(0.35); // the crumpling pops are soft; nothing anywhere near full scale
    });

    it('voices retriggered in quick succession do not click', T, async () => {
      const events = Array.from({ length: 8 }, (_, i) => ({ t: 1 + i * 0.09, type: 'crashGybe' as const, data: { rate: 3 + i } }));
      const r = await render({ seconds: 4, keys: [{ t: 0, set: { aws: kn(10), speed: kn(4) } }], events });
      const c = clicks(r, 0.5, 4);
      expect(c.step).toBeLessThan(0.5); // impacts are sharp by nature (sub-ms attack) but never a raw step
      expect(peak(r.l)).toBeLessThan(0.99);
    });
  });

  describe('stereo placement', () => {
    const wind = { aws: kn(14), speed: 0, heel: 0 };

    it('wind from the starboard bow is louder in the right ear, from the port bow in the left, from ahead balanced', T, async () => {
      const balance = async (awa: number, yaw = 0) => {
        const r = await render(staticScene(10, { ...wind, awa, yaw }, { stereo: true }));
        return toDb(rms(r.r, SETTLE * r.sr) / rms(r.l, SETTLE * r.sr));
      };
      const ahead = note('wind balance R/L from ahead (dB)', await balance(0));
      expect(Math.abs(ahead)).toBeLessThan(1.5); // (two independent noise channels never match exactly)
      expect(note('wind balance R/L from starboard bow (dB)', await balance(50 * DEG)) - ahead).toBeGreaterThan(1.5);
      expect(note('wind balance R/L from port bow (dB)', await balance(-50 * DEG)) - ahead).toBeLessThan(-1.5);
    });

    it('follows the camera: turning the view swings the wind to the other ear', T, async () => {
      const balance = async (yaw: number) => {
        const r = await render(staticScene(10, { ...wind, awa: 0, yaw }, { stereo: true }));
        return toDb(rms(r.r, SETTLE * r.sr) / rms(r.l, SETTLE * r.sr));
      };
      const ahead = await balance(0);
      expect(note('wind balance, camera turned to port (dB)', await balance(-90 * DEG)) - ahead).toBeGreaterThan(2); // the wind ahead is now on the right
      expect(note('wind balance, camera turned to starboard (dB)', await balance(90 * DEG)) - ahead).toBeLessThan(-2);
    });
  });

  describe('layers', () => {
    it('setLayerLevel(…, 0) removes a layer', T, async () => {
      const all = level(await render(staticScene(4, { aws: kn(12), speed: kn(5) })));
      const none = level(await render(staticScene(4, { aws: kn(12), speed: kn(5) }, { layers: { wind: 0, water: 0, sails: 0, impacts: 0, trim: 0 } })));
      expect(toDb(none)).toBeLessThan(-100);
      expect(all).toBeGreaterThan(0.01);
    });
  });
});
