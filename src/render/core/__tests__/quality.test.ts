import { describe, it, expect } from 'vitest';
import { GOVERNOR, QualityGovernor, TIER_ORDER, tierSettings, type QualityTier } from '../quality';

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

  it('backs off (doubles the wait) when a step-up has to be undone soon after', () => {
    const { gov, now } = warmed('medium');
    let t = run(gov, 10, 12_000, now).now;     // → high
    expect(gov.settings.tier).toBe('high');
    t = run(gov, 25, 4000, t).now;             // too heavy → back to medium quickly
    expect(gov.settings.tier).toBe('medium');
    const first = run(gov, 10, GOVERNOR.stepUpAfterMs * 2 - 1500, t);
    expect(first.changes).toEqual([]);         // the normal 10 s is no longer enough
    const second = run(gov, 10, 4000, first.now);
    expect(second.changes.map((c) => c.tier)).toEqual(['high']);
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

  it('ignores invalid input', () => {
    const { gov, now } = warmed('high');
    expect(gov.sample(Number.NaN, now + 10)).toBe(false);
    expect(gov.sample(-5, now + 20)).toBe(false);
    expect(gov.sample(16, Number.NaN)).toBe(false);
    run(gov, 16.7, 5000, now + 20);
    expect(gov.settings.tier).toBe('high');
  });
});
