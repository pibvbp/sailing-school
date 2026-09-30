// What the strict fake graph can guarantee about the OUTPUT without rendering a sample: where every signal goes, what
// bounds it, and that a running soundscape only ever moves parameters in click-free ways. These are the structural
// counterparts of the signal-level Chromium tests (`pnpm test:audio`), so the default suite and CI still protect the
// "never clips" and "no clicks" criteria.
import { afterEach, describe, expect, it } from 'vitest';
import { Soundscape } from '../Soundscape';
import { FakeContext, FakeNode, FakeParam, FakeShaper, outputChain, timeline } from './fakeContext';
import { event, snapshotFrom, type Frame } from './fixtures';

const live: Soundscape[] = [];
afterEach(() => {
  while (live.length) live.pop()!.dispose();
});

async function built(): Promise<{ sound: Soundscape; ctx: FakeContext }> {
  const ctx = new FakeContext();
  const sound = new Soundscape({ context: ctx.asContext() });
  live.push(sound);
  await sound.start();
  return { sound, ctx };
}

/** Every AudioParam that some node is wired into (a modulation input), for telling control signals from audio. */
function modulated(ctx: FakeContext): Set<FakeNode> {
  const set = new Set<FakeNode>();
  for (const p of ctx.params()) for (const n of p.fedBy) set.add(n);
  return set;
}

/** Can `from` reach `to` along audio connections without passing through `avoid`? */
function reaches(from: FakeNode, to: FakeNode, avoid?: FakeNode): boolean {
  const seen = new Set<FakeNode>([from]);
  const queue = [from];
  while (queue.length) {
    const n = queue.pop()!;
    if (n === to) return true;
    for (const m of n.out) {
      if (m === avoid || seen.has(m)) continue;
      seen.add(m);
      queue.push(m);
    }
  }
  return false;
}

describe('output topology', () => {
  it('ends in duck → pre-gain → soft limiter → master gain → speakers, each feeding only the next', async () => {
    const { ctx } = await built();
    const { master, shaper, pre, duck } = outputChain(ctx); // throws unless each link is unique and of the right kind
    expect(ctx.nodes.filter((n) => n.out.includes(ctx.destination))).toEqual([master]); // the speakers hear only the master gain
    expect(master.out).toEqual([ctx.destination]);
    expect(shaper.out).toEqual([master]);
    expect(pre.out).toEqual([shaper]);
    expect(duck.out).toEqual([pre]);
    for (const n of [master, shaper, pre, duck]) for (const p of Object.values(n)) if (p instanceof FakeParam) expect(p.fedBy).toHaveLength(0); // nothing modulates the output stage
    expect(pre.gain.value).toBe(0.5);
  });

  it('every audio source reaches the speakers only through the limiter, and only through the duck', async () => {
    const { ctx } = await built();
    const { shaper, duck } = outputChain(ctx);
    const control = modulated(ctx);
    const sources = ctx.nodes.filter((n) => n.kind === 'source' || n.kind === 'osc');
    expect(sources.length).toBeGreaterThan(20);
    const idle: FakeNode[] = [];
    for (const src of sources) {
      expect(reaches(src, ctx.destination, shaper)).toBe(false); // no way round the limiter
      expect(reaches(src, shaper, duck)).toBe(false); // no way round the duck (pause / hidden tab silence everything)
      // …and nothing is left dangling: each source either makes sound or drives a modulation input — except the two
      // crumple textures' control sources, which are only wired in while their sail sound is active.
      const audio = reaches(src, ctx.destination);
      const drivesParam = [...control].some((c) => reaches(src, c));
      if (!audio && !drivesParam) idle.push(src);
    }
    expect(idle).toHaveLength(2);
    for (const n of idle) expect((n as unknown as { buffer: { sampleRate: number } }).buffer.sampleRate).toBe(8000); // control-rate noise
  });

  it('all five layer buses are wired into the duck, and reached by a source', async () => {
    const { ctx } = await built();
    const { duck } = outputChain(ctx);
    const buses = ctx.nodes.filter((n) => n !== duck && n.out.includes(duck));
    expect(buses).toHaveLength(5); // wind, water, sails, impacts, trim
    const sources = ctx.nodes.filter((n) => n.kind === 'source' || n.kind === 'osc');
    for (const bus of buses) expect(sources.some((s) => reaches(s, bus))).toBe(true);
  });

  it('a meter tap hangs off the master gain without becoming a second way to the speakers', async () => {
    const { sound, ctx } = await built();
    const analyser = sound.analyser()!;
    const { master } = outputChain(ctx);
    expect(master.out).toContain(analyser as unknown as FakeNode);
    expect(ctx.nodes.filter((n) => n.out.includes(ctx.destination))).toEqual([master]);
    expect((analyser as unknown as FakeNode).out).toHaveLength(0);
  });
});

describe('the output ceiling', () => {
  it('the soft limiter cannot pass more than 0.95, whatever arrives', async () => {
    const { ctx } = await built();
    const { shaper, pre } = outputChain(ctx);
    const curve = (shaper as FakeShaper).curve!;
    expect(curve.length).toBeGreaterThanOrEqual(1024);
    // A WaveShaper clamps its input to −1…1 and reads the curve: emulate that for absurd bus levels.
    const through = (bus: number): number => {
      const u = Math.max(-1, Math.min(1, bus * pre.gain.value));
      return curve[Math.round(((u + 1) / 2) * (curve.length - 1))]!;
    };
    for (const a of [0.01, 0.1, 0.5, 1, 2, 4, 10, 1e3, 1e9, Number.MAX_VALUE]) {
      expect(Math.abs(through(a))).toBeLessThanOrEqual(0.95 + 1e-6);
      expect(Math.abs(through(-a))).toBeLessThanOrEqual(0.95 + 1e-6);
    }
    // Unity for ordinary levels, smooth and monotone above.
    expect(through(0.1)).toBeCloseTo(0.1, 2);
    expect(through(0.3) / 0.3).toBeGreaterThan(0.97);
    for (let i = 1; i < curve.length; i++) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
  });

  it('the master gain never exceeds 1, however it is driven', async () => {
    const { sound, ctx } = await built();
    const { master } = outputChain(ctx);
    for (const v of [1, 7, -3, NaN, Infinity, 0.5, 1e9]) {
      sound.setVolume(v);
      sound.setEnabled(false);
      sound.setEnabled(true);
    }
    sound.setLayerLevel('wind', 1e9); // a layer bus may be driven hard: the limiter is downstream
    expect(master.gain.max).toBeLessThanOrEqual(1);
    expect(master.gain.min).toBeGreaterThanOrEqual(0);
    // so the speakers get at most 0.95 × 1.
    expect(0.95 * master.gain.max).toBeLessThanOrEqual(0.95);
  });
});

describe('a running soundscape only makes click-free parameter moves', () => {
  /** A busy session: wind, luffing sails, spinnaker, trimming, events, camera swings, mute and volume changes. */
  async function session(record = false): Promise<{ ctx: FakeContext; sound: Soundscape; valueWritesAtStart: number }> {
    const { sound, ctx } = await built();
    if (record) for (const p of ctx.params()) p.record = true;
    const writes = (): number => ctx.params().reduce((n, p) => n + p.valueWrites, 0);
    const valueWritesAtStart = writes();
    let t = 0;
    for (let i = 0; i < 1500; i++) {
      ctx.currentTime = i / 60;
      const f: Frame = {
        t: (t += 1 / 60),
        aws: (3 + 18 * Math.abs(Math.sin(i / 70))) * 0.5144,
        awa: Math.sin(i / 110) * 2.8,
        heading: i / 90,
        speed: 4 * Math.abs(Math.sin(i / 95)),
        heel: Math.sin(i / 60) * 0.5,
        rollRate: Math.sin(i / 25) * 0.2,
        mainLuff: i % 400 > 220 ? 0.9 : 0,
        jibLuff: i % 530 > 300 ? 0.7 : 0,
        spinSet: i > 300,
        spinCollapsed: i % 600 > 350 ? 1 : 0,
        spinCurl: i % 600 > 350 ? 1 : 0.2,
        boomAngle: 0.3,
        boomRate: i % 300 > 200 ? -0.25 : 0,
        clewAngle: 0.5 - ((i % 300) / 300) * 0.3,
      };
      const events = [];
      if (i % 450 === 100) events.push(event('crashGybe', t, { rate: 2 + (i % 5) }));
      if (i % 450 === 200) events.push(event('spinRefill', t));
      if (i % 450 === 300) events.push(event('spinCollapse', t));
      sound.update(snapshotFrom({ ...f, events }), Math.sin(i / 50) * 3, 1 / 60);
      if (i % 250 === 10) sound.setVolume(Math.abs(Math.sin(i)));
      if (i % 500 === 20) sound.setEnabled(false);
      if (i % 500 === 60) sound.setEnabled(true);
      if (i % 700 === 30) sound.setLayerLevel(i % 2 ? 'wind' : 'sails', i % 3 ? 1 : 0.4);
    }
    sound.analyser();
    return { ctx, sound, valueWritesAtStart };
  }

  it('never writes a param\'s .value once running (every such write is a step)', async () => {
    const { ctx, valueWritesAtStart } = await session();
    const writes = ctx.params().reduce((n, p) => n + p.valueWrites, 0);
    expect(writes).toBe(valueWritesAtStart);
  });

  it('never steps or ramps a gain: only setTargetAtTime glides, plus the exact 0 that ends a fade', async () => {
    const { ctx } = await session();
    const gains = ctx.params().filter((p) => p.name === 'gain');
    expect(gains.length).toBeGreaterThan(50);
    for (const p of gains) {
      expect(p.nonZeroSteps).toBe(0);
      expect(p.linearRamps).toBe(0);
      expect(p.ramps).toBe(0);
    }
    // Some gains really were driven, a lot.
    expect(gains.filter((p) => p.targets > 100).length).toBeGreaterThan(8);
  });

  it('uses no linear ramps anywhere and exponential ramps only for the impact oscillators\' pitch', async () => {
    const { ctx } = await session();
    const params = ctx.params();
    expect(params.reduce((n, p) => n + p.linearRamps, 0)).toBe(0);
    for (const p of params) if (p.ramps > 0) expect(p.name).toBe('osc.frequency');
    expect(params.filter((p) => p.ramps > 0).length).toBeGreaterThan(0); // the session did include impacts
  });

  it('keeps every parameter inside a sane range', async () => {
    const { ctx } = await session();
    for (const p of ctx.params()) {
      if (p.calls === 0) continue;
      expect(Number.isFinite(p.min) && Number.isFinite(p.max)).toBe(true);
      if (p.name === 'gain') { expect(p.min).toBeGreaterThanOrEqual(0); expect(p.max).toBeLessThanOrEqual(8); }
      if (p.name === 'pan') { expect(p.min).toBeGreaterThanOrEqual(-1); expect(p.max).toBeLessThanOrEqual(1); }
      if (p.name === 'biquad.frequency') { expect(p.min).toBeGreaterThanOrEqual(20); expect(p.max).toBeLessThan(ctx.sampleRate / 2); }
    }
  });

  it('every exact 0 lands only after the fade before it has fallen below −100 dB (so it is an inaudible step)', async () => {
    const { ctx } = await session(true);
    let zeros = 0;
    for (const p of ctx.params()) {
      if (p.name !== 'gain') continue;
      const events = timeline(p);
      events.forEach((e, i) => {
        if (e.kind !== 'value' || e.v !== 0) return;
        zeros++;
        const prev = events[i - 1];
        expect(prev?.kind).toBe('target'); // preceded by a fade …
        expect(prev?.v).toBe(0); // … towards silence …
        expect(e.t).toBeGreaterThanOrEqual(prev!.t + 12 * prev!.tc - 1e-9); // … that has run for 12 time constants (e^-12 = −104 dB)
      });
    }
    expect(zeros).toBeGreaterThan(200);
  });

  it('per-snap retunes (a voice\'s pan, filter centre or Q) happen exactly when an envelope opens, never at a random moment', async () => {
    const { ctx } = await session(true);
    const round = (t: number): number => Math.round(t * 1e7);
    // An envelope opening = pulse(): cancel(t), attack target at t, release target (0) at t + 4·attack.
    const onsets = new Set<number>();
    for (const p of ctx.params()) {
      if (p.name !== 'gain') continue;
      const l = p.log;
      for (let i = 0; i + 2 < l.length; i++) {
        const [m0, t0] = l[i]!;
        const [m1, v1, t1, atk] = l[i + 1]!;
        const [m2, v2, t2] = l[i + 2]!;
        if (m0 === 'cancelScheduledValues' && m1 === 'setTargetAtTime' && v1! > 0 && t1 === t0 && m2 === 'setTargetAtTime' && v2 === 0 && Math.abs(t2! - (t1! + 4 * atk!)) < 1e-9) onsets.add(round(t1!));
      }
    }
    expect(onsets.size).toBeGreaterThan(100);
    let retunes = 0;
    const offenders: string[] = [];
    for (const p of ctx.params()) {
      if (!['pan', 'biquad.frequency', 'biquad.Q'].includes(p.name)) continue;
      for (const [method, v, t] of p.log) {
        // (A glide that ends at exactly 0 also finishes with setValueAtTime(0): that is a fade's end, checked above.)
        if (method !== 'setValueAtTime' || v === 0) continue;
        retunes++;
        if (!onsets.has(round(t!))) offenders.push(`${p.name} → ${v} at ${t}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(retunes).toBeGreaterThan(100);
  });
});

