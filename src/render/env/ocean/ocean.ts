// Ocean: the FFT sea, its surface, wake, gust patches, x-ray window and height sampler behind the
// interface of plan Task 11. One `update` per frame, before the scene is rendered.
import * as THREE from 'three';
import type { QualitySettings, SkyState } from '../../core/types';
import { OceanCascades } from './cascades';
import { OceanMesh } from './oceanMesh';
import { OceanSurfaceMaterial } from './oceanMaterial';
import { PlanarReflection } from './reflection';
import { OceanHeightSampler } from './sampler';
import { BowSpray } from './spray';
import { defaultOceanParams, type SeaState } from './spectrum';
import { bakeOceanTextures, type OceanTextures } from './textures';
import type { OceanBoat, OceanParams, OceanSampler, PuffPatch } from './types';
import { BoatWake } from './wake';

export type { OceanBoat, OceanParams, OceanSampler, PuffPatch } from './types';

/** Sampler queries within this distance of the boat are its own (hull, spray) and use the fine grid. */
const BOAT_OWN_RADIUS = 4.5;
/** Radius (m) of the deep-water backdrop under the x-ray window. */
const XRAY_BACKDROP_R = 500;
const _camPos = new THREE.Vector3();

export class Ocean {
  /**
   * Whether this GPU can run the ocean: the FFT, wake and probe render into half-float (or float)
   * targets. Without either extension the app should fall back (plan Review Focus #4).
   */
  static isSupported(renderer: THREE.WebGLRenderer): boolean {
    return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  }

  /** Height/normal of the drawn surface, one frame late (0 / up until the first readback lands). */
  readonly sampler: OceanSampler;
  private readonly textures: OceanTextures;
  private readonly cascades: OceanCascades;
  private readonly surface: OceanSurfaceMaterial;
  private readonly oceanMesh: OceanMesh;
  private readonly probe: OceanHeightSampler;
  private readonly wake: BoatWake;
  private readonly backdrop: THREE.Mesh;
  private readonly reflection: PlanarReflection;
  private readonly spray: BowSpray;
  private boat: OceanBoat | null = null;
  private readonly boatState: OceanBoat = { e: 0, n: 0, heading: 0, speed: 0, heel: 0 };
  private readonly spacing = { row: 0, col: 0 };
  private xrayOn = false;
  private xray = 0;
  private seaVersion = -1;
  /** Seconds since the boat was last set: its wake keeps fading on the water for a while. */
  private sinceBoat = Infinity;
  /** Diagnostics only: skip groups of offscreen passes to measure their cost. */
  readonly skip = { fft: false, wake: false, probe: false };
  /** When set, only this camera gets the planar reflection (e.g. skip it for a picture-in-picture view). */
  reflectFor: THREE.Camera | null = null;

  constructor(renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, private readonly sky: SkyState, q: QualitySettings) {
    const params = defaultOceanParams(12);
    this.textures = bakeOceanTextures(renderer, q.tier === 'low' ? 'reduced' : 'full');
    this.cascades = new OceanCascades(renderer, q, params);
    this.surface = new OceanSurfaceMaterial(renderer, this.cascades.uniforms, this.textures, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    this.oceanMesh = new OceanMesh(this.surface.material, q.oceanMeshDetail);
    this.probe = new OceanHeightSampler(renderer, this.surface.uniforms);
    this.sampler = this.probe;
    this.wake = new BoatWake(renderer, q);
    // 7 m down and wide enough that a ray through the far side of the x-ray window (11 m from the boat) still meets it
    // from a camera looking only 1° down: 11 + 7 / tan 1° ≈ 410 m.
    this.backdrop = new THREE.Mesh(new THREE.CircleGeometry(XRAY_BACKDROP_R, 64).rotateX(-Math.PI / 2), this.surface.backdropMaterial);
    this.backdrop.name = 'OceanXrayBackdrop';
    this.backdrop.visible = false;
    this.backdrop.frustumCulled = false;
    this.spray = new BowSpray(this.surface.uniforms);
    this.spray.setQuality(q);
    scene.add(this.oceanMesh.mesh, this.backdrop, this.spray.points);
    this.reflection = new PlanarReflection([this.oceanMesh.mesh, this.backdrop, this.spray.points]);
    this.reflection.setQuality(q.reflections);
    this.oceanMesh.beforeDraw = (r, s, camera) => {
      const drawn = (this.reflectFor === null || this.reflectFor === camera) && this.reflection.render(r, s, camera);
      this.surface.setReflection(drawn ? this.reflection.texture : null, this.reflection.viewProjection, this.reflection.texelsPerRadian);
    };
  }

  /** The drawn surface (for layers / picking); its geometry is placed in the vertex shader. */
  get mesh(): THREE.Mesh { return this.oceanMesh.mesh; }
  get seaState(): SeaState { return this.cascades.seaState; }
  get triangles(): number { return this.oceanMesh.triangles; }
  /** Diagnostics: registered sampler points (marks, camera) and the grids' value at a point, ignoring them. */
  get probePointCount(): number { return this.probe.registry.points.length; }
  sampleGridsOnly(x: number, z: number, out: { h: number; sx: number; sz: number }): boolean { return this.probe.grids.sampleGridsOnly(x, z, out); }
  /** Diagnostics: bow-spray droplets alive and the bow-burial rate driving them. */
  get sprayStats(): Readonly<{ live: number; rate: number; maxRate: number }> { return this.spray.stats; }

  setParams(p: OceanParams): void { this.cascades.setParams(p); }
  setPuffs(p: readonly PuffPatch[]): void { this.surface.setPuffs(p); }
  setBoat(b: OceanBoat | null): void {
    if (!b) { this.boat = null; return; }
    const s = this.boatState;
    s.e = b.e; s.n = b.n; s.heading = b.heading; s.speed = b.speed; s.heel = b.heel;
    this.boat = s;
  }
  setXray(on: boolean): void { this.xrayOn = on; }
  /** Keep objects out of the planar reflection (sky domes named 'sky' are found automatically). */
  excludeFromReflection(...objects: THREE.Object3D[]): void { this.reflection.addExclusions(...objects); }
  /** Diagnostic views: 0 off, 1 wake trail, 2 foam, 3 normal, 4 roughness, 5 gust field, 6 Fresnel, 7 Kelvin, 8 sun glitter, 9 reflected sky, 10 light from the water. */
  setDebugView(mode: number): void { this.surface.uniforms['uDebugMode']!.value = mode; }

  setQuality(q: QualitySettings): void {
    this.cascades.setQuality(q);
    this.oceanMesh.setDetail(q.oceanMeshDetail);
    this.wake.setQuality(q);
    this.reflection.setQuality(q.reflections);
    this.spray.setQuality(q);
  }

  /** Advance to sea time `t` (s) by `dt`; `camera` is the main view (probe focus when there is no boat). */
  update(dt: number, t: number, camera: THREE.Camera): void {
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    const focusX = this.boat ? this.boat.e : _camPos.x;
    const focusZ = this.boat ? -this.boat.n : _camPos.z;
    // Registered points (marks, camera clearance) are probed at the mesh's level of detail for this
    // camera; the boat's own queries stay on the fine grid.
    const v = this.probe.view;
    v.camX = _camPos.x; v.camY = _camPos.y; v.camZ = _camPos.z;
    this.oceanMesh.angularSpacing(camera, this.spacing);
    v.rowAngle = this.spacing.row; v.colAngle = this.spacing.col;
    this.probe.exclusionX = focusX;
    this.probe.exclusionZ = focusZ;
    this.probe.exclusionRadius = this.boat ? BOAT_OWN_RADIUS : -1;

    this.surface.syncSky(this.sky, this.scene.fog as THREE.Fog | THREE.FogExp2 | null);
    if (!this.skip.fft) this.cascades.update(t, dt);
    if (this.seaVersion !== this.cascades.version) {
      this.seaVersion = this.cascades.version;
      const p = this.cascades.oceanParams;
      this.surface.setSeaState(this.cascades.seaState, p.windSpeed, p.windFrom, this.cascades.stats);
    }
    this.surface.setTime(t, _camPos.x, _camPos.z);

    this.sinceBoat = this.boat ? 0 : this.sinceBoat + dt;
    const wakeLive = this.sinceBoat < 90;
    if (!this.skip.wake && wakeLive) this.wake.update(dt, this.boat);
    this.surface.setWake(this.wake.trailTexture, this.wake.kelvinTexture, this.wake.originX, this.wake.originZ, this.wake.size, this.wake.res / 2, wakeLive);

    this.xray += THREE.MathUtils.clamp((this.xrayOn ? 1 : 0) - this.xray, -dt * 3, dt * 3);
    this.surface.setBoat(this.boat, this.boat ? this.xray : 0);
    // Opaque and first while the water hides everything below it, so early depth rejection skips the
    // sky dome and hull behind it; blended after the opaque scene only while the x-ray window is open.
    this.oceanMesh.mesh.material = this.boat !== null && this.xray > 0.005 ? this.surface.xrayMaterial : this.surface.material;
    this.backdrop.visible = this.boat !== null && this.xray > 0.005;
    if (this.boat) this.backdrop.position.set(this.boat.e, -7, -this.boat.n);

    const p = this.cascades.oceanParams;
    this.spray.wind.set(-Math.sin(p.windFrom) * p.windSpeed, Math.cos(p.windFrom) * p.windSpeed);
    this.spray.update(dt, t, this.boat, this.probe);

    // Mirror about the water under the boat (or the camera). The hull floats at that level, so the clip
    // sits just under its waterline (its bottom must not reflect); without a boat, below the troughs so
    // floating marks keep their waterline.
    this.reflection.mirrorY = this.probe.heightAt(focusX, -focusZ, t);
    this.reflection.clipY = this.reflection.mirrorY - (this.boat ? 0.1 : 0.2 + 0.35 * this.cascades.seaState.totalHs);
    if (!this.skip.probe) this.probe.update(t, focusX, focusZ);
  }

  dispose(): void {
    this.scene.remove(this.oceanMesh.mesh, this.backdrop, this.spray.points);
    this.spray.dispose();
    this.oceanMesh.dispose();
    this.backdrop.geometry.dispose();
    this.surface.dispose();
    this.probe.dispose();
    this.wake.dispose();
    this.reflection.dispose();
    this.cascades.dispose();
    this.textures.dispose();
  }
}
