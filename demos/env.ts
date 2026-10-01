// Environment demo: production renderer, post chain, sky/clouds, sun light, distant land and marks over a
// flat stand-in sea (the FFT ocean replaces it in the app).
//
// Query: ?hour=17 ?clouds=0.35 ?view=<compass deg the camera looks at> ?pitch=-1 ?height=2.6 ?fov=50
//        ?tier=high ?tone=agx|aces ?wind=12 (kn) ?windFrom=200 (deg) ?drift=<s of cloud drift>
//        ?probe=1 (grey/white/chrome test objects) ?probe=2 (deck + rig: shadows, whites) ?hud=0
//        ?bench=1 (GPU cost of sky, scene, post, env bake) ?bench=post (post chain vs the old chain, real frames)
//        ?bench=post-all (alternative layouts) ?bench=post-ablate (post chain minus one piece at a time)
//        ?markView=<deg> (bearing the marks are laid out around) ?flash=1 (lighthouse lamp held on)
//        ?nantest=1 (+Inf and NaN patches: the post chain must stay finite) ?auto=1 (governor drives the tier)
//        ?ldr=1 (the post chain's direct-to-canvas fallback)
//        tuning: ?turbidity= ?rayleigh= ?mie= ?mieg= ?sexp= ?ev=<exposure bias in stops> ?meter=0..1
//                ?cscale= ?cedge= ?cdensity= ?ccoverage= ?celev= (clouds) ?wslope= ?wrough= ?wtile= (stand-in sea)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BlendFunction, BloomEffect, EffectComposer, EffectPass, FXAAEffect, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { createRenderer } from '../src/render/core/renderer';
import { createBloom, HdrFxaaEffect, HdrGuardEffect, PostChain, VibranceEffect, type ToneMapping } from '../src/render/core/post';
import { QualityGovernor, tierSettings, type QualityTier } from '../src/render/core/quality';
import { FrameTimer } from '../src/render/core/frameTimer';
import { ATMOSPHERE, SkySystem } from '../src/render/env/sky';
import { panoDirection, panoDisc } from '../src/render/env/cloudField';
import { cloudNoiseGenerationMs } from '../src/render/env/cloudNoise';
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

const sky = new SkySystem(renderer, scene, quality, { hours: hour, cloudCover: num('clouds', 0.35), volumetricClouds: params.get('volumetric') !== '0' });
sky.meteringWeight = metering;
// Volumetric cloud tuning: ?cl_<lighting key>= and ?cf_<field key>= (e.g. cl_multiScatter=0.6&cf_erosion=0.9).
if (sky.volumetric) {
  const v = sky.volumetric;
  const lighting = v.lighting as unknown as Record<string, number>;
  for (const key of Object.keys(lighting)) lighting[key] = num(`cl_${key}`, lighting[key]!);
  const field = v.field.params as unknown as Record<string, number>;
  for (const key of Object.keys(field)) field[key] = num(`cf_${key}`, field[key]!);
  v.renderAll(new THREE.Vector3(0, num('height', 2.6), 0), sky.sunDirection);
}
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
const post = new PostChain(renderer, scene, camera, quality, { hdr: params.get('ldr') !== '1' });
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

// ?nantest=1: patches that write fp16-overflowing (+Inf once stored) and NaN values into the HDR buffer.
// The post chain must show a white glowing patch and a small black patch, never spreading black blocks.
if (params.get('nantest') === '1') {
  const zero = { value: 0 };
  const patch = (glsl: string, off: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.ShaderMaterial({ uniforms: { zero }, fragmentShader: `uniform float zero;\nvoid main() { ${glsl} }` }));
    const b = viewBearing + THREE.MathUtils.degToRad(off);
    m.position.set(Math.sin(b) * 12, 2.2, -Math.cos(b) * 12);
    m.lookAt(camera.position);
    scene.add(m);
  };
  // A highlight above the fp16 maximum (+Inf when stored on IEEE GPUs; Apple saturates to 65 504), and a
  // NaN bit pattern (fast-math compilers fold 0/0 away; on Apple even this comes out as undefined values).
  patch('gl_FragColor = vec4(vec3(1.0e6 + zero), 1.0);', -6);
  patch('gl_FragColor = vec4(vec3(uintBitsToFloat(0x7fc00000u) + zero), 1.0);', 6);
  // What do these shaders actually store in an fp16 target on this GPU? (raw half-float bits)
  const probe = new THREE.WebGLRenderTarget(2, 1, { type: THREE.HalfFloatType });
  const probeScene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const half = (glsl: string, x: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 2), new THREE.ShaderMaterial({ uniforms: { zero }, fragmentShader: `uniform float zero;\nvoid main() { ${glsl} }` }));
    m.position.set(x, 0, -0.5);
    probeScene.add(m);
  };
  half('gl_FragColor = vec4(vec3(1.0e6 + zero), 1.0);', -0.5);
  half('gl_FragColor = vec4(vec3(uintBitsToFloat(0x7fc00000u) + zero), 1.0);', 0.5);
  renderer.setRenderTarget(probe);
  renderer.render(probeScene, cam);
  const bits = new Uint16Array(8);
  renderer.readRenderTargetPixels(probe, 0, 0, 2, 1, bits);
  renderer.setRenderTarget(null);
  (window as unknown as { __nanbits: string[] }).__nanbits = Array.from(bits).map((b) => b.toString(16));
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

function timeGpu(runs: number, toScreen: boolean | THREE.WebGLRenderTarget, fn: () => void): number {
  const sync = () => {
    if (typeof toScreen === 'boolean') syncGpu(toScreen);
    else renderer.readRenderTargetPixels(toScreen, 0, 0, 1, 1, toScreen.texture.type === THREE.HalfFloatType ? pixel16 : pixel8);
  };
  fn();
  sync();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  sync();
  return (performance.now() - t0) / runs;
}

/**
 * Ends a benchmark "frame" the way a real one ends: the canvas pass is closed by a draw elsewhere, so its tile
 * stores are paid. (Repeating a pass into the same target lets ANGLE/Metal merge the passes and skip them.)
 */
const tinyTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false });
const tinyScene = new THREE.Scene();
const tinyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
{
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0x808080, depthTest: false }));
  quad.frustumCulled = false;
  tinyScene.add(quad);
}
const closeFrame = () => { renderer.setRenderTarget(tinyTarget); renderer.render(tinyScene, tinyCam); renderer.setRenderTarget(null); };
const directFrame = () => {
  const saved = renderer.toneMapping;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.toneMapping = saved;
  closeFrame();
};

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
  const directFrameMs = best(5, 15, true, directFrame);
  const frameWithPostMs = best(5, 15, true, () => { post.render(dt); closeFrame(); });
  const envBakeMs = best(5, 4, false, () => { sky.setTimeOfDay(sky.hours); sky.update(1, camera, windFrom, windSpeed); toProbe(skyOnly)(); }) - skyFullScreenMs;
  renderer.setRenderTarget(null);
  return { skyFullScreenMs, skyInSceneMs: sceneMs - sceneWithoutSkyMs, sceneMs, directFrameMs, frameWithPostMs, postMs: frameWithPostMs - directFrameMs, envBakeMs };
}

/**
 * ?envcheck=1: the strip-wise environment bake must give the texture three's one-call bake gives. Bakes both ways
 * from the same sky in the same frame and compares every texel of the CubeUV target.
 */
function checkEnvironmentBake(): Record<string, number> {
  const s = sky as unknown as {
    pmremTarget: THREE.WebGLRenderTarget;
    envBaker: { busy: boolean; unitCount: number; step(): boolean };
    bakeEnvironment(): void;
    beginEnvironmentBake(): void;
  };
  const read = (): Uint16Array => {
    const t = s.pmremTarget;
    const buf = new Uint16Array(t.width * t.height * 4);
    renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
    return buf;
  };
  s.bakeEnvironment();
  const whole = read();
  s.beginEnvironmentBake();
  let steps = 0;
  while (s.envBaker.busy && steps < 1000) { s.envBaker.step(); steps++; }
  const strips = read();
  renderer.setRenderTarget(null);
  let worst = 0;
  let differing = 0;
  let peak = 0;
  for (let i = 0; i < whole.length; i++) {
    const a = THREE.DataUtils.fromHalfFloat(whole[i]!);
    const b = THREE.DataUtils.fromHalfFloat(strips[i]!);
    if (whole[i] !== strips[i]) differing++;
    worst = Math.max(worst, Math.abs(a - b));
    peak = Math.max(peak, Math.abs(a));
  }
  return { steps, units: s.envBaker.unitCount, texels: whole.length / 4, differingValues: differing, worstAbsDifference: worst, peakValue: peak };
}

/**
 * ?suncheck=1: the CPU mirror of the cloud field (which dims the sun light) against the GPU march (which draws the
 * clouds). Marches a fresh panorama, reads it back and compares its transmittance with the CPU's along the same
 * rays, over a grid of directions.
 */
function checkSunConsistency(): Record<string, number> {
  const v = sky.volumetric;
  if (!v) return {};
  const eye = camera.position.clone();
  v.renderAll(eye, sky.sunDirection);
  const target = v.newest;
  const size = target.width;
  const buf = new Uint16Array(size * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, buf);
  renderer.setRenderTarget(null);
  const disc = panoDisc(size);
  const dir = { x: 0, y: 0, z: 0 };
  let n = 0;
  let sumAbs = 0;
  let worst = 0;
  let agree = 0;
  let covered = 0;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const stride = Math.floor(size / 48);
  for (let j = stride >> 1; j < size; j += stride) {
    for (let i = stride >> 1; i < size; i += stride) {
      const u = (i + 0.5) / size;
      const w = (j + 0.5) / size;
      if (Math.hypot(u - 0.5, w - 0.5) * 2 > disc * 0.97) continue;
      panoDirection(u, w, disc, dir);
      const gpu = THREE.DataUtils.fromHalfFloat(buf[(j * size + i) * 4 + 3]!);
      // The march exactly as the per-frame sun light runs it (its default step count).
      const cpu = v.field.viewTransmittance(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z);
      n++;
      sumAbs += Math.abs(gpu - cpu);
      worst = Math.max(worst, Math.abs(gpu - cpu));
      if ((gpu < 0.5) === (cpu < 0.5)) agree++;
      if (cpu < 0.5) covered++;
      sa += gpu; sb += cpu; saa += gpu * gpu; sbb += cpu * cpu; sab += gpu * cpu;
    }
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const correlation = cov / Math.sqrt(Math.max(1e-12, (saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2)));
  return { rays: n, meanAbsDifference: sumAbs / n, worstDifference: worst, sameSideOfHalf: agree / n, coveredFraction: covered / n, correlation };
}

/**
 * ?bench=clouds: GPU cost of the volumetric clouds, measured as the brief asks: real frames that close their
 * passes, best of several interleaved rounds, clouds on against off in the same run.
 *   frame*Ms       a whole frame (post chain to the canvas) with and without one frame's cloud tiles before it
 *   generationMs   every tile and the resolve in one batch with a single sync: GPU-bound, so it holds up when
 *                  the machine's CPUs are busy (the frame figures do not: a CPU-bound loop hides GPU work)
 *   resolveMs      the resolve pass alone (once per generation)
 */
function benchmarkClouds(dt: number): Record<string, number> {
  const v = sky.volumetric;
  const out: Record<string, number> = {};
  if (!v) return out;
  const n = v.tileCount;
  const perFrame = v.quality.tilesPerFrame;
  const frames = Math.ceil(n / perFrame);
  const frame = () => { post.render(dt); closeFrame(); };
  let tile = 0;
  const frameWithTiles = () => { v.benchMarch(tile, perFrame, false); tile += perFrame; frame(); };
  let off = Infinity;
  let on = Infinity;
  for (let r = 0; r < 7; r++) {
    off = Math.min(off, timeGpu(frames, true, frame));
    tile = 0;
    on = Math.min(on, timeGpu(frames, true, frameWithTiles));
  }
  out['frameCloudsOffMs'] = off;
  out['frameCloudsOnMs'] = on;
  out['cloudWorkPerFrameMs'] = on - off;

  out['tiles'] = n;
  out['panoramaSize'] = v.quality.size;

  let generation = Infinity;
  for (let r = 0; r < 7; r++) {
    const target = v.benchMarch(0, n, true);
    generation = Math.min(generation, timeGpu(2, target, () => { v.benchMarch(0, n, true); }));
  }
  out['generationMs'] = generation;
  out['framesPerGeneration'] = frames;
  out['generationPerFrameMs'] = generation / frames;

  let resolve = Infinity;
  for (let r = 0; r < 5; r++) {
    const target = v.benchMarch(0, 0, true);
    resolve = Math.min(resolve, timeGpu(3, target, () => { v.benchMarch(0, 0, true); closeFrame(); }));
  }
  out['resolveMs'] = resolve;
  out['amortisedPerFrameMs'] = out['cloudWorkPerFrameMs']! + resolve / frames;

  // The environment bake: three's one call against the strip-wise units (each timed with its own sync).
  const s = sky as unknown as {
    pmremTarget: THREE.WebGLRenderTarget;
    envBaker: { busy: boolean; step(): boolean };
    bakeEnvironment(): void;
    beginEnvironmentBake(): void;
  };
  const sync = () => renderer.readRenderTargetPixels(s.pmremTarget, 0, 0, 1, 1, pixel16);
  let whole = Infinity;
  let unitWorst = Infinity;
  let unitSum = Infinity;
  let units = 0;
  for (let r = 0; r < 4; r++) {
    s.bakeEnvironment();
    sync();
    let t0 = performance.now();
    s.bakeEnvironment();
    sync();
    whole = Math.min(whole, performance.now() - t0);
    s.beginEnvironmentBake();
    let roundWorst = 0;
    let roundSum = 0;
    units = 0;
    while (s.envBaker.busy && units < 200) {
      t0 = performance.now();
      s.envBaker.step();
      closeFrame();
      sync();
      const ms = performance.now() - t0;
      roundWorst = Math.max(roundWorst, ms);
      roundSum += ms;
      units++;
    }
    unitWorst = Math.min(unitWorst, roundWorst);
    unitSum = Math.min(unitSum, roundSum);
  }
  renderer.setRenderTarget(null);
  out['envBakeOneCallMs'] = whole;
  out['envBakeUnits'] = units;
  out['envBakeUnitWorstMs'] = unitWorst;
  out['envBakeUnitMeanMs'] = unitSum / Math.max(1, units);
  return out;
}

/**
 * ?bench=post: real-frame cost of post-chain layouts versus the same frame without post. Every case ends its
 * frame the way a real frame does (the canvas pass is closed, so tile stores are paid), all cases are
 * interleaved within each round, and each figure is the best round (outside GPU load only adds time).
 */
function benchmarkPostLayouts(): Record<string, number> {
  const bloom7 = () => new BloomEffect({ blendFunction: BlendFunction.ADD, mipmapBlur: true, luminanceThreshold: 50, intensity: 0.4 });
  const bloomLite = (levels = 5) => {
    const b = new BloomEffect({ blendFunction: BlendFunction.ADD, mipmapBlur: true, luminanceThreshold: 50, intensity: 0.4, levels });
    b.luminancePass.resolution.scale = 0.5;
    const base = b.setSize.bind(b);
    b.setSize = (w: number, h: number) => { base(w, h); b.mipmapBlurPass.setSize(Math.round(w / 2), Math.round(h / 2)); };
    return b;
  };
  const tone = () => new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const layouts: Record<string, () => EffectPass[]> = {
    before_bloom7_smaaHigh_2pass: () => [new EffectPass(camera, bloom7(), tone()), new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }), new VignetteEffect())],
  };
  if (params.get('bench') === 'post-ablate') {
    const vig = () => new VignetteEffect({ offset: 0.22, darkness: 0.42 });
    Object.assign(layouts, {
      P0_handFused_fxaa_bloomLite: () => [new EffectPass(camera, new FXAAEffect(), bloomLite(), tone(), vig())],
      P1_production: () => { const p = new EffectPass(camera, new HdrFxaaEffect(), new HdrGuardEffect(), createBloom(), tone(), new VibranceEffect(0.25), vig()); p.dithering = true; return [p]; },
      P2_plainFxaa: () => { const p = new EffectPass(camera, new FXAAEffect(), new HdrGuardEffect(), createBloom(), tone(), new VibranceEffect(0.25), vig()); p.dithering = true; return [p]; },
      P3_noGuard: () => { const p = new EffectPass(camera, new HdrFxaaEffect(), createBloom(), tone(), new VibranceEffect(0.25), vig()); p.dithering = true; return [p]; },
      P4_unpatchedBloom: () => { const p = new EffectPass(camera, new HdrFxaaEffect(), new HdrGuardEffect(), bloomLite(), tone(), new VibranceEffect(0.25), vig()); p.dithering = true; return [p]; },
      P5_noVibrance: () => { const p = new EffectPass(camera, new HdrFxaaEffect(), new HdrGuardEffect(), createBloom(), tone(), vig()); p.dithering = true; return [p]; },
      P6_noDither: () => [new EffectPass(camera, new HdrFxaaEffect(), new HdrGuardEffect(), createBloom(), tone(), new VibranceEffect(0.25), vig())],
    });
  }
  if (params.get('bench') === 'post-all') {
    Object.assign(layouts, {
      tone_1pass: () => [new EffectPass(camera, tone())],
      bloomLite_smaaHigh_2pass: () => [new EffectPass(camera, bloomLite(), tone()), new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }), new VignetteEffect())],
      fused_fxaa_bloomLite_1pass: () => [new EffectPass(camera, new FXAAEffect(), bloomLite(), tone(), new VignetteEffect())],
      fused_noAA_bloomLite_1pass: () => [new EffectPass(camera, bloomLite(), tone(), new VignetteEffect())],
    });
  }
  const size = renderer.getSize(new THREE.Vector2());
  const cases: Array<[string, () => void, () => void]> = [];
  cases.push(['noPost_directToCanvas', directFrame, () => undefined]);
  cases.push(['production_PostChain', () => { post.render(1 / 60); closeFrame(); }, () => undefined]);
  for (const [name, make] of Object.entries(layouts)) {
    const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    composer.addPass(new RenderPass(scene, camera));
    for (const pass of make()) composer.addPass(pass);
    composer.setSize(size.x, size.y, false);
    composer.render(1 / 60);
    cases.push([name, () => { composer.render(1 / 60); closeFrame(); }, () => composer.dispose()]);
  }
  const out: Record<string, number> = {};
  for (const [name] of cases) out[name] = Infinity;
  for (let r = 0; r < 9; r++) {
    for (const [name, run] of cases) out[name] = Math.min(out[name]!, timeGpu(8, true, run));
  }
  for (const [, , dispose] of cases) dispose();
  const base = out['noPost_directToCanvas']!;
  for (const [name] of cases) if (name !== 'noPost_directToCanvas') out[`${name}__post`] = out[name]! - base;
  out['pixels'] = renderer.getDrawingBufferSize(new THREE.Vector2()).toArray().reduce((a, b) => a * b, 1);
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
let envCheck: Record<string, number> | undefined;
let sunCheck: Record<string, number> | undefined;
renderer.info.autoReset = false;
if (drift > 0) sky.update(drift, camera, windFrom, windSpeed);

const readout = document.getElementById('readout')!;
const showHud = params.get('hud') !== '0';
const governor = new QualityGovernor(tier);
const frameTimer = new FrameTimer(renderer);
const autoQuality = params.get('auto') === '1';
const tierLog: string[] = [];
const cpu = { skyMs: 0, lightMs: 0, marksMs: 0 };
let frames = 0;
let last = performance.now();
let avgFrame = 16.7;

renderer.setAnimationLoop((now) => {
  const rawMs = Math.max(0, now - last);
  const dt = Math.min(0.1, rawMs / 1000);
  last = now;
  frameTimer.begin();
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

  // ?tierflip=1: down to the low tier (2-D cloud layer) and back, then through medium and ultra.
  if (params.get('tierflip') === '1') {
    const flips: Record<number, QualityTier> = { 40: 'low', 80: 'high', 120: 'medium', 160: 'ultra', 200: 'high' };
    const next = flips[frames];
    if (next) {
      sky.setQuality(tierSettings(next));
      tierLog.push(`frame ${frames}→${next}${sky.volumetric ? ` (${sky.volumetric.quality.size})` : ' (2-D)'}`);
    }
  }
  if (params.get('envcheck') === '1' && frames === 20) envCheck = checkEnvironmentBake();
  if (params.get('suncheck') === '1' && frames === 20) sunCheck = checkSunConsistency();
  if (benchMode && frames === 40) {
    const mode = params.get('bench')!;
    bench = mode.startsWith('post') ? benchmarkPostLayouts() : mode === 'clouds' ? benchmarkClouds(dt) : benchmark(dt);
  }
  renderer.info.reset();
  post.render(dt);
  frameTimer.end();

  avgFrame = avgFrame * 0.95 + dt * 1000 * 0.05;
  if (governor.sample(rawMs, now, frameTimer.cost)) {
    tierLog.push(`${(now / 1000).toFixed(1)}s→${governor.settings.tier}`);
    if (autoQuality) {
      post.setQuality(governor.settings);
      lighting.setQuality(governor.settings);
      sky.setQuality(governor.settings);
    }
  }
  frames++;
  if (frames % 30 === 0) {
    const info = renderer.info.render;
    window.__stats = { frameMs: avgFrame, fps: 1000 / avgFrame, calls: info.calls, triangles: info.triangles };
    window.__env = {
      hour: sky.hours, exposure: sky.exposure, incidentExposure: sky.incidentExposure, sunIntensity: sky.sunIntensity, sunColor: sky.sunColor.toArray(),
      fogColor: sky.fogColor.toArray(), horizonColor: sky.horizonColor.toArray(), skyIlluminance: sky.skyIlluminance,
      bench, envCheck, sunCheck, cpuMs: { ...cpu }, cloudNoiseMs: cloudNoiseGenerationMs(), cloudGenerations: sky.volumetric?.generations ?? 0,
      cloudSun: sky.sunIntensity, tier: governor.settings.tier,
      frameCost: { ms: frameTimer.cost.ms, gpu: frameTimer.cost.gpu, cpuMs: frameTimer.cpuMs, gpuMs: frameTimer.gpuMs },
      tierLog: [...tierLog],
      postHdr: post.hdr, calls: info.calls, triangles: info.triangles,
    };
    if (showHud) {
      readout.textContent = `${avgFrame.toFixed(1)} ms · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris`
        + (bench && bench['skyInSceneMs'] !== undefined ? ` · gpu: sky ${bench['skyInSceneMs'].toFixed(2)} (full screen ${bench['skyFullScreenMs']!.toFixed(2)}) scene ${bench['sceneMs']!.toFixed(2)} post ${bench['postMs']!.toFixed(2)} ms` : '');
    }
  }
  if (frames === 3) window.__ready = true;
});
