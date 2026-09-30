import { describe, it, expect } from 'vitest';
import { FixedStepLoop } from '../loop';

describe('FixedStepLoop', () => {
  it('runs 2 steps for a 60 Hz frame at 120 Hz physics', () => {
    let n = 0;
    const loop = new FixedStepLoop(() => n++);
    const r = loop.advance(1 / 60, 1);
    expect(r.steps).toBe(2);
    expect(n).toBe(2);
    expect(r.alpha).toBeGreaterThanOrEqual(0);
    expect(r.alpha).toBeLessThan(1);
  });

  it('clamps a 30 s hitch (hidden tab) to 12 steps and drops the backlog', () => {
    let n = 0;
    const loop = new FixedStepLoop(() => n++);
    expect(loop.advance(30, 1).steps).toBe(12);
    expect(loop.advance(1 / 60, 1).steps).toBeLessThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(15);
  });

  it('slow motion runs proportionally fewer steps, pause runs none', () => {
    let n = 0;
    const loop = new FixedStepLoop(() => n++);
    for (let i = 0; i < 60; i++) loop.advance(1 / 60, 0.25);
    expect(n).toBe(30);
    const before = n;
    for (let i = 0; i < 60; i++) loop.advance(1 / 60, 0);
    expect(n).toBe(before);
  });

  it('ignores negative time', () => {
    let n = 0;
    const loop = new FixedStepLoop(() => n++);
    expect(loop.advance(-1, 1).steps).toBe(0);
    expect(n).toBe(0);
  });
});
