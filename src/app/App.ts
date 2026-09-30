// The application (plan Task 16): owns the renderer, the scene modules, the simulation and the UI, and
// implements the AppApi that the HUD, keyboard and lessons drive.
import * as THREE from 'three';
import { createRenderer, pixelRatioFor } from '../render/core/renderer';
import { PostChain } from '../render/core/post';
import { QualityGovernor } from '../render/core/quality';
import { FrameTimer } from '../render/core/frameTimer';
import type { QualitySettings, QualityTier } from '../render/core/types';
import { SkySystem } from '../render/env/sky';
import { Lighting } from '../render/env/lighting';
import { Land } from '../render/env/land';
import { Marks } from '../render/env/marks';
import { Ocean } from '../render/env/ocean/ocean';
import { BoatModel } from '../render/boat/BoatModel';
import { SailsView } from '../render/sails/SailsView';
import { CameraRig } from '../render/cameras/CameraRig';
import { Overlays } from '../render/overlays/Overlays';
import { Simulation } from '../sim/simulation';
import { AutoCrew } from '../sim/autocrew';
import { targetSpeed, type PolarTable } from '../sim/polarTable';
import polars from '../sim/data/polars.json';
import type { Controls, ScenarioInit, SimSnapshot, WindSettings } from '../sim/types';
import { Hud } from '../ui/Hud';
import { InputController } from '../ui/input';
import { LessonRunner } from '../lessons/engine';
import { OVERLAY_KEYS, type AppApi, type AppMode, type CameraKey, type Lesson, type MarkSpec, type OverlayKey } from '../lessons/types';
import { FixedStepLoop } from './loop';
import { LabPanel, LAB_DEFAULTS, twaForAwa, type LabParams } from './labPanel';
import { TelltaleCam } from './telltaleCam';
import { Soundscape } from '../audio/Soundscape';
import { cameraYawFromBasis } from '../audio/mapping';
import { DEG, KN, wrapPi } from '../shared/math';
import { BOAT } from '../shared/boatSpec';

declare global {
  interface Window {
    __ready?: boolean;
    __app?: App;
    /** Same shape as the demo kit's, so `scripts/snap.mjs --perf` reads both. */
    __stats?: { frameMs: number; fps: number; calls: number; triangles: number };
    __appInfo?: { tier: string; speedKn: number; heelDeg: number };
  }
}

const POLAR = polars as PolarTable;

/** Free-sail start: 12 kn south-westerly with some gusts, close reach on starboard, crew trimming. */
export function freeSailScenario(): ScenarioInit {
  return {
    wind: { tws: 12 * KN, twd: 225 * DEG, gustiness: 0.4, shiftAmplitude: 6 * DEG, shiftPeriod: 180, seed: 7 },
    boat: { psi: 165 * DEG, u: 2.6 },
    controls: { helmMode: 'manual' },
  };
}

/** Sail lab: the boat is towed at a steady speed while sails, forces and flow keep computing. */
export function labScenario(): ScenarioInit {
  return {
    wind: { tws: 12 * KN, twd: 90 * DEG, gustiness: 0, shiftAmplitude: 0, shiftPeriod: 120, seed: 3 },
    boat: { psi: 0, u: 2.5 },
    controls: { helmMode: 'manual', autoTrim: { main: false, jib: false, spinnaker: false } },
    towed: { speed: 2.5 },
  };
}

interface SpringState { x: number; v: number }
const spring = (s: SpringState, target: number, dt: number, omega: number): number => {
  // Critically damped follower (semi-implicit, stable for any dt).
  const a = omega * omega * (target - s.x) - 2 * omega * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
  return s.x;
};

export interface AppOptions { lessons?: Lesson[] }

export class App implements AppApi {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 40000);
  sim: Simulation;
  private readonly governor = new QualityGovernor('high');
  /** Real frame cost (GPU timer query where available, else CPU busy time) for the governor's step-up. */
  private readonly frameTimer: FrameTimer;
  private quality: QualitySettings;
  private qualityLock: QualityTier | 'auto' = 'auto';
  private readonly sky: SkySystem;
  private readonly lighting: Lighting;
  private readonly land: Land;
  private readonly marks: Marks;
  private readonly ocean: Ocean;
  private readonly boatRoot = new THREE.Group();
  private readonly boat: BoatModel;
  private readonly sails: SailsView;
  private readonly post: PostChain;
  private readonly rig: CameraRig;
  private readonly tcam: TelltaleCam;
  /** Teaching overlays (vectors, airflow, slice, wheel, labels, laylines, track). */
  private readonly ov: Overlays;
  private readonly soundscape = new Soundscape();
  private readonly camDir = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();
  /** Jib luff telltales at 25 and 50 % height (port/stbd): the pairs a helmsman watches. */
  private readonly jibTelltales: THREE.Object3D[];
  private readonly loop: FixedStepLoop;
  private readonly hud: Hud;
  private readonly input: InputController;
  private readonly runner: LessonRunner;
  private mode: AppMode = 'lessons';
  private paused = false;
  private timeScale = 1;
  private hour = 17;
  private sound = true;
  private overlayState: Record<OverlayKey, boolean>;
  private last = 0;
  private frames = 0;
  private frameMsAvg = 16.7;
  private readonly heave: SpringState = { x: 0, v: 0 };
  private readonly pitch: SpringState = { x: 0, v: 0 };
  private readonly roll: SpringState = { x: 0, v: 0 };
  private markIds: string[] = [];
  private lab: LabPanel | null = null;
  private labParams: LabParams = { ...LAB_DEFAULTS };
  /** Boat pose before the last physics step; rendering interpolates from it by the loop's alpha. */
  private readonly prevPose = { e: 0, n: 0, psi: 0, phi: 0 };
  private readonly pose = { e: 0, n: 0, psi: 0, phi: 0 };
  private readonly frameMatrix = new THREE.Matrix4();
  private readonly boatPos = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, opts: AppOptions = {}) {
    this.renderer = createRenderer(canvas);
    // The post chain renders several passes per frame; count the whole frame, not just the last pass.
    this.renderer.info.autoReset = false;
    this.frameTimer = new FrameTimer(this.renderer);
    this.quality = this.governor.settings;
    this.renderer.setPixelRatio(pixelRatioFor(this.quality));

    this.sky = new SkySystem(this.renderer, this.scene, this.quality, { hours: this.hour, cloudCover: 0.35 });
    this.lighting = new Lighting(this.scene, this.sky, this.quality);
    this.land = new Land(this.scene, this.sky);
    this.marks = new Marks(this.scene);
    this.ocean = new Ocean(this.renderer, this.scene, this.sky, this.quality);
    // Only the main view gets the planar reflection (the telltale cam would render it a second time).
    this.ocean.reflectFor = this.camera;

    this.boatRoot.name = 'boatRoot';
    this.boatRoot.rotation.order = 'YXZ';
    this.scene.add(this.boatRoot);
    this.boat = new BoatModel(this.quality);
    this.sails = new SailsView(this.quality);
    this.boatRoot.add(this.boat.root, this.sails.root);
    this.jibTelltales = this.sails.telltaleAnchors.slice(0, 4);
    this.lighting.follow(this.boatRoot);
    this.ov = new Overlays(this.scene, this.boatRoot, this.quality);

    this.post = new PostChain(this.renderer, this.scene, this.camera, this.quality);
    this.rig = new CameraRig(this.camera, canvas);
    this.tcam = new TelltaleCam(this.renderer);
    // Browsers only start audio from a user gesture; the first click or key press arms it.
    this.soundscape.startOnFirstGesture();

    this.sim = this.makeSim(freeSailScenario());
    this.loop = new FixedStepLoop((dt) => {
      const b = this.sim.boat;
      this.prevPose.e = b.e; this.prevPose.n = b.n; this.prevPose.psi = b.psi; this.prevPose.phi = b.phi;
      this.sim.step(dt);
    });
    this.syncPrevPose();
    this.overlayState = Object.fromEntries(OVERLAY_KEYS.map((k) => [k, false])) as Record<OverlayKey, boolean>;
    this.applyOceanParams();

    this.hud = new Hud(uiRoot, this);
    this.input = new InputController(this, window);
    this.hud.attachInput(this.input);
    this.runner = new LessonRunner(opts.lessons ?? [], this, this.hud.lessonPanel);
    this.hud.setControlFilter((k) => this.runner.isLive(k));
    // Toasts about sim events link to the lesson that explains them.
    this.hud.setEventLessons({
      crashGybe: 'gybing', gybeComplete: 'gybing', tackComplete: 'tacking', inIrons: 'out-of-irons',
      luffing: 'jib-telltales', backwinded: 'main-and-jib', roundUp: 'keel-and-balance',
      spinCollapse: 'spinnaker-reaching-running', spinRefill: 'spinnaker-basics',
    });
    this.hud.setPolar({ speed: (tws, twa) => targetSpeed(POLAR, tws / KN, Math.abs(twa) / DEG) * KN });
    this.hud.syncState({ mode: this.mode, camera: this.rig.mode, hour: this.hour, wind: { ...this.sim.wind.settings }, quality: 'auto' });

    addEventListener('resize', this.resize);
    this.resize();
    window.__app = this;
  }

  start(): void {
    this.last = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  // ---------------------------------------------------------------------------------------------- AppApi
  get controls(): Controls { return this.sim.controls; }

  setMode(m: AppMode): void {
    this.mode = m;
    if (m === 'free') this.scenario(freeSailScenario());
    if (m === 'lab') {
      this.scenario(labScenario());
      this.applyLab(this.labParams);
    }
    this.placeCourse(m === 'free');
    if (m === 'lab') {
      this.lab ??= new LabPanel(this.labParams, (p) => this.applyLab(p));
      this.lab.sync(this.labParams);
      this.hud.setModePanel(this.lab.el);
    } else {
      this.hud.setModePanel(null);
    }
    this.hud.syncState({ mode: m });
  }

  setCamera(c: CameraKey): void {
    this.rig.setMode(c);
    this.hud.syncState({ camera: c });
  }

  setOverlay(k: OverlayKey, on: boolean): void {
    this.overlayState[k] = on;
    this.ov.set(k, on);
    if (k === 'aoa') this.sails.setColouring(on ? 'aoa' : 'none');
    if (k === 'xray') this.ocean.setXray(on);
  }

  overlays(): Record<OverlayKey, boolean> { return { ...this.overlayState }; }

  setWind(p: Partial<WindSettings>): void {
    this.sim.setWind(p);
    this.applyOceanParams();
    this.hud.syncState({ wind: { ...this.sim.wind.settings } });
  }

  setTimeOfDay(h: number): void {
    this.hour = h;
    this.sky.setTimeOfDay(h);
    this.hud.syncState({ hour: h });
  }

  setTimeScale(s: number): void {
    this.timeScale = s;
    this.hud.syncState({ timeScale: s });
  }

  togglePause(): void {
    this.paused = !this.paused;
    this.hud.syncState({ paused: this.paused });
  }

  setQuality(t: QualityTier | 'auto'): void {
    this.qualityLock = t;
    this.governor.lock(t === 'auto' ? null : t);
    this.applyQuality(this.governor.settings);
    this.hud.syncState({ quality: t });
  }

  setSound(on: boolean): void {
    this.sound = on;
    this.soundscape.setEnabled(on);
    this.hud.syncState({ sound: on });
  }

  scenario(init: ScenarioInit): void {
    this.sim = this.makeSim(init);
    this.loop.reset();
    this.syncPrevPose();
    this.heave.x = this.heave.v = this.pitch.x = this.pitch.v = this.roll.x = this.roll.v = 0;
    this.applyOceanParams();
    this.hud.syncState({ wind: { ...this.sim.wind.settings } });
  }

  startLesson(id: string): void {
    this.mode = 'lessons';
    this.hud.syncState({ mode: 'lessons' });
    this.runner.start(id);
  }

  setMarks(marks: readonly MarkSpec[]): void {
    for (const id of this.markIds) this.marks.remove(id);
    this.markIds = marks.map((m) => m.id);
    for (const m of marks) this.marks.add(m.id, m.e, m.n, m.kind);
    this.ov.setMarks(marks);
  }

  setSliceHeight(h: number): void { this.ov.setSliceHeight(h); }

  /** Lesson ids in catalogue order (used by the e2e smoke test). */
  lessonIds(): string[] { return Object.keys(this.runner.progress()); }

  // ---------------------------------------------------------------------------------------------- internals
  private syncPrevPose(): void {
    const b = this.sim.boat;
    this.prevPose.e = b.e; this.prevPose.n = b.n; this.prevPose.psi = b.psi; this.prevPose.phi = b.phi;
  }

  private makeSim(init: ScenarioInit): Simulation {
    const sim = new Simulation(init);
    sim.crew = new AutoCrew();
    return sim;
  }

  /** Sail lab: turn the wind so the towed boat sees the wanted apparent wind angle. */
  private applyLab(p: LabParams): void {
    this.labParams = p;
    const twa = twaForAwa(p.awa, p.tow, p.tws);
    const twd = wrapPi(this.sim.boat.psi + twa);
    this.sim.setTowed({ speed: p.tow });
    this.setWind({ tws: p.tws, twd: twd < 0 ? twd + 2 * Math.PI : twd });
  }

  /** Free sail: a windward–leeward course laid from where the boat starts, square to the wind. */
  private placeCourse(on: boolean): void {
    if (!on) {
      this.setMarks([]);
      return;
    }
    const b = this.sim.boat;
    const w = this.sim.wind.settings.twd;
    const up = { e: Math.sin(w), n: Math.cos(w) };      // unit vector toward the wind
    const across = { e: up.n, n: -up.e };              // square to the wind, to the right looking upwind
    const at = (id: string, along: number, side: number, kind: MarkSpec['kind']): MarkSpec =>
      ({ id, e: b.e + up.e * along + across.e * side, n: b.n + up.n * along + across.n * side, kind });
    this.setMarks([
      at('start-pin', 60, -90, 'start'),
      at('start-boat', 60, 90, 'start'),
      at('windward', 900, 0, 'windward'),
      at('gate-left', -250, -45, 'leeward'),
      at('gate-right', -250, 45, 'leeward'),
    ]);
  }

  private applyOceanParams(): void {
    const w = this.sim.wind.settings;
    this.ocean.setParams({
      windSpeed: w.tws,
      windFrom: w.twd,
      fetchKm: 15,
      swellHeight: 0.3,
      swellFrom: w.twd + 30 * DEG,
      swellPeriod: 9,
      choppiness: 1,
    });
  }

  private applyQuality(q: QualitySettings): void {
    this.quality = q;
    this.renderer.setPixelRatio(pixelRatioFor(q));
    this.post.setQuality(q);
    this.lighting.setQuality(q);
    this.ocean.setQuality(q);
    this.ov.setQuality(q);
    this.resize();
    this.hud.syncState({ qualityActual: this.qualityLock === 'auto' ? q.tier : null });
  }

  private readonly resize = (): void => {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  /** Sea height under the hull → heave/pitch/roll that ride on top of the simulated heel. */
  private updateBoatPose(dt: number, alpha: number, t: number): void {
    // Interpolate between the last two physics states so motion is smooth at any display rate.
    const cur = this.sim.boat, prev = this.prevPose, b = this.pose;
    b.e = prev.e + (cur.e - prev.e) * alpha;
    b.n = prev.n + (cur.n - prev.n) * alpha;
    b.psi = prev.psi + wrapPi(cur.psi - prev.psi) * alpha;
    b.phi = prev.phi + (cur.phi - prev.phi) * alpha;
    const sin = Math.sin(b.psi), cos = Math.cos(b.psi);
    const at = (x: number, y: number) => {
      const e = b.e + x * sin + y * cos;
      const n = b.n + x * cos - y * sin;
      return this.ocean.sampler.heightAt(e, n, t);
    };
    const bow = at(2.8, 0), stern = at(-2.8, 0), port = at(0, -1.0), stbd = at(0, 1.0), mid = at(0, 0);
    const heave = spring(this.heave, (bow + stern + port + stbd + 2 * mid) / 6, dt, 3.2);
    const pitch = spring(this.pitch, Math.atan2(bow - stern, 5.6) * 0.8, dt, 2.6);
    const roll = spring(this.roll, Math.atan2(port - stbd, 2.0) * 0.6, dt, 2.2);
    this.boatRoot.position.set(b.e, heave, -b.n);
    this.boatRoot.rotation.set(pitch, -b.psi, -(b.phi + roll), 'YXZ');
  }

  private readonly frame = (now: number): void => {
    this.frameTimer.begin();
    // The governor sees the raw frame time (it ignores hidden-tab gaps itself); the sim gets a clamped dt.
    const rawMs = Math.max(0, now - this.last);
    const dt = Math.min(0.1, rawMs / 1000);
    this.last = now;
    const t = now / 1000;
    this.renderer.info.reset();

    this.input.update(dt);
    const scale = this.paused ? 0 : this.timeScale;
    const { alpha } = this.loop.advance(dt, scale);
    const snap = this.sim.snapshot();

    this.updateBoatPose(dt, alpha, snap.t);
    const sails = snap.sails;
    this.boat.setPose({
      boomAngle: sails.main.boomAngle,
      rudder: snap.boat.rudder,
      jibClew: sails.jib.clew,
      jibFurl: sails.jib.furl,
      spin: {
        visible: sails.spinnaker.set,
        poleAngle: sails.spinnaker.poleAngle,
        poleTipH: sails.spinnaker.poleHeight,
        tack: sails.spinnaker.tack,
        clew: sails.spinnaker.clew,
      },
      crewY: snap.boat.crewHike,
      heel: snap.boat.heel,
      sheets: { main: this.controls.mainSheet, jib: this.controls.jibSheet, spin: this.controls.spinSheet },
    });
    this.boat.update(dt * scale);
    this.sails.update(dt * scale, snap.t, sails, { awa: snap.wind.awa, aws: snap.wind.aws, awaDeck: snap.wind.awaDeck, awsDeck: snap.wind.awsDeck });

    this.ocean.setBoat({ e: snap.boat.pos.x, n: snap.boat.pos.y, heading: snap.boat.heading, speed: snap.boat.speed, heel: snap.boat.heel });
    this.ocean.setPuffs(snap.wind.puffs.map((p) => ({
      e: p.e, n: p.n, radiusAlong: p.radiusAlong, radiusAcross: p.radiusAcross,
      strength: p.strength * p.envelope, windFrom: snap.wind.twd + p.dirOffset,
    })));
    this.ocean.update(dt * scale, snap.t, this.camera);
    this.sky.update(dt, this.camera, snap.wind.twd, snap.wind.tws);
    this.lighting.update();
    this.land.update(t);
    this.marks.update(snap.t, (e, n) => this.ocean.sampler.heightAt(e, n, snap.t));

    this.boatRoot.updateMatrixWorld();
    this.frameMatrix.copy(this.boatRoot.matrixWorld);
    this.boatPos.copy(this.boatRoot.position);
    this.rig.update(dt, {
      boatMatrix: this.frameMatrix,
      boatPos: this.boatPos,
      heading: snap.boat.heading,
      heel: snap.boat.heel,
      twd: snap.wind.twd,
      windSide: snap.wind.twa >= 0 ? 1 : -1,
      waterHeight: (x, z) => this.ocean.sampler.heightAt(x, -z, snap.t),
    });

    this.ov.update(dt, snap, this.camera);
    // Listening direction: the view's heading, or the top of the screen when looking straight down.
    this.camera.getWorldDirection(this.camDir);
    this.camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.soundscape.update(snap, cameraYawFromBasis(this.camDir, this.camUp), dt);
    this.hud.update(snap, dt);
    if (this.mode === 'lab') this.lab?.update(snap, dt);
    this.runner.update(snap, dt * scale);
    this.post.render(dt);
    this.tcam.render(dt, this.hud.telltaleCamRect(), this.scene, this.jibTelltales, this.boatRoot, snap.wind.twa >= 0 ? 1 : -1, THREE.AgXToneMapping);
    this.frameTimer.end();

    if (this.governor.sample(rawMs, now, this.frameTimer.cost)) this.applyQuality(this.governor.settings);
    this.frameMsAvg += (dt * 1000 - this.frameMsAvg) * 0.05;
    if (++this.frames === 5) window.__ready = true;
    if (this.frames % 30 === 0) {
      const info = this.renderer.info.render;
      window.__stats = { frameMs: this.frameMsAvg, fps: 1000 / this.frameMsAvg, calls: info.calls, triangles: info.triangles };
      window.__appInfo = { tier: this.quality.tier, speedKn: +(snap.boat.speed / KN).toFixed(2), heelDeg: +(snap.boat.heel / DEG).toFixed(1) };
    }
  };
}

export const BOAT_NAME = BOAT.name;
