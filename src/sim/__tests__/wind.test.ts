import { describe, it, expect } from 'vitest';
import { WindField, gradientFactor } from '../wind';
import { DEG } from '../../shared/math';

const base = { tws: 6, twd: 0, gustiness: 0, shiftAmplitude: 0, shiftPeriod: 120, seed: 7 };

describe('wind field', () => {
  it('log profile: 1 at 10 m, ~0.774 at 1.8 m, finite at the surface', () => {
    expect(gradientFactor(10)).toBeCloseTo(1, 6);
    expect(gradientFactor(1.8)).toBeCloseTo(0.774, 2);
    expect(gradientFactor(0)).toBeGreaterThan(0.3);
    expect(gradientFactor(0)).toBeLessThan(gradientFactor(1));
  });

  it('a north wind blows toward the south', () => {
    const w = new WindField(base);
    const v = w.velocity(0, 0, 10);
    expect(v.e).toBeCloseTo(0, 6);
    expect(v.n).toBeCloseTo(-6, 6);
    expect(w.sample(0, 0, 10)).toEqual({ speed: 6, dir: 0 });
  });

  it('has no puffs when gustiness is 0', () => {
    const calm = new WindField(base);
    for (let i = 0; i < 600; i++) calm.step(0.1, 0, 0);
    expect(calm.puffs.length).toBe(0);
  });

  it('spawns puffs upwind that drift downwind when gusty', () => {
    const g = new WindField({ ...base, gustiness: 1 });
    for (let i = 0; i < 600; i++) g.step(0.1, 0, 0);
    expect(g.puffs.length).toBeGreaterThan(2);
    const p = g.puffs[0]!;
    const n0 = p.n;
    g.step(1, 0, 0);
    const later = g.puffs.find((q) => q.id === p.id);
    expect(later).toBeDefined();
    expect(later!.n).toBeLessThan(n0);
  });

  it('a gust at its centre raises the local wind speed', () => {
    const g = new WindField({ ...base, gustiness: 1 });
    for (let i = 0; i < 900; i++) g.step(0.1, 0, 0);
    const gust = g.puffs.find((q) => q.strength > 0.1 && q.envelope > 0.9);
    expect(gust).toBeDefined();
    const s = g.sample(gust!.e, gust!.n, 10).speed;
    expect(s).toBeGreaterThan(6 * (1 + gust!.strength * 0.8));
  });

  it('is deterministic for a seed', () => {
    const a = new WindField({ ...base, gustiness: 1 });
    const b = new WindField({ ...base, gustiness: 1 });
    for (let i = 0; i < 900; i++) { a.step(0.1, 10, 20); b.step(0.1, 10, 20); }
    expect(a.sample(15, 30, 10)).toEqual(b.sample(15, 30, 10));
  });

  it('oscillating shifts stay within the amplitude', () => {
    const w = new WindField({ ...base, shiftAmplitude: 0.2, shiftPeriod: 60 });
    let max = 0;
    for (let i = 0; i < 1200; i++) {
      w.step(0.1, 0, 0);
      max = Math.max(max, Math.abs(w.baseDirection()));
    }
    expect(max).toBeGreaterThan(0.1);
    expect(max).toBeLessThan(0.26);
  });

  it('overlapping puffs do not add up their shifts: the direction is their weighted mean (M2)', () => {
    const w = new WindField(base);
    const puff = (id: number, dirOffset: number) => ({ id, e: 0, n: 0, radiusAlong: 100, radiusAcross: 150, strength: 0.3, dirOffset, envelope: 1 });
    w.puffs.push(puff(1, 14 * DEG), puff(2, 14 * DEG));
    expect(w.sample(0, 0, 10).dir / DEG).toBeCloseTo(14, 6);
    w.puffs.length = 0;
    w.puffs.push(puff(1, 12 * DEG), puff(2, -4 * DEG));
    expect(w.sample(0, 0, 10).dir / DEG).toBeCloseTo(4, 6);
    // A lone puff seen off-centre still shifts the wind in proportion to its weight (Σw < 1).
    w.puffs.length = 0;
    w.puffs.push(puff(1, 10 * DEG));
    const edge = w.sample(0, 100, 10).dir / DEG; // one along-radius away: weight e⁻¹
    expect(edge).toBeCloseTo(10 * Math.exp(-1), 6);
  });

  it('setSettings changes speed immediately', () => {
    const w = new WindField(base);
    w.setSettings({ tws: 9 });
    expect(w.sample(0, 0, 10).speed).toBeCloseTo(9, 9);
  });
});
