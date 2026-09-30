// The slice flow field: physically sensible pictures in each regime, tangent to the cloth, cheap to rebuild.
import { describe, expect, it } from 'vitest';
import { CAMBER_PTS, SliceField, newSliceElement, sailCutAt, type FlowSample, type SliceElement } from '../flowField';
import { bestMeanMs, sail } from './helpers';
import { perfBudget } from '../../../testing/perf';

const sample = (): FlowSample => ({ u: 0, v: 0, ratio: 0, turb: 0 });

/** Point on an element's camber line at chord fraction s, pushed `off` metres toward its belly (lee) side. */
function onCloth(el: SliceElement, s: number, off: number): { x: number; y: number; tx: number; ty: number } {
  const k = Math.round(s * (CAMBER_PTS - 1));
  const x = el.pts[2 * k]!, y = el.pts[2 * k + 1]!;
  const tx = el.pts[2 * k + 2]! - el.pts[2 * k - 2]!, ty = el.pts[2 * k + 3]! - el.pts[2 * k - 1]!;
  const l = Math.hypot(tx, ty);
  return { x: x + el.nX * off, y: y + el.nY * off, tx: tx / l, ty: ty / l };
}

function element(f: SliceField, id: string): SliceElement {
  const el = f.elements.slice(0, f.count).find((e) => e.id === id);
  if (!el) throw new Error(`no ${id} cut at ${f.h} m`);
  return el;
}

describe('SliceField', () => {
  const beat = sail(12, 45);

  it('close-hauled: attached flow, faster on the lee side, slower to windward, free stream far away', () => {
    const f = new SliceField(4.5);
    expect(f.update(beat.snap, true)).toBe(true);
    const main = element(f, 'main');
    expect(main.lattice).toBeGreaterThan(0.95);
    expect(main.bluff).toBe(0);
    expect(main.k).toBeGreaterThan(0.3);
    const s = sample();
    const lee = onCloth(main, 0.3, 0.25);
    const windward = onCloth(main, 0.3, -0.25);
    expect(f.sample(lee.x, lee.y, s).ratio).toBeGreaterThan(1.08);
    expect(f.sample(windward.x, windward.y, s).ratio).toBeLessThan(0.97);
    // Far upstream the air is the free stream.
    const U = f.speed;
    f.sample(1 - 6.5 * f.uInf.x / U, -6.5 * f.uInf.y / U, s);
    expect(s.ratio).toBeGreaterThan(0.85);
    expect(s.ratio).toBeLessThan(1.15);
    for (const v of f.data) expect(Number.isFinite(v)).toBe(true);
  });

  it('advection field is (nearly) tangent to the cloth — streamlines go round the sails, not through them', () => {
    const f = new SliceField(4.5);
    f.update(beat.snap, true);
    const s = sample();
    for (const id of ['main', 'jib']) {
      const el = element(f, id);
      for (const frac of [0.3, 0.5, 0.7]) {
        for (const off of [-0.14, 0.14]) {
          const p = onCloth(el, frac, off);
          f.sample(p.x, p.y, s);
          const sp = Math.hypot(s.u, s.v);
          const normal = Math.abs(s.u * -p.ty + s.v * p.tx);
          expect(normal / sp).toBeLessThan(0.3);
        }
      }
    }
  });

  it('sailCutAt reproduces a strip section exactly at its own height', () => {
    const main = beat.snap.sails.main;
    const sec = main.sections[3]!;
    const el = newSliceElement();
    expect(sailCutAt(main, -sec.luff.z, el)).toBe(true);
    expect(el.chord).toBeCloseTo(sec.chord, 9);
    expect(el.leX).toBeCloseTo(sec.luff.x, 9);
    expect(el.cl).toBeCloseTo(sec.cl, 9);
    expect(el.aoa).toBeCloseTo(sec.aoa, 9);
    expect(sailCutAt(main, 12, el)).toBe(false); // above the head
    expect(sailCutAt(beat.snap.sails.spinnaker, 5, el)).toBe(false); // not hoisted
  });

  it('a luffing sail loses its circulation and stirs the air around it', () => {
    const luffing = sail(12, 45, { crew: false, controls: { mainSheet: 0.15, jibSheet: 0.9, autoTrim: { main: false, jib: false, spinnaker: false } } });
    const f = new SliceField(4.5);
    f.update(luffing.snap, true);
    const main = element(f, 'main');
    expect(main.luffing).toBeGreaterThan(0.85);
    expect(main.lattice).toBe(0);
    const s = sample();
    const p = onCloth(main, 0.5, 0.1);
    expect(f.sample(p.x, p.y, s).turb).toBeGreaterThan(0.15);
  });

  it('an over-sheeted, stalled sail sheds a slow turbulent wake off its leech', () => {
    const stalled = sail(12, 70, { crew: false, controls: { mainSheet: 1, jibSheet: 1, traveler: 1, autoTrim: { main: false, jib: false, spinnaker: false } } });
    const f = new SliceField(4.5);
    f.update(stalled.snap, true);
    const main = element(f, 'main');
    expect(main.stall).toBeGreaterThan(0.5);
    expect(main.stallW + main.bluff).toBeGreaterThan(0.5);
    const U = f.speed;
    const s = sample();
    // Just behind the leech, a little to lee, along the stream.
    const x = main.teX + main.nX * 0.25 + (f.uInf.x / U) * 0.8, y = main.teY + main.nY * 0.25 + (f.uInf.y / U) * 0.8;
    f.sample(x, y, s);
    expect(s.turb).toBeGreaterThan(0.3);
    expect(Math.hypot(s.u, s.v) / U).toBeLessThan(0.85);
  });

  it('running: the main is a bluff body — stagnation on the windward face, a dead-air wake behind', () => {
    const run = sail(12, 170, { seconds: 40 });
    const f = new SliceField(4.5);
    f.update(run.snap, true);
    const main = element(f, 'main');
    expect(main.bluff).toBeGreaterThan(0.9);
    const U = f.speed, ux = f.uInf.x / U, uy = f.uInf.y / U;
    const cx = 0.5 * (main.leX + main.teX), cy = 0.5 * (main.leY + main.teY);
    const s = sample();
    f.sample(cx - ux * 0.5, cy - uy * 0.5, s); // just upstream of the middle of the sail
    expect(s.ratio).toBeLessThan(0.75);
    f.sample(cx + ux * 2.5, cy + uy * 2.5, s); // behind it
    expect(s.turb).toBeGreaterThan(0.3);
    expect(Math.hypot(s.u, s.v) / U).toBeLessThan(0.7);
  });

  it('the spinnaker downwind is treated as separated flow', () => {
    const run = sail(12, 150, { spin: true, seconds: 40 });
    const f = new SliceField(5.5);
    f.update(run.snap, true);
    const spin = element(f, 'spinnaker');
    expect(spin.bluff).toBeGreaterThan(0.5);
    for (const v of f.data) expect(Number.isFinite(v)).toBe(true);
  });

  it('skips the rebuild while nothing visible changed, rebuilds when forced or the trim moves', () => {
    const { sim } = sail(12, 45);
    const f = new SliceField(4.5);
    expect(f.update(sim.snapshot(), true)).toBe(true);
    expect(f.update(sim.snapshot())).toBe(false);
    const v = f.version;
    sim.controls.autoTrim.main = false;
    sim.controls.mainSheet = 0.2; // ease the main a lot
    for (let i = 0; i < 240; i++) sim.step();
    expect(f.update(sim.snapshot())).toBe(true);
    expect(f.version).toBe(v + 1);
  });

  // Timing: best-of-N already filters scheduler noise; the retry covers a machine that is busy for seconds.
  it('rebuilds within budget (lattice + bluff + wakes, one slice)', { retry: 2 }, () => {
    const run = sail(12, 150, { spin: true, seconds: 30 });
    const f = new SliceField(5.5);
    const msRun = bestMeanMs(() => f.update(run.snap, true), 10, 6);
    const g = new SliceField(4.5);
    const msBeat = bestMeanMs(() => g.update(beat.snap, true), 10, 6);
    expect(msBeat).toBeLessThan(perfBudget(1.0));
    expect(msRun).toBeLessThan(perfBudget(1.5));
  });
});
