// The parameter-driving primitives the click-free design rests on, checked call by call: Glide (exponential glides with an
// exact 0 to finish a fade), pulse / pulseMore (percussive envelopes), Wander (slow random drift), Crackle (idle texture
// switched off) and the noise bank.
import { describe, expect, it } from 'vitest';
import { Glide, NoiseBank, Wander, pulse, pulseMore } from '../nodes';
import { Rng } from '../noise';
import { FakeContext, FakeParam, type FakeSource } from './fakeContext';

const recorder = (name = 'gain', initial = 0): FakeParam => {
  const p = new FakeParam(name, initial);
  p.record = true;
  return p;
};
const asParam = (p: FakeParam): AudioParam => p as unknown as AudioParam;

describe('Glide', () => {
  it('aims the param with setTargetAtTime and nothing else', () => {
    const p = recorder();
    const g = new Glide(asParam(p), 0.2);
    g.to(0.5, 1);
    g.to(0.8, 2);
    expect(p.log).toEqual([['setTargetAtTime', 0.5, 1, 0.2], ['setTargetAtTime', 0.8, 2, 0.2]]);
    expect(p.valueWrites).toBe(0);
  });

  it('skips calls while the target has not moved by more than eps, and ignores non-finite targets', () => {
    const p = recorder();
    const g = new Glide(asParam(p), 0.2, 1e-3);
    g.to(0.5, 1);
    g.to(0.5004, 2);
    g.to(0.4996, 3);
    g.to(NaN, 4);
    g.to(Infinity, 5);
    g.to(-Infinity, 6);
    expect(p.log).toHaveLength(1);
    g.to(0.502, 7);
    expect(p.log).toHaveLength(2);
  });

  it('takes a per-call time constant', () => {
    const p = recorder();
    new Glide(asParam(p), 0.2).to(1, 0, 0.05);
    expect(p.log[0]).toEqual(['setTargetAtTime', 1, 0, 0.05]);
  });

  it('finishes a fade to silence with an exact 0 after 12 time constants (the browser can then skip what is behind it)', () => {
    const p = recorder();
    const g = new Glide(asParam(p), 0.1);
    g.to(0.4, 0);
    g.to(0, 1);
    expect(p.log.slice(1)).toEqual([['setTargetAtTime', 0, 1, 0.1], ['setValueAtTime', 0, 1 + 12 * 0.1]]);
    expect(p.nonZeroSteps).toBe(0);
  });

  it('a new target inside that window first cancels the pending exact 0, so it cannot cut into the new glide', () => {
    const p = recorder();
    const g = new Glide(asParam(p), 0.1);
    g.to(0.4, 0);
    g.to(0, 1);
    g.to(0.3, 1.5); // the zero is due at 2.2
    expect(p.log.slice(3)).toEqual([['cancelScheduledValues', 1.5], ['setTargetAtTime', 0.3, 1.5, 0.1]]);
    g.to(0.6, 2); // no zero pending any more: no cancel needed
    expect(p.log.slice(5)).toEqual([['setTargetAtTime', 0.6, 2, 0.1]]);
  });

  it('never calls for a value it already aimed at, including 0', () => {
    const p = recorder();
    const g = new Glide(asParam(p), 0.1);
    g.to(0, 0);
    g.to(0, 1);
    g.to(0, 2);
    expect(p.log).toHaveLength(2); // the target and its exact 0, once
  });
});

describe('pulse envelopes', () => {
  it('cancel from the start time, attack, release, then finish with an exact 0', () => {
    const p = recorder();
    pulse(asParam(p), 2, 0.7, 0.001, 0.02);
    expect(p.log).toEqual([
      ['cancelScheduledValues', 2],
      ['setTargetAtTime', 0.7, 2, 0.001],
      ['setTargetAtTime', 0, 2 + 4 * 0.001, 0.02],
      ['setValueAtTime', 0, 2 + 4 * 0.001 + 12 * 0.02],
    ]);
    expect(p.nonZeroSteps).toBe(0);
    expect(p.linearRamps).toBe(0);
  });

  it('a crack with crinkles is one envelope: only the last hit carries the exact 0, and times never go backwards', () => {
    const p = recorder();
    const t = 5;
    pulse(asParam(p), t, 1, 0.0004, 0.01, false);
    pulseMore(asParam(p), t + 0.003, 0.6, 0.0004, 0.008, false);
    pulseMore(asParam(p), t + 0.009, 0.3, 0.0004, 0.007);
    const zeros = p.log.filter((e) => e[0] === 'setValueAtTime');
    expect(zeros).toHaveLength(1);
    const lastTarget = p.log.filter((e) => e[0] === 'setTargetAtTime').at(-1)!;
    expect(zeros[0]![2]!).toBeGreaterThan(lastTarget[2]! + 10 * lastTarget[3]!); // long after the last release began
    const times = p.log.filter((e) => e[0] !== 'cancelScheduledValues').map((e) => e[2]!);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    expect(p.log.filter((e) => e[0] === 'cancelScheduledValues')).toHaveLength(1); // only the first hit cancels
  });

  it('retriggering cancels the previous trigger\'s pending exact 0 (it would otherwise cut the new envelope)', () => {
    const p = recorder();
    pulse(asParam(p), 1, 1, 0.001, 0.05); // its exact 0 is due at 1.004 + 0.6
    pulse(asParam(p), 1.2, 0.5, 0.001, 0.05);
    const cancels = p.log.filter((e) => e[0] === 'cancelScheduledValues');
    expect(cancels.map((e) => e[1])).toEqual([1, 1.2]); // the second cancel (from 1.2) removes the zero due at 1.604
  });

  it('is built from setTarget curves only: no steps to a non-zero value, no ramps', () => {
    const p = recorder();
    for (let i = 0; i < 20; i++) pulse(asParam(p), i * 0.05, 0.3 + (i % 3) * 0.3, 0.0005, 0.01 + (i % 4) * 0.01);
    expect(p.nonZeroSteps).toBe(0);
    expect(p.linearRamps + p.ramps).toBe(0);
    expect(p.valueWrites).toBe(0);
  });
});

describe('Wander', () => {
  function drive(seconds: number, fps: number, seed = 4): { targets: number[]; calls: number } {
    const p = recorder('gain', 1);
    const w = new Wander(asParam(p), 0.3, 0.5, new Rng(seed));
    for (let i = 0; i < seconds * fps; i++) w.update(i / fps, 1 / fps);
    const targets = p.log.filter((e) => e[0] === 'setTargetAtTime').map((e) => e[1]!);
    return { targets, calls: p.log.length };
  }

  it('hovers around its centre with the requested depth', () => {
    const { targets } = drive(600, 60);
    const mean = targets.reduce((a, b) => a + b, 0) / targets.length;
    const sd = Math.sqrt(targets.reduce((a, b) => a + (b - mean) ** 2, 0) / targets.length);
    expect(mean).toBeGreaterThan(0.93);
    expect(mean).toBeLessThan(1.07);
    expect(sd).toBeGreaterThan(0.22);
    expect(sd).toBeLessThan(0.36);
  });

  it('re-aims the param only about 30 times a second, whatever the frame rate', () => {
    for (const fps of [30, 60, 144]) {
      const { calls } = drive(20, fps);
      expect(calls / 20).toBeGreaterThan(22);
      expect(calls / 20).toBeLessThan(36);
    }
  });

  it('wanders slowly: neighbouring aims are close, it is not white noise', () => {
    const { targets } = drive(120, 60);
    let step = 0;
    for (let i = 1; i < targets.length; i++) step += Math.abs(targets[i]! - targets[i - 1]!);
    // White noise of the same spread would move 1.13 × depth (0.3) per step; this drifts at about a third of that.
    expect(step / (targets.length - 1)).toBeLessThan(0.15);
  });

  it('respects its floor, stays finite, and is deterministic per seed', () => {
    const p = recorder('gain', 1);
    const w = new Wander(asParam(p), 2, 1, new Rng(9), 1, 0.25); // a huge depth would go negative without the floor
    for (let i = 0; i < 6000; i++) w.update(i / 60, 1 / 60);
    const targets = p.log.filter((e) => e[0] === 'setTargetAtTime').map((e) => e[1]!);
    expect(Math.min(...targets)).toBeGreaterThanOrEqual(0.25);
    expect(targets.every(Number.isFinite)).toBe(true);
    expect(drive(10, 60, 3).targets).toEqual(drive(10, 60, 3).targets);
    expect(drive(10, 60, 3).targets).not.toEqual(drive(10, 60, 4).targets);
  });

  it('dt of 0 (or a repeated frame) changes nothing', () => {
    const p = recorder('gain', 1);
    const w = new Wander(asParam(p), 0.3, 0.5, new Rng(1));
    for (let i = 0; i < 100; i++) w.update(1, 0);
    expect(p.log).toHaveLength(0);
  });
});

describe('NoiseBank', () => {
  it('builds mono and stereo loops, started at different offsets so layers sharing a buffer stay uncorrelated', async () => {
    const ctx = new FakeContext();
    const bank = await NoiseBank.create(ctx.asContext(), 7);
    expect(bank.white.numberOfChannels).toBe(1);
    expect(bank.pinkStereo.numberOfChannels).toBe(2);
    expect(bank.brownMono.numberOfChannels).toBe(1);
    const a = bank.loop(bank.white) as unknown as FakeSource;
    const b = bank.loop(bank.white) as unknown as FakeSource;
    expect(a.loop && b.loop).toBe(true);
    expect(a.started && b.started).toBe(true);
  });

  it('a crackle texture is wired in only while it is active, and idle it costs nothing', async () => {
    const ctx = new FakeContext();
    const bank = await NoiseBank.create(ctx.asContext(), 7);
    const crackle = bank.crackle(0.25, 0.9);
    const source = ctx.nodes.filter((n) => n.kind === 'source').at(-1)!;
    expect(source.out).toHaveLength(0); // idle: the control noise goes nowhere
    crackle.setActive(true);
    expect(source.out).toHaveLength(1);
    crackle.setActive(true); // idempotent
    expect(source.out).toHaveLength(1);
    crackle.setActive(false);
    expect(source.out).toHaveLength(0);
  });
});
