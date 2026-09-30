// Overlays demo: a real Simulation + AutoCrew stepped in real time (fixed 1/120 s) on a stand-in boat, with every
// physics overlay (spec §8) switchable from the keyboard. URL parameters make screenshots reproducible, e.g.
//   overlays.html?tws=12&twa=45&on=windTriangle,forces&cam=chase
//   overlays.html?tws=12&twa=150&spin=1&on=flow&cam=high        overlays.html?on=wheel&cam=top
// Keys: W wind triangle · V forces · P wheel · O flow · S slice ([ ] height) · L labels · Y laylines · T track ·
//       X x-ray flag · ←/→ steer (target TWA) · K tack · G gybe · H spinnaker · Space pause · 1–7 cameras · M particle mode
import * as THREE from 'three';
import { createDemoKit } from './shared/demoKit';
import { Stage } from './overlaysStage';
import { Simulation, DT } from '../src/sim/simulation';
import { AutoCrew } from '../src/sim/autocrew';
import { Overlays } from '../src/render/overlays/Overlays';
import { tierSettings, type QualityTier } from '../src/render/core/types';
import { OVERLAY_KEYS, type OverlayKey } from '../src/lessons/types';
import { DEG, KN } from '../src/shared/math';
import type { SimSnapshot } from '../src/sim/types';

declare global {
  interface Window { __overlays?: { cpuMs: number; p95: number; max: number; frames: number; sim: Record<string, number> } }
}

const kit = createDemoKit({ hour: 16.5, cameraPos: [12, 6, 16], target: [0, 4, 0], fov: 48 });
const q = kit.params;
const num = (k: string, d: number): number => (q.has(k) ? Number(q.get(k)) : d);
// Same light balance the sails demo uses (production calibrates sun ≈ 6× sky); ?light=kit keeps the kit's.
if (q.get('light') !== 'kit') {
  kit.scene.environmentIntensity = 0.3;
  kit.sun.intensity = kit.sky.sunIntensity * 5;
}

// --- simulation ------------------------------------------------------------------------------------------------
const tws = num('tws', 12);
const twa = num('twa', 45);
const twd = num('twd', 250) * DEG;
const spin = q.get('spin') === '1';
const sim = new Simulation({
  wind: { tws: tws * KN, twd, gustiness: num('gust', 0.3), shiftAmplitude: num('shift', 0) * DEG, shiftPeriod: 150, seed: num('seed', 7) },
  boat: { psi: (((twd - twa * DEG) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), u: 2.5 },
  spinnakerSet: spin,
  controls: { helmMode: 'twa', helmTarget: twa * DEG },
});
sim.crew = new AutoCrew();
const warmSteps = Math.round(num('warm', 25) / DT);
const tackAt = q.has('tackAt') ? Math.round(num('tackAt', 0) / DT) : -1;
// Warm-up snapshots every 0.5 s are replayed into the track overlay once it exists.
const warmTrack: SimSnapshot[] = [];
for (let i = 0; i < warmSteps; i++) {
  if (i === tackAt) sim.controls.command = 'tack';
  sim.step();
  if (i % 60 === 0) warmTrack.push(sim.snapshot());
}
let snap: SimSnapshot = sim.snapshot();

// --- scene -----------------------------------------------------------------------------------------------------
const stage = new Stage(kit.scene);
stage.update(snap);
const tier = (q.get('tier') ?? 'high') as QualityTier;
const overlays = new Overlays(kit.scene, stage.boat, tierSettings(tier));
const up = { e: Math.sin(twd), n: Math.cos(twd) };
const marks = [
  { id: 'W', e: snap.boat.pos.x + up.e * num('markDist', 320), n: snap.boat.pos.y + up.n * num('markDist', 320), kind: 'windward' as const },
  { id: 'L', e: snap.boat.pos.x - up.e * 140, n: snap.boat.pos.y - up.n * 140, kind: 'leeward' as const },
];
overlays.setMarks(marks);
stage.setMarks(marks);
overlays.setSliceHeight(num('slice', 4.5));
const on = new Set<OverlayKey>((q.get('on') ?? 'windTriangle,forces').split(',').filter((k): k is OverlayKey => (OVERLAY_KEYS as readonly string[]).includes(k)));
for (const k of OVERLAY_KEYS) overlays.set(k, on.has(k));
// Replay the warm-up into the overlays so the track shows where the boat came from.
for (const w of warmTrack) overlays.update(0, w, kit.camera);

// --- camera presets (boat-relative, yawed with the heading, level) ----------------------------------------------
const CAMS: Record<string, { pos: [number, number, number]; target: [number, number, number]; fov?: number }> = {
  chase: { pos: [7, 8, 19], target: [0, 4.2, -0.5] },
  lee: { pos: [-13, 7.5, 12], target: [-0.5, 4.8, -0.5] },
  leehigh: { pos: [-12, 17, 7], target: [-1, 3.5, -0.5] },
  astern: { pos: [2, 12, 18], target: [0, 4.2, -2] },
  top: { pos: [0, 62, 0.01], target: [0, 0, 0], fov: 40 },
  side: { pos: [-19, 5, 1], target: [0, 4.6, 0] },
  bow: { pos: [-9, 4, -17], target: [0, 4.4, 0] },
  high: { pos: [6, 21, 13], target: [0, 4.5, -0.5] },
  above: { pos: [0.5, 30, 3], target: [0.5, 5, -0.5], fov: 45 },
};
let camName = q.get('cam') ?? 'chase';
const boatPos = new THREE.Vector3();
const yawed = (v: [number, number, number], side: number, out: THREE.Vector3): THREE.Vector3 => {
  // x is to leeward-positive when side = −1 so presets look at the working side of the sails.
  out.set(v[0] * side, v[1], v[2]).applyAxisAngle(new THREE.Vector3(0, 1, 0), -snap.boat.heading);
  return out;
};
function applyCamera(name: string): void {
  if (name === 'course') {
    // Wind-relative: high behind the boat (downwind of it), looking up the beat toward the windward mark.
    camName = name;
    const up = new THREE.Vector3(Math.sin(twd), 0, -Math.cos(twd));
    boatPos.set(snap.boat.pos.x, 0, -snap.boat.pos.y);
    kit.camera.fov = num('fov', 50);
    kit.camera.updateProjectionMatrix();
    kit.camera.position.copy(boatPos).addScaledVector(up, -num('back', 90)).add(new THREE.Vector3(0, num('up', 85), 0));
    kit.controls.target.copy(boatPos).addScaledVector(up, num('ahead', 110));
    kit.controls.update();
    return;
  }
  camName = CAMS[name] ? name : 'chase';
  const c = CAMS[camName]!;
  const side = snap.wind.twa >= 0 ? 1 : -1; // put the camera on the windward side (the sails' lee side faces away)
  boatPos.set(snap.boat.pos.x, 0, -snap.boat.pos.y);
  const p = yawed(c.pos, num('camSide', 1) * side, new THREE.Vector3()).add(boatPos);
  const t = yawed(c.target, side, new THREE.Vector3()).add(boatPos);
  if (q.has('dist')) p.sub(t).multiplyScalar(num('dist', 1)).add(t);
  kit.camera.fov = num('fov', c.fov ?? 48);
  kit.camera.updateProjectionMatrix();
  kit.camera.position.copy(p);
  kit.controls.target.copy(t);
  kit.controls.update();
}
applyCamera(camName);

// --- HUD -------------------------------------------------------------------------------------------------------
const KEYS: Array<[string, OverlayKey | null, string]> = [
  ['W', 'windTriangle', 'wind triangle'], ['V', 'forces', 'forces'], ['P', 'wheel', 'points of sail'], ['O', 'flow', 'flow'],
  ['S', 'flowSlice', 'flow slice [ ]'], ['L', 'labels', 'part labels'], ['Y', 'laylines', 'laylines'], ['T', 'track', 'track'],
];
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;left:10px;top:10px;z-index:2;font:12px/1.45 ui-monospace,Menlo,monospace;color:#f4f7fb;background:rgba(7,18,33,.62);padding:8px 10px;border-radius:10px;pointer-events:none;white-space:pre';
if (q.get('ui') !== '0') document.body.appendChild(hud);
let hudT = 0;
function drawHud(): void {
  const s = snap;
  const f = (v: number, d = 1) => v.toFixed(d);
  const lines = [
    `TWS ${f(s.wind.tws / KN)} kn  TWA ${f(s.wind.twa / DEG, 0)}°  AWS ${f(s.wind.aws / KN)} kn  AWA ${f(s.wind.awa / DEG, 0)}°`,
    `speed ${f(s.boat.speed / KN)} kn  heel ${f(s.boat.heel / DEG, 0)}°  leeway ${f(s.boat.leeway / DEG)}°  ${paused ? 'PAUSED' : ''}`,
    ...KEYS.map(([key, k, name]) => `${key}  ${k && overlays.isOn(k) ? '●' : '○'} ${name}`),
    `←/→ steer  K tack  G gybe  H spinnaker  1–7 cam (${camName})`,
  ];
  hud.textContent = lines.join('\n');
}

// --- input -----------------------------------------------------------------------------------------------------
let paused = q.get('pause') === '1';
let sliceH = num('slice', 4.5);
const camOrder = Object.keys(CAMS);
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const toggle = KEYS.find(([key]) => key.toLowerCase() === k);
  if (toggle && toggle[1]) { overlays.set(toggle[1], !overlays.isOn(toggle[1])); return; }
  const c = sim.controls;
  if (k === 'x') overlays.set('xray', !overlays.isOn('xray'));
  else if (k === '[' || k === ']') { sliceH += k === ']' ? 0.5 : -0.5; overlays.setSliceHeight(sliceH); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { c.helmMode = 'twa'; c.helmTarget += (e.key === 'ArrowRight' ? -5 : 5) * DEG * Math.sign(c.helmTarget || 1); }
  else if (k === 'k') c.command = 'tack';
  else if (k === 'g') c.command = 'gybe';
  else if (k === 'h') c.spinHoist = !c.spinHoist;
  else if (k === ' ') paused = !paused;
  else if (k >= '1' && k <= '7') applyCamera(camOrder[Number(k) - 1]!);
  else if (k === 'm') { const f = flowOf(); f?.setMode(f.mode === 'rake' ? 'volume' : 'rake'); }
});
/** The demo reaches into the overlay's particle system to switch its seeding mode. */
const flowOf = () => (overlays as unknown as { flow: { mode: 'rake' | 'volume'; setMode(m: 'rake' | 'volume'): void } | null }).flow;
if (q.get('mode') === 'volume') flowOf()?.setMode('volume');

// --- loop ------------------------------------------------------------------------------------------------------
let acc = 0;
const cpu: number[] = [];
let frames = 0;
const prev = new THREE.Vector3(snap.boat.pos.x, 0, -snap.boat.pos.y);
const now = new THREE.Vector3();
const delta = new THREE.Vector3();
// ?tackIn=S commands a tack S seconds after start (e.g. to measure the overlays during a manoeuvre).
let tackIn = q.has('tackIn') ? num('tackIn', 2) : Infinity;
kit.onFrame((dt) => {
  const step = paused ? 0 : Math.min(dt, 0.1);
  tackIn -= step;
  if (tackIn <= 0) { sim.controls.command = Math.abs(snap.wind.twa) < 90 * DEG ? 'tack' : 'gybe'; tackIn = Infinity; }
  acc += step;
  let n = 0;
  while (acc >= DT && n < 12) { sim.step(); acc -= DT; n++; }
  if (n > 0) snap = sim.snapshot();
  stage.update(snap);
  // Follow the boat: shift camera and orbit target by the boat's motion.
  now.set(snap.boat.pos.x, 0, -snap.boat.pos.y);
  delta.copy(now).sub(prev);
  kit.camera.position.add(delta);
  kit.controls.target.add(delta);
  prev.copy(now);

  const t0 = performance.now();
  overlays.update(step, snap, kit.camera);
  cpu.push(performance.now() - t0);
  if (cpu.length > 300) cpu.shift();
  frames++;
  if (frames % 30 === 0) {
    const sorted = [...cpu].sort((a, b) => a - b);
    window.__overlays = {
      cpuMs: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]!, max: sorted[sorted.length - 1]!, frames,
      sim: { tws: snap.wind.tws / KN, twa: snap.wind.twa / DEG, aws: snap.wind.aws / KN, awa: snap.wind.awa / DEG, speed: snap.boat.speed / KN, heel: snap.boat.heel / DEG },
    };
  }
  hudT += dt;
  if (hudT > 0.2) { hudT = 0; drawHud(); }
});
drawHud();
kit.start();
