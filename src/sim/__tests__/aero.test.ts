import { describe, it, expect } from 'vitest';
import { MAIN_AERO, JIB_AERO, SPIN_AERO, sailCoefficients, alphaLuff, alphaStall, kheff, inducedDragCoeff } from '../aero';
import { DEG } from '../../shared/math';

const sails = [
  ['main', MAIN_AERO, 0.11],
  ['jib', JIB_AERO, 0.12],
  ['spinnaker', SPIN_AERO, 0.26],
] as const;

describe('sail coefficients', () => {
  for (const [name, p, camber] of sails) {
    describe(name, () => {
      it('is continuous over 0…180°', () => {
        for (const c of [camber * 0.6, camber, camber * 1.4]) {
          for (const draft of [0.4, 0.5]) {
            let prev = sailCoefficients(p, 0, c, draft);
            for (let a = 0.1; a <= 180; a += 0.1) {
              const cur = sailCoefficients(p, a * DEG, c, draft);
              expect(Math.abs(cur.cl - prev.cl)).toBeLessThan(0.04); // continuous: max slope ≈ 23 per rad
              expect(Math.abs(cur.cd - prev.cd)).toBeLessThan(0.04);
              prev = cur;
            }
          }
        }
      });

      it('flogs below the luff threshold', () => {
        const a = alphaLuff(p, camber, 0.45) - p.luffWidth - 0.01;
        const k = sailCoefficients(p, Math.max(a, 0), camber, 0.45);
        expect(k.cl).toBeLessThan(0.02);
        expect(k.luffing).toBe(1);
        expect(k.cd).toBeCloseTo(p.cdFlog, 1);
      });

      it('has the attached lift slope in the groove', () => {
        const lo = alphaLuff(p, camber, 0.45) + 0.02;
        const hi = alphaStall(p, camber, 0.45) - 0.02;
        const mid = (lo + hi) / 2;
        const d = 0.004;
        const slope = (sailCoefficients(p, mid + d, camber, 0.45).cl - sailCoefficients(p, mid - d, camber, 0.45).cl) / (2 * d);
        expect(slope).toBeGreaterThan(p.clSlope * 0.95);
        expect(slope).toBeLessThan(p.clSlope * 1.05);
      });

      it('loses lift after the stall and is drag-dominated at 90°', () => {
        const s = alphaStall(p, camber, 0.45);
        expect(sailCoefficients(p, 50 * DEG, camber, 0.45).cl).toBeLessThan(sailCoefficients(p, s, camber, 0.45).cl);
        const k90 = sailCoefficients(p, 90 * DEG, camber, 0.45);
        expect(Math.abs(k90.cl)).toBeLessThan(0.15);
        expect(Math.abs(k90.cd - p.cn90)).toBeLessThan(0.1);
        expect(k90.stall).toBeGreaterThan(0.99);
      });
    });
  }

  it('deeper sails make more lift at the same angle and have a wider groove', () => {
    const a = 8 * DEG;
    const flat = sailCoefficients(MAIN_AERO, a, 0.07, 0.45).cl;
    const full = sailCoefficients(MAIN_AERO, a, 0.15, 0.45).cl;
    expect(full).toBeGreaterThan(flat);
    const groove = (c: number) => alphaStall(MAIN_AERO, c, 0.45) - alphaLuff(MAIN_AERO, c, 0.45);
    expect(groove(0.15)).toBeGreaterThan(groove(0.07));
  });

  it('draft forward lowers the luffing threshold (more forgiving entry)', () => {
    expect(alphaLuff(JIB_AERO, 0.12, 0.38)).toBeLessThan(alphaLuff(JIB_AERO, 0.12, 0.52));
  });

  it('kheff follows the ORC effective-span curve', () => {
    expect(kheff(20 * DEG)).toBeCloseTo(1.45, 2);
    expect(kheff(90 * DEG)).toBeCloseTo(0.8, 2);
    expect(kheff(0)).toBeCloseTo(1.0, 2);
  });

  it('induced drag grows with lift squared and shrinks with effective height', () => {
    expect(inducedDragCoeff(1.2, 28, 14)).toBeCloseTo((1.44 * 28) / (Math.PI * 196), 9);
    expect(inducedDragCoeff(1.2, 28, 10)).toBeGreaterThan(inducedDragCoeff(1.2, 28, 14));
  });
});
