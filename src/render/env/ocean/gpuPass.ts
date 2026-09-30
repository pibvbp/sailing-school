// Minimal full-screen shader pass + render-target helper for the ocean's GPU work (FFT, bakes,
// probe, wake). Adapted from ABYSSAL `src/gfx/FullScreenPass.js`.
// Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school (TypeScript, three r186).
import * as THREE from 'three';

// One oversized triangle shared by every pass.
const triangle = new THREE.BufferGeometry();
triangle.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
triangle.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
triangle.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const PASS_VERT = /* glsl */ `precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG_HEADER = /* glsl */ `precision highp float;
precision highp int;
precision highp sampler2D;
`;

export type Uniforms = Record<string, THREE.IUniform>;

export class FullScreenPass {
  readonly material: THREE.RawShaderMaterial;
  private readonly scene = new THREE.Scene();

  /** `fragment` is GLSL ES 3.0 without the version line; it declares its own `out`s. */
  constructor(fragment: string, uniforms: Uniforms = {}, name = 'OceanPass') {
    this.material = new THREE.RawShaderMaterial({
      name,
      glslVersion: THREE.GLSL3,
      vertexShader: PASS_VERT,
      fragmentShader: FRAG_HEADER + fragment,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const mesh = new THREE.Mesh(triangle, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  get uniforms(): Uniforms { return this.material.uniforms; }

  set(name: string, value: unknown): this {
    const u = this.material.uniforms[name];
    if (u) u.value = value;
    return this;
  }

  /** Draw into `target`, which is fully overwritten (cleared first so tile GPUs skip loading it). */
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderPassScene(renderer, this.scene, passCamera, target, true);
  }

  dispose(): void { this.material.dispose(); }
}

/** Render `scene` into `target` (optionally clearing it first), restoring the renderer's state. */
export function renderPassScene(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null, clear = false): void {
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevXr = renderer.xr.enabled;
  renderer.xr.enabled = false;
  renderer.autoClear = clear;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.xr.enabled = prevXr;
}

export interface RTOptions {
  type?: THREE.TextureDataType;
  filter?: 'nearest' | 'linear' | 'mipmap';
  wrap?: THREE.Wrapping;
  count?: number;
  anisotropy?: number;
  name?: string;
}

export function makeRT(width: number, height: number, o: RTOptions = {}): THREE.WebGLRenderTarget {
  const filter = o.filter ?? 'linear';
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width | 0), Math.max(1, height | 0), {
    type: o.type ?? THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: filter === 'nearest' ? THREE.NearestFilter : filter === 'mipmap' ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter,
    wrapS: o.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: o.wrap ?? THREE.ClampToEdgeWrapping,
    generateMipmaps: filter === 'mipmap',
    anisotropy: o.anisotropy ?? 1,
    depthBuffer: false,
    stencilBuffer: false,
    count: o.count ?? 1,
  });
  rt.textures.forEach((t, i) => { t.name = `${o.name ?? 'oceanRT'}${rt.textures.length > 1 ? `[${i}]` : ''}`; });
  return rt;
}
