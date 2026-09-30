// The whole sail view, driven by the real simulation (headless: the cloth textures need a DOM, so the view
// builds untextured here; everything the CPU does per frame is exercised).
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Simulation } from '../../../sim/simulation';
import { AutoCrew } from '../../../sim/autocrew';
import type { ScenarioInit, SimSnapshot } from '../../../sim/types';
import { tierSettings, type QualitySettings } from '../../core/types';
import { perfBudget } from '../../../testing/perf';
import { SailsView, type SailsWind } from '../SailsView';
import { SpinShape } from '../spinMesh';

vi.setConfig({ testTimeout: 60_000 });

const DEG = Math.PI / 180;
const KN = 0.514444;
const FRAME = 1 / 60;

function settled(init: ScenarioInit, seconds: number): Simulation {
  const sim = new Simulation(init);
  sim.crew = new AutoCrew();
  for (let i = 0; i < seconds * 120; i++) sim.step();
  return sim;
}
const wind = (tws: number, twd: number) => ({ tws: tws * KN, twd: twd * DEG, gustiness: 0, shiftAmplitude: 0, shiftPeriod: 120, seed: 5 });
const beat = (): Simulation => settled({ wind: wind(12, 45), boat: { u: 2.5 }, controls: { helmMode: 'twa', helmTarget: 45 * DEG } }, 12);
const run = (): Simulation => settled({ wind: wind(20, 150), boat: { u: 3 }, spinnakerSet: true, controls: { helmMode: 'twa', helmTarget: 150 * DEG } }, 12);
const windOf = (s: SimSnapshot): SailsWind => ({ awa: s.wind.awa, aws: s.wind.aws, awaDeck: s.wind.awaDeck, awsDeck: s.wind.awsDeck });

/** Every vertex of every mesh under the view (sails, roll, telltales, windex, burgee). */
function positions(view: SailsView): Float32Array[] {
  const out: Float32Array[] = [];
  view.root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(Float32Array.from((o.geometry as THREE.BufferGeometry).getAttribute('position').array));
  });
  return out;
}
const allFinite = (arrs: Float32Array[]): boolean => arrs.every((a) => a.every((x) => Number.isFinite(x)));
const world = (o: THREE.Object3D): THREE.Vector3 => o.position.clone();

describe('SailsView', () => {
  it('orders the telltale anchors as App expects: jib port/stbd at 25, 50, 75 %, then the main leech', () => {
    const view = new SailsView(tierSettings('high'));
    const sim = beat();
    for (let k = 0; k < 20; k++) {
      sim.step(); sim.step();
      const s = sim.snapshot();
      view.update(FRAME, s.t, s.sails, windOf(s));
    }
    const a = view.telltaleAnchors;
    expect(a.map((o) => o.name)).toEqual([
      'jib-port-25', 'jib-stbd-25', 'jib-port-50', 'jib-stbd-50', 'jib-port-75', 'jib-stbd-75',
      'main-leech-20', 'main-leech-40', 'main-leech-60', 'main-leech-80',
    ].map((n) => `telltale:${n}`));
    const p = a.map(world);
    // Jib pairs: the same spot on either face (the starboard ribbon on the starboard side), rising in pairs.
    for (let h = 0; h < 3; h++) {
      const port = p[2 * h]!, stbd = p[2 * h + 1]!;
      expect(port.distanceTo(stbd)).toBeLessThan(0.03);
      expect(stbd.x).toBeGreaterThan(port.x);
      if (h > 0) expect(port.y).toBeGreaterThan(p[2 * h - 2]!.y + 1);
    }
    // Main leech: rising up the leech, well aft of the mast.
    for (let k = 6; k < 10; k++) {
      expect(p[k]!.z).toBeGreaterThan(p[0]!.z + 2);
      if (k > 6) expect(p[k]!.y).toBeGreaterThan(p[k - 1]!.y + 1);
    }
  });

  it('points the windex arrow into the masthead wind and streams the burgee downwind', () => {
    const view = new SailsView(tierSettings('high'));
    const s = beat().snapshot();
    const awa = 0.6, awaDeck = -0.4; // masthead wind 34° on the starboard bow; deck wind 23° on the port bow
    for (let k = 0; k < 240; k++) view.update(FRAME, s.t + k * FRAME, s.sails, { awa, aws: 7, awaDeck, awsDeck: 5 });
    const vane = view.root.getObjectByName('windex-vane')!, flag = view.root.getObjectByName('burgee-flag')!;
    // Boat-local X starboard, Z aft. The arrow (−Z at rest) points to where the wind comes from...
    const arrow = new THREE.Vector3(0, 0, -1).applyQuaternion(vane.quaternion);
    expect(arrow.distanceTo(new THREE.Vector3(Math.sin(awa), 0, -Math.cos(awa)))).toBeLessThan(0.06);
    // ...and the burgee's fly (+Z at rest) streams to where it goes.
    const fly = new THREE.Vector3(0, 0, 1).applyQuaternion(flag.quaternion);
    expect(fly.distanceTo(new THREE.Vector3(-Math.sin(awaDeck), 0, Math.cos(awaDeck)))).toBeLessThan(0.06);
  });

  it('holds everything still while paused (dt = 0), even when the sim clock jumps', () => {
    const view = new SailsView(tierSettings('high'));
    const sim = beat();
    let s = sim.snapshot();
    for (let k = 0; k < 30; k++) { sim.step(); sim.step(); s = sim.snapshot(); view.update(FRAME, s.t, s.sails, windOf(s)); }
    const before = positions(view);
    view.update(0, s.t, s.sails, windOf(s));
    view.update(0, 0, s.sails, windOf(s)); // a scenario swap restarts t
    const after = positions(view);
    after.forEach((a, i) => expect(Array.from(a)).toEqual(Array.from(before[i]!)));
  });

  it('shrugs off a non-finite frame (NaN / ∞ timing, wind or sail geometry) and carries on', () => {
    const view = new SailsView(tierSettings('high'));
    const sim = run();
    const step = (): SimSnapshot => { sim.step(); sim.step(); return sim.snapshot(); };
    let s = step();
    for (let k = 0; k < 30; k++) { s = step(); view.update(FRAME, s.t, s.sails, windOf(s)); }
    view.update(Number.NaN, Number.NaN, s.sails, { awa: Number.NaN, aws: Number.NaN, awaDeck: Number.NaN, awsDeck: Number.NaN });
    view.update(Infinity, -Infinity, s.sails, { awa: Infinity, aws: Infinity, awaDeck: -Infinity, awsDeck: Infinity });
    view.update(-1, s.t, s.sails, windOf(s));
    const bad = structuredClone(s.sails);
    bad.main.sections[3]!.leewardY = Number.NaN;
    bad.main.sections[4]!.camber = Number.NaN;
    bad.main.clew.x = Number.NaN;
    bad.spinnaker.sections[2]!.luffing = Number.NaN;
    bad.spinnaker.curl = Number.NaN;
    bad.spinnaker.collapsed = Number.NaN;
    bad.spinnaker.tack.y = Number.NaN;
    view.update(FRAME, s.t, bad, windOf(s));
    for (let k = 0; k < 30; k++) { s = step(); view.update(FRAME, s.t, s.sails, windOf(s)); }
    expect(allFinite(positions(view))).toBe(true);
  });

  it('reset() drops the motion of the previous scenario: the next frame shows the new snapshot as it is', () => {
    const b = beat().snapshot(), r = run().snapshot();
    const kept = new SailsView(tierSettings('high')), reset = new SailsView(tierSettings('high')), fresh = new SailsView(tierSettings('high'));
    for (const v of [kept, reset]) for (let k = 0; k < 60; k++) v.update(FRAME, b.t + k * FRAME, b.sails, windOf(b));
    reset.reset();
    for (const v of [kept, reset, fresh]) v.update(FRAME, r.t, r.sails, windOf(r));
    const main = (v: SailsView): THREE.BufferAttribute =>
      (v.root.getObjectByName('main') as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute;
    const gap = (a: SailsView, c: SailsView): number => {
      const pa = main(a), pc = main(c);
      let m = 0;
      for (let k = 0; k < pa.count; k++) m = Math.max(m, Math.hypot(pa.getX(k) - pc.getX(k), pa.getY(k) - pc.getY(k), pa.getZ(k) - pc.getZ(k)));
      return m;
    };
    // Reset: the same shape a brand-new view shows (only the running wobble differs). Kept: still swinging over.
    expect(gap(reset, fresh)).toBeLessThan(0.03);
    expect(gap(kept, fresh)).toBeGreaterThan(0.3);
  });

  it('follows a quality change: coarser cloth at low, shadows with the shadow map, still animating', () => {
    const view = new SailsView(tierSettings('high'));
    const s = beat().snapshot();
    view.setColouring('aoa');
    for (let k = 0; k < 10; k++) view.update(FRAME, s.t + k * FRAME, s.sails, windOf(s));
    const count = (): number => {
      let n = 0;
      view.root.traverse((o) => { if (o instanceof THREE.Mesh && o.name === 'main') n = (o.geometry as THREE.BufferGeometry).getAttribute('position').count; });
      return n;
    };
    const shadowed = (): boolean[] => {
      const out: boolean[] = [];
      view.root.traverse((o) => { if (o instanceof THREE.Mesh && ['main', 'jib', 'spinnaker'].includes(o.name)) out.push(o.castShadow, o.receiveShadow); });
      return out;
    };
    const high = count();
    expect(shadowed().every(Boolean)).toBe(true);
    const low: QualitySettings = { ...tierSettings('low'), shadowMapSize: 0 };
    view.setQuality(low);
    expect(count()).toBeLessThan(high * 0.4);
    expect(shadowed().some(Boolean)).toBe(false);
    for (let k = 0; k < 10; k++) view.update(FRAME, s.t + (10 + k) * FRAME, s.sails, windOf(s));
    expect(allFinite(positions(view))).toBe(true);
    view.setQuality(tierSettings('high'));
    expect(count()).toBe(high);
    expect(shadowed().every(Boolean)).toBe(true);
    view.update(FRAME, s.t + 1, s.sails, windOf(s));
    expect(allFinite(positions(view))).toBe(true);
    view.dispose();
  });

  // Timing: best of five batches filters scheduler noise; the retry covers a machine that is busy for seconds.
  it(`stays within the CPU budget in a broach: kite collapsed, main and jib flogging (≤ ${perfBudget(0.8).toFixed(1)} ms/frame)`, { retry: 2 }, () => {
    const view = new SailsView(tierSettings('high'));
    const kite = run().snapshot();
    const reach = beat().snapshot();
    const sails = structuredClone(reach.sails);
    sails.spinnaker = structuredClone(kite.sails.spinnaker);
    sails.spinnaker.collapsed = 1;
    sails.spinnaker.curl = 0.6;
    for (const sec of [...sails.main.sections, ...sails.jib.sections]) sec.luffing = 1;
    for (const tt of [...sails.main.telltales, ...sails.jib.telltales]) { tt.state = 'fluttering'; tt.intensity = 1; }
    const w = { awa: 1.2, aws: 12, awaDeck: 1.2, awsDeck: 10 };
    for (let k = 0; k < 120; k++) view.update(FRAME, k * FRAME, sails, w);
    const n = 60;
    let ms = Infinity;
    for (let b = 0; b < 5; b++) {
      const t0 = performance.now();
      for (let k = 0; k < n; k++) view.update(FRAME, (120 + b * n + k) * FRAME, sails, w);
      ms = Math.min(ms, (performance.now() - t0) / n);
    }
    expect(ms).toBeLessThan(perfBudget(0.8));
  });
});

describe('SpinShape extremes', () => {
  it('stays finite through curl, collapse and refill at any frame rate', () => {
    const snap = run().snapshot().sails.spinnaker;
    for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
      const s = new SpinShape(1);
      for (let k = 0; k < 6 / dt; k++) {
        const time = k * dt;
        const phase = time % 3;
        const state = { ...snap, curl: phase < 1 ? phase : 1, collapsed: phase < 1 ? 0 : phase < 2 ? phase - 1 : 3 - phase };
        s.update(dt, time, state, 12);
        expect(s.surface.out.every((x) => Number.isFinite(x))).toBe(true);
      }
    }
  });
});
