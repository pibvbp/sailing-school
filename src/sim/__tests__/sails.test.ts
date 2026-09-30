import { describe, it, expect } from 'vitest';
import { MainModel } from '../sails/main';
import { JibModel, sheetingAngle } from '../sails/jib';
import { SpinnakerModel } from '../sails/spinnaker';
import { blanketFactor, type AirContext } from '../sails/common';
import { defaultControls, type Controls } from '../types';
import { DEG } from '../../shared/math';

/** Stationary boat heading north; wind FROM `awaDeg` (so AWA = TWA = awaDeg), uniform with height. */
function airFor(awaDeg: number, speed = 6, heel = 0): AirContext {
  const d = awaDeg * DEG;
  return { kin: { heading: 0, heel, u: 0, v: 0, r: 0, p: 0 }, windAt: () => ({ e: -speed * Math.sin(d), n: -speed * Math.cos(d) }) };
}

const noShift = { main: 0, mainLuff: 0 };
const ctl = (patch: Partial<Controls> = {}): Controls => ({ ...defaultControls(), ...patch });

function runMain(m: MainModel, c: Controls, awaDeg: number, seconds: number, heel = 0, speed = 6): number {
  let maxCrash = 0;
  const air = airFor(awaDeg, speed, heel);
  for (let t = 0; t < seconds; t += 1 / 120) {
    m.step(1 / 120, c, air, noShift, 1, awaDeg * DEG);
    maxCrash = Math.max(maxCrash, m.crashRate);
  }
  return maxCrash;
}

describe('mainsail and boom', () => {
  it('weathervanes and luffs head-to-wind with the sheet eased', () => {
    const m = new MainModel();
    m.beta = 20 * DEG;
    runMain(m, ctl({ mainSheet: 0 }), 0, 12);
    expect(Math.abs(m.beta)).toBeLessThan(5 * DEG);
    const lu = m.last!.sections.reduce((a, s) => a + s.luffing, 0) / m.last!.sections.length;
    expect(lu).toBeGreaterThan(0.8);
  });

  it('settles on its sheet limit on a beam reach and fills', () => {
    const m = new MainModel();
    const c = ctl({ mainSheet: 0.5, traveler: 0 });
    runMain(m, c, 90, 6);
    const { hi } = m.limits(c);
    expect(m.beta).toBeGreaterThan(hi - 1 * DEG);
    expect(m.beta).toBeLessThan(hi + 3 * DEG);
    const lu = m.last!.sections.reduce((a, s) => a + s.luffing, 0) / m.last!.sections.length;
    expect(lu).toBeLessThan(0.2);
  });

  it('traveler to leeward moves the boom out without easing the sheet', () => {
    const m = new MainModel();
    const centred = m.limits(ctl({ mainSheet: 1, traveler: 0 })).car;
    const down = m.limits(ctl({ mainSheet: 1, traveler: -1 })).car;
    expect(down).toBeGreaterThan(centred + 10 * DEG); // starboard tack: leeward = port = +
  });

  it('crash-gybes when the wind goes by the lee with the sheet eased', () => {
    const m = new MainModel();
    const c = ctl({ mainSheet: 0.1, vang: 0.3 });
    runMain(m, c, 175, 4);
    expect(m.beta).toBeGreaterThan(60 * DEG);
    const crash = runMain(m, c, -158, 6);
    expect(m.beta).toBeLessThan(-40 * DEG);
    expect(crash).toBeGreaterThan(1.5);
  });

  it('gybes gently when the main is sheeted in first', () => {
    const m = new MainModel();
    const c = ctl({ mainSheet: 0.95 });
    runMain(m, c, 175, 4);
    const crash = runMain(m, c, -158, 6);
    expect(crash).toBe(0);
    expect(m.beta).toBeLessThan(0);
  });

  it('gravity swings a free boom to the low side when heeled', () => {
    const m = new MainModel();
    runMain(m, ctl({ mainSheet: 0 }), 0, 6, 20 * DEG, 0);
    expect(m.beta).toBeLessThan(-30 * DEG);
  });

  it('a tight leech (vang on, sheet in) has much less twist than a loose one', () => {
    const tight = new MainModel();
    runMain(tight, ctl({ mainSheet: 0.9, vang: 0.9 }), 60, 4);
    const loose = new MainModel();
    runMain(loose, ctl({ mainSheet: 0.3, vang: 0 }), 60, 4);
    expect(loose.twist).toBeGreaterThan(tight.twist + 10 * DEG);
  });
});

function runJib(j: JibModel, c: Controls, awaDeg: number, seconds: number): void {
  const air = airFor(awaDeg);
  for (let t = 0; t < seconds; t += 1 / 120) j.step(1 / 120, c, air, 0, 1, awaDeg * DEG);
}

describe('jib', () => {
  it('sits at the sheeting angle when trimmed hard', () => {
    const j = new JibModel();
    const c = ctl({ jibSheet: 1 });
    runJib(j, c, 40, 3);
    expect(j.gamma / DEG).toBeCloseTo(sheetingAngle(0) / DEG, 0);
  });

  it('swings out as the sheet is eased', () => {
    const j = new JibModel();
    runJib(j, ctl({ jibSheet: 0.3 }), 70, 3);
    expect(j.gamma).toBeGreaterThan(25 * DEG);
    expect(j.gamma).toBeLessThan(33 * DEG);
  });

  it('holds the clew to windward when backed and pushes the bow away', () => {
    const j = new JibModel();
    const c = ctl({ jibSheet: 1, jibBacked: true });
    runJib(j, c, 40, 2);
    runJib(j, c, -30, 3);
    expect(j.gamma).toBeGreaterThan(5 * DEG);
    const s = j.state(j.last!, c, 0, -30 * DEG);
    expect(s.backed).toBe(true);
    expect(s.force.y).toBeGreaterThan(0);
  });

  it('luffs through the tack, crosses and is hauled in on the new side', () => {
    const j = new JibModel();
    const c = ctl({ jibSheet: 0.9 });
    runJib(j, c, 35, 2);
    expect(j.gamma).toBeGreaterThan(5 * DEG);
    // The bow swings through the wind over 3 s (AWA +35° → −35°).
    let maxLuff = 0;
    for (let t = 0; t < 3; t += 1 / 120) {
      const awa = 35 - (70 * t) / 3;
      j.step(1 / 120, c, airFor(awa), 0, 1, awa * DEG);
      maxLuff = Math.max(maxLuff, j.last!.sections.reduce((a, s) => a + s.luffing, 0) / 8);
    }
    expect(maxLuff).toBeGreaterThan(0.5);
    runJib(j, c, -35, 4);
    expect(j.gamma).toBeLessThan(-8 * DEG);
    expect(j.workingSide).toBe(-1);
  });

  it('furling removes the area', () => {
    const j = new JibModel();
    runJib(j, ctl({ jibFurl: 1 }), 60, 4);
    expect(j.last!.sum.area).toBeLessThan(0.3);
    expect(j.state(j.last!, ctl({ jibFurl: 1 }), 0, 60 * DEG).set).toBe(false);
  });
});

function runSpin(s: SpinnakerModel, c: Controls, awaDeg: number, seconds: number): string[] {
  const events: string[] = [];
  const air = airFor(awaDeg);
  for (let t = 0; t < seconds; t += 1 / 120) {
    s.step(1 / 120, c, air, 1, awaDeg * DEG, 6);
    events.push(...s.events);
  }
  return events;
}

describe('spinnaker', () => {
  it('hoists in about six seconds', () => {
    const s = new SpinnakerModel();
    runSpin(s, ctl({ spinHoist: true }), 130, 3);
    expect(s.hoist).toBeGreaterThan(0.4);
    expect(s.hoist).toBeLessThan(0.6);
    runSpin(s, ctl({ spinHoist: true }), 130, 3.2);
    expect(s.hoist).toBe(1);
  });

  it('puts the pole tip on the forestay at 0 and square to windward at 1', () => {
    const s = new SpinnakerModel();
    const fwd = s.poleTip(ctl({ spinPole: 0, spinPoleHeight: 0.2 }));
    expect(Math.abs(fwd.y)).toBeLessThan(0.01);
    expect(fwd.x).toBeGreaterThan(3.8);
    const sq = s.poleTip(ctl({ spinPole: 1, spinPoleHeight: 0.2 }));
    expect(sq.y).toBeGreaterThan(2.7); // wind from starboard → pole to starboard
  });

  it('collapses when the sheet is eased too far and refills when trimmed', () => {
    const s = new SpinnakerModel();
    s.hoist = 1;
    const trimmed = ctl({ spinHoist: true, spinPole: 0.35, spinSheet: 0.75 });
    runSpin(s, trimmed, 120, 4);
    expect(s.collapsed).toBeLessThan(0.1);
    const eased = runSpin(s, { ...trimmed, spinSheet: 0 }, 120, 4);
    expect(eased).toContain('spinCollapse');
    expect(s.collapsed).toBeGreaterThan(0.8);
    const back = runSpin(s, trimmed, 120, 5);
    expect(back).toContain('spinRefill');
    expect(s.collapsed).toBeLessThan(0.2);
  });

  it('curls at the luff just before collapsing', () => {
    const s = new SpinnakerModel();
    s.hoist = 1;
    let seenCurl = false;
    for (let sheet = 0.9; sheet >= 0.05 && !seenCurl; sheet -= 0.02) {
      runSpin(s, ctl({ spinHoist: true, spinPole: 0.35, spinSheet: sheet }), 120, 1.5);
      if (s.curl > 0.4 && s.collapsed < 0.2) seenCurl = true;
    }
    expect(seenCurl).toBe(true);
  });
});

describe('blanketing', () => {
  it('the main blankets a sail right behind it on a dead run, not on a reach', () => {
    expect(blanketFactor(180 * DEG, 0.2, 1.5)).toBeLessThan(0.5);
    expect(blanketFactor(90 * DEG, 0.2, 1.5)).toBeCloseTo(1, 6);
    expect(blanketFactor(180 * DEG, 4, 1.5)).toBeGreaterThan(0.95); // wing-on-wing / squared pole
  });
});
