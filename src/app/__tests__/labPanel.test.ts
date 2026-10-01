// Sail lab: the apparent-wind solve and the tow limit (the panel's DOM is exercised in the browser tests).
import { describe, it, expect } from 'vitest';
import { LAB_DEFAULTS, awaForTwa, limited, towLimit, twaForAwa } from '../labPanel';
import { DEG, KN } from '../../shared/math';

describe('Sail lab: apparent wind', () => {
  it('twaForAwa turns the wind so the towed boat sees the wanted apparent angle, on both sides', () => {
    for (const tws of [4 * KN, 12 * KN, 25 * KN]) {
      for (const tow of [0, 0.5 * tws, towLimit(tws)]) {
        for (const deg of [-170, -120, -60, -35, -5, 0, 5, 35, 60, 90, 120, 150, 170]) {
          const twa = twaForAwa(deg * DEG, tow, tws);
          expect(awaForTwa(twa, tow, tws) / DEG, `awa ${deg}° tow ${tow} tws ${tws}`).toBeCloseTo(deg, 6);
          expect(Math.sign(twa) || 1, 'same side').toBe(Math.sign(deg) || 1);
          expect(Math.abs(twa)).toBeGreaterThanOrEqual(Math.abs(deg * DEG) - 1e-9); // true wind is always further aft
        }
      }
    }
  });

  it('with no tow the apparent wind is the true wind', () => {
    expect(twaForAwa(50 * DEG, 0, 6)).toBeCloseTo(50 * DEG, 12);
    expect(awaForTwa(-130 * DEG, 0, 6)).toBeCloseTo(-130 * DEG, 12);
  });
});

describe('Sail lab: tow limit', () => {
  it('holds the tow just under the wind speed', () => {
    expect(towLimit(4 * KN)).toBeCloseTo(3.8 * KN, 12);
    const fast = limited({ awa: 35 * DEG, tws: 4 * KN, tow: 8 * KN });
    expect(fast.tow).toBeCloseTo(3.8 * KN, 12);
    expect(fast.awa).toBe(35 * DEG);
    expect(fast.tws).toBe(4 * KN);
  });

  it('leaves a tow under the limit alone (same object: nothing to re-sync)', () => {
    const p = { ...LAB_DEFAULTS };
    expect(limited(p)).toBe(p);
  });

  it('a limited tow still reaches every apparent wind angle', () => {
    const tws = 4 * KN;
    const { tow } = limited({ awa: 0, tws, tow: 8 * KN });
    for (const deg of [20, 90, 150, 179]) {
      expect(awaForTwa(twaForAwa(deg * DEG, tow, tws), tow, tws) / DEG).toBeCloseTo(deg, 6);
    }
    // Without the limit a tow faster than the wind cannot: the apparent wind stays forward of the beam.
    expect(awaForTwa(twaForAwa(150 * DEG, 8 * KN, tws), 8 * KN, tws) / DEG).toBeLessThan(90);
  });
});
