import { describe, it, expect } from 'vitest';
import { FillDetector, FlogTrain, JIB_PROFILE, MAIN_PROFILE, SPIN_PROFILE, type CrackEvent, type CrackSink, type FlogProfile } from '../flog';
import { Rng } from '../noise';

interface Snap { t: number; amp: number; thump: boolean; rattle: boolean; crackHz: number; sub: number }

/** Run a train for `seconds` at 60 fps with a constant rate/level and collect every snap it schedules. */
function run(profile: FlogProfile, seed: number, rate: number, level: number, seconds: number, lookahead = 0.09): Snap[] {
  const snaps: Snap[] = [];
  const sink: CrackSink = { crack: (_t, e: CrackEvent) => snaps.push({ t: e.t, amp: e.amp, thump: e.bodyAmp > 0, rattle: e.rattle, crackHz: e.crackHz, sub: e.subCount }) };
  const train = new FlogTrain(profile, new Rng(seed));
  for (let t = 0; t < seconds; t += 1 / 60) train.advance(t, lookahead, rate, level, sink);
  return snaps;
}

const gaps = (s: Snap[]) => s.slice(1).map((x, i) => x.t - s[i]!.t);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const cv = (a: number[]) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2))) / mean(a);

describe('FlogTrain timing', () => {
  it('averages the requested flutter rate (× the sail profile)', () => {
    for (const [profile, rate] of [[MAIN_PROFILE, 4], [MAIN_PROFILE, 7], [JIB_PROFILE, 5]] as const) {
      const snaps = run(profile, 3, rate, 1, 120);
      expect(snaps.length / 120).toBeGreaterThan(0.8 * rate * profile.rateMul);
      expect(snaps.length / 120).toBeLessThan(1.2 * rate * profile.rateMul);
    }
  });

  it('is irregular — not a tremolo: intervals vary a lot, with quick doubles among longer pauses', () => {
    const g = gaps(run(MAIN_PROFILE, 5, 5, 1, 120));
    expect(cv(g)).toBeGreaterThan(0.4);
    expect(g.filter((x) => x < 0.08).length / g.length).toBeGreaterThan(0.08); // doubles
    expect(g.filter((x) => x > 1.5 / 5).length).toBeGreaterThan(g.length * 0.05); // and real pauses
    expect(Math.min(...g)).toBeGreaterThan(0.02); // but never a machine-gun burst
  });

  it('varies the snaps: hard and soft accents, low thuds on some, rattles on a few', () => {
    const s = run(MAIN_PROFILE, 8, 5, 1, 120);
    const amps = s.map((x) => x.amp);
    expect(Math.max(...amps) / Math.min(...amps)).toBeGreaterThan(3);
    const thumpFrac = s.filter((x) => x.thump).length / s.length;
    expect(thumpFrac).toBeGreaterThan(0.3);
    expect(thumpFrac).toBeLessThan(0.95);
    const rattleFrac = s.filter((x) => x.rattle).length / s.length;
    expect(rattleFrac).toBeGreaterThan(0.02);
    expect(rattleFrac).toBeLessThan(0.4);
    expect(new Set(s.map((x) => Math.round(x.crackHz / 50))).size).toBeGreaterThan(15); // every crack a little different
    expect(s.some((x) => x.sub === 0) && s.some((x) => x.sub === 2)).toBe(true);
  });

  it('the jib is crisper and lighter than the main; the spinnaker is soft and has no hardware', () => {
    const main = run(MAIN_PROFILE, 4, 5, 1, 60), jib = run(JIB_PROFILE, 4, 5, 1, 60), spin = run(SPIN_PROFILE, 4, 5, 1, 60);
    expect(mean(jib.map((x) => x.crackHz))).toBeGreaterThan(1.3 * mean(main.map((x) => x.crackHz)));
    expect(jib.filter((x) => x.thump).length / jib.length).toBeLessThan(main.filter((x) => x.thump).length / main.length);
    expect(spin.some((x) => x.rattle)).toBe(false);
  });

  it('scales with the level and stops at level 0', () => {
    const loud = run(MAIN_PROFILE, 6, 5, 1, 60).map((x) => x.amp);
    const soft = run(MAIN_PROFILE, 6, 5, 0.25, 60).map((x) => x.amp);
    expect(mean(soft) / mean(loud)).toBeCloseTo(0.25, 1);
    expect(run(MAIN_PROFILE, 6, 5, 0, 30)).toHaveLength(0);
    expect(run(MAIN_PROFILE, 6, 0, 1, 30)).toHaveLength(0);
  });

  it('a higher flutter rate gives proportionally more snaps', () => {
    const slow = run(MAIN_PROFILE, 2, 3, 1, 120).length;
    const fast = run(MAIN_PROFILE, 2, 8, 1, 120).length;
    expect(fast / slow).toBeGreaterThan(2);
    expect(fast / slow).toBeLessThan(3.3);
  });

  it('schedules in order, only inside the look-ahead window, without ever going back in time', () => {
    const times: number[] = [];
    const now: number[] = [];
    let clock = 0;
    const sink: CrackSink = { crack: (_t, e) => { times.push(e.t); now.push(clock); } };
    const train = new FlogTrain(MAIN_PROFILE, new Rng(1));
    for (clock = 0; clock < 30; clock += 1 / 60) train.advance(clock, 0.09, 6, 1, sink);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    for (let i = 0; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThanOrEqual(now[i]!); // never in the past
      expect(times[i]! - now[i]!).toBeLessThan(0.09 + 0.08); // at most the look-ahead (+ the double gap it started from)
    }
  });

  it('does not fire a backlog after a long stall or after being switched off and on', () => {
    const times: number[] = [];
    const sink: CrackSink = { crack: (_t, e) => times.push(e.t) };
    const train = new FlogTrain(MAIN_PROFILE, new Rng(2));
    for (let t = 0; t < 2; t += 1 / 60) train.advance(t, 0.09, 6, 1, sink);
    times.length = 0;
    train.advance(30, 0.09, 6, 1, sink); // the frame loop stalled for 28 s
    expect(times.length).toBeLessThanOrEqual(3);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(30);
    times.length = 0;
    for (let t = 30; t < 35; t += 1 / 60) train.advance(t, 0.09, 6, 0, sink); // off
    expect(times).toHaveLength(0);
    train.advance(35, 0.09, 6, 1, sink);
    for (let t = 35; t < 36; t += 1 / 60) train.advance(t, 0.09, 6, 1, sink); // on again
    expect(times.length).toBeLessThan(10);
    expect(Math.min(...times)).toBeGreaterThan(35);
  });

  it('is deterministic per seed', () => {
    expect(run(MAIN_PROFILE, 9, 5, 1, 20)).toEqual(run(MAIN_PROFILE, 9, 5, 1, 20));
    expect(run(MAIN_PROFILE, 9, 5, 1, 20)).not.toEqual(run(MAIN_PROFILE, 10, 5, 1, 20));
  });
});

describe('FillDetector', () => {
  /** Feed a luffing drive history at 60 fps; returns the times at which a thud was reported. */
  function thuds(drive: (t: number) => number, seconds: number): number[] {
    const d = new FillDetector();
    const out: number[] = [];
    for (let t = 0; t < seconds; t += 1 / 60) if (d.update(t, 1 / 60, drive(t)) > 0) out.push(t);
    return out;
  }

  it('thuds once when a proper flogging spell ends, at the moment it ends', () => {
    const at = thuds((t) => (t > 1 && t < 4 ? 0.85 : 0), 8);
    expect(at).toHaveLength(1);
    expect(at[0]!).toBeGreaterThan(4);
    expect(at[0]!).toBeLessThan(4.1);
  });

  it('stays quiet for a flicker or gentle luffing, and while the sail keeps flogging', () => {
    expect(thuds((t) => (t > 1 && t < 1.4 ? 0.9 : 0), 6)).toHaveLength(0); // a 0.4 s flutter is not a flogging spell
    expect(thuds((t) => (t > 1 && t < 5 ? 0.3 : 0), 8)).toHaveLength(0); // never flogged hard
    expect(thuds(() => 0.8, 10)).toHaveLength(0); // still flogging
    expect(thuds(() => 0, 10)).toHaveLength(0);
  });

  it('is rate-limited: chattering on and off does not machine-gun', () => {
    const at = thuds((t) => (Math.floor(t * 1.2) % 2 === 0 ? 0.9 : 0), 20); // 0.83 s on, 0.83 s off, over and over
    expect(at.length).toBeGreaterThan(2);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThan(1.4);
  });

  it('level follows how hard the sail flogged, capped at 1', () => {
    const d = new FillDetector();
    for (let t = 0; t < 2; t += 1 / 60) d.update(t, 1 / 60, 0.7);
    const soft = d.update(2, 1 / 60, 0);
    const d2 = new FillDetector();
    for (let t = 0; t < 2; t += 1 / 60) d2.update(t, 1 / 60, 1);
    const hard = d2.update(2, 1 / 60, 0);
    expect(hard).toBeGreaterThan(soft);
    expect(hard).toBeLessThanOrEqual(1);
  });

  it('forgets the past on reset()', () => {
    const d = new FillDetector();
    for (let t = 0; t < 2; t += 1 / 60) d.update(t, 1 / 60, 1);
    d.reset();
    expect(d.update(2, 1 / 60, 0)).toBe(0);
  });
});

