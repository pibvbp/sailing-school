// The physics overlays (spec §8): what makes the wind's work on the boat visible. One object owns them all:
//
//   const overlays = new Overlays(scene, boatRoot, quality);
//   overlays.set('forces', true);
//   overlays.update(dt, snapshot, camera);   // every frame, before rendering (also while all overlays are off)
//
// Keys owned here: windTriangle, forces, wheel, flow, flowSlice, labels, laylines, track. 'aoa' (sails module), 'xray'
// (ocean module) and 'telltaleCam' (app) are accepted and ignored — except that x-ray brightens the underwater forces.
// Boat-relative overlays hang under `boatRoot` (boat-local frame: X stbd, Y up, Z aft), world overlays under `scene`.
// Every mesh draws only for the camera passed to `update` (not reflection or picture-in-picture cameras).
import * as THREE from 'three';
import type { QualitySettings } from '../core/types';
import type { MarkSpec, OverlayKey } from '../../lessons/types';
import type { SimSnapshot } from '../../sim/types';
import { ArrowBatch } from './arrows';
import { FlowParticles, WindParticles } from './flowParticles';
import { FlowSlice } from './flowSlice';
import { ForceOverlay } from './forces';
import { BoatFrame } from './frames';
import { LabelLayer } from './labels';
import { Laylines, type Mark } from './laylines';
import { LineBatch } from './lines';
import { OVERLAY_LAYER, type OverlayContext } from './overlayMaterial';
import { PartLabels } from './partLabels';
import { TrackTrail } from './track';
import { PointsOfSailWheel } from './wheel';
import { WindTriangle } from './windTriangle';
import type { SliceField } from './flowField';

/** Teaching overlays are drawn over the world, never mirrored in the sea (see PlanarReflection). */
const noReflect = <T extends THREE.Object3D>(o: T): T => { o.userData['noReflect'] = true; return o; };

type OwnKey = 'windTriangle' | 'forces' | 'wheel' | 'flow' | 'flowSlice' | 'labels' | 'laylines' | 'track';
const OWN: readonly OwnKey[] = ['windTriangle', 'forces', 'wheel', 'flow', 'flowSlice', 'labels', 'laylines', 'track'];

/** How often (simulated seconds) each flow slice is checked for a rebuild. */
const PARTICLE_FIELD_PERIOD = 1 / 6;
const VIEW_FIELD_PERIOD = 1 / 10;
/** CPU spent on slice rebuilds per frame (ms); a started step always completes, so the worst case is this + one step. */
const FIELD_BUDGET_MS = 0.3;
/** Slices checked or started per frame at most (a check that finds nothing changed costs a few µs). */
const MAX_STARTS = 3;
/** Air-flow seconds shown when flow is switched on while the simulation is paused (then the picture freezes). */
const DEVELOP_S = 0.8;

export class Overlays {
  private readonly ctx: OverlayContext = { camera: null };
  private readonly frame = new BoatFrame();
  private readonly labels: LabelLayer;
  private readonly on = new Map<OverlayKey, boolean>();
  private readonly arrows: ArrowBatch;
  private readonly forceLines: LineBatch;
  private readonly boatWorld = new THREE.Vector3();
  private readonly track = new TrackTrail();
  private readonly toWorld = (x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 => this.frame.point(x, y, z, out);

  private wind: WindTriangle | null = null;
  private forces: ForceOverlay | null = null;
  private wheel: PointsOfSailWheel | null = null;
  private flow: FlowParticles | null = null;
  private windParticles: WindParticles | null = null;
  private slice: FlowSlice | null = null;
  private parts: PartLabels | null = null;
  private laylines: Laylines | null = null;
  private laylineLines: LineBatch | null = null;
  private trackLines: LineBatch | null = null;
  private marks: Mark[] = [];
  private sliceHeight = 4.5;
  /** CPU budget (ms) for flow-slice rebuilds per frame; 0 = exactly one step per frame. */
  fieldBudgetMs = FIELD_BUDGET_MS;
  private readonly nextCheck = new Map<SliceField, number>();
  /** Slices that must be rebuilt regardless of change detection (just switched on, or moved). */
  private readonly forced = new Set<SliceField>();
  /** The slice rebuild in progress. */
  private job: SliceField | null = null;
  // The air's own clock: follows simulated time (slow motion, pause) but advances smoothly every frame.
  private simT = NaN;
  private flowRate = 1;
  private flowClock = 0;
  private flowAge = 0;

  constructor(private readonly scene: THREE.Scene, private readonly boatRoot: THREE.Object3D, private q: QualitySettings) {
    this.labels = new LabelLayer();
    this.arrows = new ArrowBatch(this.ctx, 48);
    this.forceLines = new LineBatch(this.ctx, 64, { renderOrder: 19, hiddenAlpha: 0.3 });
    this.scene.add(noReflect(this.arrows.group), noReflect(this.forceLines.group));
  }

  /**
   * Switch an overlay. Only a real off→on or on→off change does anything: lessons re-apply every key on every step,
   * and re-applying the current state must cost nothing.
   */
  set(k: OverlayKey, on: boolean): void {
    const was = this.on.get(k) === true;
    this.on.set(k, on);
    if (was === on || !(OWN as readonly string[]).includes(k)) return;
    const key = k as OwnKey;
    if (on) this.ensure(key);
    switch (key) {
      case 'windTriangle': if (!on) this.wind?.hide(); break;
      case 'forces': if (!on) this.forces?.hide(); break;
      case 'wheel':
        if (this.wheel) this.wheel.mesh.visible = on;
        if (!on) this.wheel?.hide();
        break;
      case 'flow':
        this.flow?.setVisible(on);
        this.windParticles?.setVisible(on);
        if (on && this.flow) for (const f of this.flow.fields) this.forced.add(f);
        if (on) this.flowAge = 0;
        break;
      case 'flowSlice':
        if (this.slice) { this.slice.group.visible = on; if (on) this.forced.add(this.slice.field); else this.slice.hide(); }
        break;
      case 'labels': if (!on) this.parts?.hide(); break;
      case 'laylines':
        if (this.laylineLines) this.laylineLines.group.visible = on;
        if (!on) this.laylines?.hide();
        break;
      case 'track': if (this.trackLines) this.trackLines.group.visible = on; break;
    }
  }

  isOn(k: OverlayKey): boolean {
    return this.on.get(k) === true;
  }

  /** Height of the flow slice (m above the waterline), clamped to the rig. Re-applying the same height is free. */
  setSliceHeight(h: number): void {
    if (h === this.sliceHeight) return;
    this.sliceHeight = h;
    if (this.slice) {
      this.slice.setHeight(h);
      this.forced.add(this.slice.field);
    }
  }

  /**
   * Follow a quality-tier change (spec §9.2): particle counts scale with `q.particleScale`. The particle systems are
   * rebuilt only when that factor changes; the flow slices they read are kept.
   */
  setQuality(q: QualitySettings): void {
    const rebuild = q.particleScale !== this.q.particleScale;
    this.q = q;
    if (!rebuild || !this.flow || !this.windParticles) return;
    const fields = this.flow.fields;
    const visible = this.isOn('flow');
    for (const old of [this.flow, this.windParticles] as const) { old.trails.group.removeFromParent(); old.dispose(); }
    this.flow = new FlowParticles(this.ctx, q, fields);
    this.windParticles = new WindParticles(this.ctx, q);
    this.boatRoot.add(noReflect(this.flow.trails.group));
    this.scene.add(noReflect(this.windParticles.trails.group));
    this.flow.setVisible(visible);
    this.windParticles.setVisible(visible);
  }

  /** Race marks for the laylines (the app forwards `AppApi.setMarks` here); copied, so the caller may reuse its array. */
  setMarks(marks: readonly MarkSpec[]): void {
    this.marks = marks.map((m) => ({ ...m }));
    this.laylines?.setMarks(this.marks);
  }

  /**
   * Per frame, before rendering. `dt` is the real (wall-clock) frame time: fades, scale smoothing and labels use it.
   * The air (particles, trail pushes, rake releases, streamline pulses) runs on its own clock derived from the
   * snapshot's simulated time, so slow motion slows the flow with the boat and pause freezes it — except that flow
   * switched on while paused first develops for DEVELOP_S seconds so there is a picture to study.
   */
  update(dt: number, s: SimSnapshot, camera: THREE.Camera): void {
    this.ctx.camera = camera;
    camera.layers.enable(OVERLAY_LAYER);
    camera.updateMatrixWorld();
    const flowDt = this.flowStep(dt, s);
    this.frame.update(this.boatRoot);
    this.boatWorld.set(s.boat.pos.x, 0, -s.boat.pos.y);
    this.track.record(s);

    this.arrows.begin();
    this.forceLines.begin();
    if (this.isOn('windTriangle') && this.wind) this.wind.update(dt, s, this.frame);
    if (this.isOn('forces') && this.forces) this.forces.update(dt, s, this.frame, this.isOn('xray'));
    if (this.isOn('wheel') && this.wheel) this.wheel.update(dt, s, this.boatWorld);
    this.arrows.end();
    this.forceLines.end();

    if (this.isOn('laylines') && this.laylines && this.laylineLines) {
      this.laylineLines.begin();
      this.laylines.update(dt, s, this.boatWorld);
      this.laylineLines.end();
    }
    if (this.isOn('track') && this.trackLines) this.track.draw(this.trackLines, s);
    if (this.isOn('labels') && this.parts) this.parts.update(s, this.frame);

    const flowOn = this.isOn('flow') && this.flow !== null;
    const sliceOn = this.isOn('flowSlice') && this.slice !== null;
    if (flowOn || sliceOn) this.scheduleFields(s, flowOn, sliceOn);
    if (flowOn) {
      this.flow!.update(flowDt, s);
      this.windParticles!.update(flowDt, s);
    }
    if (sliceOn) this.slice!.update(dt, flowDt, this.toWorld);

    this.labels.frame(camera);
  }

  dispose(): void {
    this.arrows.dispose();
    this.forceLines.dispose();
    this.wheel?.dispose();
    this.flow?.dispose();
    this.windParticles?.dispose();
    this.slice?.dispose();
    this.laylineLines?.dispose();
    this.trackLines?.dispose();
    for (const o of [this.arrows.group, this.forceLines.group, this.wheel?.mesh, this.flow?.trails.group, this.windParticles?.trails.group,
      this.slice?.group, this.laylineLines?.group, this.trackLines?.group]) o?.removeFromParent();
    this.labels.dispose();
  }

  /** Create an overlay's objects the first time it is switched on. */
  private ensure(k: OwnKey): void {
    switch (k) {
      case 'windTriangle': this.wind ??= new WindTriangle(this.arrows, this.labels); break;
      case 'forces': this.forces ??= new ForceOverlay(this.arrows, this.forceLines, this.labels); break;
      case 'wheel':
        if (!this.wheel) { this.wheel = new PointsOfSailWheel(this.ctx, this.arrows, this.labels); this.scene.add(noReflect(this.wheel.mesh)); }
        break;
      case 'flow':
        if (!this.flow) {
          this.flow = new FlowParticles(this.ctx, this.q);
          this.windParticles = new WindParticles(this.ctx, this.q);
          this.boatRoot.add(noReflect(this.flow.trails.group));
          this.scene.add(noReflect(this.windParticles.trails.group));
        }
        break;
      case 'flowSlice':
        if (!this.slice) { this.slice = new FlowSlice(this.ctx, this.labels, this.sliceHeight); this.boatRoot.add(noReflect(this.slice.group)); }
        break;
      case 'labels': this.parts ??= new PartLabels(this.labels); break;
      case 'laylines':
        if (!this.laylines) {
          this.laylineLines = new LineBatch(this.ctx, 64, { depthBiasK: 0.06, depthBiasC: 0.8, renderOrder: 8 });
          this.laylines = new Laylines(this.laylineLines, this.labels);
          this.laylines.setMarks(this.marks);
          this.scene.add(noReflect(this.laylineLines.group));
        }
        break;
      case 'track':
        if (!this.trackLines) {
          this.trackLines = new LineBatch(this.ctx, 800, { depthBiasK: 0.06, depthBiasC: 0.8, renderOrder: 7 });
          this.scene.add(noReflect(this.trackLines.group));
        }
        break;
    }
  }

  /** Seconds of air flow for this frame (see `update`). */
  private flowStep(dt: number, s: SimSnapshot): number {
    let step = 0;
    if (!(s.t >= this.simT) || s.t - this.simT > 1) {
      // First frame, a reset or a jump: restart the clock.
      this.flowClock = s.t;
    } else {
      const ds = s.t - this.simT;
      // Sim steps arrive in whole 1/120 s steps (every other frame at 0.25×): track the rate, not the steps.
      if (dt > 0) this.flowRate += (ds / dt - this.flowRate) * Math.min(1, dt / 0.25);
      let next = this.flowClock + Math.max(0, dt * this.flowRate);
      next += (s.t - next) * Math.min(1, dt / 0.5); // stay locked to simulated time
      if (s.t - next > 0.5) next = this.flowClock = s.t; // far behind (frames without dt): a jump, not fast motion
      next = Math.min(next, s.t + 0.02);
      step = Math.min(Math.max(0, next - this.flowClock), 0.1);
      this.flowClock = Math.max(this.flowClock, next);
    }
    this.simT = s.t;
    if (step === 0 && this.flowAge < DEVELOP_S) step = Math.min(dt, 1 / 30); // paused: let a fresh picture develop
    this.flowAge += step;
    return step;
  }

  /**
   * Keep the flow slices fresh within a per-frame CPU budget. The rebuild in progress advances step by step (solve +
   * grid fills, then bands of rows into a back buffer, so readers always see a complete field); when it is done the
   * next slice starts — forced ones first (just switched on or moved), then the most overdue — while budget remains.
   * A slice whose inputs have not changed is checked and skipped for a few µs. Nothing here ever runs a whole rebuild
   * synchronously, and a job that was restarted, finished or switched off elsewhere is dropped, never waited on.
   */
  private scheduleFields(s: SimSnapshot, flowOn: boolean, sliceOn: boolean): void {
    const j = this.job;
    if (j && (!j.building || !this.active(j, flowOn, sliceOn) || this.forced.has(j))) this.job = null;
    const t0 = performance.now();
    let starts = 0;
    for (;;) {
      if (this.job) {
        if (this.job.work()) this.job = null;
      } else {
        if (starts >= MAX_STARTS) break;
        const f = this.nextField(s, flowOn, sliceOn);
        if (!f) break;
        starts++;
        const force = this.forced.delete(f);
        this.nextCheck.set(f, s.t + (f === this.slice?.field ? VIEW_FIELD_PERIOD : PARTICLE_FIELD_PERIOD));
        if (f.begin(s, force)) this.job = f;
      }
      if (performance.now() - t0 >= this.fieldBudgetMs) break;
    }
  }

  private active(f: SliceField, flowOn: boolean, sliceOn: boolean): boolean {
    return (sliceOn && f === this.slice?.field) || (flowOn && this.flow!.fields.includes(f));
  }

  /** A forced slice (the view slice first), else the due slice that is most overdue, else null. */
  private nextField(s: SimSnapshot, flowOn: boolean, sliceOn: boolean): SliceField | null {
    if (sliceOn && this.forced.has(this.slice!.field)) return this.slice!.field;
    const nFlow = flowOn ? this.flow!.fields.length : 0;
    for (let i = 0; i < nFlow; i++) if (this.forced.has(this.flow!.fields[i]!)) return this.flow!.fields[i]!;
    let best: SliceField | null = null;
    let bestLate = 0;
    for (let i = 0; i <= nFlow; i++) {
      const f = i < nFlow ? this.flow!.fields[i]! : sliceOn ? this.slice!.field : null;
      if (!f) continue;
      let due = this.nextCheck.get(f) ?? -Infinity;
      if (s.t < due - 5) { due = -Infinity; this.nextCheck.set(f, due); } // the simulation clock went back (reset)
      const late = s.t - due;
      if (late >= 0 && (best === null || late >= bestLate)) { best = f; bestLate = late; }
    }
    return best;
  }
}
