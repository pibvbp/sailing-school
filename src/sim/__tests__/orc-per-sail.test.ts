// Per-sail calibration (Task 5 brief, sim fix I5/I8): each sail's own lift coefficient at its optimal trim, with the
// main–jib interaction on, against the ORC VPP 2023 per-sail tables — ±15 % wherever the ORC value is above 0.5
// (the other points are printed), and |Cl| < 0.2 dead downwind for every sail.
import { describe, it, expect } from 'vitest';
import { MainModel } from '../sails/main';
import { JibModel, sheetingAngle } from '../sails/jib';
import { SpinnakerModel } from '../sails/spinnaker';
import { interactionShifts, type AirContext } from '../sails/common';
import { defaultControls, type Controls } from '../types';
import { DEG, interpTable } from '../../shared/math';

const V = 6;
const Q = 0.5 * 1.225 * V * V;

function airFor(awaDeg: number): AirContext {
  const d = awaDeg * DEG;
  return { kin: { heading: 0, heel: 0, u: 0, v: 0, r: 0, p: 0 }, windAt: () => ({ e: -V * Math.sin(d), n: -V * Math.cos(d) }) };
}

// Lift ⟂ to the free stream toward leeward (wind from starboard).
const liftOf = (f: { x: number; y: number }, awa: number) => f.x * Math.sin(awa) - f.y * Math.cos(awa);

const ORC_MAIN_CL: Array<[number, number]> = [[0, 0], [7, 0.862], [9, 1.052], [12, 1.164], [28, 1.347], [60, 1.353], [90, 1.267], [120, 0.931], [150, 0.388], [180, -0.112]];
const ORC_JIB_CL: Array<[number, number]> = [[7, 0], [15, 1.0], [20, 1.375], [27, 1.45], [50, 1.45], [60, 1.25], [100, 0.4], [150, 0], [180, -0.1]];
const ORC_SPIN_CL: Array<[number, number]> = [[28, -0.024], [41, 0.66], [50, 0.861], [60, 0.992], [67, 1.026], [75, 1.026], [100, 0.92], [115, 0.805], [130, 0.635], [150, 0.36], [170, 0.11], [180, 0]];

// Upwind pointing trim: jib sheet hard with the lead forward (least twist); the boom may come a few degrees above the
// centreline with the traveler; the clew no closer than the rig's sheets can bring it (the sheeting angle).
const up: Controls = { ...defaultControls(), jibSheet: 1, jibLead: 1 };
const BETA = { lo: -3, hi: 60 };
const GAMMA = { lo: sheetingAngle(up.jibLead) / DEG, hi: 40 };

/**
 * Ruling (lead, I5 / re-review N2): at very low AWA the jib may fall up to 30 % below ORC's generic coefficient
 * (measured at the reachable trim: −28 % at 15°, −25 % at 20°). The Kestrel's jib cannot be sheeted closer than its
 * ~11° sheeting angle, so it is at its luffing onset there, earlier than the ORC table assumes (a narrower sheeting
 * base); the sail-set envelope stays in band and the extra luffing is the physically right pinch penalty.
 * Everywhere else the tolerance is ±15 %.
 */
const LOW_SIDE_TOL: Record<string, number> = { 'jib 15': 0.3, 'jib 20': 0.3 };

const main = new MainModel();
const jib = new JibModel();

/** Main and jib lift coefficients at one trim, the interaction computed from their own lift (as in the sim). */
function pair(awaDeg: number, beta: number, gamma: number): { main: number; jib: number; set: number } {
  const air = airFor(awaDeg);
  const awa = awaDeg * DEG;
  const m0 = main.evaluate(up, beta * DEG, 4 * DEG, air, { main: 0, mainLuff: 0 });
  const j0 = jib.evaluate(up, gamma * DEG, 0, air, 0);
  const sh = interactionShifts(m0.sum.cl, j0.sum.cl, m0.sum.area, j0.sum.area, true);
  const m = main.evaluate(up, beta * DEG, 4 * DEG, air, sh);
  const j = jib.evaluate(up, gamma * DEG, 0, air, sh.jib);
  const clm = liftOf(m.sum.force, awa) / (Q * m.sum.area);
  const clj = liftOf(j.sum.force, awa) / (Q * j.sum.area);
  return { main: clm, jib: clj, set: (clm * m.sum.area + clj * j.sum.area) / (m.sum.area + j.sum.area) };
}

/** Each sail's best lift with the other one at the trim that is best for the pair. */
function perSail(awaDeg: number): { main: number; jib: number } {
  let best = { set: -Infinity, beta: 0, gamma: 0 };
  for (let b = BETA.lo; b <= BETA.hi; b += 1) {
    for (let g = GAMMA.lo; g <= GAMMA.hi; g += 1) {
      const r = pair(awaDeg, b, g);
      if (r.set > best.set) best = { set: r.set, beta: b, gamma: g };
    }
  }
  let m = -Infinity, j = -Infinity;
  for (let b = BETA.lo; b <= BETA.hi; b += 1) m = Math.max(m, pair(awaDeg, b, best.gamma).main);
  for (let g = GAMMA.lo; g <= GAMMA.hi; g += 1) j = Math.max(j, pair(awaDeg, best.beta, g).jib);
  return { main: m, jib: j };
}

function spinBest(awaDeg: number): number {
  const spin = new SpinnakerModel();
  spin.hoist = 1;
  const air = airFor(awaDeg);
  const awa = awaDeg * DEG;
  let best = -Infinity;
  for (let pole = 0; pole <= 1.0001; pole += 0.05) {
    for (let sheet = 0; sheet <= 1.0001; sheet += 0.05) {
      const cc = { ...defaultControls(), spinPole: pole, spinSheet: sheet, spinPoleHeight: 0.35 };
      const tr = spin.trim(cc, Math.PI - awa);
      if (tr.alphaTrim < 5 * DEG) continue; // luff curled/collapsed — not a usable trim
      const e = spin.evaluate(cc, tr.psiChord, air, 1, awa, V, 1, 0);
      best = Math.max(best, liftOf(e.sum.force, awa) / (Q * e.sum.area));
    }
  }
  return best;
}

const rows: string[] = [];
function check(sail: string, awa: number, got: number, table: Array<[number, number]>): void {
  const want = interpTable(table, awa);
  const pct = ((got / want - 1) * 100).toFixed(0);
  rows.push(`${sail} ${awa}°: model ${got.toFixed(3)} vs ORC ${want.toFixed(3)} (${pct} %)`);
  const below = LOW_SIDE_TOL[`${sail} ${awa}`] ?? 0.15;
  if (want > 0.5) expect(got >= (1 - below) * want && got <= 1.15 * want, `${sail} ${awa}°: model ${got.toFixed(3)} vs ORC ${want.toFixed(3)}`).toBe(true);
}

describe('ORC per-sail lift at optimal trim, interaction on', () => {
  const upwind = new Map<number, { main: number; jib: number }>();
  const at = (awa: number) => { if (!upwind.has(awa)) upwind.set(awa, perSail(awa)); return upwind.get(awa)!; };

  for (const a of [7, 12, 20, 28]) it(`main at AWA ${a}°`, () => check('main', a, at(a).main, ORC_MAIN_CL));
  for (const a of [15, 20, 27]) it(`jib at AWA ${a}°`, () => check('jib', a, at(a).jib, ORC_JIB_CL));
  for (const a of [41, 60, 90, 150]) it(`spinnaker at AWA ${a}°`, () => check('spinnaker', a, spinBest(a), ORC_SPIN_CL));

  it('dead downwind every sail is a drag sail: |Cl| < 0.2 at its running trim', () => {
    const air = airFor(180);
    // Main eased to the shrouds, jib poled out on the whisker, spinnaker at its best trim.
    const m = main.evaluate(defaultControls(), 80 * DEG, 8 * DEG, air, { main: 0, mainLuff: 0 });
    const j = jib.evaluate(defaultControls(), -80 * DEG, 0, air, 0);
    const clm = liftOf(m.sum.force, Math.PI) / (Q * m.sum.area);
    const clj = liftOf(j.sum.force, Math.PI) / (Q * j.sum.area);
    const cls = spinBest(180);
    rows.push(`180°: main ${clm.toFixed(3)}, jib ${clj.toFixed(3)}, spinnaker ${cls.toFixed(3)} (ORC −0.11, −0.10, 0)`);
    for (const cl of [clm, clj, cls]) expect(Math.abs(cl)).toBeLessThan(0.2);
    if (process.env['ORC_REPORT'] === '1') console.log(rows.join('\n'));
  });
});
