// Render hosts for the sails demo. `?prod=1` uses the app's production path — createRenderer, SkySystem
// (Preetham sky, PMREM environment, auto-exposure), Lighting (sun + shadow box following the boat) and
// PostChain (HDR, AgX) — so the cloth is judged under the light it will ship with. Otherwise the shared
// demo kit is used (with its sun/sky balance corrected, see sails.ts).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createDemoKit } from './shared/demoKit';
import { createRenderer } from '../src/render/core/renderer';
import { PostChain } from '../src/render/core/post';
import { tierSettings, type QualityTier } from '../src/render/core/quality';
import { SkySystem } from '../src/render/env/sky';
import { Lighting } from '../src/render/env/lighting';

export interface Host {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Unit vector toward the sun (world). */
  readonly sunDirection: THREE.Vector3;
  readonly params: URLSearchParams;
  readonly prod: boolean;
  follow(target: THREE.Object3D): void;
  onFrame(cb: (dt: number, t: number) => void): void;
  start(): void;
}

export function createHost(params: URLSearchParams): Host {
  return params.get('prod') === '1' ? prodHost(params) : kitHost();
}

function kitHost(): Host {
  const kit = createDemoKit({ hour: 17, cameraPos: [12, 4, 12], target: [0, 5, 0], fov: 45 });
  const q = kit.params;
  // The shared kit's sky environment out-shines its sun ~3:1; the production SkySystem calibrates direct
  // sun ≈ 6× the sky's horizontal irradiance. Rebalance so the cloth is judged under realistic light.
  if (q.get('light') !== 'kit') {
    kit.scene.environmentIntensity = 0.25;
    kit.sun.intensity = kit.sky.sunIntensity * 5.6;
    if (!q.has('exposure')) kit.renderer.toneMappingExposure = 0.4;
  }
  return {
    renderer: kit.renderer, scene: kit.scene, camera: kit.camera, controls: kit.controls,
    sunDirection: kit.sky.sunDirection, params: q, prod: false,
    follow() { /* the kit centres its shadow box on the orbit target */ },
    onFrame: (cb) => kit.onFrame(cb),
    start: () => kit.start(),
  };
}

function prodHost(params: URLSearchParams): Host {
  const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.background = '#000';
  document.body.appendChild(canvas);
  const readout = document.createElement('div');
  readout.style.cssText = 'position:fixed;left:8px;bottom:8px;font:12px ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.45);padding:4px 6px;border-radius:4px;pointer-events:none';
  document.body.appendChild(readout);

  const quality = tierSettings((params.get('tier') ?? 'high') as QualityTier);
  const renderer = createRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 40000);
  camera.position.set(12, 4, 12);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 5, 0);
  controls.enableDamping = true;
  controls.update();
  const sky = new SkySystem(renderer, scene, quality, { hours: num('hour', 17), cloudCover: num('clouds', 0.3) });
  const lighting = new Lighting(scene, sky, quality);
  const post = new PostChain(renderer, scene, camera, quality);
  const windFrom = THREE.MathUtils.degToRad(num('windFrom', 200));
  const windSpeed = num('wind', 12) * 0.514444;
  const ev = Math.pow(2, num('ev', 0));

  const resize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', resize);
  resize();

  const callbacks: Array<(dt: number, t: number) => void> = [];
  let last = performance.now();
  let frames = 0;
  let avg = 16.7;
  return {
    renderer, scene, camera, controls, sunDirection: sky.sunDirection, params, prod: true,
    follow: (o) => lighting.follow(o),
    onFrame: (cb) => { callbacks.push(cb); },
    start() {
      renderer.setAnimationLoop((now) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        for (const cb of callbacks) cb(dt, now / 1000);
        controls.update();
        sky.update(dt, camera, windFrom, windSpeed);
        if (ev !== 1) renderer.toneMappingExposure = sky.exposure * ev;
        lighting.update();
        post.render(dt);
        avg = avg * 0.95 + dt * 1000 * 0.05;
        frames++;
        if (frames % 30 === 0) {
          const info = renderer.info.render;
          window.__stats = { frameMs: avg, fps: 1000 / avg, calls: info.calls, triangles: info.triangles };
          readout.textContent = `${avg.toFixed(1)} ms · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · prod`;
        }
        if (frames === 3) window.__ready = true;
      });
    },
  };
}
