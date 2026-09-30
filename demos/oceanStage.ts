// Rendering stage for the ocean demo: the shared demo kit (default) or the production pipeline (?prod=1:
// createRenderer + SkySystem + Lighting + PostChain with AgX and auto-exposure, as the app renders).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createDemoKit } from './shared/demoKit';
import type { QualitySettings, SkyState } from '../src/render/core/types';
import { createRenderer } from '../src/render/core/renderer';
import { PostChain } from '../src/render/core/post';
import { SkySystem } from '../src/render/env/sky';
import { Lighting } from '../src/render/env/lighting';

export interface OceanStage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sky: SkyState;
  /** Centre the sun's shadow frustum on this object (production lighting only). */
  follow(target: THREE.Object3D): void;
  onFrame(cb: (dt: number) => void): void;
  start(): void;
}

export interface StageOptions {
  prod: boolean;
  quality: QualitySettings;
  hour: number;
  windFrom: number;
  windSpeed: number;
  cameraPos: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

export function createStage(o: StageOptions): OceanStage {
  return o.prod ? productionStage(o) : kitStage(o);
}

function kitStage(o: StageOptions): OceanStage {
  const kit = createDemoKit({ fov: o.fov ?? 50, cameraPos: o.cameraPos, target: o.target, hour: o.hour });
  kit.camera.far = 40000;
  kit.camera.updateProjectionMatrix();
  kit.renderer.setPixelRatio(Math.min(devicePixelRatio, o.quality.pixelRatioCap) * o.quality.renderScale);
  return {
    renderer: kit.renderer, scene: kit.scene, camera: kit.camera, controls: kit.controls, sky: kit.sky,
    follow: () => {},
    onFrame: (cb) => kit.onFrame(cb),
    start: () => kit.start(),
  };
}

function productionStage(o: StageOptions): OceanStage {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  document.body.appendChild(canvas);
  const renderer = createRenderer(canvas);
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(o.fov ?? 50, innerWidth / innerHeight, 0.1, 40000);
  camera.position.set(...o.cameraPos);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(...o.target);
  controls.enableDamping = true;
  controls.update();
  const sky = new SkySystem(renderer, scene, o.quality, { hours: o.hour, cloudCover: 0.35 });
  const lighting = new Lighting(scene, sky, o.quality);
  const post = new PostChain(renderer, scene, camera, o.quality);
  post.setToneMapping('agx');

  const readout = document.createElement('div');
  readout.style.cssText = 'position:fixed;left:8px;bottom:8px;font:12px ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.45);padding:4px 6px;border-radius:4px;pointer-events:none';
  document.body.appendChild(readout);
  const resize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', resize);
  resize();

  const callbacks: Array<(dt: number) => void> = [];
  let last = performance.now(), frames = 0, avg = 16.7, acc = 0;
  return {
    renderer, scene, camera, controls, sky,
    follow: (target) => lighting.follow(target),
    onFrame: (cb) => { callbacks.push(cb); },
    start: () => {
      renderer.setAnimationLoop((now) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        controls.update();
        sky.update(dt, camera, o.windFrom, o.windSpeed);
        for (const cb of callbacks) cb(dt);
        lighting.update();
        renderer.info.reset();
        post.render(dt);
        avg = avg * 0.95 + dt * 1000 * 0.05;
        acc += dt;
        if (acc > 0.5) {
          acc = 0;
          const info = renderer.info.render;
          window.__stats = { frameMs: avg, fps: 1000 / avg, calls: info.calls, triangles: info.triangles };
          readout.textContent = `${avg.toFixed(1)} ms · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · exposure ${sky.exposure.toFixed(3)}`;
        }
        if (++frames === 3) window.__ready = true;
      });
    },
  };
}
