import * as THREE from 'three';

declare global {
  interface Window { __ready?: boolean }
}

function showFallback(message: string): void {
  const el = document.createElement('div');
  el.className = 'fallback';
  el.innerHTML = `<div><h1>Sailing School needs WebGL 2</h1><p>${message}</p></div>`;
  document.body.appendChild(el);
  window.__ready = true;
}

function boot(): void {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const forceNo = new URLSearchParams(location.search).has('forceNoWebGL2');
  const gl = forceNo ? null : canvas.getContext('webgl2');
  if (!gl) {
    showFallback('Your browser or device could not start WebGL 2. Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.');
    return;
  }
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6fa8dc);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(3, 2, 4);
  camera.lookAt(0, 0, 0);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial());
  scene.add(cube);
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();
  let first = true;
  renderer.setAnimationLoop((t) => {
    cube.rotation.set(t * 0.0005, t * 0.0008, 0);
    renderer.render(scene, camera);
    if (first) { first = false; window.__ready = true; }
  });
}

boot();
