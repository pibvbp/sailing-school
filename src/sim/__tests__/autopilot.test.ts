import { describe, it, expect } from 'vitest';
import { Helmsman, helmCommand, helmError } from '../autopilot';
import { DEG } from '../../shared/math';

describe('helm', () => {
  it('helmCommand is the Helmsman steering law without the integral (M6: one law, not two)', () => {
    for (const s of [
      { heading: 0.2, twa: 50 * DEG, awa: 30 * DEG, r: 0.02, speed: 3 },
      { heading: 6.2, twa: -170 * DEG, awa: -165 * DEG, r: -0.1, speed: 0.5 },
      { heading: 1, twa: 5 * DEG, awa: 3 * DEG, r: 0, speed: 8 },
    ]) {
      for (const [mode, target] of [['twa', 45 * DEG], ['heading', 0.1], ['awa', -30 * DEG]] as const) {
        // A fresh helmsman stepping with dt = 0 has no integral yet.
        expect(helmCommand(mode, target, s)).toBeCloseTo(new Helmsman().command(mode, target, s, 0), 12);
      }
    }
  });

  it('steers toward the target: + error means turn to starboard', () => {
    expect(helmError('twa', 40 * DEG, { heading: 0, twa: 50 * DEG, awa: 0, r: 0, speed: 3 })).toBeGreaterThan(0);
    expect(helmError('heading', 0.1, { heading: 0, twa: 0, awa: 0, r: 0, speed: 3 })).toBeGreaterThan(0);
  });
});
