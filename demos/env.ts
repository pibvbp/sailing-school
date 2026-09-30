// Environment demo: production renderer, post chain, sky/clouds, sun light, distant land and marks over a
// flat stand-in sea (the FFT ocean replaces it in the app).
//
// Query: ?hour=17 ?clouds=0.35 ?view=<compass deg the camera looks at> ?pitch=-1 ?height=2.6 ?fov=50
//        ?tier=high ?tone=agx|aces ?wind=12 (kn) ?windFrom=200 (deg) ?drift=<s of cloud drift>
//        ?probe=1 (grey/white/chrome test objects) ?probe=2 (deck + rig: shadows, whites) ?hud=0
//        ?bench=1 (GPU cost of sky/scene/post) ?bench=post (post layouts)
//        ?markView=<deg> (bearing the marks are laid out around) ?flash=1 (lighthouse lamp held on)
//        tuning: ?turbidity= ?rayleigh= ?mie= ?mieg= ?sexp= ?ev=<exposure bias in stops> ?meter=0..1
//                ?cscale= ?cedge= ?cdensity= ?ccoverage= ?celev= (clouds) ?wslope= ?wrough= ?wtile= (stand-in sea)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BlendFunction, BloomEffect, EffectComposer, EffectPass, FXAAEffect, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { createRenderer } from '../src/render/core/renderer';
import { PostChain, type ToneMapping } from '../src/render/core/post';
import { QualityGovernor, tierSettings, type QualityTier } from '../src/render/core/quality';
import { ATMOSPHERE, SkySystem } from '../src/render/env/sky';
import { Lighting } from '../src/render/env/lighting';
import { Land } from '../src/render/env/land';
import { Marks } from '../src/render/env/marks';

declare global {
  interface Window { __env?: Record<string, unknown> }
}

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const v = params.get(key);
  return v === null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v);
};
const KN = 0.514444;
const hour = num('hour', 17);
const tier = (params.get('tier') ?? 'high') as QualityTier;
const quality = tierSettings(tier);
const windFrom = THREE.MathUtils.degToRad(num('windFrom', 200));
const windSpeed = num('wind', 12) * KN;

ATMOSPHERE.turbidity = num('turbidity', ATMOSPHERE.turbidity);
ATMOSPHERE.rayleigh = num('rayleigh', ATMOSPHERE.rayleigh);
ATMOSPHERE.mieCoefficient = num('mie', ATMOSPHERE.mieCoefficient);
ATMOSPHERE.mieDirectionalG = num('mieg', ATMOSPHERE.mieDirectionalG);
ATMOSPHERE.scatterExponent = num('sexp', ATMOSPHERE.scatterExponent);
const exposureBias = Math.pow(2, num('ev', 0));
const metering = num('meter', 0.5);

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 50), innerWidth / innerHeight, 0.1, 40000);

const sky = new SkySystem(renderer, scene, quality, { hours: hour, cloudCover: num('clouds', 0.35) });
sky.meteringWeight = metering;
{
  const cp = sky.clouds.params;
  cp.scale = num('cscale', cp.scale);
  cp.edge = num('cedge', cp.edge);
  cp.density = num('cdensity', cp.density);
  cp.coverage = num('ccoverage', cp.coverage);
  cp.elevation = num('celev', cp.elevation);
  sky.refresh();
  const u = (scene.getObjectByName('sky') as THREE.Mesh).material as THREE.ShaderMaterial;
  u.uniforms['cloudLightStep']!.value = num('clstep', 0.00025);
  u.uniforms['cloudShadow']!.value = num('clshadow', 4);
}
const lighting = new Lighting(scene, sky, quality);
const land = new Land(scene, sky);
const marks = new Marks(scene);
const post = new PostChain(renderer, scene, camera, quality);
post.setToneMapping((params.get('tone') ?? 'agx') as ToneMapping);

// --- camera: eye height above the water, looking along a compass bearing ------------------------------------
const viewBearing = THREE.MathUtils.degToRad(num('view', 318));
const pitch = THREE.MathUtils.degToRad(num('pitch', -1));
camera.position.set(0, num('height', 2.6), 0);
const look = new THREE.Vector3(Math.sin(viewBearing) * Math.cos(pitch), Math.sin(pitch), -Math.cos(viewBearing) * Math.cos(pitch));
const controls = new OrbitControls(camera, canvas);
controls.target.copy(camera.position).addScaledVector(look, 1);
controls.enableDamping = true;
controls.enableZoom = false;
controls.rotateSpeed = -0.35; // drag = look around
controls.update();

// Marks placed relative to the view so every preset shows them: [id, metres, degrees off the view, kind].
// ?markView=<deg> pins them to another bearing (for telephoto checks).
const markLayout: Array<[string, number, number, 'windward' | 'leeward' | 'start']> = [
  ['windward', 38, 9, 'windward'],
  ['leeward', 165, -13, 'leeward'],
  ['pin', 95, 21, 'start'],
];
const markBearing = THREE.MathUtils.degToRad(num('markView', num('view', 318)));
for (const [id, dist, off, kind] of markLayout) {
  const b = markBearing + THREE.MathUtils.degToRad(off);
  marks.add(id, Math.sin(b) * dist, Math.cos(b) * dist, kind);
}

// --- stand-in sea: glossy dark water with a tileable procedural ripple normal map ---------------------------
/**
 * Tileable slope field of wind waves (0.3–20 m wavelengths, spread around the wind) as a normal map.
 * RMS slope ≈ 0.15, close to Cox–Munk for a moderate breeze once the unresolved part goes into roughness.
 */
function rippleNormalMap(size: number, tile: number, seed: number): THREE.DataTexture {
  let s = seed;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const downwind = Math.PI / 2 - (windFrom + Math.PI); // texture u = east, v = north
  const waves: Array<{ kx: number; ky: number; slope: number; phase: number }> = [];
  for (let i = 0; i < 72; i++) {
    const cycles = Math.max(1, Math.round(Math.exp(rand() * Math.log(60))));
    const spread = (rand() + rand() + rand() - 1.5) * 1.2;
    const dir = downwind + spread;
    const kx = Math.round(Math.cos(dir) * cycles);
    const ky = Math.round(Math.sin(dir) * cycles);
    const k = Math.hypot(kx, ky);
    if (k === 0) continue;
    waves.push({ kx, ky, slope: Math.pow(k, num('wslope', 0)), phase: rand() * Math.PI * 2 });
  }
  const sx = new Float32Array(size * size);
  const sy = new Float32Array(size * size);
  let sum2 = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let gx = 0;
      let gy = 0;
      for (const w of waves) {
        const c = w.slope * Math.cos((2 * Math.PI * (w.kx * x + w.ky * y)) / size + w.phase);
        const k = Math.hypot(w.kx, w.ky);
        gx += (c * w.kx) / k;
        gy += (c * w.ky) / k;
      }
      sx[y * size + x] = gx;
      sy[y * size + x] = gy;
      sum2 += gx * gx + gy * gy;
    }
  }
  const scale = 0.15 / Math.sqrt(sum2 / (size * size));
  const data = new Uint8Array(size * size * 4);
  const n = new THREE.Vector3();
  for (let i = 0; i < size * size; i++) {
    n.set(-sx[i]! * scale, -sy[i]! * scale, 1).normalize();
    data[i * 4] = (n.x * 0.5 + 0.5) * 255;
    data[i * 4 + 1] = (n.y * 0.5 + 0.5) * 255;
    data[i * 4 + 2] = (n.z * 0.5 + 0.5) * 255;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(waterSize / tile, waterSize / tile);
  tex.needsUpdate = true;
  return tex;
}

const waterSize = 24000;
const ripples = rippleNormalMap(512, num('wtile', 23), 7);
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(waterSize, waterSize).rotateX(-Math.PI / 2),
  new THREE.MeshPhysicalMaterial({
    name: 'stand-in sea',
    color: new THREE.Color().setRGB(0.004, 0.016, 0.022, THREE.LinearSRGBColorSpace),
    roughness: num('wrough', 0.12),
    metalness: 0,
    ior: 1.333,
    normalMap: ripples,
    fog: false,
  }),
);
water.receiveShadow = true;
scene.add(water);

// --- optional lighting probes -------------------------------------------------------------------------------
if (params.get('probe') === '1') {
  const at = (d: number, off: number, y: number) => {
    const b = viewBearing + THREE.MathUtils.degToRad(off);
    return new THREE.Vector3(Math.sin(b) * d, y, -Math.cos(b) * d);
  };
  const grey = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 24), new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.18, 0.18, 0.18, THREE.LinearSRGBColorSpace), roughness: 0.9 }));
  grey.position.copy(at(9, -9, 1.2));
  const chrome = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 24), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.02, metalness: 1 }));
  chrome.position.copy(at(9, 0, 1.2));
  const white = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.8, 0.8, 0.8, THREE.LinearSRGBColorSpace), roughness: 0.7 }));
  white.position.copy(at(9, 9, 1.2));
  white.rotation.y = 0.6;
  for (const m of [grey, chrome, white]) {
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  lighting.follow(chrome);
}

// ?probe=2: a gelcoat deck with a mast, boom and a white sail panel: shadow softness and whites headroom.
if (params.get('probe') === '2') {
  const rig = new THREE.Group();
  const b = viewBearing + THREE.MathUtils.degToRad(4);
  rig.position.set(Math.sin(b) * 7, 0.3, -Math.cos(b) * 7);
  rig.rotation.y = -viewBearing + 0.5;
  const gelcoat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(0.82, 0.82, 0.8, THREE.LinearSRGBColorSpace), roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 });
  const alu = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.6, 0.6, 0.62, THREE.LinearSRGBColorSpace), roughness: 0.35, metalness: 1 });
  const cloth = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.83, 0.82, 0.78, THREE.LinearSRGBColorSpace), roughness: 0.8, side: THREE.DoubleSide });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.1, 2.4), gelcoat);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 3.4, 16), alu);
  mast.position.set(-0.9, 1.75, 0);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.2, 12).rotateZ(Math.PI / 2), alu);
  boom.position.set(0.2, 0.75, 0.1);
  const sail = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.86, 0.8, 0), new THREE.Vector3(1.25, 0.8, 0.12), new THREE.Vector3(-0.86, 3.3, 0)]), cloth);
  sail.geometry.computeVertexNormals();
  for (const m of [deck, mast, boom, sail]) {
    m.castShadow = m.receiveShadow = true;
    rig.add(m);
  }
  scene.add(rig);
  lighting.follow(rig);
}

// --- GPU throughput benchmark: N renders, then a 1-pixel readback to wait for the GPU. (ANGLE/Metal timer
// queries time whole command buffers, and gl.finish() does not block there.)
const skyOnly = new THREE.Scene();
const skyMesh = scene.getObjectByName('sky') as THREE.Mesh;
const skyProbe = new THREE.Mesh(skyMesh.geometry, skyMesh.material);
skyProbe.frustumCulled = false;
skyOnly.add(skyProbe);
const probeTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });

const pixel16 = new Uint16Array(4);
const pixel8 = new Uint8Array(4);
/** A 1-pixel readback blocks until the GPU has finished everything that writes the target. */
function syncGpu(toScreen: boolean): void {
  if (toScreen) {
    const gl = renderer.getContext();
    renderer.setRenderTarget(null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel8);
  } else {
    renderer.readRenderTargetPixels(probeTarget, 0, 0, 1, 1, pixel16);
  }
}

function timeGpu(runs: number, toScreen: boolean, fn: () => void): number {
  fn();
  syncGpu(toScreen);
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  syncGpu(toScreen);
  return (performance.now() - t0) / runs;
}

/** Each figure is the best of several rounds: other GPU work on the machine only ever adds time. */
function benchmark(dt: number): Record<string, number> {
  skyProbe.position.copy(camera.position);
  const best = (rounds: number, runs: number, toScreen: boolean, fn: () => void) => {
    let min = Infinity;
    for (let r = 0; r < rounds; r++) min = Math.min(min, timeGpu(runs, toScreen, fn));
    return min;
  };
  // The composer turns autoClear off: clear explicitly, or stale depth early-z-rejects the whole sky.
  const toProbe = (s: THREE.Scene) => () => { renderer.setRenderTarget(probeTarget); renderer.clear(); renderer.render(s, camera); };
  const skyFullScreenMs = best(5, 40, false, toProbe(skyOnly));
  const sceneMs = best(5, 15, false, toProbe(scene));
  skyMesh.visible = false;
  const sceneWithoutSkyMs = best(5, 15, false, toProbe(scene));
  skyMesh.visible = true;
  const frameWithPostMs = best(5, 15, true, () => { renderer.setRenderTarget(null); post.render(dt); });
  const envBakeMs = best(5, 4, false, () => { sky.setTimeOfDay(sky.hours); sky.update(1, camera, windFrom, windSpeed); toProbe(skyOnly)(); }) - skyFullScreenMs;
  renderer.setRenderTarget(null);
  return { skyFullScreenMs, skyInSceneMs: sceneMs - sceneWithoutSkyMs, sceneMs, postMs: frameWithPostMs - sceneMs, frameWithPostMs, envBakeMs };
}

/** ?bench=post: cost of alternative post-chain layouts, each as its own composer (scene render included). */
function benchmarkPostLayouts(): Record<string, number> {
  const bloom = () => new BloomEffect({ blendFunction: BlendFunction.ADD, mipmapBlur: true, luminanceThreshold: 50, intensity: 0.4 });
  const tone = () => new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const layouts: Record<string, () => EffectPass[]> = {
    sceneOnly: () => [],
    toneOnly: () => [new EffectPass(camera, tone())],
    bloomTone: () => [new EffectPass(camera, bloom(), tone())],
    bloomTone_smaaVignette: () => [new EffectPass(camera, bloom(), tone()), new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }), new VignetteEffect())],
    bloomTone_smaaMediumVignette: () => [new EffectPass(camera, bloom(), tone()), new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM }), new VignetteEffect())],
    bloomTone_fxaaVignette: () => [new EffectPass(camera, bloom(), tone()), new EffectPass(camera, new FXAAEffect(), new VignetteEffect())],
    fusedSmaaBloomToneVignette: () => [new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }), bloom(), tone(), new VignetteEffect())],
    msaa4_bloomToneVignette: () => [new EffectPass(camera, bloom(), tone(), new VignetteEffect())],
    bloomHalfLumTone_smaaVignette: () => {
      const b = bloom();
      b.luminancePass.resolution.scale = 0.5;
      return [new EffectPass(camera, b, tone()), new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }), new VignetteEffect())];
    },
    bloom5HalfLumTone_smaaVignette: () => {
      const b = new BloomEffect({ blendFunction: BlendFunction.ADD, mipmapBlur: true, luminanceThreshold: 50, intensity: 0.4, levels: 5 });
      b.luminancePass.resolution.scale = 0.5;
      return [new EffectPass(camera, b, tone()), new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }), new VignetteEffect())];
    },
  };
  const size = renderer.getSize(new THREE.Vector2());
  const out: Record<string, number> = {};
  for (const [name, make] of Object.entries(layouts)) {
    const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: name.startsWith('msaa4') ? 4 : 0 });
    composer.addPass(new RenderPass(scene, camera));
    for (const pass of make()) composer.addPass(pass);
    composer.setSize(size.x, size.y, false);
    let min = Infinity;
    for (let r = 0; r < 5; r++) min = Math.min(min, timeGpu(12, true, () => composer.render(1 / 60)));
    out[name] = min;
    composer.dispose();
  }
  return out;
}

// --- resize, governor (display only), loop -----------------------------------------------------------------
function resize(): void {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  post.setSize(innerWidth, innerHeight);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  probeTarget.setSize(size.x, size.y);
}
addEventListener('resize', resize);
resize();

const drift = num('drift', 0);
const benchMode = params.has('bench');
let bench: Record<string, number> | undefined;
renderer.info.autoReset = false;
if (drift > 0) sky.update(drift, camera, windFrom, windSpeed);

const readout = document.getElementById('readout')!;
const showHud = params.get('hud') !== '0';
const governor = new QualityGovernor(tier);
const cpu = { skyMs: 0, lightMs: 0, marksMs: 0 };
let frames = 0;
let last = performance.now();
let avgFrame = 16.7;

renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  controls.update();

  let c0 = performance.now();
  sky.update(dt, camera, windFrom, windSpeed);
  cpu.skyMs = cpu.skyMs * 0.95 + (performance.now() - c0) * 0.05;
  c0 = performance.now();
  lighting.update();
  cpu.lightMs = cpu.lightMs * 0.95 + (performance.now() - c0) * 0.05;
  c0 = performance.now();
  marks.update(t, (e, n) => 0.12 * Math.sin(0.9 * t + 0.21 * e) + 0.07 * Math.sin(1.3 * t - 0.17 * n + 0.4 * e));
  cpu.marksMs = cpu.marksMs * 0.95 + (performance.now() - c0) * 0.05;
  land.update(params.get('flash') === '1' ? 0.3 : t); // ?flash=1 holds the lighthouse at a flash peak
  ripples.offset.set(t * 0.004 * Math.sin(windFrom + Math.PI), t * 0.004 * Math.cos(windFrom + Math.PI));
  if (exposureBias !== 1) renderer.toneMappingExposure = sky.exposure * exposureBias;

  if (benchMode && frames === 40) bench = params.get('bench') === 'post' ? benchmarkPostLayouts() : benchmark(dt);
  renderer.info.reset();
  post.render(dt);

  avgFrame = avgFrame * 0.95 + dt * 1000 * 0.05;
  governor.sample(dt * 1000, now);
  frames++;
  if (frames % 30 === 0) {
    const info = renderer.info.render;
    window.__stats = { frameMs: avgFrame, fps: 1000 / avgFrame, calls: info.calls, triangles: info.triangles };
    window.__env = {
      hour: sky.hours, exposure: sky.exposure, incidentExposure: sky.incidentExposure, sunIntensity: sky.sunIntensity, sunColor: sky.sunColor.toArray(),
      fogColor: sky.fogColor.toArray(), horizonColor: sky.horizonColor.toArray(), skyIlluminance: sky.skyIlluminance,
      bench, cpuMs: { ...cpu }, tier: governor.settings.tier,
      postHdr: post.hdr, calls: info.calls, triangles: info.triangles,
    };
    if (showHud) {
      readout.textContent = `${avgFrame.toFixed(1)} ms · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris`
        + (bench && bench['skyInSceneMs'] !== undefined ? ` · gpu: sky ${bench['skyInSceneMs'].toFixed(2)} (full screen ${bench['skyFullScreenMs']!.toFixed(2)}) scene ${bench['sceneMs']!.toFixed(2)} post ${bench['postMs']!.toFixed(2)} ms` : '');
    }
  }
  if (frames === 3) window.__ready = true;
});
