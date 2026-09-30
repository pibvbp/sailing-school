// Boat demo: the procedural Kestrel 25 at the waterline on a dark glossy stand-in sea.
//   ?prod=1                        production renderer + SkySystem + Lighting + PostChain (AgX, auto-exposure)
//                                  (default: the shared demo kit)
//   ?view=side|bow|stern|deck|quarter|helm|cockpit|mastbase|bowclose|transom|keel|sailing|sheets|pole|crew
//   ?pose=rest|sail|spin           preset pose (rest: jib furled, boom centred)
//   ?boom=deg&rudder=deg&heel=deg&crew=-1..1&furl=0..1&jib=deg   pose overrides
//   ?hour=17  ?lift=m (raise the boat to inspect the keel)  ?tier=ultra|high|medium|low
//   ?sails=1                       simple placeholder sails (demo only; the real sails are Task 13)
//   ?helm=0                        hide the helmsman everywhere; ?helm=cam hides him for this camera only
//                                  (camera.userData[BoatModel.HIDE_HELMSMAN], as the helm camera should)
//   ?anim=tack|dither|hike         drive crewY/heel through repeated tacks (?period=s), a downwind dither
//                                  around 0, or a breeze building to full hike and back; ?at=s runs it for
//                                  s seconds at a fixed 60 Hz before the first frame and holds (stills)
//   ?jiblead=-1..1&car=m           optional pose fields: jib-lead cars, traveller car (m, + stbd)
//   ?ui=0                          hide the slider panel (for screenshots)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BoatModel, type BoatPose } from '../src/render/boat/BoatModel';
import { createRenderer } from '../src/render/core/renderer';
import { PostChain } from '../src/render/core/post';
import { tierSettings, type QualityTier } from '../src/render/core/types';
import { Lighting } from '../src/render/env/lighting';
import { SkySystem } from '../src/render/env/sky';
import { BOAT } from '../src/shared/boatSpec';
import { bodyToLocal } from '../src/shared/coords';
import { createDemoKit } from './shared/demoKit';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) && params.get(k) !== '' ? Number(params.get(k)) : d);
const DEG = Math.PI / 180;
const tier = (params.get('tier') ?? 'high') as QualityTier;
const quality = tierSettings(tier);
const prod = params.get('prod') === '1';

const VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
  side: { pos: [17, 2.4, 0.6], target: [0, 3.6, -0.2], fov: 38 },
  bow: { pos: [4.6, 2.2, -10.5], target: [0, 1.9, -0.6], fov: 42 },
  stern: { pos: [-4.2, 2.6, 10.5], target: [0, 1.9, 0.2], fov: 42 },
  deck: { pos: [1.8, 6.2, 8.2], target: [0, 1.0, -0.8], fov: 45 },
  quarter: { pos: [9.5, 3.4, 9.5], target: [0, 2.9, -0.3], fov: 42 },
  sailing: { pos: [11, 2.2, -6.5], target: [0, 3.2, 0], fov: 44 },
  helm: { pos: [0.95, 1.45, 2.3], target: [0.2, 1.2, -3.2], fov: 62 },
  cockpit: { pos: [0.35, 2.6, 5.6], target: [0, 0.55, 2.0], fov: 48 },
  mastbase: { pos: [1.0, 1.95, 0.6], target: [0, 1.25, -1.05], fov: 50 },
  bowclose: { pos: [1.6, 1.7, -6.0], target: [0, 1.0, -3.7], fov: 45 },
  transom: { pos: [1.4, 1.3, 6.6], target: [0, 0.55, 3.6], fov: 45 },
  keel: { pos: [7.5, 1.0, 1.5], target: [0, 0.4, 0.2], fov: 42 },
  sheets: { pos: [-3.2, 3.4, 4.8], target: [-0.3, 1.0, -0.6], fov: 50 },
  pole: { pos: [4.6, 3.2, 3.6], target: [0.6, 1.8, -1.6], fov: 50 },
  crew: { pos: [-0.35, 1.95, 0.1], target: [0.75, 1.35, 1.5], fov: 45 },
};
const viewName = params.get('view') ?? 'quarter';
const view = VIEWS[viewName] ?? VIEWS.quarter;

// --- Environment: shared kit or the production chain ----------------------------------------------
interface Env { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; onFrame(cb: (dt: number) => void): void; start(): void; follow(o: THREE.Object3D): void }

function kitEnv(): Env {
  const kit = createDemoKit({ cameraPos: view.pos, target: view.target, fov: view.fov });
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new THREE.MeshPhysicalMaterial({ color: 0x0b2236, roughness: 0.1, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.12 }),
  );
  water.receiveShadow = true;
  kit.scene.add(water);
  return { renderer: kit.renderer, scene: kit.scene, camera: kit.camera, onFrame: (cb) => kit.onFrame((dt) => cb(dt)), start: () => kit.start(), follow: () => {} };
}

/** Small tileable ripple normal map for the stand-in sea (a few wind-wave components). */
function ripples(size: number): THREE.DataTexture {
  const waves = Array.from({ length: 48 }, (_, i) => {
    const a = 0.5 + (((i * 0.618) % 1) - 0.5) * 1.6;
    const k = 2 + ((i * 11) % 41);
    return { kx: Math.round(Math.cos(a) * k), ky: Math.round(Math.sin(a) * k), amp: 1 / k, ph: i * 2.3 };
  });
  const data = new Uint8Array(size * size * 4);
  const n = new THREE.Vector3();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let gx = 0, gy = 0;
    for (const w of waves) {
      const c = w.amp * Math.cos((2 * Math.PI * (w.kx * x + w.ky * y)) / size + w.ph);
      gx += c * w.kx * 0.05; gy += c * w.ky * 0.05;
    }
    n.set(-gx, -gy, 1).normalize();
    const i = (y * size + x) * 4;
    data[i] = (n.x * 0.5 + 0.5) * 255; data[i + 1] = (n.y * 0.5 + 0.5) * 255; data[i + 2] = (n.z * 0.5 + 0.5) * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.repeat.set(4000 / 9, 4000 / 9);
  t.needsUpdate = true;
  return t;
}

function prodEnv(): Env {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#000';
  document.body.appendChild(canvas);
  const renderer = createRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(view.fov, innerWidth / innerHeight, 0.05, 40000);
  camera.position.set(...view.pos);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(...view.target);
  controls.enableDamping = true;
  controls.update();
  const sky = new SkySystem(renderer, scene, quality, { hours: num('hour', 17), cloudCover: num('clouds', 0.3) });
  const lighting = new Lighting(scene, sky, quality);
  const post = new PostChain(renderer, scene, camera, quality);
  post.setToneMapping('agx');
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(0.004, 0.016, 0.022, THREE.LinearSRGBColorSpace), roughness: 0.1, metalness: 0, ior: 1.333, normalMap: ripples(256), normalScale: new THREE.Vector2(0.22, 0.22) }),
  );
  sea.receiveShadow = true;
  scene.add(sea);
  const resize = () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); post.setSize(innerWidth, innerHeight); };
  addEventListener('resize', resize);
  resize();
  const cbs: Array<(dt: number) => void> = [];
  const readout = document.createElement('div');
  readout.style.cssText = 'position:fixed;left:8px;bottom:8px;font:12px ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.45);padding:4px 6px;border-radius:4px;pointer-events:none';
  if (params.get('ui') !== '0') document.body.appendChild(readout);
  let last = performance.now(), frames = 0, avg = 16.7;
  renderer.info.autoReset = false;
  return {
    renderer, scene, camera,
    onFrame: (cb) => cbs.push(cb),
    follow: (o) => lighting.follow(o),
    start: () => renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      controls.update();
      for (const cb of cbs) cb(dt);
      sky.update(dt, camera, 200 * DEG, 12 * 0.5144);
      lighting.update();
      renderer.info.reset();
      post.render(dt);
      avg = avg * 0.95 + dt * 1000 * 0.05;
      frames++;
      if (frames % 20 === 0) {
        const info = renderer.info.render;
        window.__stats = { frameMs: avg, fps: 1000 / avg, calls: info.calls, triangles: info.triangles };
        readout.textContent = `${avg.toFixed(1)} ms · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · exposure ${sky.exposure.toFixed(3)}`;
      }
      if (frames === 3) window.__ready = true;
    }),
  };
}

const env = prod ? prodEnv() : kitEnv();

// --- Boat ------------------------------------------------------------------------------------------
const t0 = performance.now();
// No SailsView here, so the boat draws its own furled-jib roll (off by default in the app).
const boat = new BoatModel(quality, { furledJib: true });
const buildMs = performance.now() - t0;
env.scene.add(boat.root);
env.follow(boat.root);
boat.root.position.y = num('lift', 0);
if (params.get('helm') === '0') boat.setHelmVisible(false);
if (params.get('helm') === 'cam') env.camera.userData[BoatModel.HIDE_HELMSMAN] = true;

// --- Pose presets ------------------------------------------------------------------------------
const preset = params.get('pose') ?? (viewName === 'sailing' ? 'sail' : 'rest');
const jibTack = BOAT.jib.tack;

function clewFromAngle(angle: number, furl: number): { x: number; y: number; z: number } {
  // Clew on a circle around the tack at clew height (+ angle = to port); furling winds it in to the foil.
  const r = BOAT.jib.foot * (1 - 0.9 * furl);
  return { x: jibTack.x - r * Math.cos(angle), y: -r * Math.sin(angle), z: -(BOAT.jib.clewH + 0.3 * furl) };
}

const pose: BoatPose = {
  boomAngle: 0,
  rudder: 0,
  jibClew: clewFromAngle(0.02, 1),
  jibFurl: 1,
  spin: { visible: false, poleAngle: 0, poleTipH: 2.2, tack: { x: 3, y: 0, z: -2 }, clew: { x: 0, y: -3, z: -2 } },
  crewY: 0.55,
  heel: 0,
  sheets: { main: 0.5, jib: 0.5, spin: 0.5 },
};
let jibAngle = 0.02;
if (preset === 'sail') {
  Object.assign(pose, { boomAngle: 9 * DEG, jibFurl: 0, crewY: 1, heel: -17 * DEG, rudder: -3 * DEG, sheets: { main: 0.8, jib: 0.85, spin: 0.5 } });
  jibAngle = 11 * DEG;
} else if (preset === 'spin') {
  Object.assign(pose, { boomAngle: 72 * DEG, jibFurl: 1, crewY: 0.45, heel: -4 * DEG, sheets: { main: 0.2, jib: 0.1, spin: 0.6 } });
  const poleAngle = 58 * DEG, tipH = 2.5;
  const L = BOAT.spinnaker.poleLength;
  const inboard = BOAT.mast.x + BOAT.mast.sectionBase[0] / 2 + 0.03;
  const tack = { x: inboard + L * Math.cos(poleAngle), y: L * Math.sin(poleAngle), z: -tipH };
  pose.spin = { visible: true, poleAngle, poleTipH: tipH, tack, clew: { x: -0.6, y: -3.4, z: -3.0 } };
}
pose.boomAngle = num('boom', pose.boomAngle / DEG) * DEG;
pose.rudder = num('rudder', pose.rudder / DEG) * DEG;
pose.heel = num('heel', pose.heel / DEG) * DEG;
pose.crewY = num('crew', pose.crewY);
pose.jibFurl = num('furl', pose.jibFurl);
jibAngle = num('jib', jibAngle / DEG) * DEG;
pose.jibClew = clewFromAngle(jibAngle, pose.jibFurl);
if (params.has('jiblead')) pose.jibLead = num('jiblead', 0);
if (params.has('car')) pose.travelerCarY = num('car', 0);

function applyPose(): void {
  boat.root.rotation.set(0, 0, -pose.heel, 'YXZ');
  boat.setPose(pose);
}
applyPose();

// --- Optional placeholder sails (cambered, demo only) -----------------------------------------------
const sailGroup = new THREE.Group();
boat.root.add(sailGroup);
const sailMat = new THREE.MeshStandardMaterial({ color: 0xece8dc, roughness: 0.78, side: THREE.DoubleSide });
function sailSurface(tack: THREE.Vector3, head: THREE.Vector3, clew: THREE.Vector3, camber: number, side: number): THREE.BufferGeometry {
  const nu = 16, nv = 24;
  const pos: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    const luff = new THREE.Vector3().lerpVectors(tack, head, v);
    const leech = new THREE.Vector3().lerpVectors(clew, head, Math.pow(v, 0.9));
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const p = new THREE.Vector3().lerpVectors(luff, leech, u);
      p.x += side * camber * luff.distanceTo(leech) * 4 * u * (1 - u) * (1.1 - 0.6 * u) * (1 - 0.5 * v);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i;
    idx.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
function rebuildSails(): void {
  for (const c of [...sailGroup.children]) { (c as THREE.Mesh).geometry.dispose(); sailGroup.remove(c); }
  if (params.get('sails') !== '1') return;
  const a = boat.anchors;
  const side = pose.boomAngle >= 0 ? -1 : 1;
  const main = new THREE.Mesh(sailSurface(a.gooseneck.clone().add(new THREE.Vector3(0, 0.06, -0.03)), a.mastTop.clone().add(new THREE.Vector3(0, -0.2, 0.08)), a.boomEnd(pose.boomAngle).add(new THREE.Vector3(0, 0.06, 0)), 0.09, side), sailMat);
  main.castShadow = main.receiveShadow = true;
  sailGroup.add(main);
  if (pose.jibFurl < 0.5) {
    const c = bodyToLocal(pose.jibClew);
    const head = a.forestayTack.clone().lerp(a.forestayHead, 0.955);
    const jib = new THREE.Mesh(sailSurface(a.forestayTack.clone().add(new THREE.Vector3(0, 0.08, 0)), head, new THREE.Vector3(c.x, c.y, c.z), 0.1, c.x < 0 ? -1 : 1), sailMat);
    jib.castShadow = jib.receiveShadow = true;
    sailGroup.add(jib);
  }
}
rebuildSails();

// --- Slider panel ------------------------------------------------------------------------------
if (params.get('ui') !== '0') {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:10px;top:10px;background:rgba(10,20,34,.72);color:#e8eef5;font:12px system-ui;padding:10px 12px;border-radius:8px;display:grid;grid-template-columns:auto 160px 42px;gap:4px 8px;align-items:center;z-index:2';
  const slider = (label: string, min: number, max: number, value: number, set: (v: number) => void) => {
    const l = document.createElement('span'); l.textContent = label;
    const s = document.createElement('input'); s.type = 'range'; s.min = String(min); s.max = String(max); s.step = 'any'; s.value = String(value);
    const o = document.createElement('span'); o.textContent = value.toFixed(1);
    s.oninput = () => { const v = Number(s.value); o.textContent = v.toFixed(1); set(v); applyPose(); rebuildSails(); };
    panel.append(l, s, o);
  };
  slider('boom°', -80, 80, pose.boomAngle / DEG, (v) => { pose.boomAngle = v * DEG; });
  slider('rudder°', -35, 35, pose.rudder / DEG, (v) => { pose.rudder = v * DEG; });
  slider('heel°', -35, 35, pose.heel / DEG, (v) => { pose.heel = v * DEG; });
  slider('crew', -1, 1, pose.crewY, (v) => { pose.crewY = v; });
  slider('jib°', -40, 40, jibAngle / DEG, (v) => { jibAngle = v * DEG; pose.jibClew = clewFromAngle(jibAngle, pose.jibFurl); });
  slider('furl', 0, 1, pose.jibFurl, (v) => { pose.jibFurl = v; pose.jibClew = clewFromAngle(jibAngle, v); });
  document.body.appendChild(panel);
}

// Animated crew checks: tacks (crewY lags the helm like the sim's auto-crew), downwind dither, hiking.
const anim = params.get('anim');
const period = num('period', 8);
const holdAt = params.has('at') ? num('at', 0) : null;
let clock = 0;
function animate(dt: number): void {
  clock += dt;
  if (anim === 'tack') {
    const u = (clock % period) / period;               // one tack each half period
    const flip = (x: number) => Math.cos(Math.PI * THREE.MathUtils.smoothstep(x, 0.1, 0.1 + 1.6 / period));
    const side = u < 0.5 ? flip(u) : -flip(u - 0.5);
    pose.crewY = side;
    pose.heel = -0.26 * side;
    pose.boomAngle = 0.16 * side;
    applyPose();
  } else if (anim === 'dither') {
    pose.crewY = 0.05 * Math.sin(clock * 2 * Math.PI * 0.9) + 0.02 * Math.sin(clock * 5.1);
    pose.heel = 0.03 * Math.sin(clock * 1.3);
    applyPose();
  } else if (anim === 'hike') {
    pose.crewY = 0.55 + 0.45 * Math.sin(clock * 2 * Math.PI / period);
    pose.heel = -0.3 * pose.crewY;
    applyPose();
  }
  boat.update(dt);
}
if (holdAt !== null) {
  for (let t = 0; t < holdAt - 1e-9; t += 1 / 60) animate(1 / 60);
  rebuildSails();
}
env.onFrame((dt) => (holdAt !== null ? boat.update(0) : animate(dt)));
env.start();

declare global { interface Window { __boat?: { buildStats: BoatModel['buildStats']; buildMs: number; triangles: () => number; breakdown: () => Record<string, number>; updateMs: () => number; gpuMs: () => Record<string, number> } } }
window.__boat = {
  buildStats: boat.buildStats,
  buildMs,
  triangles: () => {
    let t = 0;
    boat.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && m.geometry) t += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
    });
    return Math.round(t);
  },
  breakdown: () => {
    const out: Record<string, number> = {};
    boat.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const key = m.name || m.parent?.name || '?';
      out[key] = (out[key] ?? 0) + Math.round((m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3);
    });
    return out;
  },
  /**
   * GPU time of the scene render (incl. the shadow pass) with and without the boat: N renders into an
   * off-screen HDR target, then a 1-pixel readback waits for the GPU. Best of 5 rounds.
   */
  gpuMs: () => {
    const r = env.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    const px = new Uint16Array(4);
    const draw = () => { r.setRenderTarget(target); r.clear(); r.render(env.scene, env.camera); };
    const sync = () => r.readRenderTargetPixels(target, 0, 0, 1, 1, px);
    const time = (runs: number) => { draw(); sync(); const t = performance.now(); for (let i = 0; i < runs; i++) draw(); sync(); return (performance.now() - t) / runs; };
    const best = () => Math.min(...[0, 1, 2, 3, 4].map(() => time(15)));
    const withBoat = best();
    boat.root.visible = false;
    const without = best();
    boat.root.visible = true;
    r.setRenderTarget(null);
    target.dispose();
    return { sceneWithBoatMs: withBoat, sceneWithoutBoatMs: without, boatMs: withBoat - without, width: size.x, height: size.y };
  },
  /** CPU cost of a full pose update (ropes, crew, extension), averaged over 200 runs. */
  updateMs: () => {
    const t = performance.now();
    for (let i = 0; i < 200; i++) { pose.crewY = Math.sin(i * 0.1); pose.boomAngle = 0.3 * Math.sin(i * 0.07); boat.setPose(pose); boat.update(1 / 60); }
    return (performance.now() - t) / 200;
  },
};
