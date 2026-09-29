import { describe, it, expect } from 'vitest';
import { bodyToLocal, localToBody, bearingToEN, worldToThreeXZ, bodyPoint } from '../coords';
import { rotX, rotZ, DEG } from '../math';

const close = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.z).toBeCloseTo(b.z, 9);
};

describe('frames (spec §5)', () => {
  it('body forward maps to three −Z, starboard to +X, up to +Y', () => {
    close(bodyToLocal({ x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: -1 });
    close(bodyToLocal({ x: 0, y: 1, z: 0 }), { x: 1, y: 0, z: 0 });
    close(bodyToLocal({ x: 0, y: 0, z: -1 }), { x: 0, y: 1, z: 0 });
  });
  it('localToBody inverts bodyToLocal', () => {
    const p = { x: 1.2, y: -3.4, z: 5.6 };
    close(localToBody(bodyToLocal(p)), p);
  });
  it('bodyPoint uses height above the waterline', () => {
    close(bodyPoint(1, 2, 3), { x: 1, y: 2, z: -3 });
  });
  it('positive heel tilts the masthead to starboard', () => {
    const top = rotX({ x: 0, y: 0, z: -10 }, 20 * DEG);
    expect(top.y).toBeGreaterThan(3);
    expect(top.z).toBeLessThan(-9);
  });
  it('positive rotation about body z turns forward toward starboard', () => {
    const v = rotZ({ x: 1, y: 0, z: 0 }, 90 * DEG);
    close(v, { x: 0, y: 1, z: 0 });
  });
  it('bearings: east is +e, north is +n; north maps to three −Z', () => {
    const e = bearingToEN(90 * DEG);
    expect(e.e).toBeCloseTo(1, 9);
    expect(e.n).toBeCloseTo(0, 9);
    expect(worldToThreeXZ(0, 5)).toEqual({ x: 0, z: -5 });
  });
});
