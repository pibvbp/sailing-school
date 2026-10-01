// Volumetric clouds, GPU side: the cloud field (cloudField.ts) is ray-marched into a panorama of the upper
// hemisphere that the sky dome samples (and through it the environment map the sea and the boat reflect).
//
// Cost model. The camera sits near sea level and the clouds are kilometres away, so the panorama does not depend
// on where the camera looks and barely on where it is: it is re-rendered a tile per frame. A complete pass over
// the tiles is a "generation": it is marched from one frozen snapshot (drift, camera, sun), so there are no seams
// between tiles. The dome cross-fades from the previous generation to the newest while the next one renders, and
// shifts each by the wind drift since its snapshot, so the clouds move every frame even though each texel is
// marched about once a second.
import * as THREE from 'three';
import { cloudNoise, type CloudNoise } from './cloudNoise';
import { CloudField, panoDirection, panoDisc } from './cloudField';
import { CLOUD_RESOLVE_FRAG, CLOUD_VERT, cloudMarchFragment } from './cloudShaders';
import type { QualityTier } from '../core/types';

export interface CloudQuality {
  /** Panorama width and height (texels). */
  size: number;
  /** Tile edge (texels): one tile is marched per unit of work. */
  tile: number;
  /** Coarse march steps through the slab (envelope test only). */
  steps: number;
  /** Lit sub-steps per coarse step inside a cloud. */
  subSteps: number;
  /** Samples toward the sun per lit step. */
  lightSteps: number;
}

/** Panorama settings per tier; `null` = keep the 2-D layer. */
export function cloudQualityFor(tier: QualityTier): CloudQuality | null {
  switch (tier) {
    case 'ultra': return { size: 1536, tile: 192, steps: 56, subSteps: 5, lightSteps: 6 };
    case 'high': return { size: 1024, tile: 128, steps: 40, subSteps: 4, lightSteps: 5 };
    case 'medium': return { size: 768, tile: 96, steps: 32, subSteps: 3, lightSteps: 4 };
    default: return null;
  }
}

/**
 * A generation (every tile once, then the resolve) takes about this long whatever the frame rate: one tile per
 * frame at 60 fps on every tier, two at 30 fps, one every other frame at 120 fps (review M-9).
 */
export const GENERATION_SECONDS = 1;
/** No frame marches more than this many tiles: a slow frame must not make the next one slower still. */
export const MAX_TILES_PER_FRAME = 3;

/**
 * Tiles to march in a frame of `dt` seconds. `credit` carries the fraction of a tile left over from earlier
 * frames; returns the whole tiles due now and the credit to carry on.
 */
export function tilesDue(credit: number, dt: number, tileCount: number): { tiles: number; credit: number } {
  const total = Math.min(credit + (Math.max(dt, 0) * tileCount) / GENERATION_SECONDS, MAX_TILES_PER_FRAME);
  const tiles = Math.floor(total);
  return { tiles, credit: total - tiles };
}

/** The wind aloft veers and strengthens relative to the surface wind (northern hemisphere). */
const UPPER_WIND_VEER = THREE.MathUtils.degToRad(20);
const UPPER_WIND_FACTOR = 1.8;
const MIN_DRIFT_MS = 3;
/** Billows move through their cloud: a little faster than the cloud downwind, and upward (m/s). */
const SHAPE_EVOLVE = { along: 0.9, up: 0.45 };
const DETAIL_EVOLVE = { along: 2.2, up: 1.4 };
/** The dome shifts each panorama as if its clouds sat at this height above the base (the bases dominate overhead). */
const REF_ALTITUDE_ABOVE_BASE_M = 250;
const MAX_CAMERA_HEIGHT_M = 600;

const fract = (x: number): number => x - Math.floor(x);

/** Tiles of a size² panorama that touch the disc (corner tiles outside it are never marched). */
export function panoTiles(size: number, tile: number): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  const half = size / 2;
  for (let y = 0; y < size; y += tile) {
    for (let x = 0; x < size; x += tile) {
      const w = Math.min(tile, size - x);
      const h = Math.min(tile, size - y);
      // Distance from the centre to the nearest point of the tile.
      const nx = Math.max(x - half, 0, half - (x + w));
      const ny = Math.max(y - half, 0, half - (y + h));
      if (Math.hypot(nx, ny) <= half) out.push({ x, y, w, h });
    }
  }
  return out;
}

interface Snapshot {
  driftX: number;
  driftZ: number;
  camX: number;
  camZ: number;
  disc: number;
}

const triangle = new THREE.BufferGeometry();
triangle.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
triangle.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function volumeTexture(size: number, data: Uint8Array, name: string): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.name = name;
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** How well the CPU mirror of the field matches a freshly marched panorama (`VolumetricClouds.compareWithField`). */
export interface CloudMirrorStats {
  rays: number;
  /** Mean and worst |GPU − CPU| transmittance over the rays. */
  meanAbsDifference: number;
  worstDifference: number;
  /** Share of rays on which GPU and CPU agree whether the sky behind is more than half hidden. */
  sameSideOfHalf: number;
  /** Share of rays the CPU finds more than half hidden: the check means something only if this is not 0 or 1. */
  coveredFraction: number;
  correlation: number;
}

/** Lighting constants of the march (the demo can edit these; call `invalidate()` afterwards). */
export interface CloudLighting {
  /** First step toward the sun (m). */
  lightStep: number;
  /** How fast multiply-scattered sunlight fades with optical depth (two-stream: ≈ 0.75 (1 − g)). */
  diffuseFalloff: number;
  /** Strength of the multiply-scattered sunlight relative to isotropic single scattering. */
  multiScatter: number;
  /** Rate at which the powder term saturates with density. */
  powder: number;
  /** Henyey–Greenstein asymmetry of the forward and backward lobes, and the forward lobe's share. */
  gForward: number;
  gBack: number;
  forwardShare: number;
  /** Ambient light at a cloud's base relative to its top. */
  ambientBase: number;
  /** Extinction of the haze between the eye and the clouds (1/m). */
  haze: number;
}

export const CLOUD_LIGHTING: CloudLighting = {
  lightStep: 50,
  diffuseFalloff: 0.35,
  multiScatter: 0.75,
  powder: 6,
  gForward: 0.8,
  gBack: -0.3,
  forwardShare: 0.5,
  ambientBase: 0.35,
  haze: 6e-5,
};

export class VolumetricClouds {
  /** The CPU mirror of the field the GPU marches (drift, cover, sun transmittance). */
  readonly field: CloudField;
  /** Uniforms for the sky dome's shader (see `CLOUD_DOME_PARS_GLSL`); share these objects between materials. */
  readonly domeUniforms: Record<string, THREE.IUniform>;
  readonly lighting: CloudLighting = { ...CLOUD_LIGHTING };
  quality: CloudQuality;
  /** Completed panorama generations since start-up. */
  generations = 0;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly noise: CloudNoise;
  private readonly weatherTex: THREE.DataTexture;
  private readonly shapeTex: THREE.Data3DTexture;
  private readonly detailTex: THREE.Data3DTexture;
  private readonly scene = new THREE.Scene();
  private readonly mesh: THREE.Mesh;
  private material: THREE.RawShaderMaterial;
  /** March materials by step counts (see createMaterial). */
  private readonly materials = new Map<string, THREE.RawShaderMaterial>();
  /** Fraction of a tile carried over between frames (see tilesDue). */
  private tileCredit = 0;
  private readonly uniforms: Record<string, THREE.IUniform>;
  /** Three resolved panoramas: the one fading out, the one fading in, and the one the next resolve writes. */
  private readonly targets: THREE.WebGLRenderTarget[] = [];
  private readonly snaps: Snapshot[] = [];
  /**
   * The generation being marched: one layer of an array texture per tile (layer = row × columns + column),
   * assembled into `targets[next]` by the resolve pass when complete. A tile-based GPU loads and stores the
   * whole attachment of every render pass, so a tile must never be drawn into a panorama-sized target, neither
   * through a scissor nor by copying (measured on an M2: 0.7–2 ms per tile at 1536², against 0.15 ms of march).
   */
  private tileLayers: THREE.WebGLArrayRenderTarget;
  private readonly rawSnap: Snapshot = { driftX: 0, driftZ: 0, camX: 0, camZ: 0, disc: 1 };
  private readonly resolveScene = new THREE.Scene();
  private readonly resolveMaterial: THREE.RawShaderMaterial;
  private prev = 0;
  private cur = 0;
  private next = 1;
  private tiles: Array<{ x: number; y: number; w: number; h: number }> = [];
  /** Tiles of the generation in flight that are done; −1 = none in flight. */
  private tileIndex = -1;
  private readonly cam = new THREE.Vector3();
  private readonly sun = new THREE.Vector3(0, 1, 0);

  /** Rendering the panorama needs float colour buffers. */
  static isSupported(renderer: THREE.WebGLRenderer): boolean {
    return renderer.capabilities.isWebGL2 !== false
      && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  }

  constructor(renderer: THREE.WebGLRenderer, quality: CloudQuality, cover: number, noise: CloudNoise = cloudNoise()) {
    this.renderer = renderer;
    this.quality = quality;
    this.noise = noise;
    this.field = new CloudField(noise, cover);
    this.field.drawnSteps = quality.steps * quality.subSteps;

    this.weatherTex = new THREE.DataTexture(noise.weather.data, noise.weather.size, noise.weather.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.weatherTex.name = 'cloudWeather';
    this.weatherTex.wrapS = this.weatherTex.wrapT = THREE.RepeatWrapping;
    this.weatherTex.minFilter = this.weatherTex.magFilter = THREE.LinearFilter;
    this.weatherTex.needsUpdate = true;
    this.shapeTex = volumeTexture(noise.shape.size, noise.shape.data, 'cloudShape');
    this.detailTex = volumeTexture(noise.detail.size, noise.detail.data, 'cloudDetail');

    this.uniforms = {
      uWeather: { value: this.weatherTex },
      uShape: { value: this.shapeTex },
      uDetail: { value: this.detailTex },
      uWeatherOff: { value: new THREE.Vector2() },
      uShapeOff: { value: new THREE.Vector3() },
      uDetailOff: { value: new THREE.Vector3() },
      uTileInv: { value: new THREE.Vector3() },
      uSlab: { value: new THREE.Vector4() },
      uCover: { value: new THREE.Vector4() },
      uCarve: { value: new THREE.Vector3() },
      uInvSize: { value: new THREE.Vector2() },
      uTileOrigin: { value: new THREE.Vector2() },
      uDisc: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCamHeight: { value: 0 },
      uJitter: { value: 0 },
      uTexel: { value: new THREE.Vector2() },
      uLight: { value: new THREE.Vector4() },
      uPhase: { value: new THREE.Vector3() },
      uAmbient: { value: new THREE.Vector2() },
    };
    this.material = this.createMaterial();
    this.mesh = new THREE.Mesh(triangle, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    const panorama = (name: string): THREE.WebGLRenderTarget => {
      const target = new THREE.WebGLRenderTarget(quality.size, quality.size, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      });
      target.texture.name = name;
      return target;
    };
    for (let i = 0; i < 3; i++) {
      this.targets.push(panorama(`cloudPanorama${i}`));
      this.snaps.push({ driftX: 0, driftZ: 0, camX: 0, camZ: 0, disc: panoDisc(quality.size) });
    }
    this.tileLayers = VolumetricClouds.createTileLayers(quality);
    this.tiles = panoTiles(quality.size, quality.tile);

    this.resolveMaterial = new THREE.RawShaderMaterial({
      name: 'CloudResolve',
      glslVersion: THREE.GLSL3,
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_RESOLVE_FRAG,
      uniforms: {
        uTiles: { value: this.tileLayers.texture },
        uLayout: { value: new THREE.Vector3(quality.tile, quality.size / quality.tile, quality.size) },
        uSoften: { value: 0.35 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const resolveMesh = new THREE.Mesh(triangle, this.resolveMaterial);
    resolveMesh.frustumCulled = false;
    this.resolveScene.add(resolveMesh);

    this.domeUniforms = {
      cloudPanoA: { value: this.targets[0]!.texture },
      cloudPanoB: { value: this.targets[0]!.texture },
      cloudBlend: { value: 0 },
      cloudShiftA: { value: new THREE.Vector3(0, 0, 1) },
      cloudShiftB: { value: new THREE.Vector3(0, 0, 1) },
      cloudRefAltitude: { value: this.field.params.base + REF_ALTITUDE_ABOVE_BASE_M },
      cloudSunLight: { value: new THREE.Color(1, 1, 1) },
      cloudAmbientLight: { value: new THREE.Color(0.2, 0.2, 0.2) },
      cloudFadePower: { value: new THREE.Vector3(1, 1, 1) },
      cloudHazeGrey: { value: 0 },
    };
  }

  /**
   * The march material for the current step counts. One is kept per combination, so a governor that flips
   * between two tiers compiles each program once instead of at every flip (review M-1).
   */
  private createMaterial(): THREE.RawShaderMaterial {
    const q = this.quality;
    const key = `${q.steps}x${q.subSteps}x${q.lightSteps}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.RawShaderMaterial({
        name: 'CloudMarch',
        glslVersion: THREE.GLSL3,
        vertexShader: CLOUD_VERT,
        fragmentShader: cloudMarchFragment(q.steps, q.subSteps, q.lightSteps),
        uniforms: this.uniforms,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
      });
      this.materials.set(key, material);
    }
    return material;
  }

  setCover(cover: number): void {
    this.field.setCover(cover);
  }

  /** Change the panorama settings; the panoramas are re-allocated one by one as they come up for marching. */
  setQuality(quality: CloudQuality): void {
    const recompile = quality.steps !== this.quality.steps || quality.subSteps !== this.quality.subSteps || quality.lightSteps !== this.quality.lightSteps;
    const relayout = quality.size !== this.quality.size || quality.tile !== this.quality.tile;
    this.quality = quality;
    this.field.drawnSteps = quality.steps * quality.subSteps;
    if (recompile) {
      this.material = this.createMaterial();
      this.mesh.material = this.material;
    }
    // A generation in flight was laid out for the old size: start it again.
    if (relayout) this.tileIndex = -1;
  }

  /** Move the field with the wind aloft: `windFrom` = surface wind FROM (compass rad), `windSpeed` in m/s. */
  advance(dt: number, windFrom: number, windSpeed: number): void {
    const from = windFrom + UPPER_WIND_VEER;
    const speed = Math.max(MIN_DRIFT_MS, windSpeed * UPPER_WIND_FACTOR);
    // Downwind in the three.js world: east = +X, north = −Z.
    const wx = -Math.sin(from);
    const wz = Math.cos(from);
    const d = this.field.drift;
    d.x += wx * speed * dt;
    d.z += wz * speed * dt;
    d.shape[0] += wx * SHAPE_EVOLVE.along * dt;
    d.shape[1] += SHAPE_EVOLVE.up * dt;
    d.shape[2] += wz * SHAPE_EVOLVE.along * dt;
    d.detail[0] += wx * DETAIL_EVOLVE.along * dt;
    d.detail[1] += DETAIL_EVOLVE.up * dt;
    d.detail[2] += wz * DETAIL_EVOLVE.along * dt;
  }

  /**
   * Per frame: march the tiles that are due after `dt` seconds (a generation per `GENERATION_SECONDS`, whatever
   * the frame rate) unless `work` is false (the frame's GPU budget went elsewhere), and point the dome's uniforms
   * at the two newest complete panoramas. `camera` is the world position of the eye.
   */
  update(camera: THREE.Vector3, sunDirection: THREE.Vector3, dt: number, work = true): void {
    this.cam.copy(camera);
    this.sun.copy(sunDirection);
    if (work) {
      const due = tilesDue(this.tileCredit, dt, this.tiles.length);
      this.tileCredit = due.credit;
      if (due.tiles > 0) this.march(due.tiles);
    }
    this.syncDome();
  }

  /**
   * Did the march really run? The rim of the panorama looks along the horizon, where no cloud is marched, so its
   * transmittance must be exactly 1. If the march or the resolve program failed to compile, or the layered
   * half-float framebuffer is incomplete, nothing was drawn and it reads 0: the caller must then fall back to the
   * 2-D layer, or the sky would silently lose its clouds and its sun disc (review M-2). Call after `renderAll`.
   */
  selfTest(): boolean {
    const target = this.targets[this.cur]!;
    const size = target.width;
    const texel = new Uint16Array(4);
    const previous = this.renderer.getRenderTarget();
    try {
      // Just inside the rim, on the +x axis of the disc.
      const x = Math.min(size - 1, Math.round(size / 2 + (panoDisc(size) * size) / 2 - 1));
      this.renderer.readRenderTargetPixels(target, x, size >> 1, 1, 1, texel);
    } catch {
      return false;
    } finally {
      this.renderer.setRenderTarget(previous);
    }
    return Math.abs(THREE.DataUtils.fromHalfFloat(texel[3]!) - 1) < 1e-3;
  }

  /**
   * Free the panoramas and the tile array on the GPU (19–75 MB) while the clouds are not shown; the field keeps
   * its drift and cover, and the next `renderAll` re-allocates them (review M-7).
   */
  release(): void {
    for (const t of this.targets) t.dispose();
    this.tileLayers.dispose();
    this.tileIndex = -1;
  }

  /** March a whole generation now and show it alone (start-up, or after a jump in time). */
  renderAll(camera: THREE.Vector3, sunDirection: THREE.Vector3): void {
    this.cam.copy(camera);
    this.sun.copy(sunDirection);
    this.tileIndex = -1;
    this.march(Infinity);
    this.prev = this.cur;
    this.syncDome();
  }

  /** Progress of the generation in flight, 0…1. */
  get progress(): number {
    return this.tileIndex < 0 ? 0 : this.tileIndex / this.tiles.length;
  }

  /** Fraction of the direct sunlight reaching the eye at world position `camera`. */
  sunTransmittance(camera: THREE.Vector3, sunDirection: THREE.Vector3): number {
    return this.field.sunTransmittance(camera.x, camera.y, camera.z, sunDirection.x, sunDirection.y, sunDirection.z);
  }

  /**
   * Debug and end-to-end check that the CPU mirror of the field (which dims the sun's light) is the field the GPU
   * draws: march a fresh panorama, read it back, and compare its transmittance with the CPU march along the same
   * rays, on a grid of directions over the hemisphere. Synchronous and slow (a full march and an 8 MB readback):
   * never call it per frame. `demos/env.html?suncheck=1` and the app's `?suncheck=1` (e2e/clouds.spec.ts) use it.
   */
  compareWithField(eye: THREE.Vector3, sunDirection: THREE.Vector3): CloudMirrorStats {
    this.renderAll(eye, sunDirection);
    const target = this.targets[this.cur]!;
    const size = target.width;
    const texels = new Uint16Array(size * size * 4);
    const previous = this.renderer.getRenderTarget();
    this.renderer.readRenderTargetPixels(target, 0, 0, size, size, texels);
    this.renderer.setRenderTarget(previous);
    const disc = panoDisc(size);
    const dir = { x: 0, y: 0, z: 0 };
    const stride = Math.max(1, Math.floor(size / 48));
    let n = 0, sumAbs = 0, worst = 0, agree = 0, covered = 0;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let j = stride >> 1; j < size; j += stride) {
      for (let i = stride >> 1; i < size; i += stride) {
        const u = (i + 0.5) / size;
        const v = (j + 0.5) / size;
        if (Math.hypot(u - 0.5, v - 0.5) * 2 > disc * 0.97) continue;
        panoDirection(u, v, disc, dir);
        const gpu = THREE.DataUtils.fromHalfFloat(texels[(j * size + i) * 4 + 3]!);
        // The march the sun's disc is judged by (the per-frame light runs it too, with the reach rule on top).
        const cpu = this.field.viewTransmittance(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z);
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

  /** Throw away the generation in flight so the next one picks up edited parameters at once. */
  invalidate(): void {
    this.tileIndex = -1;
  }

  /** The newest complete panorama (benchmarks sync on it; debug views show it). */
  get newest(): THREE.WebGLRenderTarget {
    return this.targets[this.cur]!;
  }

  /** Number of tiles in one generation. */
  get tileCount(): number {
    return this.tiles.length;
  }

  /**
   * Benchmark hook: march `count` tiles starting at `first` (no bookkeeping), then, with `resolve`, run the
   * resolve pass into the free display target. Returns that target (a benchmark syncs on it after a resolve).
   */
  benchMarch(first: number, count: number, resolve: boolean): THREE.WebGLRenderTarget {
    if (this.tileIndex < 0) this.beginGeneration();
    const renderer = this.renderer;
    const out = this.targets[this.next]!;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    for (let i = 0; i < count; i++) this.marchTile(this.tiles[(first + i) % this.tiles.length]!);
    if (resolve) this.resolveInto(out);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    return out;
  }

  /** March one tile into its own layer of the tile array: a render pass on a tile-sized attachment. */
  private marchTile(t: { x: number; y: number; w: number; h: number }): void {
    const q = this.quality;
    (this.uniforms['uTileOrigin']!.value as THREE.Vector2).set(t.x, t.y);
    this.renderer.setRenderTarget(this.tileLayers, (t.y / q.tile) * (q.size / q.tile) + t.x / q.tile);
    this.renderer.render(this.scene, passCamera);
  }

  /** Assemble and filter the marched tiles into a display panorama (see CLOUD_RESOLVE_FRAG). */
  private resolveInto(out: THREE.WebGLRenderTarget): void {
    const q = this.quality;
    if (out.width !== q.size) out.setSize(q.size, q.size);
    this.renderer.setRenderTarget(out);
    this.renderer.render(this.resolveScene, passCamera);
  }

  /** The array texture the tiles are marched into: one layer per tile of the panorama's grid. */
  private static createTileLayers(q: CloudQuality): THREE.WebGLArrayRenderTarget {
    const perRow = q.size / q.tile;
    const target = new THREE.WebGLArrayRenderTarget(q.tile, q.tile, perRow * perRow, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.texture.name = 'cloudTiles';
    return target;
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.tileLayers.dispose();
    this.resolveMaterial.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.weatherTex.dispose();
    this.shapeTex.dispose();
    this.detailTex.dispose();
  }

  private beginGeneration(): void {
    const q = this.quality;
    const perRow = q.size / q.tile;
    if (this.tileLayers.width !== q.tile || this.tileLayers.depth !== perRow * perRow) {
      // A tier change: the tile grid has a new shape.
      this.tileLayers.dispose();
      this.tileLayers = VolumetricClouds.createTileLayers(q);
      this.resolveMaterial.uniforms['uTiles']!.value = this.tileLayers.texture;
    }
    (this.resolveMaterial.uniforms['uLayout']!.value as THREE.Vector3).set(q.tile, perRow, q.size);
    this.tiles = panoTiles(q.size, q.tile);
    this.tileIndex = 0;

    const p = this.field.params;
    const d = this.field.drift;
    const disc = panoDisc(q.size);
    const snap = this.rawSnap;
    snap.driftX = d.x;
    snap.driftZ = d.z;
    snap.camX = this.cam.x;
    snap.camZ = this.cam.z;
    snap.disc = disc;

    const u = this.uniforms;
    (u['uWeatherOff']!.value as THREE.Vector2).set(fract((this.cam.x - d.x) / p.weatherTile), fract((this.cam.z - d.z) / p.weatherTile));
    (u['uShapeOff']!.value as THREE.Vector3).set(
      fract((this.cam.x - d.x - d.shape[0]) / p.shapeTile), fract(-d.shape[1] / p.shapeTile), fract((this.cam.z - d.z - d.shape[2]) / p.shapeTile));
    (u['uDetailOff']!.value as THREE.Vector3).set(
      fract((this.cam.x - d.x - d.detail[0]) / p.detailTile), fract(-d.detail[1] / p.detailTile), fract((this.cam.z - d.z - d.detail[2]) / p.detailTile));
    (u['uTileInv']!.value as THREE.Vector3).set(1 / p.weatherTile, 1 / p.shapeTile, 1 / p.detailTile);
    (u['uSlab']!.value as THREE.Vector4).set(p.base, 1 / (p.top - p.base), p.top, p.sigma);
    (u['uCover']!.value as THREE.Vector4).set(p.threshold, 1 / p.edge, 1 / p.rise, p.heightScale);
    (u['uCarve']!.value as THREE.Vector3).set(p.heightMin, p.erosion, p.detailErosion);
    (u['uInvSize']!.value as THREE.Vector2).set(1 / q.size, 1 / q.size);
    u['uDisc']!.value = disc;
    (u['uSunDir']!.value as THREE.Vector3).copy(this.sun).normalize();
    u['uCamHeight']!.value = THREE.MathUtils.clamp(this.cam.y, 0, MAX_CAMERA_HEIGHT_M);
    // A different sub-step offset each generation, so the cross-fade averages the march's sampling error.
    u['uJitter']!.value = fract(this.generations * 0.61803398875);
    (u['uTexel']!.value as THREE.Vector2).set(p.shapeTile / this.noise.shape.size, p.detailTile / this.noise.detail.size);
    const l = this.lighting;
    (u['uLight']!.value as THREE.Vector4).set(l.lightStep, l.diffuseFalloff, l.multiScatter, l.powder);
    (u['uPhase']!.value as THREE.Vector3).set(l.gForward, l.gBack, l.forwardShare);
    (u['uAmbient']!.value as THREE.Vector2).set(l.ambientBase, l.haze);
    this.domeUniforms['cloudRefAltitude']!.value = p.base + REF_ALTITUDE_ABOVE_BASE_M;
  }

  private march(count: number): void {
    if (this.tileIndex < 0) this.beginGeneration();
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevCubeFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const prevAutoClear = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    renderer.autoClear = false;
    renderer.xr.enabled = false;
    let marched = 0;
    for (; marched < count && this.tileIndex < this.tiles.length; marched++, this.tileIndex++) this.marchTile(this.tiles[this.tileIndex]!);
    // The resolve is a full pass over the panorama (≈ 1 ms): it gets a frame of its own, after the last tile.
    const complete = this.tileIndex >= this.tiles.length && (marched === 0 || count === Infinity);
    if (complete) {
      this.resolveInto(this.targets[this.next]!);
      Object.assign(this.snaps[this.next]!, this.rawSnap);
    }
    renderer.setRenderTarget(prevTarget, prevCubeFace, prevMip);
    renderer.autoClear = prevAutoClear;
    renderer.xr.enabled = prevXr;

    if (complete) {
      // The generation is complete: it starts fading in, and the oldest panorama is free for the next one.
      const free = this.prev === this.cur ? 3 - this.cur - this.next : this.prev;
      this.prev = this.cur;
      this.cur = this.next;
      this.next = free;
      this.tileIndex = -1;
      this.generations++;
    }
  }

  private syncDome(): void {
    const u = this.domeUniforms;
    const d = this.field.drift;
    const a = this.snaps[this.prev]!;
    const b = this.snaps[this.cur]!;
    u['cloudPanoA']!.value = this.targets[this.prev]!.texture;
    u['cloudPanoB']!.value = this.targets[this.cur]!.texture;
    u['cloudBlend']!.value = this.prev === this.cur ? 0 : this.progress;
    (u['cloudShiftA']!.value as THREE.Vector3).set(d.x - a.driftX - (this.cam.x - a.camX), d.z - a.driftZ - (this.cam.z - a.camZ), a.disc);
    (u['cloudShiftB']!.value as THREE.Vector3).set(d.x - b.driftX - (this.cam.x - b.camX), d.z - b.driftZ - (this.cam.z - b.camZ), b.disc);
  }
}
