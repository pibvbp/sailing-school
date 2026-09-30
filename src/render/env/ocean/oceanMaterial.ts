// The water surface material: owns every uniform of shaders/surface.glsl.ts and keeps them in step with
// the sky (SkyState), the sea state, gust patches, the boat and the wake.
import * as THREE from 'three';
import { BOAT } from '../../../shared/boatSpec';
import { KN } from '../../../shared/math';
import type { SkyState } from '../../core/types';
import type { CascadeStats, CascadeUniforms } from './cascades';
import { FullScreenPass, makeRT } from './gpuPass';
import { BACKDROP_FRAG, BACKDROP_VERT, ENV_EQUIRECT_BAKE, MAX_PUFFS, SKYLIGHT_BAKE, SURFACE_FRAG, SURFACE_VERT } from './shaders/surface.glsl';
import { coxMunkMss, type SeaState } from './spectrum';
import type { OceanTextures } from './textures';
import type { OceanBoat, PuffPatch } from './types';

/** Lat-long sky-reflection map (upper hemisphere). */
const ENV_WIDTH = 512;
const ENV_HEIGHT = 128;

export class OceanSurfaceMaterial {
  /** Opaque water (no blending: cheapest for the biggest draw). */
  readonly material: THREE.ShaderMaterial;
  /** The same shader and uniforms, alpha-blended, while the x-ray window is open. */
  readonly xrayMaterial: THREE.ShaderMaterial;
  /** Deep-water backdrop seen through the x-ray window where no hull is behind the surface. */
  readonly backdropMaterial: THREE.ShaderMaterial;
  private readonly u: Record<string, THREE.IUniform>;
  private envKey = '';
  /** Horizon haze ring + sky ambient, re-baked whenever the sky may have changed. */
  private readonly skyLight = makeRT(32, 2, { wrap: THREE.RepeatWrapping, name: 'oceanSkyLight' });
  private readonly skyLightPass: FullScreenPass;
  private readonly envEquirect = makeRT(ENV_WIDTH, ENV_HEIGHT, { filter: 'mipmap', name: 'oceanSkyReflection' });
  private readonly envPass: FullScreenPass;
  private lastEnv: THREE.Texture | null = null;
  private skyFrames = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer, cascades: CascadeUniforms, textures: OceanTextures, anisoMax: number) {
    const v4 = (): THREE.Vector4[] => Array.from({ length: MAX_PUFFS }, () => new THREE.Vector4());
    this.u = {
      ...cascades,
      // grid
      uInvViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uGridSize: { value: new THREE.Vector2(1, 1) },
      uGridNdc: { value: new THREE.Vector4(-1, 1, -1, 1) },
      uSkirt: { value: 1.1 },
      uRMax: { value: 30000 },
      uEarthCurvature: { value: 1 },
      uWarpStrength: { value: 12 },
      // gusts
      uPuffA: { value: v4() },
      uPuffB: { value: v4() },
      uPuffCount: { value: 0 },
      // sky
      uEnvMap: { value: null },
      uFallbackHorizon: { value: new THREE.Color(0.7, 0.75, 0.8) },
      uFallbackZenith: { value: new THREE.Color(0.2, 0.35, 0.6) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRadiance: { value: new THREE.Color(1, 1, 1) },
      uFogDensity: { value: 0 },
      uHazeMax: { value: 0.75 },
      uStreaks: { value: 0 },
      // water; texture offsets relative to uRef (see setTime)
      uRef: { value: new THREE.Vector2() },
      uOffRipple: { value: new THREE.Vector4() },
      uOffFoamA: { value: new THREE.Vector4() },
      uOffFoamB: { value: new THREE.Vector4() },
      uOffFoamC: { value: new THREE.Vector4() },
      // Irradiance reflectance of clear sea water (π·Rrs): ≈ 4 % in the blue, a third of that in the
      // green, almost nothing in the red — clear water is blue because red is absorbed within metres.
      uWaterScatter: { value: new THREE.Vector3(0.0022, 0.0135, 0.041) },
      uWaterAbsorb: { value: new THREE.Vector3(0.0008, 0.004, 0.011) },
      uWindSpeed: { value: 6 },
      uWindDirTo: { value: new THREE.Vector2(0, 1) },
      uHs: { value: 0.5 },
      uMssMean: { value: 0.03 },
      uUnresolvedMss: { value: 0.002 },
      uCascadeMss: { value: new THREE.Vector3() },
      uBandLambdaMin: { value: new THREE.Vector3(1, 1, 1) },
      uBandOctaves: { value: new THREE.Vector3(1, 1, 1) },
      uAnisoMax: { value: anisoMax },
      uFoamTex: { value: textures.foam },
      uRippleTex: { value: textures.ripple },
      uNoiseTex: { value: textures.noise },
      // boat / wake
      uWakeTex: { value: null },
      uKelvinTex: { value: null },
      uWakeRect: { value: new THREE.Vector4(0, 0, 1, 0) },
      uKelvinStep: { value: new THREE.Vector2(1, 1) },
      uBoat: { value: new THREE.Vector4(0, 0, 0, -1) },
      uHullShape: { value: hullShape() },
      uHullWL: { value: new THREE.Vector4(BOAT.hull.stemWL.x, BOAT.hull.transomWL.x, BOAT.hull.maxBeamX, BOAT.hull.bwl / 2) },
      uHullState: { value: new THREE.Vector4() },
      uDebugMode: { value: 0 },
      uSkyLight: { value: this.skyLight.texture },
      uEnvEquirect: { value: this.envEquirect.texture },
      uEnvWidth: { value: ENV_WIDTH },
      uReflection: { value: null },
      uReflectionMatrix: { value: new THREE.Matrix4() },
      uReflectionOn: { value: 0 },
    };
    this.envEquirect.texture.wrapS = THREE.RepeatWrapping;
    this.envPass = new FullScreenPass(ENV_EQUIRECT_BAKE, {
      uEnvMap: this.u['uEnvMap']!, uFallbackHorizon: this.u['uFallbackHorizon']!, uFallbackZenith: this.u['uFallbackZenith']!,
      uSize: { value: new THREE.Vector2(ENV_WIDTH, ENV_HEIGHT) },
    }, 'oceanSkyReflection');
    this.skyLightPass = new FullScreenPass(SKYLIGHT_BAKE, {
      uEnvMap: this.u['uEnvMap']!, uFallbackHorizon: this.u['uFallbackHorizon']!, uFallbackZenith: this.u['uFallbackZenith']!,
    }, 'oceanSkyLight');
    // Two materials, one program: neither uses NormalBlending, so three's program key (its "opaque"
    // flag) is identical and switching to x-ray never recompiles.
    this.material = new THREE.ShaderMaterial({
      name: 'OceanSurface',
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      uniforms: this.u,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NoBlending,
    });
    this.xrayMaterial = new THREE.ShaderMaterial({
      name: 'OceanSurfaceXray',
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      uniforms: this.u,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.backdropMaterial = new THREE.ShaderMaterial({
      name: 'OceanXrayBackdrop',
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
      uniforms: this.u,
      depthWrite: true,
    });
  }

  get uniforms(): Record<string, THREE.IUniform> { return this.u; }

  /**
   * Time and a reference point near the camera for the texture lookups. Everything large — the
   * reference's position times each texture's frequency, and drift with time — is wrapped here in
   * double precision, so the shader only ever adds small numbers.
   */
  setTime(t: number, refX: number, refZ: number): void {
    const u = this.u;
    const wd = u['uWindDirTo']!.value as THREE.Vector2;
    (u['uRef']!.value as THREE.Vector2).set(refX, refZ);
    // Wind frame (the shader's windFrame · v) and the ripple layers' rotation, applied to the reference.
    const wa = wd.x * refX + wd.y * refZ, wc = -wd.y * refX + wd.x * refZ;
    const ra = 0.8339 * refX - 0.5519 * refZ, rc = 0.5519 * refX + 0.8339 * refZ;
    (u['uOffRipple']!.value as THREE.Vector4).set(
      fract(refX * 8.3 + wd.x * t * 0.6), fract(refZ * 8.3 + wd.y * t * 0.6),
      fract(ra * 23 - wd.x * t * 1.3), fract(rc * 23 - wd.y * t * 1.3));
    (u['uOffFoamA']!.value as THREE.Vector4).set(
      fract(wa * 0.031 * 0.22 + t * 0.004), fract(wc * 0.031 - t * 0.003),
      fract(wa * 0.145 * 0.22 - t * 0.011), fract(wc * 0.145 - t * 0.008));
    (u['uOffFoamB']!.value as THREE.Vector4).set(
      fract(refX * 0.62 - t * 0.03), fract(refZ * 0.62 + t * 0.021), fract(refX * 0.23), fract(refZ * 0.23));
    (u['uOffFoamC']!.value as THREE.Vector4).set(fract(refX * 0.92 + 0.31), fract(refZ * 0.92 + 0.31), fract(-t * 0.0003), 0);
  }

  /** Sun, sky reflection and haze from the shared SkyState and the scene fog. */
  syncSky(sky: SkyState, fog: THREE.Fog | THREE.FogExp2 | null): void {
    (this.u['uSunDir']!.value as THREE.Vector3).copy(sky.sunDirection).normalize();
    (this.u['uSunRadiance']!.value as THREE.Color).copy(sky.sunColor).multiplyScalar(sky.sunIntensity);
    (this.u['uFallbackHorizon']!.value as THREE.Color).copy(sky.horizonColor);
    this.u['uFogDensity']!.value = fog && (fog as THREE.FogExp2).isFogExp2 ? (fog as THREE.FogExp2).density
      : fog ? 1.6 / Math.max((fog as THREE.Fog).far, 1) : 0.00008;
    const env = sky.envMap;
    this.u['uEnvMap']!.value = env;
    const height = env ? (env.image as { height?: number } | undefined)?.height ?? 0 : 0;
    const key = env && height > 0 ? `cubeuv${height}` : 'none';
    if (key !== this.envKey) {
      this.envKey = key;
      this.applyEnvDefines(env, height);
    }
    // A new env texture, or periodically: SkySystem re-renders into the same texture when the sun moves.
    if (env !== this.lastEnv || ++this.skyFrames >= 20) {
      this.lastEnv = env;
      this.skyFrames = 0;
      this.skyLightPass.render(this.renderer, this.skyLight);
      this.envPass.render(this.renderer, this.envEquirect);
    }
  }

  private applyEnvDefines(env: THREE.Texture | null, height: number): void {
    const defines: Record<string, string> = {};
    if (env && height > 0) {
      // Same sizes three derives for built-in materials (WebGLProgram.generateCubeUVSize).
      const maxMip = Math.log2(height) - 2;
      defines['ENVMAP_TYPE_CUBE_UV'] = '';
      defines['CUBEUV_TEXEL_WIDTH'] = String(1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16)));
      defines['CUBEUV_TEXEL_HEIGHT'] = String(1 / height);
      defines['CUBEUV_MAX_MIP'] = `${maxMip}.0`;
    }
    for (const m of [this.skyLightPass.material, this.envPass.material]) {
      m.defines = { ...defines };
      m.needsUpdate = true;
    }
  }

  setSeaState(s: SeaState, windSpeed: number, windFrom: number, stats: CascadeStats): void {
    const u = this.u;
    u['uWindSpeed']!.value = windSpeed;
    (u['uWindDirTo']!.value as THREE.Vector2).set(-Math.sin(windFrom), Math.cos(windFrom));
    u['uHs']!.value = Math.max(s.totalHs, 0.02);
    // Foam streaks along the wind from a fresh breeze (Beaufort 5) up.
    u['uStreaks']!.value = THREE.MathUtils.smoothstep(windSpeed / KN, 14, 24);
    const mssMean = coxMunkMss(windSpeed);
    u['uMssMean']!.value = mssMean;
    u['uUnresolvedMss']!.value = Math.max(mssMean - stats.resolvedMss, 0.0015);
    (u['uCascadeMss']!.value as THREE.Vector3).copy(stats.mss);
    (u['uBandLambdaMin']!.value as THREE.Vector3).copy(stats.lambdaMin);
    (u['uBandOctaves']!.value as THREE.Vector3).copy(stats.octaves);
  }

  setPuffs(patches: readonly PuffPatch[]): void {
    const a = this.u['uPuffA']!.value as THREE.Vector4[];
    const b = this.u['uPuffB']!.value as THREE.Vector4[];
    const n = Math.min(patches.length, MAX_PUFFS);
    for (let i = 0; i < n; i++) {
      const p = patches[i]!;
      // Ellipse axis = direction the wind blows TO inside the patch, in world (x, z).
      const ax = -Math.sin(p.windFrom), az = Math.cos(p.windFrom);
      a[i]!.set(p.e, -p.n, 1 / Math.max(p.radiusAlong, 1), 1 / Math.max(p.radiusAcross, 1));
      b[i]!.set(ax, az, p.strength, 0);
    }
    this.u['uPuffCount']!.value = n;
  }

  setBoat(b: OceanBoat | null, xray: number): void {
    const boat = this.u['uBoat']!.value as THREE.Vector4;
    const state = this.u['uHullState']!.value as THREE.Vector4;
    if (!b) { state.set(0, 0, 0, 0); return; }
    boat.set(b.e, -b.n, Math.sin(b.heading), -Math.cos(b.heading));
    state.set(1, b.heel, xray, Math.max(b.speed, 0));
  }

  setWake(trail: THREE.Texture, kelvin: THREE.Texture, originX: number, originZ: number, size: number, kelvinRes: number, enabled: boolean): void {
    this.u['uWakeTex']!.value = trail;
    this.u['uKelvinTex']!.value = kelvin;
    (this.u['uWakeRect']!.value as THREE.Vector4).set(originX, originZ, 1 / size, enabled ? 1 : 0);
    (this.u['uKelvinStep']!.value as THREE.Vector2).set(1 / kelvinRes, size / kelvinRes);
  }

  /** The mirrored-scene texture and its camera for the current draw (null texture = off). */
  setReflection(texture: THREE.Texture | null, viewProjection: THREE.Matrix4): void {
    this.u['uReflection']!.value = texture;
    this.u['uReflectionOn']!.value = texture ? 1 : 0;
    (this.u['uReflectionMatrix']!.value as THREE.Matrix4).copy(viewProjection);
    this.material.uniformsNeedUpdate = true;
  }

  dispose(): void {
    this.material.dispose();
    this.xrayMaterial.dispose();
    this.backdropMaterial.dispose();
    this.skyLightPass.dispose();
    this.skyLight.dispose();
    this.envPass.dispose();
    this.envEquirect.dispose();
  }
}

const fract = (x: number): number => x - Math.floor(x);

/** Waterplane outline for the cockpit cut-out, shrunk to stay inside the hull (boat-local metres). */
function hullShape(): THREE.Vector4 {
  const h = BOAT.hull;
  return new THREE.Vector4(h.stemWL.x - 0.25, h.transomWL.x + 0.1, h.maxBeamX, h.bwl / 2 - 0.14);
}
