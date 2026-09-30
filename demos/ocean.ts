// Ocean demo: FFT sea, whitecaps, glitter, gust patches, wake, x-ray and the height sampler.
//   ?prod=1 renders through the production renderer, SkySystem, Lighting and PostChain (as the app does).
//   ?wind=12 (kn) &dir=240 (wind FROM, deg) &hour=17 &boat=1 (hull proxy circling at 5 kn)
//   &speed=5 (boat, kn) &puffs=1 (gust + lull patches) &xray=1 &marks=1 (buoys 30 m and 80 m beyond the boat) &cam=low|eye|high &az=<deg camera bearing from target>
//   &tier=ultra|high|medium|low &refl=off|half|full &swell=0.3 &fetch=15 &chop=1.1 &preroll=<s>
//   &freeze=1 (fixed 1/60 s steps for 2 s of frames — the sampler and spray need real frames — then time
//   stops: a repeatable photograph) &aim=<m> (camera aims this far forward of
//   the boat's centre, e.g. 3 = the bow) &dist= &height= (camera offset from the aim point) &fov=50
// Diagnostics: &check=1 (sampler point probes vs grids → window.__samplerCheck) &timing=1 (GPU cost → window.__oceanTiming) &debug=1…7 (wake, foam, normal, roughness,
// gusts, Fresnel, Kelvin) &skip=fft,wake,probe &nodraw=1
import * as THREE from 'three';
import { createStage } from './oceanStage';
import { tierSettings, type QualityTier } from '../src/render/core/types';
import { Ocean } from '../src/render/env/ocean/ocean';
import { defaultOceanParams } from '../src/render/env/ocean/spectrum';
import type { PuffPatch } from '../src/render/env/ocean/types';
import { BOAT } from '../src/shared/boatSpec';
import { KN } from '../src/shared/math';

declare global {
  interface Window {
    __ocean?: Record<string, unknown>;
    __oceanTiming?: Record<string, number | string>;
    __samplerCheck?: Record<string, unknown>;
  }
}

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) ? Number(params.get(k)) : d);
const flag = (k: string): boolean => params.get(k) === '1';
const deg = THREE.MathUtils.degToRad;

const hasBoat = flag('boat');
const cam = params.get('cam') ?? 'eye';
const preset = { low: { dist: 9, height: 1.3 }, eye: { dist: 16, height: 3.6 }, high: { dist: 58, height: 44 } }[cam] ?? { dist: 16, height: 3.6 };
const camAz = deg(num('az', 150));
const camDist = num('dist', preset.dist);
const camHeight = num('height', preset.height);

const q = tierSettings((params.get('tier') ?? 'high') as QualityTier);
if (params.has('refl')) q.reflections = params.get('refl') as typeof q.reflections;
const windKn = num('wind', 12);
const windFrom = deg(num('dir', 240));
const kit = createStage({
  prod: flag('prod'), quality: q, hour: num('hour', 17), windFrom, windSpeed: windKn * KN, fov: num('fov', 50),
  cameraPos: [Math.sin(camAz) * camDist, camHeight, -Math.cos(camAz) * camDist], target: [0, 0.6, 0],
});

const sea = defaultOceanParams(windKn, windFrom);
sea.swellHeight = num('swell', sea.swellHeight);
sea.fetchKm = num('fetch', sea.fetchKm);
sea.choppiness = num('chop', sea.choppiness);

const ocean = new Ocean(kit.renderer, kit.scene, kit.sky, q);
ocean.setParams(sea);
ocean.setXray(flag('xray'));
ocean.setDebugView(num('debug', 0));

// ------------------------------------------------------------------ hull proxy (Kestrel 25 lines)
function halfBeamAt(x: number, stem: number, transom: number, xm: number, hb: number): number {
  if (x >= xm) { const u = (x - xm) / (stem - xm); return hb * Math.pow(Math.max(1 - u * u, 0), 0.7); }
  const u = (xm - x) / (xm - transom);
  return hb * (1 - 0.28 * u * u);
}

function hullProxy(): THREE.Group {
  const H = BOAT.hull;
  const rings = [
    { y: -H.canoeDraft, stem: H.stemWL.x - 0.8, transom: H.transomWL.x + 0.5, hb: H.bwl * 0.27 },
    { y: 0, stem: H.stemWL.x, transom: H.transomWL.x, hb: H.bwl / 2 },
    { y: 0.78, stem: H.stemDeck.x, transom: H.transomDeck.x, hb: H.beam / 2 },
  ];
  const n = 28;
  const ringPoints = rings.map((r) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const x = r.transom + ((r.stem - r.transom) * (1 - Math.cos((Math.PI * i) / n))) / 2;
      pts.push(new THREE.Vector3(halfBeamAt(x, r.stem, r.transom, H.maxBeamX, r.hb), r.y, -x));
    }
    for (let i = n - 1; i >= 1; i--) { const p = pts[i]!; pts.push(new THREE.Vector3(-p.x, p.y, p.z)); }
    return pts;
  });
  const m = ringPoints[0]!.length;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const colorAt = (y: number) => (y < 0.04 ? [0.05, 0.07, 0.1] : y < 0.12 ? [0.03, 0.05, 0.16] : [0.92, 0.93, 0.92]);
  for (const ring of ringPoints) for (const p of ring) { pos.push(p.x, p.y, p.z); col.push(...colorAt(p.y)); }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < m; i++) {
      const a = r * m + i, b = r * m + ((i + 1) % m), c = a + m, d = b + m;
      idx.push(a, b, c, b, d, c);
    }
  }
  // Deck and bottom caps as fans around their centroids (separate vertices keep the edges crisp).
  const cap = (ring: THREE.Vector3[], up: boolean, rgb: number[]) => {
    const base = pos.length / 3;
    const cz = ring.reduce((s, p) => s + p.z, 0) / ring.length;
    pos.push(0, ring[0]!.y, cz); col.push(...rgb);
    for (const p of ring) { pos.push(p.x, p.y, p.z); col.push(...rgb); }
    for (let i = 0; i < ring.length; i++) {
      const a = base + 1 + i, b = base + 1 + ((i + 1) % ring.length);
      if (up) idx.push(base, a, b); else idx.push(base, b, a);
    }
  };
  cap(ringPoints[2]!, true, [0.6, 0.62, 0.63]);
  cap(ringPoints[0]!, false, [0.05, 0.07, 0.1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const hull = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, side: THREE.DoubleSide }));
  hull.castShadow = true;
  const keel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.85), new THREE.MeshStandardMaterial({ color: 0x1a2028, roughness: 0.7 }));
  keel.position.set(0, -0.36 - 0.55, -0.25);
  const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.34), new THREE.MeshStandardMaterial({ color: 0x1a2028, roughness: 0.7 }));
  rudder.position.set(0, -0.15 - 0.5, 2.85);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, BOAT.mast.topH - BOAT.mast.baseH, 12), new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 0.8, roughness: 0.3 }));
  mast.position.set(0, (BOAT.mast.topH + BOAT.mast.baseH) / 2, -BOAT.mast.x);
  mast.castShadow = true;
  const group = new THREE.Group();
  group.add(hull, keel, rudder, mast);
  group.rotation.order = 'YXZ';
  return group;
}

// ------------------------------------------------------------------ scene objects
const RADIUS = 70;
const SPEED = num('speed', 5) * KN;
const OMEGA = SPEED / RADIUS;
const preroll = num('preroll', hasBoat ? 24 : 8);
let seaTime = num('t0', 40);
let boatAngle = deg(200) - OMEGA * preroll;

const boat = hasBoat ? hullProxy() : null;
if (boat) { kit.scene.add(boat); kit.follow(boat); }
const pose = { heave: 0, pitch: 0, roll: 0 };

function boatState(angle: number) {
  const e = RADIUS * Math.sin(angle), n = RADIUS * Math.cos(angle);
  return { e, n, heading: angle + Math.PI / 2, speed: SPEED, heel: 0 };
}

const buoy = new THREE.Group();
{
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.35, 32, 16), new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.45 }));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.352, 0.018, 8, 48).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 }));
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8), new THREE.MeshStandardMaterial({ color: 0x333333 }));
  pole.position.y = 0.75;
  const flagMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.2), new THREE.MeshStandardMaterial({ color: 0xffd400, side: THREE.DoubleSide }));
  flagMesh.position.set(0.15, 1.05, 0);
  buoy.add(ball, ring, pole, flagMesh);
  kit.scene.add(buoy);
}
// Buoy just inside the circle, a little ahead of where the boat ends the pre-roll.
const buoyPos = (() => {
  if (!hasBoat) return { e: 0, n: 0 };
  const a = boatAngle + OMEGA * preroll + 14 / RADIUS;
  const r = RADIUS - 7;
  return { e: r * Math.sin(a), n: r * Math.cos(a) };
})();

// ------------------------------------------------------------------ distant marks (&marks=1)
// Buoys 30 m and 80 m beyond the boat, as the app's Marks drive them: heave from heightAt at the centre,
// tilt from ±0.6 m slopes. Their queries register point probes, so they ride the drawn chop exactly.
interface DemoMark { e: number; n: number; obj: THREE.Object3D; roll: number; pitch: number }
const farMarks: DemoMark[] = [];
if (flag('marks')) {
  // The camera keeps its offset from the boat, so "beyond the boat" is along target − camera.
  const b = boatState(boatAngle + OMEGA * preroll);
  const away = new THREE.Vector2(kit.controls.target.x - kit.camera.position.x, kit.controls.target.z - kit.camera.position.z).normalize();
  for (const [dist, side] of [[30, 6], [80, -14]] as const) {
    const x = b.e + away.x * dist - away.y * side, z = -b.n + away.y * dist + away.x * side;
    const obj = buoy.clone();
    kit.scene.add(obj);
    farMarks.push({ e: x, n: -z, obj, roll: 0, pitch: 0 });
  }
}
function updateFarMarks(): void {
  const s = ocean.sampler;
  for (const m of farMarks) {
    const h = s.heightAt(m.e, m.n, seaTime);
    const slopeE = (s.heightAt(m.e + 0.6, m.n, seaTime) - s.heightAt(m.e - 0.6, m.n, seaTime)) / 1.2;
    const slopeN = (s.heightAt(m.e, m.n + 0.6, seaTime) - s.heightAt(m.e, m.n - 0.6, seaTime)) / 1.2;
    m.obj.position.set(m.e, h, -m.n);
    m.obj.rotation.set(Math.atan(slopeN), 0, -Math.atan(slopeE), 'XZY');
  }
}

// ------------------------------------------------------------------ gust / lull patches
const puffs: PuffPatch[] = [];
if (flag('puffs')) {
  // Laid out in front of the camera so they read from 10–60 m (lessons teach spotting them).
  const look = new THREE.Vector3().subVectors(kit.controls.target, kit.camera.position).setY(0).normalize();
  const side = new THREE.Vector3(-look.z, 0, look.x);
  const place = (ahead: number, across: number, along: number, acrossR: number, strength: number, dirOff = 0): PuffPatch => {
    const p = kit.controls.target.clone().addScaledVector(look, ahead).addScaledVector(side, across);
    return { e: p.x, n: -p.z, radiusAlong: along, radiusAcross: acrossR, strength, windFrom: windFrom + deg(dirOff) };
  };
  puffs.push(
    place(22, -16, 16, 28, 0.45, 6),
    place(70, 34, 30, 55, -0.3),
    place(130, -60, 45, 80, 0.4, 8),
    place(240, 90, 60, 110, 0.35),
    place(380, -150, 70, 140, -0.28),
    place(520, 120, 90, 180, 0.42),
  );
}
const drift = { e: -Math.sin(windFrom) * 0.5 * sea.windSpeed, n: -Math.cos(windFrom) * 0.5 * sea.windSpeed };

// ------------------------------------------------------------------ per-frame
const target = new THREE.Vector3();
function step(dt: number): void {
  seaTime += dt;
  for (const p of puffs) { p.e += drift.e * dt; p.n += drift.n * dt; }
  ocean.setPuffs(puffs);
  const s = ocean.sampler;
  if (boat) {
    boatAngle += OMEGA * dt;
    const b = boatState(boatAngle);
    ocean.setBoat(b);
    const fe = Math.sin(b.heading), fn = Math.cos(b.heading);
    const h = (dx: number, dy: number) => s.heightAt(b.e + fe * dx + fn * dy, b.n + fn * dx - fe * dy, seaTime);
    const bow = h(2.4, 0), stern = h(-2.4, 0), port = h(-0.3, -0.9), stbd = h(-0.3, 0.9), mid = h(0, 0);
    const k = 1 - Math.exp(-dt / 0.35);
    pose.heave += ((bow + stern + port + stbd + mid) / 5 - pose.heave) * k;
    pose.pitch += (Math.atan2(bow - stern, 4.8) - pose.pitch) * k;
    pose.roll += (Math.atan2(port - stbd, 1.8) - pose.roll) * k;
    boat.position.set(b.e, pose.heave, -b.n);
    boat.rotation.set(pose.pitch, -b.heading, -pose.roll);
    const aim = num('aim', 0);
    target.set(b.e + fe * aim, aim !== 0 ? 0.4 : 1.0, -(b.n + fn * aim));
  } else {
    target.set(0, 0.6, 0);
  }
  updateFarMarks();
  const hb = s.heightAt(buoyPos.e, buoyPos.n, seaTime);
  const nb = s.normalAt(buoyPos.e, buoyPos.n, seaTime);
  buoy.position.set(buoyPos.e, hb, -buoyPos.n);
  buoy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nb.x, nb.y, nb.z));
  ocean.update(dt, seaTime, kit.camera);
}

// Keep the orbit offset while following the boat.
function follow(): void {
  const delta = target.clone().sub(kit.controls.target);
  kit.controls.target.add(delta);
  kit.camera.position.add(delta);
}

// Pre-roll so the wake and the foam have built up before the first frame.
const PRE_DT = 1 / 20;
for (let i = 0; i < Math.round(preroll / PRE_DT); i++) step(PRE_DT);
follow();
kit.controls.update();

for (const k of (params.get('skip') ?? '').split(',')) if (k === 'fft' || k === 'wake' || k === 'probe') ocean.skip[k] = true;
if (flag('nodraw')) ocean.mesh.visible = false;
const timing = flag('timing');
const freeze = flag('freeze');
const gl = kit.renderer.getContext() as WebGL2RenderingContext;
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
let frame = 0;

// GPU cost by synchronous fencing: a 1-pixel readPixels cannot return before the GPU has finished all
// queued work, so (fence, N × work, fence) / N is the GPU time of the work. (EXT_disjoint_timer_query
// numbers on ANGLE-Metal include command-buffer gaps and are not additive, so they are not used.)
const pixel = new Uint8Array(4);
const fence = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
const REPS = 10;
const cost = { passes: [] as number[], withSea: [] as number[], withoutSea: [] as number[] };
function measure(work: () => void): number {
  fence();
  const t0 = performance.now();
  for (let i = 0; i < REPS; i++) work();
  fence();
  return (performance.now() - t0) / REPS;
}

kit.onFrame((dt) => {
  if (timing && frame > 30 && frame <= 90) {
    cost.passes.push(measure(() => step(1 / 60 / REPS)));
    cost.withSea.push(measure(() => kit.renderer.render(kit.scene, kit.camera)));
    ocean.mesh.visible = false;
    cost.withoutSea.push(measure(() => kit.renderer.render(kit.scene, kit.camera)));
    ocean.mesh.visible = true;
    if (frame === 90) {
      const passes = median(cost.passes), draw = median(cost.withSea) - median(cost.withoutSea);
      const min = (a: number[]) => Math.min(...a);
      window.__oceanTiming = {
        passesMs: +passes.toFixed(2), oceanDrawMs: +draw.toFixed(2), oceanTotalMs: +(passes + draw).toFixed(2),
        minTotalMs: +(min(cost.passes) + min(cost.withSea) - min(cost.withoutSea)).toFixed(2),
        sceneWithoutSeaMs: +median(cost.withoutSea).toFixed(2), triangles: ocean.triangles, tier: q.tier,
        pixels: kit.renderer.domElement.width * kit.renderer.domElement.height,
      };
    }
  } else if (!freeze) {
    step(Math.min(dt, 1 / 20));
  } else if (frame < 120) {
    step(1 / 60);
  } else {
    ocean.update(0, seaTime, kit.camera);
  }
  if (boat) follow();
  frame++;
  const st = ocean.seaState;
  window.__ocean = {
    windKn, hs: +st.totalHs.toFixed(3), windHs: +st.windHs.toFixed(3), tp: +st.windTp.toFixed(2),
    buoyY: +buoy.position.y.toFixed(3), heave: +pose.heave.toFixed(3), triangles: ocean.triangles,
    spray: { ...ocean.sprayStats },
    probePoints: ocean.probePointCount,
  };
  if (flag('check')) window.__samplerCheck = samplerCheck();
});
/**
 * &check=1: for each far mark (and a point 12 m upwind of the boat, inside the fine grid), the sampler's
 * registered-point value against what the boat grids would have served there — the review's I-1 gap.
 */
const checkSums = new Map<string, { n: number; d2: number; p2: number }>();
function samplerCheck(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const grid = { h: 0, sx: 0, sz: 0 };
  const points: Array<[string, number, number]> = farMarks.map((m, i) => [`mark${i}`, m.e, m.n]);
  if (boat) {
    const b = boatState(boatAngle);
    points.push(['upwind12m', b.e + Math.sin(windFrom) * 12, b.n + Math.cos(windFrom) * 12]);
  }
  for (const [name, e, n] of points) {
    const probed = ocean.sampler.heightAt(e, n, seaTime);
    const hasGrid = ocean.sampleGridsOnly(e, -n, grid);
    // RMS over the animated frames (the instantaneous difference depends on the wave phase there).
    const acc = checkSums.get(name) ?? { n: 0, d2: 0, p2: 0 };
    if (hasGrid && frame > 10 && frame < 120) { acc.n++; acc.d2 += (probed - grid.h) ** 2; acc.p2 += probed * probed; }
    checkSums.set(name, acc);
    out[name] = {
      probed: +probed.toFixed(3), grids: hasGrid ? +grid.h.toFixed(3) : null,
      rmsHeight: acc.n ? +Math.sqrt(acc.p2 / acc.n).toFixed(3) : null,
      rmsGridError: acc.n ? +Math.sqrt(acc.d2 / acc.n).toFixed(3) : null, frames: acc.n,
    };
  }
  return out;
}
kit.start();

