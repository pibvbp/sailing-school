import { describe, it, expect } from 'vitest';
import { solveSteady, bestSpeed } from '../vpp';
import { targetSpeed, optimalVmg, type PolarTable } from '../polarTable';
import polars from '../data/polars.json';
import { DEG, KN } from '../../shared/math';

// Plausibility bands for a 25 ft keelboat of this type (J/24-class references; light air set lower
// because a deep-running boat's apparent wind collapses — see spec §7.8).
const BANDS = [
  { tws: 6, beat: [3.2, 4.6], reach: [3.8, 5.2], broad: [2.9, 4.4] },
  { tws: 12, beat: [4.9, 6.0], reach: [6.0, 7.2], broad: [5.2, 6.8] },
  { tws: 20, beat: [5.0, 6.3], reach: [7.0, 8.6], broad: [7.0, 8.8] },
] as const;

describe('steady-state performance (VPP)', () => {
  for (const b of BANDS) {
    it(`${b.tws} kn: optimal beat angle, reach and broad-reach speeds are plausible`, () => {
      let best = { vmg: -Infinity, twa: 0, speed: 0 };
      for (let a = 34; a <= 52; a += 2) {
        const r = solveSteady(b.tws * KN, a * DEG);
        expect(r.converged).toBe(true);
        const vmg = r.speed * Math.cos(a * DEG);
        if (vmg > best.vmg) best = { vmg, twa: a, speed: r.speed / KN };
      }
      expect(best.twa).toBeGreaterThanOrEqual(34);
      expect(best.twa).toBeLessThanOrEqual(48);
      expect(best.speed).toBeGreaterThan(b.beat[0]);
      expect(best.speed).toBeLessThan(b.beat[1]);
      const pinch = solveSteady(b.tws * KN, 30 * DEG);
      expect(pinch.speed * Math.cos(30 * DEG)).toBeLessThan(best.vmg);
      const reach = bestSpeed(b.tws * KN, 90 * DEG).speed / KN;
      expect(reach).toBeGreaterThan(b.reach[0]);
      expect(reach).toBeLessThan(b.reach[1]);
      const broad = bestSpeed(b.tws * KN, 150 * DEG).speed / KN;
      expect(broad).toBeGreaterThan(b.broad[0]);
      expect(broad).toBeLessThan(b.broad[1]);
    }, 60_000);
  }

  it('in light air the best downwind VMG is on a broad reach, not dead downwind', () => {
    const broad = bestSpeed(6 * KN, 150 * DEG);
    const dead = bestSpeed(6 * KN, 178 * DEG);
    expect(-broad.vmg).toBeGreaterThan(-dead.vmg);
  }, 60_000);
});

describe('polar table', () => {
  const table = polars as PolarTable;
  it('matches the current physics (regenerate with `pnpm polars` after changing the model)', () => {
    for (const [tws, twa] of [[12, 45], [12, 90], [6, 150], [20, 120]] as const) {
      const live = bestSpeed(tws * KN, twa * DEG).speed / KN;
      expect(Math.abs(targetSpeed(table, tws, twa) - live) / live).toBeLessThan(0.03);
    }
  }, 60_000);
  it('interpolates between table points and gives optimal VMG angles', () => {
    const mid = targetSpeed(table, 11, 92.5);
    expect(mid).toBeGreaterThan(Math.min(targetSpeed(table, 10, 90), targetSpeed(table, 12, 95)) - 0.01);
    const up = optimalVmg(table, 12, true);
    expect(up.twa).toBeGreaterThan(34);
    expect(up.twa).toBeLessThan(48);
    const down = optimalVmg(table, 12, false);
    expect(down.twa).toBeGreaterThan(130);
    expect(down.vmg).toBeLessThan(0);
  });
});
