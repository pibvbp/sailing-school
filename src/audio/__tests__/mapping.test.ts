import { describe, it, expect } from 'vitest';
import { DEG, KN } from '../../shared/math';
import {
  cameraYawFromForward, collapseLevel, crashLevel, finiteOr, flogLevel, flutterRate, luffDrive, meanLuffing, panFor, refillLevel,
  relativeBearing, spinRustleDrive, swooshCentre, swooshDrive, swooshLevel, waterRushCutoff, waterRushLevel, whistleDrive, whistleFreqA,
  whistleFreqB, windHissCutoff, windHissLevel, windRoarCutoff, windRoarLevel,
} from '../mapping';

const range = (lo: number, hi: number, n = 40) => Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
const nondecreasing = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]! - 1e-12);

describe('wind mapping', () => {
  it('the roar level grows with the square of the apparent wind speed', () => {
    for (const aws of [2, 3, 4, 6]) expect(windRoarLevel(2 * aws) / windRoarLevel(aws)).toBeCloseTo(4, 6);
  });

  it('level and brightness rise monotonically with AWS', () => {
    const a = range(0, 25);
    for (const f of [windRoarLevel, windRoarCutoff, windHissLevel, windHissCutoff, whistleDrive, whistleFreqA, whistleFreqB]) expect(nondecreasing(a.map(f))).toBe(true);
  });

  it('is silent in no wind and never non-finite', () => {
    expect(windRoarLevel(0)).toBe(0);
    expect(windHissLevel(0)).toBe(0);
    for (const aws of range(0, 80)) for (const f of [windRoarLevel, windRoarCutoff, windHissLevel, windHissCutoff, whistleDrive, whistleFreqA, whistleFreqB]) expect(Number.isFinite(f(aws))).toBe(true);
  });

  it('the whistle is absent in light air, faint at 15 kn and fully in by 22 kn', () => {
    expect(whistleDrive(10 * KN)).toBe(0);
    expect(whistleDrive(13 * KN)).toBe(0);
    expect(whistleDrive(15 * KN)).toBeGreaterThan(0);
    expect(whistleDrive(15 * KN)).toBeLessThan(0.2);
    expect(whistleDrive(22 * KN)).toBe(1);
    expect(whistleDrive(35 * KN)).toBe(1);
  });

  it('the whistle pitch follows the wind and stays in the audible band', () => {
    expect(whistleFreqA(14)).toBeGreaterThan(whistleFreqA(8));
    for (const aws of range(0, 60)) {
      expect(whistleFreqA(aws)).toBeGreaterThanOrEqual(500);
      expect(whistleFreqB(aws)).toBeLessThanOrEqual(4000);
    }
  });
});

describe('water mapping', () => {
  it('the rush rises faster than linearly with speed and brightens', () => {
    expect(waterRushLevel(0)).toBe(0);
    expect(waterRushLevel(4) / waterRushLevel(2)).toBeGreaterThan(2);
    expect(nondecreasing(range(0, 8).map(waterRushCutoff))).toBe(true);
  });

  it('the swoosh follows roll activity and heel, and needs speed', () => {
    expect(swooshDrive(0, 0, 3)).toBe(0);
    expect(swooshDrive(0.2, 0, 3)).toBeGreaterThan(swooshDrive(0.05, 0, 3));
    expect(swooshDrive(0, 0.4, 3)).toBeGreaterThan(swooshDrive(0, 0.05, 3));
    expect(swooshDrive(0, -0.4, 3)).toBeCloseTo(swooshDrive(0, 0.4, 3), 9);
    expect(swooshDrive(0.2, 0.3, 0)).toBeLessThan(swooshDrive(0.2, 0.3, 3));
    expect(nondecreasing(range(0, 2).map(swooshLevel))).toBe(true);
    expect(nondecreasing(range(0, 2).map(swooshCentre))).toBe(true);
  });
});

describe('sail flogging mapping', () => {
  it('gates on luffing: nothing below ~0.18, half-way around the spec threshold of 0.3, full above ~0.42', () => {
    expect(luffDrive(0)).toBe(0);
    expect(luffDrive(0.15)).toBe(0);
    expect(luffDrive(0.3)).toBeGreaterThan(0.15);
    expect(luffDrive(0.3)).toBeLessThan(0.4);
    expect(luffDrive(0.5)).toBeGreaterThan(luffDrive(0.3) * 2);
    expect(luffDrive(1)).toBe(1);
    expect(nondecreasing(range(0, 1).map(luffDrive))).toBe(true);
  });

  it('flutter rate is 3–8 Hz and rises with AWS', () => {
    const rates = range(0, 40).map(flutterRate);
    expect(Math.min(...rates)).toBeCloseTo(3, 9);
    expect(Math.max(...rates)).toBeCloseTo(8, 9);
    expect(nondecreasing(rates)).toBe(true);
  });

  it('loudness is luffing × AWS² (until the cap) and grows with both', () => {
    expect(flogLevel(0, 10)).toBe(0);
    expect(flogLevel(0.5, 5) / flogLevel(1, 5)).toBeCloseTo(0.5, 9);
    expect(flogLevel(1, 4) / flogLevel(1, 2)).toBeCloseTo(4, 9);
    expect(flogLevel(1, 40)).toBeLessThan(2);
    expect(nondecreasing(range(0, 30).map((a) => flogLevel(1, a)))).toBe(true);
  });

  it('meanLuffing averages sections and shrugs off garbage', () => {
    expect(meanLuffing([])).toBe(0);
    expect(meanLuffing([{ luffing: 0 }, { luffing: 1 }])).toBe(0.5);
    expect(meanLuffing([{ luffing: NaN }, { luffing: 1 }])).toBe(0.5);
  });
});

describe('spinnaker and impact mapping', () => {
  it('a full spinnaker is quiet, a collapsed one rustles more in more wind', () => {
    expect(spinRustleDrive(0, 0, 8)).toBe(0);
    expect(spinRustleDrive(1, 1, 8)).toBeGreaterThan(spinRustleDrive(1, 1, 3));
    expect(spinRustleDrive(1, 1, 8)).toBeGreaterThan(spinRustleDrive(0.3, 0, 8));
    expect(spinRustleDrive(0, 1, 8)).toBeGreaterThan(0); // curling already flutters, gently
    expect(spinRustleDrive(0, 1, 8)).toBeLessThan(spinRustleDrive(1, 0, 8));
  });

  it('the boom crash is louder with the impact rate, within 0.55…1', () => {
    expect(crashLevel(1.5)).toBeCloseTo(0.55, 9);
    expect(crashLevel(10)).toBeCloseTo(1, 9);
    expect(nondecreasing(range(1.5, 8).map(crashLevel))).toBe(true);
    expect(crashLevel(NaN)).toBeCloseTo(0.55, 9);
  });

  it('refill and collapse are louder in more wind', () => {
    expect(refillLevel(10)).toBeGreaterThan(refillLevel(3));
    expect(collapseLevel(10)).toBeGreaterThan(collapseLevel(3));
    expect(refillLevel(10)).toBeGreaterThan(collapseLevel(10));
  });
});

describe('stereo placement', () => {
  // Boat heading north; the camera looks along the bow.
  it('wind from the starboard bow pans right, from the port bow pans left, from ahead stays centred', () => {
    expect(panFor(relativeBearing(0, 40 * DEG, 0), 0.55)).toBeGreaterThan(0.2);
    expect(panFor(relativeBearing(0, -40 * DEG, 0), 0.55)).toBeLessThan(-0.2);
    expect(Math.abs(panFor(relativeBearing(0, 0, 0), 0.55))).toBeLessThan(1e-9);
  });

  it('turns with the camera: looking to starboard puts an ahead wind on the left', () => {
    expect(panFor(relativeBearing(0, 0, 90 * DEG), 0.55)).toBeLessThan(-0.5);
    expect(panFor(relativeBearing(0, 0, -90 * DEG), 0.55)).toBeGreaterThan(0.5);
  });

  it('accounts for the boat heading (compass bearings)', () => {
    // Heading east, wind 30° off the bow to starboard = from the south-east; camera looking due east.
    expect(panFor(relativeBearing(90 * DEG, 30 * DEG, 90 * DEG), 1)).toBeCloseTo(0.5, 6);
    // Same wind (from compass 120°), camera looking south (180°): it comes from 60° to the left of the view.
    expect(panFor(relativeBearing(90 * DEG, 30 * DEG, 180 * DEG), 1)).toBeCloseTo(-Math.sin(60 * DEG), 6);
  });

  it('never exceeds the requested width and wraps across north', () => {
    for (const b of range(-10, 10)) expect(Math.abs(panFor(b, 0.55))).toBeLessThanOrEqual(0.55 + 1e-12);
    expect(panFor(relativeBearing(350 * DEG, 20 * DEG, 5 * DEG), 1)).toBeCloseTo(Math.sin(5 * DEG), 9);
  });

  it('converts a three.js forward vector to a compass yaw (X = east, Z = −north)', () => {
    expect(cameraYawFromForward(0, -1)).toBeCloseTo(0, 9);
    expect(cameraYawFromForward(1, 0)).toBeCloseTo(90 * DEG, 9);
    expect(Math.abs(cameraYawFromForward(0, 1))).toBeCloseTo(180 * DEG, 9);
    expect(cameraYawFromForward(-1, 0)).toBeCloseTo(-90 * DEG, 9);
  });
});

describe('finiteOr', () => {
  it('passes finite numbers and replaces NaN and infinities', () => {
    expect(finiteOr(3, 0)).toBe(3);
    expect(finiteOr(-1e300, 0)).toBe(-1e300);
    expect(finiteOr(NaN, 7)).toBe(7);
    expect(finiteOr(Infinity, 7)).toBe(7);
    expect(finiteOr(-Infinity, 7)).toBe(7);
  });
});
