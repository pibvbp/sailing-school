import { describe, it, expect } from 'vitest';
import { GOVERNOR, QualityGovernor, TIER_ORDER, tierSettings, type FrameCost, type QualityTier } from '../quality';

/** Feeds frames of a constant duration; returns every tier change with its timestamp. */
function run(gov: QualityGovernor, frameMs: number, durationMs: number, startMs: number) {
  const changes: Array<{ at: number; tier: QualityTier }> = [];
  let now = startMs;
  const end = startMs + durationMs;
  while (now < end) {
    now += frameMs;
    if (gov.sample(frameMs, now)) changes.push({ at: now, tier: gov.settings.tier });
  }
  return { changes, now };
}

type Work = Record<QualityTier, { cpu: number; gpu: number }>;

/**
 * A machine with known per-tier work on a display of `hz`: rAF intervals are vsync-quantised (CPU and GPU
 * pipelined, so a frame takes max(cpu, gpu)), and the cost is what a FrameTimer would report: GPU-inclusive
 * with a working timer query, CPU busy time without one, nothing at all for the legacy call.
 */
function simulate(gov: QualityGovernor, o: { hz: number; work: Work; timer: 'gpu' | 'cpu' | 'none'; durationMs: number; startMs: number }) {
  const period = 1000 / o.hz;
  const changes: Array<{ at: number; tier: QualityTier }> = [];
  const timeIn: Record<QualityTier, number> = { low: 0, medium: 0, high: 0, ultra: 0 };
  let now = o.startMs;
  const end = o.startMs + o.durationMs;
  while (now < end) {
    const w = o.work[gov.settings.tier];
    const busy = Math.max(w.cpu, w.gpu);
    const interval = period * Math.max(1, Math.ceil(busy / period - 1e-9));
    now += interval;
    timeIn[gov.settings.tier] += interval;
    const cost: FrameCost | undefined = o.timer === 'gpu' ? { ms: busy, gpu: true } : o.timer === 'cpu' ? { ms: w.cpu, gpu: false } : undefined;
    if (gov.sample(interval, now, cost)) changes.push({ at: now, tier: gov.settings.tier });
  }
  return { changes, now, timeIn };
}

const uniform = (cpu: number, gpu: number): Work => ({ low: { cpu, gpu }, medium: { cpu, gpu }, high: { cpu, gpu }, ultra: { cpu, gpu } });

/** A governor that is past its start-up warm-up, sitting at `tier` with 16.7 ms frames. */
function warmed(tier: QualityTier) {
  const gov = new QualityGovernor(tier);
  const { now } = run(gov, 16.7, GOVERNOR.warmupMs + 3000, 0);
  expect(gov.settings.tier).toBe(tier);
  return { gov, now };
}

describe('QualityGovernor', () => {
  it('starts with the settings of the requested tier', () => {
    const gov = new QualityGovernor('high');
    expect(gov.settings).toEqual(tierSettings('high'));
    expect(TIER_ORDER).toEqual(['low', 'medium', 'high', 'ultra']);
  });

  it('ignores slow frames during the start-up warm-up (shader compiles)', () => {
    const gov = new QualityGovernor('high');
    const { changes } = run(gov, 40, GOVERNOR.warmupMs - 50, 0);
    expect(changes).toEqual([]);
  });

  it('steps down one tier after sustained 25 ms frames (within two 2 s windows)', () => {
    const { gov, now } = warmed('high');
    const { changes } = run(gov, 25, 2 * GOVERNOR.windowMs + 200, now);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.tier).toBe('medium');
    expect(changes[0]!.at - now).toBeGreaterThan(GOVERNOR.windowMs / 2);
    expect(gov.settings).toEqual(tierSettings('medium'));
  });

  it('keeps stepping down while frames stay slow, then stops at the bottom tier', () => {
    const { gov, now } = warmed('ultra');
    const { changes } = run(gov, 25, 30_000, now);
    expect(changes.map((c) => c.tier)).toEqual(['high', 'medium', 'low']);
    // Each step waits for the settle period plus a fresh window.
    expect(changes[1]!.at - changes[0]!.at).toBeGreaterThanOrEqual(GOVERNOR.settleMs + GOVERNOR.windowMs);
    expect(gov.settings.tier).toBe('low');
  });

  it('does not step down for a short burst or a single long hitch (median, not mean)', () => {
    const { gov, now } = warmed('high');
    let t = run(gov, 25, 700, now).now;       // a 0.7 s burst of slow frames …
    t = run(gov, 16.7, 3000, t).now;          // … inside mostly good windows
    expect(gov.sample(900, t + 900)).toBe(false); // one 0.9 s hitch
    run(gov, 16.7, 5000, t + 900);
    expect(gov.settings.tier).toBe('high');
  });

  it('steps up after 10 s continuously under 12 ms, not before', () => {
    const { gov, now } = warmed('medium');
    const early = run(gov, 10, GOVERNOR.stepUpAfterMs - 100, now);
    expect(early.changes).toEqual([]);
    const later = run(gov, 10, GOVERNOR.windowMs + 500, early.now);
    expect(later.changes.map((c) => c.tier)).toEqual(['high']);
    expect(later.changes[0]!.at - now).toBeGreaterThanOrEqual(GOVERNOR.stepUpAfterMs);
  });

  it('holds the tier anywhere in the 12–20 ms dead band (hysteresis)', () => {
    for (const ms of [12.5, 16.7, 19.5]) {
      const { gov, now } = warmed('high');
      const { changes } = run(gov, ms, 60_000, now);
      expect(changes).toEqual([]);
    }
  });

  it('a dead-band window breaks the step-up streak', () => {
    const { gov, now } = warmed('medium');
    let t = run(gov, 10, 8000, now).now;
    t = run(gov, 16.7, 2500, t).now;          // one ordinary window resets the count
    const { changes } = run(gov, 10, 8000, t);
    expect(changes).toEqual([]);
    expect(gov.settings.tier).toBe('medium');
  });

  it('after a step-down, fast frames need the full 10 s again before stepping back up', () => {
    const { gov, now } = warmed('high');
    const down = run(gov, 25, 2 * GOVERNOR.windowMs + 200, now);
    expect(gov.settings.tier).toBe('medium');
    const quick = run(gov, 8, 6000, down.now);
    expect(quick.changes).toEqual([]);
    const { changes } = run(gov, 8, 8000, quick.now);
    expect(changes.map((c) => c.tier)).toEqual(['high']);
  });

  it('after a failed step-up (interval rule) it retries only once the higher tier is predicted to fit', () => {
    const { gov, now } = warmed('medium');
    let t = run(gov, 10, 12_000, now).now;     // → high
    expect(gov.settings.tier).toBe('high');
    t = run(gov, 25, 4000, t).now;             // too heavy: 2.5× the cost it was chosen at → back to medium
    expect(gov.settings.tier).toBe('medium');
    const same = run(gov, 10, 60_000, t);      // unchanged scene: 10 ms × 2.5 = 25 ms would not fit
    expect(same.changes).toEqual([]);
    const lighter = run(gov, 5, GOVERNOR.stepUpAfterMs * 2 + 4000, same.now); // 5 × 2.5 = 12.5 ms fits
    expect(lighter.changes.map((c) => c.tier)).toEqual(['high']);
    expect(lighter.changes[0]!.at - same.now).toBeGreaterThanOrEqual(GOVERNOR.stepUpAfterMs * 2); // doubled wait
  });

  it('a hidden-tab gap neither changes the tier nor counts toward a step-up', () => {
    const { gov, now } = warmed('medium');
    let t = run(gov, 10, 6000, now).now;
    expect(gov.sample(30_000, t + 30_000)).toBe(false);
    t += 30_000;
    const { changes } = run(gov, 10, 7000, t);
    expect(changes).toEqual([]);
    expect(gov.settings.tier).toBe('medium');
  });

  it('lock(tier) pins the settings and stops adaptation; lock(null) resumes from there', () => {
    const { gov, now } = warmed('high');
    gov.lock('low');
    expect(gov.settings).toEqual(tierSettings('low'));
    expect(gov.locked).toBe(true);
    const locked = run(gov, 8, 30_000, now);
    expect(locked.changes).toEqual([]);
    gov.lock(null);
    expect(gov.locked).toBe(false);
    const resumed = run(gov, 8, 30_000, locked.now);
    expect(resumed.changes[0]!.tier).toBe('medium');
  });

  it('never steps above ultra', () => {
    const { gov, now } = warmed('ultra');
    const { changes } = run(gov, 6, 40_000, now);
    expect(changes).toEqual([]);
  });

  describe('with a measured frame cost (FrameTimer)', () => {
    it('60 Hz: steps up on the measured cost, not on the vsync interval', () => {
      const { gov, now } = warmed('medium');
      const { changes } = simulate(gov, { hz: 60, work: uniform(2, 6), timer: 'gpu', durationMs: 26_000, startMs: now });
      expect(changes.map((c) => c.tier)).toEqual(['high', 'ultra']);
      expect(changes[0]!.at - now).toBeGreaterThanOrEqual(GOVERNOR.stepUpAfterMs);
    });

    it('60 Hz without a cost: the interval never shows headroom, so the tier holds (legacy rule)', () => {
      const { gov, now } = warmed('medium');
      const { changes } = simulate(gov, { hz: 60, work: uniform(2, 6), timer: 'none', durationMs: 60_000, startMs: now });
      expect(changes).toEqual([]);
    });

    it('60 Hz: holds while the measured cost sits in the 12–20 ms band', () => {
      const { gov, now } = warmed('high');
      const { changes } = simulate(gov, { hz: 60, work: uniform(3, 14), timer: 'gpu', durationMs: 60_000, startMs: now });
      expect(changes).toEqual([]);
    });

    it('60 Hz, GPU timer: one failed probe of a too-heavy tier, then no oscillation', () => {
      const work: Work = { low: { cpu: 2, gpu: 5 }, medium: { cpu: 2, gpu: 8 }, high: { cpu: 3, gpu: 11 }, ultra: { cpu: 3, gpu: 19 } };
      const { gov, now } = warmed('high');
      const { changes, timeIn } = simulate(gov, { hz: 60, work, timer: 'gpu', durationMs: 20 * 60_000, startMs: now });
      expect(changes.map((c) => c.tier)).toEqual(['ultra', 'high']); // probed once, never again
      expect(timeIn.high / (20 * 60_000)).toBeGreaterThan(0.95);
    });

    it('60 Hz, GPU timer: retries the failed tier once the scene gets light enough for it', () => {
      const heavy: Work = { low: { cpu: 2, gpu: 5 }, medium: { cpu: 2, gpu: 8 }, high: { cpu: 3, gpu: 11 }, ultra: { cpu: 3, gpu: 19 } };
      const light: Work = { ...heavy, high: { cpu: 3, gpu: 6 }, ultra: { cpu: 3, gpu: 10.5 } };
      const { gov, now } = warmed('high');
      const first = simulate(gov, { hz: 60, work: heavy, timer: 'gpu', durationMs: 60_000, startMs: now });
      expect(first.changes.map((c) => c.tier)).toEqual(['ultra', 'high']);
      const later = simulate(gov, { hz: 60, work: light, timer: 'gpu', durationMs: 5 * 60_000, startMs: first.now });
      expect(later.changes.map((c) => c.tier)).toEqual(['ultra']); // 6 ms × 19/11 ≈ 10.4 ms predicted: fits, and stays
    });

    it('CPU-only timing: a failed step-up bars that tier for the session; lock(null) lifts it', () => {
      const work: Work = { low: { cpu: 2, gpu: 5 }, medium: { cpu: 3, gpu: 9 }, high: { cpu: 4, gpu: 14 }, ultra: { cpu: 4.5, gpu: 22 } };
      const { gov, now } = warmed('high');
      const run1 = simulate(gov, { hz: 60, work, timer: 'cpu', durationMs: 30 * 60_000, startMs: now });
      expect(run1.changes.map((c) => c.tier)).toEqual(['ultra', 'high']); // CPU time cannot see the GPU cost: one probe
      gov.lock(null);
      const run2 = simulate(gov, { hz: 60, work, timer: 'cpu', durationMs: 20_000, startMs: run1.now });
      expect(run2.changes.map((c) => c.tier)).toEqual(['ultra', 'high']);
    });

    it('120 Hz: the interval alone shows headroom; it settles on the highest tier that keeps 60 fps', () => {
      const work: Work = { low: { cpu: 2, gpu: 4 }, medium: { cpu: 2, gpu: 7 }, high: { cpu: 3, gpu: 9.5 }, ultra: { cpu: 3, gpu: 14 } };
      const legacy = warmed('medium');
      const a = simulate(legacy.gov, { hz: 120, work, timer: 'none', durationMs: 60_000, startMs: legacy.now });
      expect(a.changes.map((c) => c.tier)).toEqual(['high']); // at high the interval is 16.7 ms: holds
      const timed = warmed('medium');
      const b = simulate(timed.gov, { hz: 120, work, timer: 'gpu', durationMs: 60_000, startMs: timed.now });
      expect(b.changes.map((c) => c.tier)).toEqual(['high', 'ultra']); // 9.5 ms measured → ultra, which holds 60 fps
    });

    it('a doubled step-up wait decays back after five stable minutes', () => {
      const heavy: Work = { low: { cpu: 2, gpu: 5 }, medium: { cpu: 2, gpu: 8 }, high: { cpu: 3, gpu: 11 }, ultra: { cpu: 3, gpu: 19 } };
      const light: Work = { ...heavy, high: { cpu: 3, gpu: 6 }, ultra: { cpu: 3, gpu: 10.5 } };
      const { gov, now } = warmed('high');
      const fail = simulate(gov, { hz: 60, work: heavy, timer: 'gpu', durationMs: 7 * 60_000, startMs: now });
      expect(fail.changes.map((c) => c.tier)).toEqual(['ultra', 'high']);
      const back = simulate(gov, { hz: 60, work: light, timer: 'gpu', durationMs: 60_000, startMs: fail.now });
      expect(back.changes.map((c) => c.tier)).toEqual(['ultra']);
      expect(back.changes[0]!.at - fail.now).toBeLessThan(GOVERNOR.stepUpAfterMs * 2); // back to the base wait
    });
  });

  it('ignores invalid input', () => {
    const { gov, now } = warmed('high');
    expect(gov.sample(Number.NaN, now + 10)).toBe(false);
    expect(gov.sample(-5, now + 20)).toBe(false);
    expect(gov.sample(16, Number.NaN)).toBe(false);
    run(gov, 16.7, 5000, now + 20);
    expect(gov.settings.tier).toBe('high');
  });
});
