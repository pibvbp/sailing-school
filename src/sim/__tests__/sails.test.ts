import { describe, it, expect } from 'vitest';
import { MainModel } from '../sails/main';
import { JibModel, sheetingAngle } from '../sails/jib';
import { SpinnakerModel, ALPHA_CURL } from '../sails/spinnaker';
import { blanketFactor, evaluateSection, sideFromAwa, type AirContext } from '../sails/common';
import { MAIN_AERO } from '../aero';
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

// ------------------------------------------------------------------------------------------ sim fix round 1

describe('rig side hysteresis (C3)', () => {
  it('head to wind: changes only outside a ±3° band', () => {
    expect(sideFromAwa(1, 2 * DEG)).toBe(1);
    expect(sideFromAwa(1, -2 * DEG)).toBe(1);
    expect(sideFromAwa(1, -4 * DEG)).toBe(-1);
    expect(sideFromAwa(-1, 4 * DEG)).toBe(1);
  });

  it('dead downwind: the wind flickering across the stern does not move the sails', () => {
    for (const awa of [-179, -175, -170, -165.5]) expect(sideFromAwa(1, awa * DEG)).toBe(1);
    for (const awa of [180, 175, 170, 165.5]) expect(sideFromAwa(-1, awa * DEG)).toBe(-1);
    expect(sideFromAwa(1, -164 * DEG)).toBe(-1);
    expect(sideFromAwa(-1, 150 * DEG)).toBe(1);
  });
});

describe('whisker pole (C1)', () => {
  it('carries the clew onto the pole opposite the boom over 2–3 s, never stepping', () => {
    const j = new JibModel();
    const c = ctl({ jibSheet: 0.5 });
    const air = airFor(170, 7);
    for (let t = 0; t < 3; t += 1 / 120) j.step(1 / 120, c, air, 0, 1, 170 * DEG, 1, 75 * DEG);
    expect(j.gamma).toBeGreaterThan(0); // eased out to port, like the boom
    const poled = { ...c, jibWhisker: true };
    let maxRate = 0, reachedT = -1;
    for (let t = 0; t < 6; t += 1 / 120) {
      j.step(1 / 120, poled, air, 0, 1, 170 * DEG, 1, 75 * DEG);
      maxRate = Math.max(maxRate, Math.abs(j.gammaDot));
      if (reachedT < 0 && Math.abs(j.gamma + 80 * DEG) < 3 * DEG) reachedT = t;
    }
    expect(j.whiskerSide).toBe(-1); // boom to port → pole to starboard (wing-on-wing)
    expect(reachedT).toBeGreaterThan(1.5);
    expect(reachedT).toBeLessThan(3.5);
    expect(maxRate).toBeLessThan(2);
  });

  it('stays latched while the wind flickers across the stern and follows a gybe of the rig', () => {
    const j = new JibModel();
    const c = ctl({ jibWhisker: true });
    for (let t = 0; t < 4; t += 1 / 120) {
      const awa = (t * 10) % 2 < 1 ? 179 : -179; // the wind crossing the stern every 0.1 s
      j.step(1 / 120, c, airFor(awa, 6), 0, 1, awa * DEG, undefined, 75 * DEG);
    }
    expect(j.whiskerSide).toBe(-1);
    expect(j.gamma).toBeLessThan(-75 * DEG);
    // The simulation gybes the rig: the pole goes across with it, at the same finite speed.
    let maxRate = 0;
    for (let t = 0; t < 6; t += 1 / 120) {
      j.step(1 / 120, c, airFor(-170, 6), 0, 1, -170 * DEG, -1, -75 * DEG);
      maxRate = Math.max(maxRate, Math.abs(j.gammaDot));
    }
    expect(j.whiskerSide).toBe(1);
    expect(j.gamma).toBeGreaterThan(75 * DEG);
    expect(maxRate).toBeLessThan(3);
  });
});

describe('hard stops and the cloth-motion term (C1)', () => {
  it('the clew stops dead at ±95°: no rate left to grow against the clamp', () => {
    const j = new JibModel();
    j.gamma = 94.9 * DEG;
    j.gammaDot = 400; // flung at the stop faster than the sheet can hold it back in one step
    j.step(1 / 120, ctl({ jibSheet: 0 }), airFor(170, 6), 0, 1, 170 * DEG);
    expect(j.gamma).toBeCloseTo(95 * DEG, 9);
    expect(j.gammaDot).toBeLessThanOrEqual(0);
  });

  it('the boom stops dead at the shrouds', () => {
    const m = new MainModel();
    const c = ctl({ mainSheet: 0 });
    m.step(1 / 120, c, airFor(150, 6), noShift, 1, 150 * DEG);
    m.beta = 81.9 * DEG;
    m.betaDot = 30; // faster than the sheet spring can stop in one step
    m.step(1 / 120, c, airFor(150, 6), noShift, 1, 150 * DEG);
    expect(m.beta).toBeLessThanOrEqual(82 * DEG + 1e-12);
    expect(m.betaDot).toBeLessThanOrEqual(0);
  });

  it('caps the cloth\'s own motion at half the section airflow', () => {
    const g = { h: 0.5, luff: { x: 1, y: 0, z: -5 }, chordDir: { x: -1, y: 0, z: 0 }, chord: 2, height: 1, camber: 0.1, draft: 0.45 };
    const air = airFor(40, 6);
    const still = evaluateSection(g, MAIN_AERO, air);
    for (const w of [-400, -50, 50, 400]) {
      const r = evaluateSection(g, MAIN_AERO, air, { rotationRate: w, rotationAxis: { x: 1, y: 0 } });
      expect(r.speed).toBeLessThanOrEqual(1.5 * still.speed + 1e-9);
      expect(r.speed).toBeGreaterThanOrEqual(0.5 * still.speed - 1e-9);
    }
    // A slow swing is still damped (the term that cured the boom limit cycle).
    const slow = evaluateSection(g, MAIN_AERO, air, { rotationRate: 0.3, rotationAxis: { x: 1, y: 0 } });
    expect(Math.abs(slow.force.y - still.force.y)).toBeGreaterThan(1);
  });

  it('an interaction shift cannot push the angle of attack past π (M9)', () => {
    const g = { h: 0.5, luff: { x: 1, y: 0, z: -5 }, chordDir: { x: -1, y: 0, z: 0 }, chord: 2, height: 1, camber: 0.1, draft: 0.45 };
    for (const awa of [178, 179.5, -179.5]) {
      const r = evaluateSection(g, MAIN_AERO, airFor(awa, 6), { alphaShift: 0.2 });
      expect(r.aoa).toBeLessThanOrEqual(Math.PI);
      expect(r.cd).toBeGreaterThanOrEqual(MAIN_AERO.cd0);
    }
  });
});

describe('spinnaker leech reach (C2)', () => {
  it('finds both ends of the reachable chord angles with the pole squared', () => {
    const s = new SpinnakerModel();
    // Pole 45°, 58.5°, 72°, 90°: reachable ψ found by brute force (1° grid) in the review.
    for (const [pole, lo, hi] of [[0.5, 66, 180], [0.65, 51, 176], [0.8, 37, 162], [1, 19, 143]] as const) {
      const c = ctl({ spinPole: pole, spinPoleHeight: 0.4 });
      const r = s.leechRange(s.poleTip(c));
      expect(r.lo / DEG).toBeGreaterThan(lo - 3);
      expect(r.lo / DEG).toBeLessThan(lo + 3);
      expect(r.hi / DEG).toBeGreaterThan(hi - 3);
      expect(r.hi / DEG).toBeLessThanOrEqual(hi + 3);
      expect(s.leechLimitedPsi(s.poleTip(c))).toBe(r.lo);
      // Flown dead downwind (flow straight ahead), the chord sits across the boat, never straight aft.
      const tr = s.trim(c, 0);
      expect(tr.psiChord / DEG).toBeGreaterThanOrEqual(95 - 1e-9);
      expect(tr.psiChord).toBeLessThanOrEqual(r.hi + 1e-12);
    }
  });
});

describe('reversed flow on the main (I1)', () => {
  it('boom centred, 8 m/s from astern: no jump in side force as the wind crosses the stern', () => {
    const m = new MainModel();
    const c = ctl({ mainSheet: 1 });
    let prev: number | null = null;
    let maxStep = 0;
    // 178° → 180° → −178° in 0.5° steps.
    for (let a = 178; a <= 182.0001; a += 0.5) {
      const awa = a > 180 ? a - 360 : a;
      const fy = m.evaluate(c, 0, 3 * DEG, airFor(awa, 8), noShift).sum.force.y;
      if (prev !== null) maxStep = Math.max(maxStep, Math.abs(fy - prev));
      prev = fy;
    }
    expect(maxStep).toBeLessThan(150);
  });
});

describe('backed jib (I4)', () => {
  it('the crew holds the clew at −side·15° whatever the sheet says', () => {
    for (const sheet of [0.5, 0.7, 0.85, 1]) {
      const j = new JibModel();
      const c = ctl({ jibSheet: sheet, jibBacked: true });
      runJib(j, { ...c, jibBacked: false }, 40, 2); // sailing on starboard, then back it through a tack
      runJib(j, c, -30, 3);                          // wind now from port: windward = port = + clew
      expect(j.gamma / DEG).toBeGreaterThan(15 - 3);
      expect(j.gamma / DEG).toBeLessThan(15 + 3);
      expect(j.state(j.last!, c, 0, -30 * DEG).backed).toBe(true);
      // On the same tack the crew hauls it across to windward (starboard, −).
      const k = new JibModel();
      runJib(k, { ...c, jibBacked: false }, 40, 2);
      runJib(k, c, 40, 3);
      expect(k.gamma / DEG).toBeLessThan(-15 + 3);
      expect(k.gamma / DEG).toBeGreaterThan(-15 - 3);
    }
  });
});

describe('ropes are handled at a finite speed (M3, I2)', () => {
  it('the mainsheet hauls at ≈0.35/s and eases at ≈1/s', () => {
    const m = new MainModel();
    const air = airFor(90, 6);
    m.step(1 / 120, ctl({ mainSheet: 0 }), air, noShift, 1, 90 * DEG);
    let t = 0;
    while (m.sheet < 0.99 && t < 10) { m.step(1 / 120, ctl({ mainSheet: 1 }), air, noShift, 1, 90 * DEG); t += 1 / 120; }
    expect(t).toBeGreaterThan(2.5);
    expect(t).toBeLessThan(3.3);
    t = 0;
    while (m.sheet > 0.01 && t < 10) { m.step(1 / 120, ctl({ mainSheet: 0 }), air, noShift, 1, 90 * DEG); t += 1 / 120; }
    expect(t).toBeGreaterThan(0.8);
    expect(t).toBeLessThan(1.2);
  });

  it('the jib and spinnaker sheets are rate-limited too', () => {
    const j = new JibModel();
    j.step(1 / 120, ctl({ jibSheet: 0 }), airFor(100), 0, 1, 100 * DEG);
    for (let i = 0; i < 120; i++) j.step(1 / 120, ctl({ jibSheet: 1 }), airFor(100), 0, 1, 100 * DEG);
    expect(j.sheet).toBeGreaterThan(0.3);
    expect(j.sheet).toBeLessThan(0.4);
    const s = new SpinnakerModel();
    s.hoist = 1;
    s.step(1 / 120, ctl({ spinHoist: true, spinSheet: 0 }), airFor(120), 1, 120 * DEG, 6);
    for (let i = 0; i < 120; i++) s.step(1 / 120, ctl({ spinHoist: true, spinSheet: 1 }), airFor(120), 1, 120 * DEG, 6);
    expect(s.sheet).toBeGreaterThan(0.3);
    expect(s.sheet).toBeLessThan(0.4);
  });

  it('the traveler car does not jump when the tack flips — only its target changes side', () => {
    const m = new MainModel();
    const c = ctl({ mainSheet: 1, traveler: -0.8 });
    runMain(m, c, 40, 3);
    expect(m.carY).toBeCloseTo(-0.64, 2); // starboard tack, car to leeward = port
    let maxStep = 0, prev = m.carY;
    for (let t = 0; t < 3; t += 1 / 120) {
      m.step(1 / 120, c, airFor(-40), noShift, 1, -40 * DEG);
      maxStep = Math.max(maxStep, Math.abs(m.carY - prev));
      prev = m.carY;
    }
    expect(m.carY).toBeCloseTo(0.64, 2); // now to leeward on port tack
    expect(maxStep).toBeLessThan(1.7 / 120); // ≤ one track length per second (easing), never a jump
  });
});

describe('boom held out by hand (Controls.boomPush)', () => {
  it('holds the boom where the crew pushes it, never past the sheet, and lets go at once at 0', () => {
    const m = new MainModel();
    const held = ctl({ mainSheet: 0.1, boomPush: 1 });
    runMain(m, held, 0, 4, 0, 4);                      // in irons, 4 m/s from dead ahead
    expect(m.beta / DEG).toBeGreaterThan(65);         // ≈ 70° out to port
    expect(m.beta).toBeLessThanOrEqual(m.appliedLimits().hi + 1 * DEG);
    // The crew can only push as far as the sheet lets the boom go.
    const k = new MainModel();
    runMain(k, ctl({ mainSheet: 0.6, boomPush: 1 }), 0, 4, 0, 4);
    expect(k.beta).toBeLessThan(k.appliedLimits().hi + 1 * DEG);
    // Let go: from the very next steps the wind swings the boom back toward the centreline.
    const free = { ...held, boomPush: 0 };
    const air = airFor(0, 4);
    for (let i = 0; i < 30; i++) m.step(1 / 120, free, air, noShift, 1, 0);
    expect(m.betaDot).toBeLessThan(-0.05);
    runMain(m, free, 0, 5, 0, 4);
    expect(Math.abs(m.beta) / DEG).toBeLessThan(15);
  });

  it('cannot hold a full main against a fresh breeze (a person pushes ≈ 300 N), but can in light air', () => {
    // Beam reach, sheet eased: the crew tries to hold the boom in at ≈ 10° while the full sail drives it out.
    const hold = ctl({ mainSheet: 0.1, boomPush: 0.15 });
    const fresh = new MainModel();
    runMain(fresh, hold, 90, 4, 0, 12);
    expect(fresh.beta / DEG).toBeGreaterThan(40); // the wind wins
    const light = new MainModel();
    runMain(light, hold, 90, 4, 0, 2);
    expect(Math.abs(light.beta / DEG - 10.5)).toBeLessThan(4); // a light sail is easily held
  });
});

describe('by-the-lee moment (M8)', () => {
  it('blends in with the boom angle: no step as the boom passes 5°', () => {
    // 20° by the lee in a fresh breeze: the full gybing moment would be ≈ 2.4 kN·m (a 0.2 rad/s jump in one step).
    const acc = (betaDeg: number) => {
      const m = new MainModel();
      m.beta = betaDeg * DEG;
      m.betaDot = 0;
      m.step(1 / 120, ctl({ mainSheet: 0 }), airFor(-160, 12), noShift, 1, -160 * DEG, 1);
      return m.betaDot;
    };
    for (const b of [3, 5, 7]) expect(Math.abs(acc(b + 0.05) - acc(b - 0.05))).toBeLessThan(0.02);
  });
});

describe('crash gybe detection in the boom model (I2, M12)', () => {
  it('a slow, wide swing across with the wind aft counts as a gybe; a sheeted-in crossing does not', () => {
    const m = new MainModel();
    const c = ctl({ mainSheet: 0.1 });
    runMain(m, c, 175, 4);
    let swing = 0;
    const air = airFor(-160, 6);
    for (let t = 0; t < 6; t += 1 / 120) { m.step(1 / 120, c, air, noShift, 1, -160 * DEG); swing = Math.max(swing, m.swingRate); }
    expect(m.beta).toBeLessThan(-40 * DEG);
    expect(swing).toBeGreaterThan(0);
    const g = new MainModel();
    const tight = ctl({ mainSheet: 0.95 });
    runMain(g, tight, 175, 4);
    let s2 = 0, crash = 0;
    for (let t = 0; t < 6; t += 1 / 120) { g.step(1 / 120, tight, air, noShift, 1, -160 * DEG); s2 = Math.max(s2, g.swingRate); crash = Math.max(crash, g.crashRate); }
    expect(s2).toBe(0);
    expect(crash).toBe(0);
  });

  it('never on a tack: the boom crossing with the wind forward is not a gybe', () => {
    const m = new MainModel();
    const c = ctl({ mainSheet: 0.2 });
    runMain(m, c, 60, 3, 0, 9);
    let crash = 0, swing = 0;
    for (let t = 0; t < 6; t += 1 / 120) {
      m.step(1 / 120, c, airFor(-60, 9), noShift, 1, -60 * DEG);
      crash = Math.max(crash, m.crashRate);
      swing = Math.max(swing, m.swingRate);
    }
    expect(m.beta).toBeLessThan(0);
    expect(crash).toBe(0);
    expect(swing).toBe(0);
  });
});

describe('spinnaker collapse and refill timing (M16)', () => {
  it('collapses 0.6 s after the luff goes below α_curl − 7°, refills 1 s after it recovers', () => {
    const s = new SpinnakerModel();
    s.hoist = 1;
    const trimmed = ctl({ spinHoist: true, spinPole: 0.35, spinSheet: 0.75 });
    runSpin(s, trimmed, 120, 4);
    expect(s.collapsed).toBe(0);
    // Ease hard: once the (rate-limited) sheet has let the trim angle fall below α_curl − 7°, time the collapse.
    const eased = { ...trimmed, spinSheet: 0 };
    let tLow = -1, tCollapse = -1;
    for (let t = 0; t < 6; t += 1 / 120) {
      s.step(1 / 120, eased, airFor(120), 1, 120 * DEG, 6);
      if (tLow < 0 && s.alphaTrim < ALPHA_CURL - 7 * DEG) tLow = t;
      if (tCollapse < 0 && s.events.includes('spinCollapse')) tCollapse = t;
    }
    expect(tLow).toBeGreaterThanOrEqual(0);
    // The 0.6 s timer, then the collapse ramps in at 2.5/s (to 50 % in 0.2 s).
    expect(tCollapse - tLow).toBeGreaterThan(0.6);
    expect(tCollapse - tLow).toBeLessThan(0.6 + 0.2 + 0.05);
    let tHigh = -1, tRefill = -1;
    for (let t = 0; t < 8; t += 1 / 120) {
      s.step(1 / 120, trimmed, airFor(120), 1, 120 * DEG, 6);
      if (tHigh < 0 && s.alphaTrim > ALPHA_CURL - 3 * DEG) tHigh = t;
      if (tRefill < 0 && s.events.includes('spinRefill')) tRefill = t;
    }
    expect(tHigh).toBeGreaterThanOrEqual(0);
    // The 1 s timer, then the collapse unwinds at 1.2/s (from 1 to 50 % in ≈0.42 s).
    expect(tRefill - tHigh).toBeGreaterThan(1.0);
    expect(tRefill - tHigh).toBeLessThan(1.0 + 0.42 + 0.05);
  });
});
