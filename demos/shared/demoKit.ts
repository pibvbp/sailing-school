// Shared scaffolding for the standalone module demos (dev only).
// Gives every render agent the same lighting: renderer + three.js Sky (Preetham + clouds) + PMREM
// environment + sun light with shadows + orbit camera + a frame-time readout.
// The production sky/post chain lives in src/render (Task 10); this kit only keeps demos consistent.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import type { SkyState } from '../../src/render/core/types';

declare global {
  interface Window { __ready?: boolean; __stats?: { frameMs: number; fps: number; calls: number; triangles: number } }
}

export interface DemoSky extends SkyState {
  setHour(hour: number): void;
  setCloudCover(c: number): void;
}

export interface DemoKit {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sky: DemoSky;
  sun: THREE.DirectionalLight;
  params: URLSearchParams;
  /** Called every frame with (dt seconds, t seconds). */
  onFrame(cb: (dt: number, t: number) => void): void;
  start(): void;
}

/** Sun direction (three.js world: North = −Z, East = +X) for a mid-latitude summer day. */
export function sunDirectionForHour(hour: number): THREE.Vector3 {
  const elevation = THREE.MathUtils.degToRad(Math.max(-4, 62 * Math.sin((Math.PI * (hour - 6)) / 12)));
  const azimuth = THREE.MathUtils.degToRad(90 + (180 * (hour - 6)) / 12); // compass bearing
  const horiz = Math.cos(elevation);
  return new THREE.Vector3(Math.sin(azimuth) * horiz, Math.sin(elevation), -Math.cos(azimuth) * horiz).normalize();
}

export function createDemoKit(opts: { hour?: number; cameraPos?: [number, number, number]; target?: [number, number, number]; fov?: number } = {}): DemoKit {
  const params = new URLSearchParams(location.search);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Number(params.get('exposure') ?? 0.5);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 50, 1, 0.05, 30000);
  camera.position.set(...(opts.cameraPos ?? [12, 4, 14]));
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(...(opts.target ?? [0, 3, 0]));
  controls.enableDamping = true;
  controls.update();

  // Visible sky dome and a small copy used only for baking the environment map.
  const skyMesh = new Sky();
  skyMesh.scale.setScalar(20000);
  scene.add(skyMesh);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(50);
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTarget: THREE.WebGLRenderTarget | null = null;

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 80;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  const state = {
    sunDirection: new THREE.Vector3(),
    sunColor: new THREE.Color(),
    sunIntensity: 3,
    envMap: null as THREE.Texture | null,
    fogColor: new THREE.Color(0x9fb8cc),
    horizonColor: new THREE.Color(0x9fb8cc),
    cloudCover: 0.35,
  };

  const applySky = (u: Record<string, THREE.IUniform>) => {
    u['turbidity']!.value = 2.5;
    u['rayleigh']!.value = 1.4;
    u['mieCoefficient']!.value = 0.005;
    u['mieDirectionalG']!.value = 0.8;
    u['sunPosition']!.value.copy(state.sunDirection);
    if (u['cloudCoverage']) u['cloudCoverage'].value = state.cloudCover;
    if (u['cloudDensity']) u['cloudDensity'].value = 0.5;
    if (u['cloudElevation']) u['cloudElevation'].value = 0.5;
  };

  const rebake = () => {
    applySky(skyMesh.material.uniforms);
    applySky(envSky.material.uniforms);
    envTarget?.dispose();
    envTarget = pmrem.fromScene(envScene, 0.02);
    state.envMap = envTarget.texture;
    scene.environment = state.envMap;
    const el = Math.asin(THREE.MathUtils.clamp(state.sunDirection.y, -1, 1));
    const warm = THREE.MathUtils.smoothstep(THREE.MathUtils.radToDeg(el), 0, 40);
    state.sunColor.setRGB(1, 0.62 + 0.34 * warm, 0.38 + 0.52 * warm);
    state.sunIntensity = 3.2 * THREE.MathUtils.smoothstep(THREE.MathUtils.radToDeg(el), -2, 10);
    sun.color.copy(state.sunColor);
    sun.intensity = state.sunIntensity;
    state.horizonColor.setRGB(0.62 + 0.2 * (1 - warm), 0.72, 0.8);
    state.fogColor.copy(state.horizonColor);
    scene.fog = new THREE.FogExp2(state.fogColor.getHex(), 0.00012);
  };

  const sky: DemoSky = Object.assign(state, {
    setHour(hour: number) { state.sunDirection.copy(sunDirectionForHour(hour)); rebake(); },
    setCloudCover(c: number) { state.cloudCover = c; rebake(); },
  });
  sky.setHour(Number(params.get('hour') ?? opts.hour ?? 17));

  const readout = document.createElement('div');
  readout.style.cssText = 'position:fixed;left:8px;bottom:8px;font:12px ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.45);padding:4px 6px;border-radius:4px;pointer-events:none';
  document.body.appendChild(readout);

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  const callbacks: Array<(dt: number, t: number) => void> = [];
  let last = performance.now();
  let frames = 0;
  let acc = 0;
  let avg = 16;
  return {
    renderer, scene, camera, controls, sky, sun, params,
    onFrame(cb) { callbacks.push(cb); },
    start() {
      renderer.setAnimationLoop((now) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const t = now / 1000;
        for (const cb of callbacks) cb(dt, t);
        controls.update();
        // Keep the shadow frustum centred on the orbit target.
        sun.position.copy(controls.target).addScaledVector(state.sunDirection, 40);
        sun.target.position.copy(controls.target);
        renderer.render(scene, camera);
        avg = avg * 0.95 + dt * 1000 * 0.05;
        frames++;
        acc += dt;
        if (acc > 0.5) {
          const info = renderer.info.render;
          window.__stats = { frameMs: avg, fps: 1000 / avg, calls: info.calls, triangles: info.triangles };
          readout.textContent = `${avg.toFixed(1)} ms · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris`;
          acc = 0;
        }
        if (frames === 3) window.__ready = true;
      });
    },
  };
}
