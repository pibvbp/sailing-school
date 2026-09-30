// Event detection rules (sim fix round 1: M11 round-up, one crash-gybe event per gybe).
import { describe, it, expect } from 'vitest';
import { EventDetector, type EventInputs } from '../events';
import { DEG } from '../../shared/math';

const base: EventInputs = {
  t: 10, dt: 1 / 120, twa: 50 * DEG, speed: 3, heel: -10 * DEG, yawRate: 0, rudder: 0, crashRate: 0,
  spinEvents: [], mainLuffing: 0, jibLuffing: 0, jibSet: true, mainLuffBubble: 0, mainLeechFull: false,
};

const fired = (d: EventDetector, patch: Partial<EventInputs>, type: string): boolean => {
  d.update({ ...base, ...patch });
  return d.drain().some((e) => e.type === type);
};

describe('round-up (M11)', () => {
  // Wind from starboard (TWA > 0): the bow swinging toward the wind is a turn to starboard (r > 0).
  const roundingUp = { heel: -30 * DEG, yawRate: 12 * DEG };

  it('fires with the tiller centred: heeled past 25°, the bow swinging to windward faster than 8°/s', () => {
    expect(fired(new EventDetector(), { ...roundingUp, rudder: 0 }, 'roundUp')).toBe(true);
  });

  it('fires while the helm fights it (rudder hard the other way)', () => {
    expect(fired(new EventDetector(), { ...roundingUp, rudder: -35 * DEG }, 'roundUp')).toBe(true);
  });

  it('not when the rudder is steering the boat up into the wind', () => {
    expect(fired(new EventDetector(), { ...roundingUp, rudder: 6 * DEG }, 'roundUp')).toBe(false);
  });

  it('not when upright, slow to turn, or turning away from the wind', () => {
    expect(fired(new EventDetector(), { ...roundingUp, heel: -20 * DEG }, 'roundUp')).toBe(false);
    expect(fired(new EventDetector(), { ...roundingUp, yawRate: 6 * DEG }, 'roundUp')).toBe(false);
    expect(fired(new EventDetector(), { ...roundingUp, yawRate: -12 * DEG }, 'roundUp')).toBe(false);
  });

  it('mirrors on port tack', () => {
    expect(fired(new EventDetector(), { twa: -50 * DEG, heel: 30 * DEG, yawRate: -12 * DEG, rudder: 0 }, 'roundUp')).toBe(true);
    expect(fired(new EventDetector(), { twa: -50 * DEG, heel: 30 * DEG, yawRate: -12 * DEG, rudder: -6 * DEG }, 'roundUp')).toBe(false);
  });
});

describe('crash gybe events', () => {
  it('one gybe, one event: the swing and the slam a moment apart are reported once', () => {
    const d = new EventDetector();
    d.update({ ...base, t: 10, crashRate: 0.9 });
    d.update({ ...base, t: 10.4, crashRate: 2.1 });
    expect(d.drain().filter((e) => e.type === 'crashGybe').length).toBe(1);
    d.update({ ...base, t: 14, crashRate: 1.8 });
    expect(d.drain().filter((e) => e.type === 'crashGybe').length).toBe(1);
  });
});
