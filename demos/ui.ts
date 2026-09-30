// UI demo: the full HUD + lessons over the demo kit's sky and a placeholder boat, driven by a fake
// snapshot stream (uiFake.ts) and a mock AppApi. URL switches (for screenshots):
//   bg=flat            no WebGL, CSS gradient background        lesson=<id> step=<n> quiz=1 hint=1
//   left=0 right=0     collapse the docks                       mode=free|lab   pause=1   slow=0.5
//   help=1 menu=1 polar=1 toasts=1 pip=1                        sheet=lesson|trim|view (phones)
//   overlays=forces,wheel   twa=45   pilot=twa:44|hdg:200   spin=1   done=id,id   warm=<s>   answer=0,2   stats=1
import * as THREE from 'three';
import { createDemoKit } from './shared/demoKit';
import { Hud, OVERLAY_KEYS, type AppApi, type AppMode, type CameraKey, type OverlayKey } from '../src/ui/Hud';
import { InputController } from '../src/ui/input';
import { LessonRunner, PROGRESS_KEY } from '../src/lessons/engine';
import { defaultControls, type ScenarioInit, type SimSnapshot, type WindSettings } from '../src/sim/types';
import type { QualitySettings } from '../src/render/core/types';
import { BOAT } from '../src/shared/boatSpec';
import { DEG } from '../src/shared/math';
import { bodyToLocal } from '../src/shared/coords';
import { FakeSim, demoLessons, demoPolar } from './uiFake';

declare global {
  interface Window {
    __ready?: boolean;
    __ui?: { hud: Hud; runner: LessonRunner; input: InputController; app: MockApp; sim: FakeSim };
    __uiStats?: { hudMeanMs: number; hudMaxMs: number; uiFrameMeanMs: number; uiFrameP95Ms: number; frames: number };
  }
}

const q = new URLSearchParams(location.search);
const flag = (k: string) => q.get(k) === '1';

// ---- mock App -------------------------------------------------------------------------------------

class MockApp implements AppApi {
  controls = defaultControls();
  paused = false;
  timeScale = 1;
  hud: Hud | null = null;
  runner: LessonRunner | null = null;
  private readonly ov = Object.fromEntries(OVERLAY_KEYS.map((k) => [k, false])) as Record<OverlayKey, boolean>;

  constructor(private readonly sim: FakeSim, private readonly setHour: (h: number) => void) {}

  setMode(m: AppMode): void {
    if (m !== 'lessons') this.runner?.exit();
    this.hud?.syncState({ mode: m });
  }
  setCamera(c: CameraKey): void { this.hud?.syncState({ camera: c }); }
  setOverlay(k: OverlayKey, on: boolean): void { this.ov[k] = on; }
  overlays(): Record<OverlayKey, boolean> { return { ...this.ov }; }
  setWind(p: Partial<WindSettings>): void {
    this.sim.setWind(p);
    this.hud?.syncState({ wind: this.sim.wind });
  }
  setTimeOfDay(h: number): void {
    this.setHour(h);
    this.hud?.syncState({ hour: h });
  }
  setTimeScale(s: number): void { this.timeScale = s; this.hud?.syncState({ timeScale: s }); }
  togglePause(): void { this.paused = !this.paused; this.hud?.syncState({ paused: this.paused }); }
  setQuality(t: QualitySettings['tier'] | 'auto'): void { this.hud?.syncState({ quality: t, qualityActual: t === 'auto' ? 'high' : null }); }
  setSound(on: boolean): void { this.hud?.syncState({ sound: on }); }
  scenario(init: ScenarioInit): void {
    this.sim.reset(init);
    const base = defaultControls();
    this.controls = { ...base, ...init.controls, autoTrim: { ...base.autoTrim, ...init.controls?.autoTrim } };
    this.hud?.syncState({ wind: this.sim.wind });
  }
  startLesson(id: string): void {
    this.hud?.syncState({ mode: 'lessons' });
    this.runner?.start(id);
  }

  setMarks(): void {}
}

// ---- placeholder boat (so the glass panels sit over a real-looking scene) ---------------------------

function makeBoat(): { root: THREE.Group; pose(s: SimSnapshot): void } {
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.6 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.85, side: THREE.DoubleSide });
  const root = new THREE.Group();
  const hullShape = new THREE.Shape();
  const { loa, beam } = BOAT.hull;
  hullShape.moveTo(0, -BOAT.hull.stemDeck.x);
  hullShape.bezierCurveTo(beam * 0.42, -2.6, beam * 0.52, -0.5, beam * 0.5, 0.8);
  hullShape.bezierCurveTo(beam * 0.48, 2.4, beam * 0.42, 3.3, beam * 0.38, -BOAT.hull.transomDeck.x);
  hullShape.lineTo(-beam * 0.38, -BOAT.hull.transomDeck.x);
  hullShape.bezierCurveTo(-beam * 0.42, 3.3, -beam * 0.48, 2.4, -beam * 0.5, 0.8);
  hullShape.bezierCurveTo(-beam * 0.52, -0.5, -beam * 0.42, -2.6, 0, -BOAT.hull.stemDeck.x);
  const hull = new THREE.Mesh(new THREE.ExtrudeGeometry(hullShape, { depth: 1.05, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 2 }), white);
  hull.rotation.x = Math.PI / 2;
  hull.position.y = 0.85;
  root.add(hull);
  const keel = new THREE.Mesh(new THREE.BoxGeometry(0.12, BOAT.hull.draft, 0.8), dark);
  keel.position.set(0, -BOAT.hull.draft / 2, -0.4);
  root.add(keel);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, BOAT.mast.topH - BOAT.mast.baseH, 8), new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.7, roughness: 0.35 }));
  const mastLocal = bodyToLocal({ x: BOAT.mast.x, y: 0, z: -(BOAT.mast.baseH + BOAT.mast.topH) / 2 });
  mast.position.set(mastLocal.x, mastLocal.y, mastLocal.z);
  root.add(mast);
  const tri = (a: number[], b: number[], c: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
    g.computeVertexNormals();
    return g;
  };
  const gh = BOAT.boom.gooseneck.h;
  const boomPivot = new THREE.Group();
  boomPivot.position.set(0, 0, -BOAT.boom.gooseneck.x);
  const mainSail = new THREE.Mesh(tri([0, gh + 0.05, 0], [0, gh + BOAT.main.P, 0.05], [0, gh + 0.05, BOAT.main.E]), cloth);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, BOAT.boom.length), dark);
  boom.position.set(0, gh, BOAT.boom.length / 2);
  boomPivot.add(mainSail, boom);
  root.add(boomPivot);
  const jibPivot = new THREE.Group();
  jibPivot.position.set(0, 0, -BOAT.jib.tack.x);
  const headDz = BOAT.jib.tack.x - BOAT.jib.head.x;
  jibPivot.add(new THREE.Mesh(tri([0, BOAT.jib.tack.h, 0], [0, BOAT.jib.head.h, headDz], [0, BOAT.jib.clewH, BOAT.jib.foot]), cloth));
  root.add(jibPivot);
  root.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return {
    root,
    pose(s) {
      // Spec §5: Euler 'YXZ', y = −ψ, z = −φ. Boom/clew angles > 0 swing to port (−X), i.e. rotation.y = −angle.
      root.rotation.set(0, -s.boat.heading, -s.boat.heel, 'YXZ');
      boomPivot.rotation.y = -s.sails.main.boomAngle;
      jibPivot.rotation.y = -s.sails.jib.clewAngle * 0.8;
    },
  };
}

// ---- build ----------------------------------------------------------------------------------------

const uiRoot = document.getElementById('ui')!;
const sim = new FakeSim();
const flat = q.get('bg') === 'flat';
let setHour: (h: number) => void = () => {};
let scene: { onFrame(cb: (dt: number) => void): void; start(): void };

if (flat) {
  document.body.classList.add('flat');
  const cbs: ((dt: number) => void)[] = [];
  let last = performance.now();
  let frames = 0;
  scene = {
    onFrame: (cb) => cbs.push(cb),
    start: () => {
      const tick = (now: number) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        for (const cb of cbs) cb(dt);
        if (++frames === 3) window.__ready = true;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
  };
} else {
  const kit = createDemoKit({ hour: Number(q.get('hour') ?? 17), cameraPos: [9, 5.5, 17], target: [0, 3.2, 0], fov: 48 });
  document.body.prepend(kit.renderer.domElement);
  const readout = document.body.lastElementChild as HTMLElement | null;
  if (readout && readout !== uiRoot && !flag('stats')) readout.style.display = 'none';
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
    new THREE.MeshPhysicalMaterial({ color: 0x0b2c47, roughness: 0.12, metalness: 0, clearcoat: 0.4 }),
  );
  water.receiveShadow = true;
  kit.scene.add(water);
  const boat = makeBoat();
  kit.scene.add(boat.root);
  kit.controls.enabled = false;
  setHour = (h) => kit.sky.setHour(h);
  kit.onFrame(() => {
    boat.pose(sim.snap);
    // Chase camera: behind and a little to windward of the boat.
    const psi = sim.snap.boat.heading;
    const side = sim.snap.wind.twa >= 0 ? 1 : -1;
    const fwd = new THREE.Vector3(Math.sin(psi), 0, -Math.cos(psi));
    const right = new THREE.Vector3(Math.cos(psi), 0, Math.sin(psi));
    kit.camera.position.copy(fwd.multiplyScalar(-27)).addScaledVector(right, 9 * side).setY(6.5);
    kit.controls.target.set(0, 4.2, 0);
  });
  scene = { onFrame: (cb) => kit.onFrame(cb), start: () => kit.start() };
}

// Seed completion ticks for screenshots (storage access guarded like the engine's).
const done = q.get('done');
if (done) {
  try {
    const completed = Object.fromEntries(done.split(',').map((id) => [id, true]));
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ v: 1, completed, quiz: {}, last: null }));
  } catch { /* storage blocked: ticks just won't show */ }
}

const app = new MockApp(sim, (h) => setHour(h));
const hud = new Hud(uiRoot, app);
app.hud = hud;
const input = new InputController(app, window);
hud.attachInput(input);
const runner = new LessonRunner(demoLessons, app, hud.lessonPanel);
app.runner = runner;
hud.setControlFilter((k) => runner.isLive(k));
hud.setPolar(demoPolar);
hud.syncState({ wind: sim.wind, hour: Number(q.get('hour') ?? 17), qualityActual: 'high' });
window.__ui = { hud, runner, input, app, sim };

// ---- initial state from the URL -------------------------------------------------------------------

if (q.get('twa')) sim.settle(Number(q.get('twa')));
else sim.settle(45);
if (flag('spin')) {
  sim.settle(Number(q.get('twa') ?? 140));
  app.controls.spinHoist = true;
  sim.reset({ wind: sim.wind, spinnakerSet: true });
}
runner.update(sim.snap, 0);
const lesson = q.get('lesson');
if (lesson) {
  runner.start(lesson);
  for (let i = 0; i < Number(q.get('step') ?? 0); i++) runner.next();
  if (flag('quiz')) {
    const l = demoLessons.find((x) => x.id === lesson);
    for (let i = runner.activeStepIndex; i >= 0 && i < (l?.steps.length ?? 0); i++) runner.next();
  }
  if (q.get('twa')) sim.settle(Number(q.get('twa')));
}
const pilot = q.get('pilot');
if (pilot) {
  const [mode, value] = pilot.split(':');
  app.controls.helmMode = mode === 'hdg' ? 'heading' : mode === 'awa' ? 'awa' : 'twa';
  app.controls.helmTarget = Number(value) * DEG;
}
for (const k of (q.get('overlays') ?? '').split(',').filter(Boolean)) app.setOverlay(k as OverlayKey, true);
if (flag('pip')) app.setOverlay('telltaleCam', true);
const mode = q.get('mode');
if (mode === 'free' || mode === 'lab') hud.syncState({ mode });
if (q.get('left') === '0') (uiRoot.querySelector('.sx-dock-left .sx-dock-tab') as HTMLButtonElement | null)?.click();
if (q.get('right') === '0') (uiRoot.querySelector('.sx-dock-right .sx-dock-tab') as HTMLButtonElement | null)?.click();
if (flag('pause')) hud.commands.togglePause();
if (q.get('slow')) app.setTimeScale(Number(q.get('slow')));
if (flag('polar')) (uiRoot.querySelector('.sx-ovl[aria-label="Polar diagram"]') as HTMLButtonElement | null)?.click();
if (flag('help')) hud.openHelp();
if (flag('menu')) hud.openSettings();
const sheet = q.get('sheet');
if (sheet) (uiRoot.querySelector(`.sx-mnav-btn:nth-child(${sheet === 'lesson' ? 1 : sheet === 'trim' ? 2 : 3})`) as HTMLButtonElement | null)?.click();

// Warm-up: run the fake stream (and the runner) forward so progress bars and trails have content.
const warm = Number(q.get('warm') ?? 0);
for (let t = 0; t < warm; t += 1 / 60) {
  sim.step(1 / 60, app.controls);
  runner.update(sim.snap, 1 / 60);
}
if (flag('hint')) runner.requestHint();
// answer=0,2 answers the quiz questions in order (after quiz=1).
const answer = q.get('answer');
if (answer !== null) {
  for (const [i, a] of answer.split(',').entries()) {
    if (i > 0) runner.next();
    runner.answer(Number(a));
  }
}

// ---- frame loop -----------------------------------------------------------------------------------

let toastsShown = false;
const frameMs: number[] = [];
let statAcc = 0;
scene.onFrame((dt) => {
  const t0 = performance.now();
  input.update(dt);
  sim.step(app.paused ? 0 : dt * app.timeScale, app.controls);
  hud.update(sim.snap, dt);
  runner.update(sim.snap, dt);
  if (flag('toasts') && !toastsShown) {
    toastsShown = true;
    hud.toast('Accidental [[gybe]]! The wind got behind the mainsail — steer less deep.', 'gybing', 'warn');
    hud.toast('Mainsail: you\'re trimming — crew auto-trim off');
  }
  frameMs.push(performance.now() - t0);
  statAcc += dt;
  if (statAcc > 0.5 && frameMs.length > 10) {
    statAcc = 0;
    const sorted = frameMs.slice().sort((a, b) => a - b);
    const s = hud.stats();
    window.__uiStats = {
      hudMeanMs: +s.meanMs.toFixed(4), hudMaxMs: +s.maxMs.toFixed(3),
      uiFrameMeanMs: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(4),
      uiFrameP95Ms: +sorted[Math.floor(sorted.length * 0.95)]!.toFixed(4),
      frames: sorted.length,
    };
    if (frameMs.length > 600) frameMs.splice(0, frameMs.length - 600);
  }
});
scene.start();
