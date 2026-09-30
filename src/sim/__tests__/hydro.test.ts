import { describe, it, expect } from 'vitest';
import { frictionCf, hullResistance, foilForce, KEEL, RUDDER, crossFlow, windage, rightingMoment } from '../hydro';
import { BOAT } from '../../shared/boatSpec';
import { DEG } from '../../shared/math';

describe('hull resistance', () => {
  it('ORC friction line: Cf ≈ 0.00255 at 2.88 m/s', () => {
    expect(frictionCf(2.88)).toBeGreaterThan(0.00255 * 0.97);
    expect(frictionCf(2.88)).toBeLessThan(0.00255 * 1.03);
  });
  it('total upright resistance near 5.6 kn is in the expected range', () => {
    const r = hullResistance(2.88, 0).total;
    expect(r).toBeGreaterThan(260);
    expect(r).toBeLessThan(380);
  });
  it('rises monotonically and hits the hull-speed wall', () => {
    let prev = 0;
    for (let v = 0.2; v < 5; v += 0.2) {
      const r = hullResistance(v, 0).total;
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
    expect(hullResistance(3.4, 0).total / hullResistance(2.88, 0).total).toBeGreaterThan(1.8);
  });
  it('heel adds drag', () => {
    expect(hullResistance(2.5, 25 * DEG).total).toBeGreaterThan(hullResistance(2.5, 0).total * 1.05);
  });
});

describe('keel and rudder foils', () => {
  it('keel lift opposes sideslip', () => {
    const f = foilForce(KEEL, { x: -3, y: -0.2, z: 0 }, 0); // boat sliding to starboard
    expect(f.force.y).toBeLessThan(0);
    const g = foilForce(KEEL, { x: -3, y: 0.2, z: 0 }, 0);
    expect(g.force.y).toBeGreaterThan(0);
  });
  it('a positive rudder angle pushes the stern to port (bow to starboard)', () => {
    const f = foilForce(RUDDER, { x: -3, y: 0, z: 0 }, 10 * DEG);
    expect(f.force.y).toBeLessThan(0);
  });
  it('reversed flow (sternway) reverses the rudder force', () => {
    const fwd = foilForce(RUDDER, { x: -1, y: 0, z: 0 }, 10 * DEG);
    const back = foilForce(RUDDER, { x: 1, y: 0, z: 0 }, 10 * DEG);
    expect(Math.sign(back.force.y)).toBe(-Math.sign(fwd.force.y));
  });
  it('the keel stalls: less lift at 30° than at 14°', () => {
    const at = (deg: number) => Math.abs(foilForce(KEEL, { x: -3 * Math.cos(deg * DEG), y: -3 * Math.sin(deg * DEG), z: 0 }, 0).force.y);
    expect(at(30)).toBeLessThan(at(14));
    expect(foilForce(KEEL, { x: -3 * Math.cos(30 * DEG), y: -3 * Math.sin(30 * DEG), z: 0 }, 0).stalled).toBe(true);
  });
  it('produces drag along the flow', () => {
    const f = foilForce(KEEL, { x: -3, y: 0, z: 0 }, 0);
    expect(f.force.x).toBeLessThan(0);
    expect(Math.abs(f.force.y)).toBeLessThan(1e-6);
  });
});

describe('cross-flow, windage, stability', () => {
  it('cross-flow drag opposes sideways motion and yaw', () => {
    expect(crossFlow(0.5, 0).Y).toBeLessThan(0);
    expect(crossFlow(-0.5, 0).Y).toBeGreaterThan(0);
    expect(crossFlow(0, 0.3).N).toBeLessThan(0);
  });
  it('windage pushes the boat downwind', () => {
    expect(windage({ x: -5, y: 0, z: 0 }).x).toBeLessThan(0);   // head to wind: pushed aft
    expect(windage({ x: 0, y: -5, z: 0 }).y).toBeLessThan(0);   // wind from starboard: pushed to port
  });
  it('windage uses the projected areas in the boat spec (M6)', () => {
    const q = 0.5 * 1.225 * 25;
    expect(windage({ x: -5, y: 0, z: 0 }).x).toBeCloseTo(-q * BOAT.hull.windageFront, 9);
    expect(windage({ x: 0, y: -5, z: 0 }).y).toBeCloseTo(-q * BOAT.hull.windageSide, 9);
  });
  it('righting moment opposes heel with the GZ curve', () => {
    const k = rightingMoment(20 * DEG);
    expect(k).toBeLessThan(-4988 * 0.95);
    expect(k).toBeGreaterThan(-4988 * 1.05);
    expect(rightingMoment(-20 * DEG)).toBeCloseTo(-k, 6);
  });
});
