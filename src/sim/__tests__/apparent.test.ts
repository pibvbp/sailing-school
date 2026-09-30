import { describe, it, expect } from 'vitest';
import { airVelocityBody, awaAws, twaOf } from '../apparent';
import { DEG } from '../../shared/math';

const still = { heading: 0, heel: 0, u: 0, v: 0, r: 0, p: 0 };

describe('apparent wind', () => {
  it('stationary boat, wind from the east (starboard) → AWA +90°', () => {
    const a = airVelocityBody({ x: 0, y: 0, z: -5 }, still, { e: -5, n: 0 });
    const { awa, aws } = awaAws(a);
    expect(awa / DEG).toBeCloseTo(90, 3);
    expect(aws).toBeCloseTo(5, 6);
  });

  it('motoring into the wind adds boat speed', () => {
    const { awa, aws } = awaAws(airVelocityBody({ x: 0, y: 0, z: -5 }, { ...still, u: 5 }, { e: 0, n: -5 }));
    expect(awa).toBeCloseTo(0, 6);
    expect(aws).toBeCloseTo(10, 6);
  });

  it('beam reach at wind speed → AWA 45°, √2 × speed', () => {
    const { awa, aws } = awaAws(airVelocityBody({ x: 0, y: 0, z: -5 }, { ...still, u: 5 }, { e: -5, n: 0 }));
    expect(awa / DEG).toBeCloseTo(45, 3);
    expect(aws).toBeCloseTo(Math.SQRT2 * 5, 5);
  });

  it('wind from port gives a negative AWA', () => {
    const { awa } = awaAws(airVelocityBody({ x: 0, y: 0, z: -5 }, still, { e: 5, n: 0 }));
    expect(awa / DEG).toBeCloseTo(-90, 3);
  });

  it('heel reduces the cross-flow component by cos φ (ORC effective angle)', () => {
    const a = airVelocityBody({ x: 0, y: 0, z: -5 }, { ...still, heel: 30 * DEG }, { e: -5, n: 0 });
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(5 * Math.cos(30 * DEG), 5);
  });

  it('heading is respected: heading east, wind from east is head-on', () => {
    const { awa } = awaAws(airVelocityBody({ x: 0, y: 0, z: -5 }, { ...still, heading: 90 * DEG }, { e: -5, n: 0 }));
    expect(awa).toBeCloseTo(0, 6);
  });

  it('rolling to starboard adds wind from starboard at the masthead', () => {
    const a = airVelocityBody({ x: 0, y: 0, z: -10 }, { ...still, p: 0.5 }, { e: 0, n: 0 });
    expect(a.y).toBeCloseTo(-5, 6); // the air moves to port relative to a mast moving to starboard at 5 m/s
  });

  it('yawing to starboard adds wind from port at the bow', () => {
    const a = airVelocityBody({ x: 3, y: 0, z: -1 }, { ...still, r: 1 }, { e: 0, n: 0 });
    expect(a.y).toBeCloseTo(-3, 6);
  });

  it('TWA sign: heading north, wind from east is +90°; from west −90°', () => {
    expect(twaOf(0, 90 * DEG) / DEG).toBeCloseTo(90, 6);
    expect(twaOf(0, -90 * DEG) / DEG).toBeCloseTo(-90, 6);
  });
});
