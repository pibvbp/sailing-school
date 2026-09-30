// Sails demo: SailsView driven by a mock snapshot (demos/sailsMock.ts) or the real simulation (?sim=1), on the
// real Kestrel 25 (?boat=stand: the original stand-in hull and rig instead).
// Everything is settable from the URL for reproducible screenshots, e.g.
//   sails.html?prod=1&preset=beat&cam=quarter&hour=17&sun=behind     (production renderer, sky, light, post)
//   sails.html?preset=run&cam=spin      sails.html?anim=tack&cam=side      sails.html?colour=aoa
//   ?sun=behind|front puts the sun on the windward|leeward beam (overrides ?hdg=), ?sunoff=<deg> turns it
//   ?seek=<s> steps the animation deterministically to that instant and holds it (filmstrips)
import * as THREE from 'three';
import { SailsView } from '../src/render/sails/SailsView';
import { tierSettings, type QualityTier } from '../src/render/core/types';
import { defaultMock, mockSails, mockWind, type MockParams } from './sailsMock';
import { RealBoat, StandInBoat, cameraPreset, makeWater, type DemoBoat, type DemoPose } from './sailsStage';
import { createHost } from './sailsProd';
import { Simulation } from '../src/sim/simulation';
import { AutoCrew } from '../src/sim/autocrew';
import type { SimSnapshot } from '../src/sim/types';

declare global {
  interface Window { __sails?: { cpuMs: number; p95: number; tris: number } }
}

const PRESETS: Record<string, Partial<MockParams> & { heel?: number }> = {
  beat: { awa: 32, boom: 8, clew: 11, twist: 9, heel: 14 },
  pinch: { awa: 24, boom: 6, clew: 10, jibLuff: 0.55, mainLuff: 0.4, heel: 8 },
  luffing: { awa: 16, boom: 6, clew: 10, jibLuff: 1, mainLuff: 0.9, heel: 3 },
  stalled: { awa: 44, boom: 2, clew: 8, stall: 0.95, twist: 4, heel: 18 },
  reach: { awa: 95, boom: 48, clew: 32, camber: 0.13, jibCamber: 0.14, twist: 16, heel: 9 },
  run: { furl: 1, awa: 165, boom: 76, clew: 40, spin: true, pole: 72, spinSheet: 0.5, heel: 3, camber: 0.14, twist: 18 },
  spinreach: { furl: 1, awa: 105, boom: 55, clew: 38, spin: true, pole: 22, spinSheet: 0.6, heel: 12, camber: 0.13, twist: 16 },
  curl: { furl: 1, awa: 140, boom: 70, clew: 40, spin: true, pole: 52, spinSheet: 0.3, curl: 0.9, heel: 6, camber: 0.14, twist: 16 },
  collapse: { furl: 1, awa: 140, boom: 70, clew: 40, spin: true, pole: 52, spinSheet: 0.1, collapse: 1, heel: 3, camber: 0.14, twist: 16 },
  furled: { awa: 32, boom: 8, clew: 11, furl: 0.45, heel: 12 },
};

const q = new URLSearchParams(location.search);
const anim = q.get('anim');
const kit = createHost(q);
const num = (k: string, d: number): number => (q.has(k) ? Number(q.get(k)) : d);

const params: MockParams = { ...defaultMock() };
const preset = PRESETS[q.get('preset') ?? 'beat'] ?? PRESETS['beat']!;
Object.assign(params, preset);
const keys: Array<[keyof MockParams, string]> = [
  ['awa', 'awa'], ['aws', 'aws'], ['boom', 'boom'], ['clew', 'clew'], ['camber', 'camber'], ['jibCamber', 'jcamber'],
  ['twist', 'twist'], ['mainLuff', 'mluff'], ['jibLuff', 'jluff'], ['stall', 'stall'], ['furl', 'furl'], ['hoist', 'hoist'],
  ['curl', 'curl'], ['collapse', 'collapse'], ['pole', 'pole'], ['spinSheet', 'sheet'],
];
for (const [k, qk] of keys) if (q.has(qk)) (params as unknown as Record<string, number>)[k] = Number(q.get(qk));
if (q.has('spin')) params.spin = q.get('spin') === '1';
if (q.has('side')) params.side = Number(q.get('side'));
let heelDeg = num('heel', preset.heel ?? 10);
const tier = (q.get('tier') ?? 'high') as QualityTier;

// Boat root per spec §5: Euler 'YXZ', y = −heading, z = −heel (heel > 0 = starboard side down).
const boat = new THREE.Group();
boat.rotation.order = 'YXZ';
kit.scene.add(boat);
makeWater(kit.scene, kit.prod);
const hull: DemoBoat = q.get('boat') === 'stand' ? new StandInBoat(boat) : new RealBoat(boat, tierSettings(tier));
kit.follow(boat);
const view = new SailsView(tierSettings(tier));
boat.add(view.root);
if (q.get('colour') === 'aoa') view.setColouring('aoa');
// ?pressure=1: a test overlay (red at the luff → blue at the leech, fading out toward the head) on both sails.
if (q.get('pressure') === '1') {
  const W = 64, H = 64, d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4, u = x / (W - 1), v = y / (H - 1);
    d[k] = 255 * (1 - u); d[k + 1] = 40; d[k + 2] = 255 * u; d[k + 3] = 255 * (1 - v) * 0.8;
  }
  const tex = new THREE.DataTexture(d, W, H);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  view.setPressureTexture('main', tex);
  view.setPressureTexture('jib', tex);
}

/** Heading that puts the sun on the windward (behind the sails, seen from leeward) or leeward beam. */
const sunAz = Math.atan2(kit.sunDirection.x, -kit.sunDirection.z);
const heading = (): number => {
  const ws = params.awa >= 0 ? 1 : -1;
  const mode = q.get('sun');
  const off = THREE.MathUtils.degToRad(num('sunoff', 0));
  if (mode === 'behind') return sunAz - (ws * Math.PI) / 2 + off;
  if (mode === 'front') return sunAz + (ws * Math.PI) / 2 + off;
  return THREE.MathUtils.degToRad(num('hdg', 200));
};
const hdg0 = heading();
/** Heading-only frame of the boat: cameras live here so heel never dips one under the water. */
const yawFrame = new THREE.Object3D();
kit.scene.add(yawFrame);
let simHeading = 0;
const applyPose = (heelRad?: number) => {
  const ws = params.awa >= 0 ? 1 : -1;
  boat.rotation.y = -(hdg0 + simHeading);
  boat.rotation.z = heelRad !== undefined ? -heelRad : THREE.MathUtils.degToRad(ws * heelDeg);
  boat.updateMatrixWorld(true);
  yawFrame.rotation.y = boat.rotation.y;
  yawFrame.updateMatrixWorld(true);
};
applyPose();

let camName = q.get('cam') ?? 'default';
let camLee = params.awa >= 0 ? -1 : 1;
const setCamera = (name: string) => {
  camName = name;
  const c = cameraPreset(name, camLee);
  kit.camera.fov = num('fov', c.fov);
  kit.camera.updateProjectionMatrix();
  const pos = yawFrame.localToWorld(c.pos.clone());
  pos.y = Math.max(pos.y, 0.35);
  kit.camera.position.copy(pos);
  kit.controls.target.copy(boat.localToWorld(c.target.clone()));
  kit.controls.update();
};
setCamera(camName);

// ?sim=1: the real simulation and auto-crew (holding ?twa= in ?tws= knots) drive the sails instead of the mock.
const sim = q.get('sim') === '1' ? makeSim() : null;
function makeSim(): Simulation {
  const KN = 0.514444;
  const twa = THREE.MathUtils.degToRad(num('twa', 45));
  const s = new Simulation({
    wind: { tws: num('tws', 12) * KN, twd: 0, gustiness: num('gust', 0.15), shiftAmplitude: 0, shiftPeriod: 120, seed: 7 },
    boat: { psi: -twa, u: num('speed', 5.5) * KN },
    controls: { helmMode: 'twa', helmTarget: twa },
    spinnakerSet: q.get('spin') === '1',
  });
  s.crew = new AutoCrew();
  camLee = twa >= 0 ? -1 : 1;
  setCamera(camName);
  return s;
}
let simAcc = 0;
let simT = 0;
const simStep = (dt: number): SimSnapshot => {
  const s = sim!;
  simAcc = Math.min(simAcc + dt, 0.1);
  while (simAcc >= 1 / 120) { s.step(1 / 120); simAcc -= 1 / 120; simT += 1 / 120; }
  // Crew commands on a timer: ?anim=tack|gybe every 14 s, ?anim=hoist toggles the spinnaker every 16 s.
  const cycle = Math.floor(simT / (anim === 'hoist' ? 16 : 14));
  if (cycle !== lastCycle) {
    lastCycle = cycle;
    if (cycle > 0 && (anim === 'tack' || anim === 'gybe')) s.controls.command = anim;
    if (anim === 'hoist') s.controls.spinHoist = cycle % 2 === 0;
  }
  const snap = s.snapshot();
  simHeading = snap.boat.heading + THREE.MathUtils.degToRad(num('twa', 45));
  applyPose(snap.boat.heel);
  if (q.get('follow') === '1') setCamera(camName);
  return snap;
};
let lastCycle = 0;

// Mock animations: a tack, a gybe, a spinnaker hoist/douse cycle, a collapse/refill cycle.
const base = { ...params };
const smooth = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const animate = (t: number) => {
  if (anim === 'tack') {
    const period = 11, ph = (t % (2 * period)) / period;
    const dir = ph < 1 ? 1 : -1;
    const tau = smooth(0.15, 0.75, ph < 1 ? ph : ph - 1);
    const awa = 32 * dir * Math.cos(Math.PI * tau);
    params.awa = awa;
    const head = 1 - smooth(10, 26, Math.abs(awa));
    params.mainLuff = head;
    params.jibLuff = Math.max(head, 1 - smooth(14, 30, Math.abs(awa)));
    params.boom = 8 * Math.tanh(awa / 5);
    params.clew = 11 * Math.tanh(awa / 3) + 4 * Math.sin(t * 9) * head;
    params.side = null;
    heelDeg = 14 * smooth(8, 30, Math.abs(awa));
    applyPose();
  } else if (anim === 'gybe') {
    const period = 10, ph = (t % (2 * period)) / period;
    const dir = ph < 1 ? 1 : -1;
    const tau = smooth(0.2, 0.8, ph < 1 ? ph : ph - 1);
    const awa = dir * (160 + 40 * tau);
    params.awa = ((awa + 540) % 360) - 180;
    const cross = smooth(0.45, 0.62, tau);
    params.boom = dir * 75 * (1 - 2 * cross);
    params.clew = dir * 40 * (1 - 2 * smooth(0.5, 0.75, tau));
    params.side = null;
    params.mainLuff = 0.8 * Math.sin(Math.PI * cross);
    params.jibLuff = 0.9 * Math.sin(Math.PI * smooth(0.45, 0.8, tau));
    applyPose();
  } else if (anim === 'hoist') {
    const c = t % 18;
    params.spin = true;
    params.hoist = c < 6 ? c / 6 : c < 12 ? 1 : Math.max(0, 1 - (c - 12) / 5);
  } else if (anim === 'collapse') {
    const c = t % 7;
    params.collapse = c < 1 ? 0 : c < 2 ? c - 1 : c < 3.5 ? 1 : Math.max(0, 1 - (c - 3.5) / 1.2);
    params.curl = c < 1 ? c : 0.9 * (1 - smooth(0.9, 1.3, c));
  } else if (anim === 'breathe') {
    params.jibLuff = base.jibLuff + 0.35 * Math.max(0, Math.sin(t * 0.6));
  }
};

// Control panel (hidden with ?ui=0).
if (q.get('ui') !== '0') buildPanel();

const DEG = Math.PI / 180;
const pose: DemoPose = { heel: 0, rudder: 0, crewY: 0, sheets: { main: 0.7, jib: 0.7, spin: 0.5 } };
const cpu: number[] = [];
let frameCount = 0;
const step = (dt: number, t: number): void => {
  let sails: SimSnapshot['sails'];
  let wind: { awa: number; aws: number; awaDeck: number; awsDeck: number };
  if (sim) {
    const snap = simStep(dt);
    sails = snap.sails;
    wind = snap.wind;
    const c = sim.controls;
    pose.heel = snap.boat.heel; pose.rudder = snap.boat.rudder; pose.crewY = snap.boat.crewHike;
    pose.sheets.main = c.mainSheet; pose.sheets.jib = c.jibSheet; pose.sheets.spin = c.spinSheet;
  } else {
    animate(t);
    sails = mockSails(params);
    wind = mockWind(params);
    // The mock has no helm or crew: sit the crew on the windward rail as the boat heels; sheets follow the trim.
    const ws = params.awa >= 0 ? 1 : -1;
    pose.heel = -boat.rotation.z; pose.rudder = 0; pose.crewY = ws * Math.min(1, 0.3 + Math.abs(pose.heel) / (15 * DEG));
    pose.sheets.main = 1 - Math.min(Math.abs(params.boom) / 80, 1);
    pose.sheets.jib = 1 - Math.min(Math.abs(params.clew) / 45, 1);
    pose.sheets.spin = params.spinSheet;
  }
  hull.update(sails, dt, pose);
  const a = performance.now();
  view.update(dt, t, sails, wind);
  // Statistics skip the first two seconds (JIT warm-up, first-use allocations).
  if (++frameCount > 120) cpu.push(performance.now() - a);
  if (cpu.length > 600) cpu.shift();
  if (cpu.length % 30 === 0) {
    // performance.now() is quantised (0.1 ms in Chromium): report the mean over many frames, and the
    // p95 of 10-frame means (a frame that is really slow still shows).
    const mean = cpu.reduce((x, y) => x + y, 0) / cpu.length;
    const groups: number[] = [];
    for (let i = 0; i + 10 <= cpu.length; i += 10) groups.push(cpu.slice(i, i + 10).reduce((x, y) => x + y, 0) / 10);
    groups.sort((x, y) => x - y);
    window.__sails = { cpuMs: mean, p95: groups[Math.floor(groups.length * 0.95)] ?? mean, tris: kit.renderer.info.render.triangles };
  }
};
// ?seek=T: step deterministically at 60 Hz from t = 0 to T, then hold that instant (filmstrips of motion).
const seek = q.has('seek') ? Number(q.get('seek')) : null;
let seeked = false;
let t0 = -1;
kit.onFrame((dt, now) => {
  if (seek !== null) {
    if (!seeked) {
      for (let k = 0; k <= Math.round(seek * 60); k++) step(1 / 60, k / 60);
      seeked = true;
    }
    return;
  }
  if (t0 < 0) t0 = now;
  step(dt, now - t0 + num('t', 0));
});
kit.start();

function buildPanel(): void {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:8px;top:8px;width:250px;max-height:calc(100% - 16px);overflow:auto;font:12px ui-sans-serif,system-ui;color:#eef3f8;background:rgba(10,22,38,.72);padding:8px 10px;border-radius:8px;backdrop-filter:blur(6px)';
  const sliders: Array<[keyof MockParams, number, number, number]> = [
    ['awa', -180, 180, 1], ['aws', 0, 14, 0.5], ['boom', -80, 80, 1], ['clew', -60, 60, 1], ['camber', 0, 0.2, 0.005],
    ['jibCamber', 0, 0.2, 0.005], ['twist', 0, 25, 1], ['mainLuff', 0, 1, 0.01], ['jibLuff', 0, 1, 0.01], ['stall', 0, 1, 0.01],
    ['furl', 0, 1, 0.01], ['hoist', 0, 1, 0.01], ['curl', 0, 1, 0.01], ['collapse', 0, 1, 0.01], ['pole', 0, 90, 1], ['spinSheet', 0, 1, 0.01],
  ];
  // The mock's sliders mean nothing when the real simulation drives the sails.
  for (const [k, min, max, step] of sim ? [] : sliders) {
    const row = document.createElement('label');
    row.style.cssText = 'display:grid;grid-template-columns:70px 1fr 44px;gap:6px;align-items:center;margin:3px 0';
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(params[k]);
    const out = document.createElement('span');
    const show = (x: number) => { out.textContent = String(Number(x.toFixed(3))); };
    show(Number(params[k]));
    out.style.textAlign = 'right';
    input.oninput = () => { (params as unknown as Record<string, number>)[k] = Number(input.value); show(Number(input.value)); applyPose(); };
    row.append(k, input, out);
    panel.append(row);
  }
  const check = (label: string, on: boolean, fn: (v: boolean) => void) => {
    const l = document.createElement('label');
    l.style.cssText = 'display:inline-flex;gap:4px;margin:4px 8px 4px 0;align-items:center';
    const c = document.createElement('input');
    c.type = 'checkbox'; c.checked = on; c.onchange = () => fn(c.checked);
    l.append(c, label);
    panel.append(l);
  };
  if (!sim) check('spinnaker', params.spin, (v) => { params.spin = v; });
  check('AoA colours', q.get('colour') === 'aoa', (v) => view.setColouring(v ? 'aoa' : 'none'));
  const buttons = (labels: string[], fn: (label: string) => void) => {
    const row = document.createElement('div');
    row.style.marginTop = '6px';
    for (const c of labels) {
      const b = document.createElement('button');
      b.textContent = c;
      b.style.cssText = 'margin:2px;font:11px ui-sans-serif;padding:2px 6px';
      b.onclick = () => fn(c);
      row.append(b);
    }
    panel.append(row);
  };
  buttons(['default', 'quarter', 'astern', 'helm', 'telltales', 'sailview', 'leech', 'side', 'bow', 'jib', 'spin', 'spinluff', 'windex'], setCamera);
  // With ?sim=1 the real crew does the work.
  if (sim) {
    buttons(['tack', 'gybe', 'spinnaker'], (c) => {
      if (c === 'spinnaker') sim.controls.spinHoist = !sim.controls.spinHoist;
      else sim.controls.command = c as 'tack' | 'gybe';
    });
  }
  document.body.append(panel);
}
