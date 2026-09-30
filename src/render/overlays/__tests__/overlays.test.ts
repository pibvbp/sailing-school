// End-to-end and unit checks for the overlay modules that do not need a GPU.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEG } from '../../../shared/math';
import { OVERLAY_KEYS } from '../../../lessons/types';
import { tierSettings } from '../../core/types';
import { Overlays } from '../Overlays';
import { FlowParticles } from '../flowParticles';
import { CAMBER_PTS, newSliceElement, sailCutAt } from '../flowField';
import { laylineBearings } from '../laylines';
import { DISPLAY_CAP, agxForward, agxInverse } from '../overlayMaterial';
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
