// The run-state lifecycle of a real-time Soundscape, driven against the strict fake context with fake timers and a stub
// `document`: starting inside a gesture, mute / unmute, hidden tab, paused simulation, stalled frame loop, the browser
// stopping the context by itself, failures, dispose. (The Chromium suite renders offline contexts, which have none of this.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Soundscape } from '../Soundscape';
import { FakeContext, outputChain } from './fakeContext';
import { snapshotFrom, type Frame } from './fixtures';

// ------------------------------------------------------------------------------------------------ rig

interface StubDocument {
  hidden: boolean;
  listeners: Map<string, Set<() => void>>;
  addEventListener(type: string, h: () => void): void;
  removeEventListener(type: string, h: () => void): void;
  setHidden(hidden: boolean): void;
}

function stubDocument(): StubDocument {
  const doc: StubDocument = {
    hidden: false,
    listeners: new Map(),
    addEventListener(type, h) { (doc.listeners.get(type) ?? doc.listeners.set(type, new Set()).get(type)!).add(h); },
    removeEventListener(type, h) { doc.listeners.get(type)?.delete(h); },
    setHidden(hidden) {
      doc.hidden = hidden;
      doc.listeners.get('visibilitychange')?.forEach((h) => h());
    },
  };
  return doc;
}

interface FakeTarget extends EventTarget {
  handlers: Map<string, Set<() => void>>;
  dispatch(type: string): void;
  armed(): number;
}

function fakeTarget(): FakeTarget {
  const handlers = new Map<string, Set<() => void>>();
  return {
    handlers,
    addEventListener: (type: string, h: () => void) => { (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(h); },
    removeEventListener: (type: string, h: () => void) => { handlers.get(type)?.delete(h); },
    dispatch: (type: string) => handlers.get(type)?.forEach((h) => h()),
    armed: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  } as unknown as FakeTarget;
}

const live: Soundscape[] = [];
afterEach(() => {
  while (live.length) live.pop()!.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A real-time (non-offline) Soundscape on the fake context, with fake timers and a stub document. */
function rig(state: 'running' | 'suspended' = 'running') {
  vi.useFakeTimers();
  const doc = stubDocument();
  vi.stubGlobal('document', doc);
  const ctx = new FakeContext();
  ctx.state = state;
  const sound = new Soundscape({ context: ctx.asContext() });
  live.push(sound);
  let simT = 0;
  return {
    ctx,
    doc,
    sound,
    /** start() under fake timers: the noise generation yields on timers, so let them run. */
    async start(): Promise<void> {
      const p = sound.start();
      await vi.advanceTimersByTimeAsync(60);
      await p;
    },
    /** `seconds` of running simulation at 60 fps: audio clock, wall clock and snapshot clock advance together. */
    frames(seconds: number, f: Frame = {}, frozen = false): void {
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        ctx.currentTime += 1 / 60;
        if (!frozen) simT += 1 / 60;
        sound.update(snapshotFrom({ t: simT, ...f }), 0, 1 / 60);
        vi.advanceTimersByTime(1000 / 60);
      }
    },
    /** Wall time passing with nobody calling update() (a hidden tab, a stalled loop). */
    async idle(ms: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms);
    },
    master: () => outputChain(ctx).master.gain,
    duck: () => outputChain(ctx).duck.gain,
  };
}

// ------------------------------------------------------------------------------------------------ starting

describe('starting inside a user gesture', () => {
  it('creates and resumes the context synchronously when the gesture fires, before any await', () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    let created = 0;
    vi.stubGlobal('AudioContext', function () { created++; return ctx; });
    const sound = new Soundscape();
    live.push(sound);
    const target = fakeTarget();
    sound.startOnFirstGesture(target);
    expect(created).toBe(0); // armed, nothing exists yet
    target.dispatch('pointerdown'); // the gesture
    // Straight after the handler returned — no timer, no microtask has run:
    expect(created).toBe(1);
    expect(ctx.resumes).toBe(1);
    expect(ctx.state).toBe('running');
    expect(ctx.nodes).toHaveLength(0); // the graph follows once the noise is generated
  });

  it('start() itself makes the context and asks it to resume before its promise is even awaited', () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    let created = 0;
    vi.stubGlobal('AudioContext', function () { created++; return ctx; });
    const sound = new Soundscape();
    live.push(sound);
    void sound.start();
    expect([created, ctx.resumes]).toEqual([1, 1]);
  });

  it('stays armed until the context is really running, then lets go of the listeners', async () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    ctx.resumeBlocked = true; // a touch that does not count as a gesture: resume() is accepted but nothing happens
    vi.stubGlobal('AudioContext', function () { return ctx; });
    const sound = new Soundscape();
    live.push(sound);
    const target = fakeTarget();
    sound.startOnFirstGesture(target);
    target.dispatch('pointerdown');
    await vi.advanceTimersByTimeAsync(80);
    expect(ctx.nodes.length).toBeGreaterThan(50); // the graph is built…
    expect(sound.running).toBe(false); // …but the context is still locked
    expect(target.armed()).toBeGreaterThan(0); // so the next event gets another try
    ctx.resumeBlocked = false;
    target.dispatch('keydown');
    await vi.advanceTimersByTimeAsync(10);
    expect(sound.running).toBe(true);
    expect(target.armed()).toBe(0);
    expect(ctx.resumes).toBe(2);
  });

  it('one gesture that fires several events (pointerdown, pointerup) builds one graph', async () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    let created = 0;
    vi.stubGlobal('AudioContext', function () { created++; return ctx; });
    const sound = new Soundscape();
    live.push(sound);
    const target = fakeTarget();
    sound.startOnFirstGesture(target);
    target.dispatch('pointerdown');
    target.dispatch('pointerup');
    await vi.advanceTimersByTimeAsync(80);
    expect(created).toBe(1);
    const sources = ctx.nodes.filter((n) => n.kind === 'source').length;
    expect(sources).toBeGreaterThan(20);
    expect(sources).toBeLessThan(40); // not two copies of the graph
  });
});

// ------------------------------------------------------------------------------------------------ mute

describe('mute', () => {
  it('fades at once, sleeps after 1.3 s, and unmuting wakes it immediately', async () => {
    const r = rig();
    await r.start();
    r.frames(0.5);
    expect(r.ctx.suspends).toBe(0);
    r.sound.setEnabled(false);
    expect(r.master().lastTarget).toBe(0); // the fade starts now
    r.frames(1.25);
    expect(r.ctx.suspends).toBe(0); // the fade is still going
    r.frames(0.1);
    expect(r.ctx.suspends).toBe(1);
    expect(r.ctx.state).toBe('suspended');
    r.sound.setEnabled(true);
    expect(r.ctx.resumes).toBe(1); // wakes at once …
    expect(r.ctx.state).toBe('running');
    expect(r.master().lastTarget).toBeCloseTo(0.64, 9); // … and fades back in
  });

  it('sleeps on time even if update() has stopped being called', async () => {
    const r = rig();
    await r.start();
    r.frames(0.3);
    r.sound.setEnabled(false);
    await r.idle(1250);
    expect(r.ctx.suspends).toBe(0);
    await r.idle(100);
    expect(r.ctx.suspends).toBe(1); // (the 0.7 s watchdog firing meanwhile must not postpone it)
  });

  it('unmuting inside the fade cancels the sleep', async () => {
    const r = rig();
    await r.start();
    r.frames(0.3);
    r.sound.setEnabled(false);
    r.frames(0.8);
    r.sound.setEnabled(true);
    r.frames(3);
    expect(r.ctx.suspends).toBe(0);
    expect(r.ctx.resumes).toBe(0);
    expect(vi.getTimerCount()).toBe(1); // only the watchdog
  });

  it('repeated setEnabled(false) sleeps once and keeps the first deadline', async () => {
    const r = rig();
    await r.start();
    r.sound.setEnabled(false);
    r.frames(1);
    r.sound.setEnabled(false);
    r.sound.setEnabled(false);
    r.frames(0.4);
    expect(r.ctx.suspends).toBe(1);
  });

  it('muted before start(): the graph is built but the context is asleep at once', async () => {
    const r = rig();
    r.sound.setEnabled(false);
    await r.start();
    expect(r.ctx.nodes.length).toBeGreaterThan(50);
    expect(r.ctx.suspends).toBe(1);
    expect(r.ctx.state).toBe('suspended');
    expect(r.master().lastTarget).toBe(0);
    expect(r.sound.audible).toBe(false);
    r.sound.setEnabled(true);
    expect(r.ctx.resumes).toBe(1);
    expect(r.ctx.state).toBe('running');
    expect(r.master().lastTarget).toBeCloseTo(0.64, 9);
  });

  it('muted while the graph is still being built (the first click is the sound toggle): asleep as soon as it exists', async () => {
    const r = rig();
    const p = r.sound.start();
    expect(r.ctx.nodes).toHaveLength(0); // the noise is still being generated
    r.sound.setEnabled(false);
    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(r.ctx.nodes.length).toBeGreaterThan(50);
    expect(r.ctx.suspends).toBe(1);
    expect(r.master().lastTarget).toBe(0);
  });

  it('a muted, sleeping soundscape ignores update() and start() and stays asleep', async () => {
    const r = rig();
    await r.start();
    r.frames(0.2);
    r.sound.setEnabled(false);
    r.frames(1.4);
    const calls = () => r.ctx.params().reduce((n, p) => n + p.calls, 0);
    const before = calls();
    r.frames(1);
    expect(calls() - before).toBeLessThan(5);
    await r.sound.start(); // another gesture while muted must not wake it
    expect(r.ctx.resumes).toBe(0);
    expect(r.ctx.state).toBe('suspended');
  });

  it('an offline context is never suspended or resumed and uses no timers', async () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    (ctx as unknown as { startRendering: () => void }).startRendering = () => undefined;
    const doc = stubDocument();
    vi.stubGlobal('document', doc);
    const sound = new Soundscape({ context: ctx.asContext() });
    live.push(sound);
    sound.setEnabled(false);
    const p = sound.start();
    await vi.advanceTimersByTimeAsync(60);
    await p;
    sound.setEnabled(true);
    sound.setEnabled(false);
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect([ctx.suspends, ctx.resumes]).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.listeners.get('visibilitychange')?.size ?? 0).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ hidden tab

describe('hidden tab', () => {
  it('ducks at once, sleeps 0.3 s later, and wakes when visible with the duck still down', async () => {
    const r = rig();
    await r.start();
    r.frames(0.3);
    expect(r.duck().lastTarget).toBe(1);
    r.doc.setHidden(true);
    expect(r.duck().lastTarget).toBe(0); // fades first
    expect(r.sound.audible).toBe(false);
    await r.idle(250);
    expect(r.ctx.suspends).toBe(0);
    await r.idle(100);
    expect(r.ctx.suspends).toBe(1);
    r.doc.setHidden(false);
    r.frames(0.05); // the frame loop starts again
    expect(r.ctx.resumes).toBe(1);
    expect(r.ctx.state).toBe('running');
    r.frames(0.1);
    expect(r.duck().lastTarget).toBe(1); // brought back up by update()
  });

  it('stays down while hidden even if update() keeps being called', async () => {
    const r = rig();
    await r.start();
    r.doc.setHidden(true);
    r.frames(0.5);
    expect(r.duck().lastTarget).toBe(0);
  });

  it('hiding and showing within the fade never sleeps', async () => {
    const r = rig();
    await r.start();
    r.frames(0.2);
    r.doc.setHidden(true);
    await r.idle(150);
    r.doc.setHidden(false);
    r.frames(1);
    expect(r.ctx.suspends).toBe(0);
    expect(r.ctx.resumes).toBe(0);
  });

  it('showing the tab does not wake a muted soundscape; unmuting does', async () => {
    const r = rig();
    await r.start();
    r.frames(0.2);
    r.sound.setEnabled(false);
    r.doc.setHidden(true);
    await r.idle(2000);
    expect(r.ctx.suspends).toBe(1);
    r.doc.setHidden(false);
    r.frames(0.1);
    expect(r.ctx.resumes).toBe(0);
    expect(r.ctx.state).toBe('suspended');
    r.sound.setEnabled(true);
    expect(r.ctx.resumes).toBe(1);
  });

  it('starting in a hidden tab builds the graph and sleeps at once', async () => {
    const r = rig();
    r.doc.hidden = true;
    await r.start();
    expect(r.ctx.nodes.length).toBeGreaterThan(50);
    expect(r.ctx.suspends).toBe(1);
    r.doc.setHidden(false);
    r.frames(0.05);
    expect(r.ctx.resumes).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ paused / stalled

describe('paused simulation and stalled frame loop', () => {
  it('pause ducks, sleeps 1.6 s later, and resuming the simulation wakes it', async () => {
    const r = rig();
    await r.start();
    r.frames(0.5);
    r.frames(0.5, {}, true); // the snapshot clock stands still
    expect(r.sound.drives.ducked).toBe(true);
    expect(r.sound.audible).toBe(false);
    expect(r.duck().lastTarget).toBe(0);
    expect(r.ctx.suspends).toBe(0); // fading, not asleep yet
    r.frames(1.3, {}, true);
    expect(r.ctx.suspends).toBe(0);
    r.frames(0.6, {}, true);
    expect(r.ctx.suspends).toBe(1); // ≈ 0.3 s to notice + 1.6 s
    expect(r.ctx.state).toBe('suspended');
    r.frames(0.2); // the clock moves again
    expect(r.sound.drives.ducked).toBe(false);
    expect(r.ctx.resumes).toBe(1);
    expect(r.ctx.state).toBe('running');
    expect(r.duck().lastTarget).toBe(1);
  });

  it('a short pause never sleeps', async () => {
    const r = rig();
    await r.start();
    r.frames(0.3);
    r.frames(0.8, {}, true);
    r.frames(0.5);
    r.frames(0.8, {}, true);
    r.frames(0.5);
    expect(r.ctx.suspends).toBe(0);
  });

  it('a stalled frame loop fades after 0.7 s, sleeps 1.6 s later, and the next update wakes it', async () => {
    const r = rig();
    await r.start();
    r.frames(0.3);
    await r.idle(600);
    expect(r.sound.audible).toBe(true); // a hiccup is not a stall
    await r.idle(450); // the watchdog ticks every 250 ms
    expect(r.sound.audible).toBe(false); // it has faded the sound
    expect(r.duck().lastTarget).toBe(0);
    expect(r.ctx.suspends).toBe(0);
    await r.idle(1700);
    expect(r.ctx.suspends).toBe(1);
    r.frames(0.05);
    expect(r.sound.audible).toBe(true);
    expect(r.ctx.resumes).toBe(1);
    expect(r.duck().lastTarget).toBe(1);
  });

  it('a muted soundscape whose frame loop stalls is not put to sleep later than the mute would', async () => {
    const r = rig();
    await r.start();
    r.frames(0.2);
    r.sound.setEnabled(false);
    await r.idle(1350); // no update() at all meanwhile: the watchdog also fires at 0.75 s
    expect(r.ctx.suspends).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ the browser stops it

describe('the browser stops the context by itself', () => {
  it('asks to resume at once and re-arms the gesture listeners', async () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    vi.stubGlobal('AudioContext', function () { return ctx; });
    vi.stubGlobal('document', stubDocument());
    const sound = new Soundscape();
    live.push(sound);
    const target = fakeTarget();
    sound.startOnFirstGesture(target);
    target.dispatch('pointerdown');
    await vi.advanceTimersByTimeAsync(80);
    expect(target.armed()).toBe(0); // running: listeners dropped
    const resumes = ctx.resumes;
    ctx.interrupt(); // a phone call
    expect(ctx.resumes).toBe(resumes + 1); // tried again straight away
    expect(target.armed()).toBeGreaterThan(0); // and will try on the next tap
  });

  it('does not fight the user: a mute we slept on is not "interrupted"', async () => {
    const r = rig();
    await r.start();
    r.sound.setEnabled(false);
    await r.idle(1400);
    expect(r.ctx.suspends).toBe(1);
    expect(r.ctx.resumes).toBe(0); // our own suspend() raised statechange, and was ignored
  });

  it('does not keep asking while the sound is inaudible anyway', async () => {
    const r = rig();
    await r.start();
    r.frames(0.2);
    r.doc.setHidden(true);
    r.ctx.interrupt();
    expect(r.ctx.resumes).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ failure

describe('failure', () => {
  it('a browser missing a node type: one warning, the context we made is closed, nothing throws afterwards', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeContext();
    ctx.failOn = 'createStereoPanner'; // Safari < 14.1
    let created = 0;
    vi.stubGlobal('AudioContext', function () { created++; return ctx; });
    const sound = new Soundscape();
    live.push(sound);
    const p = sound.start();
    await vi.advanceTimersByTimeAsync(80);
    await p;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(ctx.closed).toBe(true);
    expect(sound.running).toBe(false);
    expect(() => sound.update(snapshotFrom(), 0, 1 / 60)).not.toThrow();
    expect(() => sound.setEnabled(false)).not.toThrow();
    await sound.start(); // no second attempt
    expect(created).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('WebAudio missing altogether: start() resolves quietly', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sound = new Soundscape();
    live.push(sound);
    await expect(sound.start()).resolves.toBeUndefined();
    expect(sound.running).toBe(false);
  });

  it('an exception inside update() never reaches the caller: one warning, then silence and a closed context', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeContext();
    vi.stubGlobal('AudioContext', function () { return ctx; });
    const sound = new Soundscape();
    live.push(sound);
    const p = sound.start();
    await vi.advanceTimersByTimeAsync(80);
    await p;
    sound.update(snapshotFrom({ t: 0.1 }), 0, 1 / 60);
    // The browser refuses an automation call (say, InvalidStateError on an interrupted context).
    for (const q of ctx.params()) q.setTargetAtTime = () => { throw new Error('InvalidStateError'); };
    expect(() => sound.update(snapshotFrom({ t: 0.2, aws: 9 }), 0, 1 / 60)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(ctx.closed).toBe(true);
    expect(sound.running).toBe(false);
    const calls = ctx.params().reduce((n, q) => n + q.calls, 0);
    sound.update(snapshotFrom({ t: 0.3, aws: 9 }), 0, 1 / 60);
    expect(ctx.params().reduce((n, q) => n + q.calls, 0)).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('with an injected context a failure silences the graph but leaves the context to its owner', async () => {
    const r = rig();
    await r.start();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    r.frames(0.1);
    for (const q of r.ctx.params()) q.setTargetAtTime = () => { throw new Error('boom'); };
    r.frames(0.1, { aws: 14 });
    expect(r.ctx.closed).toBe(false);
    expect(r.sound.running).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ dispose

describe('dispose', () => {
  it('removes every timer and listener, even with a sleep pending', async () => {
    const r = rig();
    await r.start();
    r.frames(0.2);
    r.sound.setEnabled(false); // a sleep is pending
    expect(vi.getTimerCount()).toBe(2); // the sleep + the watchdog
    r.sound.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(r.doc.listeners.get('visibilitychange')?.size ?? 0).toBe(0);
    expect(r.ctx.onstatechange).toBeNull();
    await r.idle(5000);
    expect([r.ctx.suspends, r.ctx.resumes]).toEqual([0, 0]);
    expect(r.ctx.closed).toBe(false); // the injected context is not ours to close
  });

  it('is idempotent and leaves later calls harmless', async () => {
    const r = rig();
    await r.start();
    r.sound.dispose();
    r.sound.dispose();
    expect(() => {
      r.sound.update(snapshotFrom(), 0, 1 / 60);
      r.sound.setEnabled(true);
      r.sound.setVolume(0.3);
      r.sound.setLayerLevel('wind', 0);
    }).not.toThrow();
    expect(r.sound.analyser()).toBeNull();
    await r.sound.start();
    expect(r.sound.running).toBe(false);
  });

  it('disposing while the graph is still being built leaves nothing behind', async () => {
    const r = rig();
    const p = r.sound.start();
    r.sound.dispose();
    await vi.advanceTimersByTimeAsync(80);
    await p;
    expect(r.ctx.nodes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a context it created itself, and stops listening for gestures', async () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    vi.stubGlobal('AudioContext', function () { return ctx; });
    const sound = new Soundscape();
    const target = fakeTarget();
    sound.startOnFirstGesture(target);
    target.dispatch('pointerdown');
    await vi.advanceTimersByTimeAsync(80);
    sound.dispose();
    expect(ctx.closed).toBe(true);
    expect(target.armed()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
