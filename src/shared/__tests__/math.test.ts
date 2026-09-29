import { describe, it, expect } from 'vitest';
import { wrapPi, angleDiff, interpTable, smoothstep, cross3, norm3 } from '../math';

describe('math helpers', () => {
  it('wrapPi maps into (−π, π]', () => {
    expect(wrapPi(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi((3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2, 12);
    expect(wrapPi(0)).toBe(0);
    expect(wrapPi(7 * Math.PI)).toBeCloseTo(Math.PI, 9);
  });
  it('angleDiff gives the short way round', () => {
    expect(angleDiff(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(0.2, 12);
  });
  it('interpTable interpolates and clamps', () => {
    const t = [[0, 0], [10, 1], [20, 3]] as const;
    expect(interpTable(t, -5)).toBe(0);
    expect(interpTable(t, 5)).toBeCloseTo(0.5, 12);
    expect(interpTable(t, 15)).toBeCloseTo(2, 12);
    expect(interpTable(t, 25)).toBe(3);
  });
  it('smoothstep is 0/0.5/1 at the edges and middle', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });
  it('cross and norm behave', () => {
    expect(cross3({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(norm3({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });
});
