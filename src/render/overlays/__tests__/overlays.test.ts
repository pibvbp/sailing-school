// End-to-end and unit checks for the overlay modules that do not need a GPU.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DEG } from '../../../shared/math';
import { OVERLAY_KEYS } from '../../../lessons/types';
import { tierSettings } from '../../core/types';
import { Overlays } from '../Overlays';
import { FlowParticles } from '../flowParticles';
import { CAMBER_PTS, newSliceElement, sailCutAt } from '../flowField';
import { laylineBearings } from '../laylines';
import { DISPLAY_CAP, agxContrast, agxContrastInverse, agxForward, agxInverse, agxInverseLookup, agxInverseTable } from '../overlayMaterial';
import { aeroSplit } from '../forces';
import { SliceField } from '../flowField';
import { FlowSlice } from '../flowSlice';
import { COLORS, linearColor } from '../palette';
import { SECTORS, pointOfSail } from '../wheel';
import { bestMeanMs, sail } from './helpers';
import { perfBudget } from '../../../testing/perf';

describe('points-of-sail wheel', () => {
  it('classifies true wind angles on either tack like the glossary', () => {
    const name = (deg: number) => SECTORS[pointOfSail(deg * DEG)]!.name;
    expect(name(0)).toBe('No-go zone');
    expect(name(-30)).toBe('No-go zone');
    expect(name(45)).toBe('Close-hauled');
    expect(name(-45)).toBe('Close-hauled');
    expect(name(65)).toBe('Close reach');
    expect(name(90)).toBe('Beam reach');
    expect(name(-135)).toBe('Broad reach');
    expect(name(170)).toBe('Run');
    expect(name(180)).toBe('Run');
  });
});

describe('laylines', () => {
  it('a boat on either layline, sailing its tack’s course over ground, fetches the mark', () => {
    const twd = 250 * DEG, twa = 40 * DEG, leeway = 3 * DEG;
    const [stbd, port] = laylineBearings(twd, twa, leeway);
    const mark = { e: 100, n: 400 };
    for (const [bearing, cog] of [[stbd, twd - twa - leeway], [port, twd + twa + leeway]] as const) {
      const start = { e: mark.e + Math.sin(bearing) * 300, n: mark.n + Math.cos(bearing) * 300 };
      const end = { e: start.e + Math.sin(cog) * 300, n: start.n + Math.cos(cog) * 300 };
      expect(Math.hypot(end.e - mark.e, end.n - mark.n)).toBeLessThan(1e-6);
    }
    // Both laylines extend downwind of the mark.
    for (const b of [stbd, port]) expect(Math.cos(b - twd)).toBeLessThan(0);
  });
});

describe('overlay colour output', () => {
  it('inverse AgX + exposure lands palette colours back on themselves after three’s AgX (exact inside AgX’s gamut)', () => {
    const v = new THREE.Vector3();
    const out = new THREE.Vector3();
    const plain = new THREE.Vector3();
    for (const [key, hex] of Object.entries(COLORS)) {
      const c = linearColor(hex);
      const target = new THREE.Vector3(Math.min(c.r, DISPLAY_CAP), Math.min(c.g, DISPLAY_CAP), Math.min(c.b, DISPLAY_CAP));
      for (const exposure of [0.35, 1, 2.5]) {
        agxInverse(target, exposure, v);
        agxForward(v, exposure, out);
        const err = out.distanceTo(target);
        // Pastels and greys are reachable exactly.
        if (['boatWind', 'lift', 'drag', 'white'].includes(key)) expect(err).toBeLessThan(0.01);
        // Saturated greens/cyans lie outside what AgX can output: never meaningfully worse than no compensation,
        // and the dominant channel stays dominant (the hue family is kept).
        agxForward(target, exposure, plain);
        expect(err).toBeLessThan(plain.distanceTo(target) + 0.03);
        const arr = target.toArray(), got = out.toArray();
        expect(got.indexOf(Math.max(...got))).toBe(arr.indexOf(Math.max(...arr)));
      }
    }
  });
});

describe('overlay colour lookup table', () => {
  it('the 256-entry table reproduces the inverse AgX contrast curve the shader used to bisect', () => {
    const table = agxInverseTable();
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const y = agxContrast(0) + ((agxContrast(1) - agxContrast(0)) * i) / 2000;
      worst = Math.max(worst, Math.abs(agxInverseLookup(table, y) - agxContrastInverse(y)));
    }
    expect(worst).toBeLessThan(2e-3);
  });
});

describe('aerodynamic force split', () => {
  it('sails + induced drag + windage = the simulation’s aerodynamic force (drive and side force), on every point of sail', () => {
    for (const [twa, spin] of [[40, false], [90, false], [150, true], [170, false]] as const) {
      const { snap } = sail(14, twa, { spin, seconds: 30 });
      const split = aeroSplit(snap, { windage: { x: 0, y: 0 }, induced: { x: 0, y: 0 }, sails: [] });
      const c = Math.cos(snap.boat.heel);
      let x = split.windage.x + split.induced.x, y = split.windage.y + split.induced.y;
      for (const sailState of split.sails) { x += sailState.force.x; y += sailState.force.y * c; }
      expect(x).toBeCloseTo(snap.forces.drive, 3);
      expect(y).toBeCloseTo(snap.forces.sideForce, 3);
      // The pieces are physical: windage drags downwind, the induced drag is not negligible upwind.
      expect(Math.hypot(split.windage.x, split.windage.y)).toBeGreaterThan(5);
      if (twa === 40) expect(Math.hypot(split.induced.x, split.induced.y)).toBeGreaterThan(40);
    }
  });
});

describe('degenerate snapshots', () => {
  it('flat calm, dead stop, going astern and extreme heel: every overlay stays finite', () => {
    const cases = [
      sail(0.01, 45, { seconds: 2 }),
      sail(12, 0, { seconds: 8, crew: false }), // in irons, drifting astern
      sail(25, 90, { seconds: 15, crew: false, controls: { mainSheet: 1, jibSheet: 1, autoTrim: { main: false, jib: false, spinnaker: false } } }),
    ];
    for (const { sim } of cases) {
      const scene = new THREE.Scene();
      const boat = new THREE.Group();
      const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 5000);
      const ov = new Overlays(scene, boat, tierSettings('low'));
      for (const k of OVERLAY_KEYS) ov.set(k, true);
      ov.setMarks([{ id: 'W', e: 0, n: 200, kind: 'windward' }]);
      for (let i = 0; i < 90; i++) { sim.step(); sim.step(); ov.update(1 / 60, sim.snapshot(), camera); }
      const priv = ov as unknown as { flow: { fields: SliceField[]; trails: { data: Float32Array } }; slice: { field: SliceField } };
      for (const f of [...priv.flow.fields, priv.slice.field]) for (const v of f.data) expect(Number.isFinite(v)).toBe(true);
      for (const v of priv.flow.trails.data) expect(Number.isFinite(v)).toBe(true);
      ov.dispose();
    }
  });
});

describe('flow particles', () => {
  it('never cross the cloth (collision guard) and keep smoke rakes flowing', () => {
    const { snap } = sail(12, 45);
    const fp = new FlowParticles({ camera: null }, tierSettings('high'));
    for (const f of fp.fields) f.update(snap, true);
    const priv = fp as unknown as { x: Float32Array; y: Float32Array; h: Float32Array; alive: Uint8Array };
    const el = newSliceElement();
    let crossings = 0;
    let steps = 0;
    const px = new Float32Array(priv.x.length), py = new Float32Array(priv.y.length);
    for (let frame = 0; frame < 240; frame++) {
      px.set(priv.x); py.set(priv.y);
      const wasAlive = priv.alive.slice();
      fp.update(1 / 60, snap);
      for (let i = 0; i < px.length; i++) {
        if (!wasAlive[i] || !priv.alive[i]) continue;
        steps++;
        for (const sailState of [snap.sails.main, snap.sails.jib]) {
          if (!sailCutAt(sailState, priv.h[i]!, el)) continue;
          for (let k = 0; k < CAMBER_PTS - 1; k++) {
            const ax = el.pts[2 * k]!, ay = el.pts[2 * k + 1]!, bx = el.pts[2 * k + 2]!, by = el.pts[2 * k + 3]!;
            const d0 = (bx - ax) * (py[i]! - ay) - (by - ay) * (px[i]! - ax);
            const d1 = (bx - ax) * (priv.y[i]! - ay) - (by - ay) * (priv.x[i]! - ax);
            const e0 = (priv.x[i]! - px[i]!) * (ay - py[i]!) - (priv.y[i]! - py[i]!) * (ax - px[i]!);
            const e1 = (priv.x[i]! - px[i]!) * (by - py[i]!) - (priv.y[i]! - py[i]!) * (bx - px[i]!);
            if (d0 * d1 < 0 && e0 * e1 < 0) crossings++;
          }
        }
      }
    }
    let alive = 0;
    for (const a of priv.alive) alive += a;
    expect(steps).toBeGreaterThan(20000);
    expect(alive).toBeGreaterThan(200);
    // The guard works on 0.25 m height levels, the check on the exact height: allow a handful of grazing cases.
    expect(crossings / steps).toBeLessThan(2e-4);
  });
});

describe('Overlays', () => {
  it('runs every overlay against a real simulation, then disposes cleanly', () => {
    const { sim } = sail(12, 60, { gust: 0.5 });
    const scene = new THREE.Scene();
    const boat = new THREE.Group();
    scene.add(boat);
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
    camera.position.set(10, 8, 20);
    camera.lookAt(0, 4, 0);
    const before = scene.children.length + boat.children.length;
    const ov = new Overlays(scene, boat, tierSettings('high'));
    ov.setMarks([{ id: 'W', e: 0, n: 300, kind: 'windward' }, { id: 'L', e: 0, n: -100, kind: 'leeward' }]);
    for (const k of OVERLAY_KEYS) ov.set(k, true);
    ov.setSliceHeight(5);
    for (let i = 0; i < 180; i++) {
      for (let k = 0; k < 2; k++) sim.step();
      const s = sim.snapshot();
      boat.position.set(s.boat.pos.x, 0, -s.boat.pos.y);
      boat.rotation.set(0, -s.boat.heading, -s.boat.heel, 'YXZ');
      ov.update(1 / 60, s, camera);
    }
    expect(scene.children.length + boat.children.length).toBeGreaterThan(before);
    for (const k of OVERLAY_KEYS) ov.set(k, false);
    ov.update(1 / 60, sim.snapshot(), camera);
    ov.dispose();
    expect(boat.children.length).toBe(0);
    expect(scene.children.length + boat.children.length).toBe(before);
  });

  it('does not retrace the flow slice\'s streamlines while the camera rests on the edge of a spacing step', () => {
    const { sim } = sail(12, 60);
    const scene = new THREE.Scene();
    const boat = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
    camera.position.set(10, 8, 20);
    camera.lookAt(0, 4, 0);
    const ov = new Overlays(scene, boat, tierSettings('high'));
    ov.set('flowSlice', true);
    const s = sim.snapshot();
    for (let i = 0; i < 400; i++) ov.update(1 / 60, s, camera); // the field is built
    const slice = (ov as unknown as { slice: FlowSlice }).slice;
    const trace = vi.spyOn(slice as unknown as { startTrace(): void }, 'startTrace');
    const toWorld = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(y, -z, -x);
    // A view scale wobbling round 1.5 (the edge between two steps: 3 × 1.5 = 4.5 quarters).
    for (let i = 0; i < 120; i++) slice.update(1 / 60, 1 / 60, toWorld, 1.5 + 0.01 * Math.sin(i));
    expect(trace.mock.calls.length).toBeLessThanOrEqual(1);
    // A real change of distance still changes the spacing.
    trace.mockClear();
    slice.update(1 / 60, 1 / 60, toWorld, 2.5);
    expect(trace).toHaveBeenCalledTimes(1);
    ov.dispose();
  });

  // Timing: best-of-N already filters scheduler noise; the retry covers a machine that is busy for seconds.
  it('stays within the CPU budget with flow and slice on (median frame, node)', { retry: 2 }, () => {
    const { sim } = sail(12, 45);
    const scene = new THREE.Scene();
    const boat = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
    const ov = new Overlays(scene, boat, tierSettings('high'));
    for (const k of ['windTriangle', 'forces', 'flow', 'flowSlice'] as const) ov.set(k, true);
    const s = sim.snapshot();
    for (let i = 0; i < 60; i++) ov.update(1 / 60, s, camera); // settle (forced builds, JIT)
    const ms = bestMeanMs(() => { sim.step(); sim.step(); ov.update(1 / 60, sim.snapshot(), camera); }, 30, 6);
    // Includes two sim steps and a snapshot per frame; the browser measurement is in the report.
    expect(ms).toBeLessThan(perfBudget(2.5));
  });
});
