import { describe, it, expect } from 'vitest';
import { TrailBuffer, vmgOptima, type PolarModel } from '../polarChart';

const collect = (b: TrailBuffer, now: number) => {
  const out: { a: number; kn: number; f: number }[] = [];
  b.forEach(now, (a, kn, f) => out.push({ a, kn, f }));
  return out;
};

describe('TrailBuffer (polar chart trail)', () => {
  it('adds nothing while the snapshot time is frozen (paused), however many frames pass', () => {
    const b = new TrailBuffer(160, 6, 20);
    b.push(10, 0.7, 5);
    for (let i = 0; i < 216_000; i++) b.push(10, 0.7, 5); // one hour of paused frames at 60 Hz
    expect(b.size).toBe(1);
  });

  it('is rate-limited in simulated time and hard-capped', () => {
    const b = new TrailBuffer(50, 6, 20);
    for (let i = 0; i < 1000; i++) b.push(i / 120, 0.7, 5); // 120 Hz snapshots for 8.3 s
    expect(b.size).toBe(50);
  });

  it('only yields samples inside the time window, oldest first, with a 0…1 age fraction', () => {
    const b = new TrailBuffer(160, 6, 20);
    for (let t = 0; t <= 10; t += 0.5) b.push(t, t, t);
    const s = collect(b, 10);
    expect(s[0]!.a).toBeGreaterThanOrEqual(4);
    expect(s[s.length - 1]!.a).toBe(10);
    expect(s[0]!.f).toBe(0);
    expect(s[s.length - 1]!.f).toBe(1);
  });

  it('starts over when the simulation time jumps back (scenario reset)', () => {
    const b = new TrailBuffer();
    for (let t = 0; t < 5; t += 0.1) b.push(t, 1, 1);
    b.push(0.05, 2, 2);
    expect(b.size).toBe(1);
    expect(collect(b, 0.05)[0]!.a).toBe(2);
  });
});

describe('vmgOptima', () => {
  it('finds the best upwind and downwind VMG angles of a polar', () => {
    const DEG = Math.PI / 180;
    // A textbook-shaped polar: nothing below 30°, fastest on a reach, slower dead downwind.
    const model: PolarModel = { speed: (_tws, twa) => (twa < 30 * DEG ? 0 : 3 * Math.sin(Math.min(twa, 100 * DEG)) + (twa > 100 * DEG ? -0.8 * (twa / Math.PI - 0.55) : 0)) };
    const o = vmgOptima(model, 6);
    expect(o.beat.twa / DEG).toBeGreaterThan(30);
    expect(o.beat.twa / DEG).toBeLessThan(60);
    expect(o.beat.vmg).toBeGreaterThan(0);
    expect(o.run.twa / DEG).toBeGreaterThan(120);
    expect(o.run.vmg).toBeLessThan(0);
  });
});
