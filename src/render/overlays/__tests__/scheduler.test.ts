// The budgeted flow-slice scheduler: forced rebuilds (overlay toggles, slice moves, lessons re-applying their overlay
// state on every step) must never wedge it, and switching flow on must not rebuild every slice in one frame.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tierSettings } from '../../core/types';
import { perfBudget } from '../../../testing/perf';
import { Overlays } from '../Overlays';
import { FIELD_NY, type SliceField } from '../flowField';
import { sail } from './helpers';

interface Priv { job: SliceField | null; flow: { fields: SliceField[] } | null; slice: { field: SliceField } | null }

function rig(gust = 1) {
  const { sim } = sail(12, 45, { gust, seconds: 20 });
  const scene = new THREE.Scene();
  const boat = new THREE.Group();
  scene.add(boat);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
  camera.position.set(10, 8, 20);
  const ov = new Overlays(scene, boat, tierSettings('high'));
  const priv = ov as unknown as Priv;
  const frame = () => {
    sim.step(); sim.step();
    const s = sim.snapshot();
    boat.position.set(s.boat.pos.x, 0, -s.boat.pos.y);
    boat.rotation.set(0, -s.boat.heading, -s.boat.heel, 'YXZ');
    ov.update(1 / 60, s, camera);
    // The wedge: a job that is no longer building must never survive a frame.
    if (priv.job) expect(priv.job.building).toBe(true);
  };
  const fields = () => [...priv.flow!.fields, priv.slice!.field];
  return { sim, ov, priv, frame, fields };
}

describe('flow-slice scheduler', () => {
  it('keeps rebuilding when rebuilds are forced at every step of an in-flight job', () => {
    const { sim, ov, priv, frame, fields } = rig();
    ov.fieldBudgetMs = 0; // one scheduler step per frame: every job spans several frames, deterministically
    ov.set('flow', true);
    ov.set('flowSlice', true);
    for (let i = 0; i < 60; i++) frame();
    sim.controls.command = 'tack'; // the sails swing across: every slice keeps changing
    const steps = Math.ceil(FIELD_NY / 21); // ROW_BAND rows per work() step
    const triggers: Array<[string, () => void]> = [
      ['slice height', () => ov.setSliceHeight(priv.slice!.field.h > 5 ? 3.5 : 6)],
      ['slice off/on', () => { ov.set('flowSlice', false); ov.set('flowSlice', true); }],
      ['flow off/on', () => { ov.set('flow', false); ov.set('flow', true); }],
      ['lesson re-apply', () => { ov.set('flow', true); ov.set('flowSlice', true); }],
      // The original wedge: the in-flight field rebuilt to completion behind the scheduler's back.
      ['external rebuild', () => { priv.job?.update(sim.snapshot(), true); }],
    ];
    let hits = 0;
    for (const [, trigger] of triggers) {
      for (let phase = 0; phase < steps; phase++) {
        // Wait until a rebuild is in flight at this step, then force.
        for (let k = 0; k < 600 && !(priv.job && priv.job.buildPhase === phase); k++) frame();
        if (priv.job && priv.job.buildPhase === phase) hits++;
        trigger();
        frame();
      }
    }
    expect(hits).toBeGreaterThan(triggers.length * steps / 2);
    // Afterwards every slice must keep refreshing while the boat keeps changing.
    sim.controls.command = 'tack';
    const before = fields().map((f) => f.version);
    for (let i = 0; i < 480; i++) frame();
    const after = fields().map((f) => f.version);
    after.forEach((v, i) => expect(v).toBeGreaterThan(before[i]! + 1));
  });

  // Timing part: best of 8 fresh overlays plus a retry for a machine that is busy for seconds; the "never more
  // slices in a frame than the scheduler may start" check below is the real regression guard.
  it('switching flow on spreads the slice rebuilds over frames, and re-applying it costs nothing', { retry: 2 }, () => {
    // Warm the JIT on a throwaway instance so the first measured frame is not compilation.
    const warm = rig();
    warm.ov.set('flow', true);
    warm.ov.set('flowSlice', true);
    for (let i = 0; i < 120; i++) warm.frame();

    // The frame right after switching on (where six synchronous rebuilds used to land): best of eight fresh overlays,
    // so a garbage-collection pause in the parallel suite cannot fail it.
    const firstFrame: number[] = [];
    for (let r = 0; r < 8; r++) {
      const fresh = rig();
      fresh.ov.set('flow', true);
      fresh.ov.set('flowSlice', true);
      const t0 = performance.now();
      fresh.frame();
      firstFrame.push(performance.now() - t0);
    }
    expect(Math.min(...firstFrame)).toBeLessThan(perfBudget(1.5)); // includes two sim steps and a snapshot

    // No frame publishes more slices than the scheduler may start in one (three, and only while they fit its time
    // budget: a fast machine fits three, a busy one fewer). It was all six at once. All are there within 40 frames.
    const { ov, frame, fields } = rig();
    ov.set('flow', true);
    ov.set('flowSlice', true);
    let maxPublished = 0;
    for (let i = 0; i < 40; i++) {
      const v0 = fields().map((f) => f.version);
      frame();
      maxPublished = Math.max(maxPublished, fields().filter((f, k) => f.version !== v0[k]).length);
    }
    expect(fields().every((f) => f.version > 0)).toBe(true);
    expect(maxPublished).toBeLessThanOrEqual(3);

    // A lesson step re-applies the same overlay state: no forced rebuilds follow.
    const priv = ov as unknown as { forced: Set<SliceField> };
    ov.set('flow', true);
    ov.set('flowSlice', true);
    ov.setSliceHeight(4.5);
    expect(priv.forced.size).toBe(0);
  });
});
