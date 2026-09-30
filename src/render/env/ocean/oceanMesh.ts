// Screen-space projected grid: every vertex is a view ray intersected with the (curved) sea, so the
// triangle density is uniform in pixels and the mesh ends exactly on the geometric horizon.
// Adapted from ABYSSAL `src/ocean/OceanMesh.js` (buildProjectedGrid, skirt, horizon snapping).
// Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school: rows are
// concentrated below the horizon each frame (no vertices wasted on sky), camera state is taken in
// onBeforeRender so any camera that draws the sea (main view, picture-in-picture) is exact.
import * as THREE from 'three';

const EARTH_R = 6371000;
const GRID_MARGIN = 1.04;

export function gridResolution(detail: number): { x: number; y: number } {
  const d = THREE.MathUtils.clamp(detail, 0.2, 1.2);
  return { x: Math.max(64, Math.round(480 * d)), y: Math.max(40, Math.round(300 * d)) };
}

export function buildProjectedGrid(nx: number, ny: number): THREE.BufferGeometry {
  const grid = new Float32Array((nx + 1) * (ny + 1) * 2);
  let o = 0;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) { grid[o++] = i / nx; grid[o++] = j / ny; }
  }
  const idx = new Uint32Array(nx * ny * 6);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = d;
      idx[k++] = a; idx[k++] = d; idx[k++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('aGrid', new THREE.BufferAttribute(grid, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** NDC y where the view ray at NDC x meets the geometric horizon (±∞ encoded as ±2). */
function horizonNdcY(invViewProj: THREE.Matrix4, x: number, dip: number): number {
  const elevation = (y: number): number => {
    _a.set(x, y, -1).applyMatrix4(invViewProj);
    _b.set(x, y, 1).applyMatrix4(invViewProj);
    _b.sub(_a).normalize();
    return Math.asin(THREE.MathUtils.clamp(_b.y, -1, 1));
  };
  let lo = -1.6, hi = 1.6;
  const target = -dip;
  const eLo = elevation(lo), eHi = elevation(hi);
  if (eLo > target && eHi > target) return -2;
  if (eLo < target && eHi < target) return 2;
  const rising = eHi > eLo;
  for (let i = 0; i < 22; i++) {
    const mid = 0.5 * (lo + hi);
    if ((elevation(mid) < target) === rising) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export class OceanMesh {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Extra per-camera work right before the sea is drawn (e.g. the planar reflection). */
  beforeDraw: ((renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => void) | null = null;
  private nx = 0;
  private ny = 0;

  constructor(private readonly material: THREE.ShaderMaterial, detail: number) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = 'Ocean';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      this.fitToCamera(camera);
      this.beforeDraw?.(renderer, scene as THREE.Scene, camera);
    };
    this.setDetail(detail);
  }

  get triangles(): number { return this.nx * this.ny * 2; }

  /**
   * Angular size (rad) of one grid row and one column as last fitted for `camera` — with the camera
   * height and distance this gives the footprint the vertex shader picks its level of detail from.
   */
  angularSpacing(camera: THREE.Camera, out: { row: number; col: number }): { row: number; col: number } {
    const cam = camera as THREE.PerspectiveCamera;
    const tanHalf = cam.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) : 0.5;
    const aspect = cam.isPerspectiveCamera ? cam.aspect : 1;
    const ndc = this.material.uniforms['uGridNdc']!.value as THREE.Vector4;
    out.row = ((ndc.w - ndc.z) / this.ny) * tanHalf;
    out.col = ((ndc.y - ndc.x) / this.nx) * tanHalf * aspect;
    return out;
  }

  setDetail(detail: number): void {
    const { x, y } = gridResolution(detail);
    if (x === this.nx && y === this.ny) return;
    this.nx = x; this.ny = y;
    const old = this.mesh.geometry;
    this.mesh.geometry = buildProjectedGrid(x, y);
    old.dispose();
    (this.material.uniforms['uGridSize']!.value as THREE.Vector2).set(x, y);
  }

  /** Aim the grid for the camera about to draw it. */
  private fitToCamera(camera: THREE.Camera): void {
    const u = this.material.uniforms;
    const inv = u['uInvViewProj']!.value as THREE.Matrix4;
    inv.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    const cam = (u['uCamPos']!.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    const eye = Math.max(cam.y, 0.35);
    const horizon = Math.sqrt(2 * EARTH_R * eye);
    const far = (camera as THREE.PerspectiveCamera).far ?? 1e5;
    u['uRMax']!.value = Math.min(horizon * 1.02, far * 0.97);
    const dip = Math.sqrt((2 * eye) / EARTH_R);
    const top = Math.max(horizonNdcY(inv, -GRID_MARGIN, dip), horizonNdcY(inv, GRID_MARGIN, dip));
    const yTop = THREE.MathUtils.clamp(top + 0.03, -GRID_MARGIN + 0.01, GRID_MARGIN);
    (u['uGridNdc']!.value as THREE.Vector4).set(-GRID_MARGIN, GRID_MARGIN, -GRID_MARGIN, yTop);
    this.mesh.material.uniformsNeedUpdate = true;
  }

  dispose(): void { this.mesh.geometry.dispose(); }
}
