// Calibration: with optimal trim at each apparent wind angle, the sail sets must reproduce the ORC VPP 2023
// coefficient envelopes (Tables 5.1, 5.4, 5.6) within ±15 %. Sail sets are compared, as the ORC combines
// its per-sail coefficients by area: main + jib upwind/reaching, main + spinnaker downwind.
import { describe, it, expect } from 'vitest';
import { MainModel } from '../sails/main';
import { JibModel } from '../sails/jib';
import { SpinnakerModel } from '../sails/spinnaker';
import { interactionShifts, type AirContext } from '../sails/common';
import { defaultControls } from '../types';
import { DEG, interpTable } from '../../shared/math';

const V = 6;
const Q = 0.5 * 1.225 * V * V;

function airFor(awaDeg: number): AirContext {
  const d = awaDeg * DEG;
  return { kin: { heading: 0, heel: 0, u: 0, v: 0, r: 0, p: 0 }, windAt: () => ({ e: -V * Math.sin(d), n: -V * Math.cos(d) }) };
}

// Lift is measured ⟂ to the free stream toward leeward; drag along it (wind from starboard).
const liftOf = (f: { x: number; y: number }, awa: number) => f.x * Math.sin(awa) - f.y * Math.cos(awa);
const dragOf = (f: { x: number; y: number }, awa: number) => -f.x * Math.cos(awa) - f.y * Math.sin(awa);

const ORC_MAIN_CL: Array<[number, number]> = [[0, 0], [7, 0.862], [9, 1.052], [12, 1.164], [28, 1.347], [60, 1.353], [90, 1.267], [120, 0.931], [150, 0.388], [180, -0.112]];
const ORC_MAIN_CD: Array<[number, number]> = [[0, 0.043], [7, 0.026], [9, 0.023], [12, 0.023], [28, 0.033], [60, 0.113], [90, 0.383], [120, 0.969], [150, 1.316], [180, 1.345]];
const ORC_JIB_CL: Array<[number, number]> = [[7, 0], [15, 1.0], [20, 1.375], [27, 1.45], [50, 1.45], [60, 1.25], [100, 0.4], [150, 0], [180, -0.1]];
const ORC_JIB_CD: Array<[number, number]> = [[7, 0.05], [15, 0.032], [20, 0.031], [27, 0.037], [50, 0.25], [60, 0.35], [100, 0.73], [150, 0.95], [180, 0.9]];
const ORC_SPIN_CL: Array<[number, number]> = [[28, -0.024], [41, 0.66], [50, 0.861], [60, 0.992], [67, 1.026], [75, 1.026], [100, 0.92], [115, 0.805], [130, 0.635], [150, 0.36], [170, 0.11], [180, 0]];
const ORC_SPIN_CD: Array<[number, number]> = [[28, 0.182], [41, 0.267], [50, 0.337], [60, 0.417], [67, 0.465], [75, 0.506], [100, 0.588], [115, 0.615], [130, 0.636], [150, 0.65], [170, 0.65], [180, 0.64]];

const c = defaultControls();
const main = new MainModel();
const jib = new JibModel();
const spin = new SpinnakerModel();
spin.hoist = 1;

function upwindSet(awaDeg: number): { cl: number; cdAtBest: number; area: number } {
  const air = airFor(awaDeg);
  const awa = awaDeg * DEG;
  let best = { cl: -Infinity, cdAtBest: 0, area: 1 };
  for (let beta = -6; beta <= 78; beta += 2) {
    for (let gamma = 8; gamma <= 40; gamma += 2) {
      const m0 = main.evaluate(c, beta * DEG, 4 * DEG, air, { main: 0, mainLuff: 0 });
      const j0 = jib.evaluate(c, gamma * DEG, 0, air, 0);
      const sh = interactionShifts(m0.sum.cl, j0.sum.cl, m0.sum.area, j0.sum.area, true);
      const m = main.evaluate(c, beta * DEG, 4 * DEG, air, sh);
      const j = jib.evaluate(c, gamma * DEG, 0, air, sh.jib);
      const f = { x: m.sum.force.x + j.sum.force.x, y: m.sum.force.y + j.sum.force.y };
      const area = m.sum.area + j.sum.area;
      const cl = liftOf(f, awa) / (Q * area);
      if (cl > best.cl) best = { cl, cdAtBest: dragOf(f, awa) / (Q * area), area };
    }
  }
  return best;
}

function downwindSet(awaDeg: number): { cl: number; cd: number } {
  const air = airFor(awaDeg);
  const awa = awaDeg * DEG;
  let best = { cl: -Infinity, cd: 0 };
  let maxCd = 0;
  for (let pole = 0; pole <= 1.0001; pole += 0.1) {
    for (let sheet = 0; sheet <= 1.0001; sheet += 0.05) {
      const cc = { ...c, spinPole: pole, spinSheet: sheet, spinPoleHeight: 0.35 };
      const flowPsi = Math.PI - awa; // flow direction measured from the bow toward leeward
      const tr = spin.trim(cc, flowPsi);
      if (tr.alphaTrim < 5 * DEG) continue; // luff curled/collapsed — not a usable trim
      const s = spin.evaluate(cc, tr.psiChord, air, 1, awa, V, 1, 0);
      for (let beta = 20; beta <= 78; beta += 4) {
        const m = main.evaluate(c, beta * DEG, 8 * DEG, air, { main: 0, mainLuff: 0 });
        const f = { x: m.sum.force.x + s.sum.force.x, y: m.sum.force.y + s.sum.force.y };
        const area = m.sum.area + s.sum.area;
        const cl = liftOf(f, awa) / (Q * area);
        const cd = dragOf(f, awa) / (Q * area);
        if (cl > best.cl) best = { cl, cd };
        maxCd = Math.max(maxCd, cd);
      }
    }
  }
  return awaDeg >= 170 ? { cl: best.cl, cd: maxCd } : best;
}

const within = (got: number, want: number, tol = 0.15) => Math.abs(got - want) <= tol * Math.max(Math.abs(want), 0.2);

describe('ORC coefficient envelopes (optimal trim)', () => {
  const aMain = 14.6, aJib = 13.8, aSpin = 32;
  const orcUp = (a: number) => (interpTable(ORC_MAIN_CL, a) * aMain + interpTable(ORC_JIB_CL, a) * aJib) / (aMain + aJib);
  const orcDown = (a: number) => (interpTable(ORC_MAIN_CL, a) * aMain + interpTable(ORC_SPIN_CL, a) * aSpin) / (aMain + aSpin);
  const orcDownCd = (a: number) => (interpTable(ORC_MAIN_CD, a) * aMain + interpTable(ORC_SPIN_CD, a) * aSpin) / (aMain + aSpin);
  const orcUpCd = (a: number) => (interpTable(ORC_MAIN_CD, a) * aMain + interpTable(ORC_JIB_CD, a) * aJib) / (aMain + aJib);

  const rows: string[] = [];
  for (const a of [15, 20, 27, 40, 60, 90, 120]) {
    it(`main + jib lift at AWA ${a}°`, () => {
      const got = upwindSet(a);
      rows.push(`up ${a}°: model ${got.cl.toFixed(3)} vs ORC ${orcUp(a).toFixed(3)}`);
      expect(within(got.cl, orcUp(a)), `model ${got.cl.toFixed(3)} vs ORC ${orcUp(a).toFixed(3)}`).toBe(true);
    });
  }
  it('main + jib drag on a dead run', () => {
    const air = airFor(180);
    const m = main.evaluate(c, 78 * DEG, 10 * DEG, air, { main: 0, mainLuff: 0 });
    // Dead-run trim for the jib: poled out square to the wind on the whisker (ORC's 180° headsail coefficient). An
    // eased jib is only ~40° to a following wind and, with reversed flow modelled as a flat plate (I1), is no drag sail.
    const j = jib.evaluate(c, -80 * DEG, 0, air, 0);
    const f = { x: m.sum.force.x + j.sum.force.x, y: m.sum.force.y + j.sum.force.y };
    const cd = dragOf(f, Math.PI) / (Q * (m.sum.area + j.sum.area));
    rows.push(`up 180° CD: model ${cd.toFixed(3)} vs ORC ${orcUpCd(180).toFixed(3)}`);
    expect(within(cd, orcUpCd(180)), `model ${cd.toFixed(3)} vs ORC ${orcUpCd(180).toFixed(3)}`).toBe(true);
  });
  for (const a of [60, 75, 90, 110, 130, 150]) {
    it(`main + spinnaker lift at AWA ${a}°`, () => {
      const got = downwindSet(a);
      rows.push(`down ${a}°: model ${got.cl.toFixed(3)} vs ORC ${orcDown(a).toFixed(3)}`);
      expect(within(got.cl, orcDown(a), 0.18), `model ${got.cl.toFixed(3)} vs ORC ${orcDown(a).toFixed(3)}`).toBe(true);
    });
  }
  it('main + spinnaker drag on a dead run', () => {
    const got = downwindSet(180);
    rows.push(`down 180° CD: model ${got.cd.toFixed(3)} vs ORC ${orcDownCd(180).toFixed(3)}`);
    expect(within(got.cd, orcDownCd(180)), `model ${got.cd.toFixed(3)} vs ORC ${orcDownCd(180).toFixed(3)}`).toBe(true);
    console.log(rows.join('\n'));
  });
});
