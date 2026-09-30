// Sky, sun and image-based light (spec §9.4).
//
// The visible sky is three r186 `Sky.js` (Preetham daylight + its 2-D cloud layer, see clouds.ts). A CPU
// port of the same Preetham terms gives the sun colour, horizon/fog colours and auto-exposure, so every
// module lights and fogs with numbers that match the pixels of the sky behind it.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CloudLayer, cloudUniforms, patchCloudShader } from './clouds';
import type { QualitySettings, SkyState } from '../core/types';

// ---------------------------------------------------------------------------------------------------------
// Sun position

/** Latitude and solar declination of the sailing area (mid-latitude, late summer). */
export const SITE = { latitudeDeg: 45, declinationDeg: 20 } as const;

/**
 * Sun elevation and compass azimuth (rad) for local solar time `hours` (standard solar-position formulas).
 * At the default site: 17:00 → 24° (the spec's late-afternoon default), 13:00 → 62°, 18:30 → 9°.
 */
export function sunPosition(hours: number, latitudeDeg: number = SITE.latitudeDeg, declinationDeg: number = SITE.declinationDeg): { elevation: number; azimuth: number } {
  const phi = THREE.MathUtils.degToRad(latitudeDeg);
  const delta = THREE.MathUtils.degToRad(declinationDeg);
  const hourAngle = THREE.MathUtils.degToRad(15 * (hours - 12));
  const sinEl = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(hourAngle);
  const elevation = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  const azimuth = Math.atan2(
    -Math.sin(hourAngle) * Math.cos(delta),
    Math.sin(delta) * Math.cos(phi) - Math.cos(delta) * Math.sin(phi) * Math.cos(hourAngle),
  );
  return { elevation, azimuth: (azimuth + 2 * Math.PI) % (2 * Math.PI) };
}

/** Unit vector toward a compass bearing/elevation in the three.js world (North = −Z, East = +X). */
export function directionFromBearing(azimuth: number, elevation: number, out = new THREE.Vector3()): THREE.Vector3 {
  const h = Math.cos(elevation);
  return out.set(Math.sin(azimuth) * h, Math.sin(elevation), -Math.cos(azimuth) * h);
}

// ---------------------------------------------------------------------------------------------------------
// CPU Preetham model — the same terms as the vertex/fragment shader of three r186 `Sky.js` (MIT).

export interface AtmosphereParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  /**
   * Exponent on the in-scattered light (Sky.js: 1.5). Lower values lift the zenith relative to the
   * horizon: 1.5 makes the horizon ≈ 11× brighter than the zenith; clear skies measure ≈ 3–5×.
   */
  scatterExponent: number;
}

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5] as const;
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14] as const;
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const SKY_BIAS = [0, 0.0003, 0.00075] as const;

export class PreethamModel {
  readonly sun = new THREE.Vector3(0, 1, 0);
  /** The shader's `vSunE`: sun intensity after the "earth shadow" horizon cut-off. */
  sunE = 0;
  private readonly betaR = [0, 0, 0];
  private readonly betaM = [0, 0, 0];
  private g = 0.8;
  private exponent = 1.5;
  private readonly fex = [0, 0, 0];

  set(params: AtmosphereParams, sunDirection: THREE.Vector3): this {
    this.sun.copy(sunDirection).normalize();
    const zenith = Math.acos(THREE.MathUtils.clamp(this.sun.y, -1, 1));
    this.sunE = EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - zenith) / STEEPNESS)));
    // The shader's sun fade uses sunPosition.y / 450000; with a unit vector it is 1.
    const sunFade = 1 - THREE.MathUtils.clamp(1 - Math.exp(this.sun.y / 450000), 0, 1);
    const rayleighCoefficient = params.rayleigh - (1 - sunFade);
    const mie = 0.434 * (0.2 * params.turbidity * 10e-18);
    for (let i = 0; i < 3; i++) {
      this.betaR[i] = TOTAL_RAYLEIGH[i]! * rayleighCoefficient;
      this.betaM[i] = mie * MIE_CONST[i]! * params.mieCoefficient;
    }
    this.g = params.mieDirectionalG;
    this.exponent = params.scatterExponent;
    return this;
  }

  /** Atmospheric transmittance from the top of the atmosphere along a direction with this `y`. */
  extinction(dirY: number, out: number[] = this.fex): number[] {
    const zenithAngle = Math.acos(Math.max(0, dirY));
    const inverse = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
    const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
    const sM = MIE_ZENITH_LENGTH * inverse;
    for (let i = 0; i < 3; i++) out[i] = Math.exp(-(this.betaR[i]! * sR + this.betaM[i]! * sM));
    return out;
  }

  /** Sky radiance (linear, same units as the sky shader's output) without sun disc or clouds. */
  radiance(dir: THREE.Vector3, out: THREE.Color): THREE.Color {
    const fex = this.extinction(dir.y);
    const cosTheta = dir.dot(this.sun);
    const r = cosTheta * 0.5 + 0.5;
    const rPhase = (3 / (16 * Math.PI)) * (1 + r * r);
    const g2 = this.g * this.g;
    const mPhase = (1 / (4 * Math.PI)) * ((1 - g2) / Math.pow(1 - 2 * this.g * cosTheta + g2, 1.5));
    const blend = THREE.MathUtils.clamp(Math.pow(1 - this.sun.y, 5), 0, 1);
    const rgb = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const bR = this.betaR[i]!;
      const bM = this.betaM[i]!;
      const scatter = (this.sunE * (bR * rPhase + bM * mPhase)) / (bR + bM);
      let lin = Math.pow(scatter * (1 - fex[i]!), this.exponent);
      lin *= 1 + (Math.pow(scatter * fex[i]!, 0.5) - 1) * blend;
      rgb[i] = (lin + 0.1 * fex[i]!) * 0.04 + SKY_BIAS[i]!;
    }
    return out.setRGB(rgb[0]!, rgb[1]!, rgb[2]!, THREE.LinearSRGBColorSpace);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Sky dome material: Sky.js + cloud patches (clouds.ts) + a distant sea below the horizon.

/** Clear maritime air: deep blue overhead, a pale but not white horizon. */
export const ATMOSPHERE: AtmosphereParams = { turbidity: 2.4, rayleigh: 1.25, mieCoefficient: 0.0045, mieDirectionalG: 0.8, scatterExponent: 1.5 };

type SkyShaderDef = { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string };

/** Patches on top of the cloud patches: adjustable in-scatter exponent and the distant sea below the horizon. */
const SKY_PATCHES: Array<[string, string]> = [
  [
    '* ( 1.0 - Fex ), vec3( 1.5 ) );',
    '* ( 1.0 - Fex ), vec3( scatterExponent ) );',
  ],
  ['uniform float time;', 'uniform float time;\n\t\tuniform float scatterExponent;\n\t\tuniform float seaBelowHorizon;\n\t\tuniform vec3 seaWater;'],
  [
    'vec3 direction = normalize( vWorldPosition - cameraPosition );',
    `vec3 direction = normalize( vWorldPosition - cameraPosition );
			// Below the horizon: a distant sea. Wave facets tilted toward the eye reflect sky from above the
			// mirror direction, and the Fresnel of a rough sea tops out well below 1, so the far sea stays
			// darker than the sky just above it: that contrast is the horizon line.
			float seaMask = 0.0;
			float seaFresnel = 0.0;
			if ( seaBelowHorizon > 0.5 && direction.y < 0.0 ) {
				float mu = - direction.y;
				seaMask = 1.0;
				seaFresnel = 0.02 + 0.98 * pow( 1.0 - max( mu, 0.18 ), 5.0 );
				direction = normalize( vec3( direction.x, mu + 0.12 * ( 1.0 - mu ) * ( 1.0 - mu ), direction.z ) );
			}`,
  ],
  ['* 50000.0, 0.0, 1.0 ) * showSunDisc;', '* 50000.0, 0.0, 1.0 ) * showSunDisc * ( 1.0 - seaMask );'],
  [
    'gl_FragColor = vec4( texColor, 1.0 );',
    'texColor = mix( texColor, seaWater + seaFresnel * texColor, seaMask );\n\t\t\tgl_FragColor = vec4( texColor, 1.0 );',
  ],
];

function createSkyMaterial(): THREE.ShaderMaterial {
  const shader = Sky.SkyShader as SkyShaderDef;
  let fragmentShader = patchCloudShader(shader.fragmentShader);
  for (const [from, to] of SKY_PATCHES) {
    if (!fragmentShader.includes(from)) throw new Error(`sky: Sky.js shader changed, cannot find "${from}"`);
    fragmentShader = fragmentShader.replace(from, to);
  }
  return new THREE.ShaderMaterial({
    name: 'SailingSky',
    uniforms: THREE.UniformsUtils.merge([
      shader.uniforms,
      cloudUniforms(),
      { seaBelowHorizon: { value: 1 }, seaWater: { value: new THREE.Color() }, scatterExponent: { value: 1.5 } },
    ]),
    vertexShader: shader.vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------------------------------------
// SkySystem

/**
 * Sun illuminance per unit of the model's direct beam (`sunE` × transmittance luminance). Calibrated so the
 * direct sun at normal incidence is ≈ 6× the sky's horizontal irradiance at 24° elevation — the real-world
 * ratio that puts shadows about three stops below sunlit faces.
 */
const SUN_ILLUMINANCE_SCALE = 0.1;
/** Remote-sensing reflectance of open coastal water (sr⁻¹) and its hue: the light the sea sends back up. */
const WATER_REFLECTANCE = 0.0055;
const WATER_TINT = new THREE.Color().setRGB(0.18, 0.55, 0.62, THREE.LinearSRGBColorSpace);
/** Aerial perspective for built-in materials (FogExp2): ≈ 40 % haze at 5 km on a clear day. */
const FOG_DENSITY = 1.3e-4;
/** Incident-light exposure is only partly adapted: evening scenes stay a little darker than a meter says. */
const EXPOSURE_ADAPTATION = 0.8;
const EXPOSURE_REFERENCE_ILLUMINANCE = 30;
/** Reflected-light metering over the view: target log-average luminance and eye-like adaptation time. */
const METER_KEY = 0.16;
const METER_ADAPT_S = 0.7;
const METER_GRID = [-0.75, -0.25, 0.25, 0.75] as const;
const SUN_BEHIND_CLOUD_TIME_S = 0.6;
/** Rebaking the IBL costs a few ms: at most this often while the time of day is being animated. */
const MIN_BAKE_INTERVAL_S = 0.5;

const luminance = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export interface SkyOptions {
  hours?: number;
  cloudCover?: number;
}

/**
 * Owns the visible sky dome, the PMREM environment (`scene.environment`), scene fog and the renderer's
 * tone-mapping exposure (metered from the sky model). Publishes {@link SkyState} for other modules.
 */
export class SkySystem implements SkyState {
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly sunColor = new THREE.Color(1, 1, 1);
  sunIntensity = 0;
  /** Stable texture object: rebakes render into the same PMREM target. */
  envMap: THREE.Texture | null = null;
  readonly fogColor = new THREE.Color();
  readonly horizonColor = new THREE.Color();
  cloudCover: number;
  /** Local solar time (hours). */
  hours = 17;
  /** Cloud layer: cover, drift and shape parameters (edit `clouds.params`, then call `refresh()`). */
  readonly clouds: CloudLayer;
  /**
   * Blend of reflected-light metering over the camera view into the exposure (0 = incident reading only).
   * Looking into a low sun stops down like a camera would; looking away opens up slightly.
   */
  meteringWeight = 0.5;
  /** Current exposure, written to `renderer.toneMappingExposure` every update. */
  exposure = 1;
  /** Incident-light exposure for the current sun and cover (the view-independent part). */
  incidentExposure = 1;
  /** Clear-sky horizontal illuminance from the sky dome alone (model units). */
  skyIlluminance = 0;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly model = new PreethamModel();
  private readonly material: THREE.ShaderMaterial;
  private readonly dome: THREE.Mesh;
  private readonly fog: THREE.FogExp2;

  private readonly envScene = new THREE.Scene();
  private readonly envMaterial: THREE.ShaderMaterial;
  private readonly cubeTarget: THREE.WebGLCubeRenderTarget | null = null;
  private readonly cubeCamera: THREE.CubeCamera | null = null;
  private readonly pmrem: THREE.PMREMGenerator | null = null;
  private pmremTarget: THREE.WebGLRenderTarget | null = null;
  private envDirty = true;
  private sinceBake = Infinity;

  private clearSunIntensity = 0;
  private cloudSun = 1;
  private seaWaterLuminance = 0;
  private metered = false;
  private readonly ray = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly sample = new THREE.Color();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, q: QualitySettings, options: SkyOptions = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.cloudCover = THREE.MathUtils.clamp(options.cloudCover ?? 0.35, 0, 1);
    this.clouds = new CloudLayer(this.cloudCover);

    this.material = createSkyMaterial();
    this.dome = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.dome.name = 'sky';
    this.dome.scale.setScalar(1000);
    this.dome.frustumCulled = false;
    // Drawn after the other opaques so early-z skips the sky wherever the sea, land or boat cover it.
    this.dome.renderOrder = 10_000;
    scene.add(this.dome);

    this.envMaterial = this.material.clone();
    this.envMaterial.uniforms['showSunDisc']!.value = 0; // the sun is a light, not a texel of the IBL
    const envDome = new THREE.Mesh(this.dome.geometry, this.envMaterial);
    envDome.scale.setScalar(10);
    envDome.frustumCulled = false;
    this.envScene.add(envDome);

    // Rendering the IBL needs half-float render targets; without them materials go without IBL.
    if (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float')) {
      const size = q.tier === 'low' ? 128 : 256;
      this.cubeTarget = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, depthBuffer: false });
      this.cubeCamera = new THREE.CubeCamera(0.1, 100, this.cubeTarget);
      this.pmrem = new THREE.PMREMGenerator(renderer);
      this.pmrem.compileCubemapShader();
    }

    this.fog = new THREE.FogExp2(0xffffff, FOG_DENSITY);
    scene.fog = this.fog;

    this.setTimeOfDay(options.hours ?? this.hours);
    this.bakeEnvironment();
  }

  setTimeOfDay(hours: number): void {
    this.hours = ((hours % 24) + 24) % 24;
    const { elevation, azimuth } = sunPosition(this.hours);
    directionFromBearing(azimuth, elevation, this.sunDirection);
    this.refreshLighting();
  }

  setCloudCover(cover: number): void {
    this.cloudCover = THREE.MathUtils.clamp(cover, 0, 1);
    this.clouds.setCover(this.cloudCover);
    this.refreshLighting();
  }

  /** Re-derive lighting and rebake after editing `clouds.params` or `ATMOSPHERE` directly. */
  refresh(): void {
    this.refreshLighting();
  }

  /**
   * Per frame: keep the dome on the camera, drift the clouds with the wind aloft, dim the sun while a cloud
   * covers it, meter the exposure for this view, and rebake the environment if the sun or cover changed.
   * `windFromRad` = surface true wind direction FROM (compass rad), `windSpeed` in m/s.
   */
  update(dt: number, camera: THREE.Camera, windFromRad: number, windSpeed: number): void {
    camera.getWorldPosition(this.dome.position);
    this.clouds.update(dt, windFromRad, windSpeed);
    this.clouds.applyTo(this.material.uniforms);
    const target = this.clouds.sunTransmittance(this.sunDirection);
    this.cloudSun += (target - this.cloudSun) * (1 - Math.exp(-dt / SUN_BEHIND_CLOUD_TIME_S));
    this.sunIntensity = this.clearSunIntensity * this.cloudSun;

    const goal = this.meteredExposure(camera);
    this.exposure = this.metered ? this.exposure * Math.pow(goal / this.exposure, 1 - Math.exp(-dt / METER_ADAPT_S)) : goal;
    this.metered = true;
    this.renderer.toneMappingExposure = this.exposure;

    this.sinceBake += dt;
    if (this.envDirty && this.sinceBake >= MIN_BAKE_INTERVAL_S) this.bakeEnvironment();
  }

  /** Remove the dome and free GPU resources. */
  dispose(): void {
    this.scene.remove(this.dome);
    if (this.scene.fog === this.fog) this.scene.fog = null;
    if (this.scene.environment === this.envMap) this.scene.environment = null;
    this.dome.geometry.dispose();
    this.material.dispose();
    this.envMaterial.dispose();
    this.cubeTarget?.dispose();
    this.pmremTarget?.dispose();
    this.pmrem?.dispose();
  }

  /** Recompute everything derived from the sun position, atmosphere and cloud cover. */
  private refreshLighting(): void {
    const model = this.model.set(ATMOSPHERE, this.sunDirection);
    const elevation = Math.asin(THREE.MathUtils.clamp(this.sunDirection.y, -1, 1));

    // Direct sun: the model's beam through the atmosphere, colour normalised to a max channel of 1.
    const t = model.extinction(this.sunDirection.y, [0, 0, 0]);
    const beam = model.sunE * luminance(t[0]!, t[1]!, t[2]!);
    const peak = Math.max(t[0]!, t[1]!, t[2]!, 1e-6);
    this.sunColor.setRGB(t[0]! / peak, t[1]! / peak, t[2]! / peak, THREE.LinearSRGBColorSpace);
    const colorLum = Math.max(1e-6, luminance(this.sunColor.r, this.sunColor.g, this.sunColor.b));
    this.clearSunIntensity = (SUN_ILLUMINANCE_SCALE * beam) / colorLum;
    this.cloudSun = this.clouds.sunTransmittance(this.sunDirection);
    this.sunIntensity = this.clearSunIntensity * this.cloudSun;

    // Sky irradiance on a horizontal surface and the horizon ring; under cloud the haze turns grey.
    this.skyIlluminance = this.integrateSky();
    this.sampleHorizon(0.009, this.horizonColor);
    const grey = luminance(this.horizonColor.r, this.horizonColor.g, this.horizonColor.b) * 0.9;
    this.fogColor.copy(this.horizonColor).lerp(new THREE.Color(grey, grey, grey), this.cloudCover * this.cloudCover);
    this.fog.color.copy(this.fogColor);
    this.fog.density = FOG_DENSITY * (1 + 0.8 * this.cloudCover);

    // Light reaching the water, and what the water sends back up (seen below the horizon in the IBL).
    const overcast = 1 - 0.85 * this.cloudCover * this.cloudCover;
    const sunOnWater = this.clearSunIntensity * colorLum * Math.max(0, Math.sin(elevation)) * overcast;
    const down = sunOnWater + this.skyIlluminance;
    const tintLum = luminance(WATER_TINT.r, WATER_TINT.g, WATER_TINT.b);
    const water = WATER_TINT.clone().multiplyScalar((WATER_REFLECTANCE * down) / tintLum);
    this.seaWaterLuminance = WATER_REFLECTANCE * down;

    // Incident-light reading (grey card → middle grey), partially adapted; `update` adds view metering.
    this.incidentExposure = Math.PI * Math.pow(Math.max(1e-3, down), -EXPOSURE_ADAPTATION) * Math.pow(EXPOSURE_REFERENCE_ILLUMINANCE, EXPOSURE_ADAPTATION - 1);
    if (!this.metered) {
      this.exposure = this.incidentExposure;
      this.renderer.toneMappingExposure = this.exposure;
    }

    for (const material of [this.material, this.envMaterial]) {
      const u = material.uniforms;
      u['turbidity']!.value = ATMOSPHERE.turbidity;
      u['rayleigh']!.value = ATMOSPHERE.rayleigh;
      u['mieCoefficient']!.value = ATMOSPHERE.mieCoefficient;
      u['mieDirectionalG']!.value = ATMOSPHERE.mieDirectionalG;
      u['scatterExponent']!.value = ATMOSPHERE.scatterExponent;
      (u['sunPosition']!.value as THREE.Vector3).copy(this.sunDirection);
      (u['seaWater']!.value as THREE.Color).copy(water);
      (u['cloudSunTransmittance']!.value as THREE.Color).setRGB(t[0]!, t[1]!, t[2]!, THREE.LinearSRGBColorSpace);
    }
    this.clouds.applyTo(this.material.uniforms);
    this.envDirty = true;
  }

  /**
   * Exposure for this view: the log-average luminance of 16 rays across the frustum (sky from the model,
   * sea as in the dome's below-horizon shading), blended with the incident reading by `meteringWeight`.
   */
  private meteredExposure(camera: THREE.Camera): number {
    if (this.meteringWeight <= 0) return this.incidentExposure;
    camera.updateMatrixWorld();
    const origin = camera.getWorldPosition(this.origin);
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    let logSum = 0;
    for (const x of METER_GRID) {
      for (const y of METER_GRID) {
        const d = this.ray.set(x, y, 0.5).unproject(camera);
        d.set(d.x - ox, d.y - oy, d.z - oz).normalize();
        let lum: number;
        if (d.y > 0) {
          this.model.radiance(d, this.sample);
          lum = luminance(this.sample.r, this.sample.g, this.sample.b);
        } else {
          const mu = -d.y;
          const fresnel = 0.02 + 0.98 * Math.pow(1 - Math.max(mu, 0.18), 5);
          d.y = mu + 0.12 * (1 - mu) * (1 - mu);
          this.model.radiance(d.normalize(), this.sample);
          lum = this.seaWaterLuminance + fresnel * luminance(this.sample.r, this.sample.g, this.sample.b);
        }
        logSum += Math.log(Math.max(lum, 1e-4));
      }
    }
    const reflected = METER_KEY / Math.exp(logSum / (METER_GRID.length * METER_GRID.length));
    const blended = this.incidentExposure * Math.pow(reflected / this.incidentExposure, this.meteringWeight);
    return THREE.MathUtils.clamp(blended, this.incidentExposure / 4, this.incidentExposure * 1.6);
  }

  private bakeEnvironment(): void {
    this.envDirty = false;
    this.sinceBake = 0;
    if (!this.cubeCamera || !this.cubeTarget || !this.pmrem) return;
    this.clouds.applyTo(this.envMaterial.uniforms);
    this.cubeCamera.update(this.renderer, this.envScene);
    this.pmremTarget = this.pmrem.fromCubemap(this.cubeTarget.texture, this.pmremTarget);
    this.pmremTarget.texture.name = 'sky-environment';
    this.envMap = this.pmremTarget.texture;
    this.scene.environment = this.envMap;
  }

  /** Cosine-weighted integral of the clear sky over the upper hemisphere (horizontal irradiance, luminance). */
  private integrateSky(): number {
    const dir = new THREE.Vector3();
    const c = new THREE.Color();
    const rings = 12;
    const sectors = 24;
    let sum = 0;
    for (let i = 0; i < rings; i++) {
      const el0 = (i / rings) * (Math.PI / 2);
      const el1 = ((i + 1) / rings) * (Math.PI / 2);
      const el = (el0 + el1) / 2;
      const weight = Math.sin(el) * (Math.sin(el1) - Math.sin(el0)) * ((2 * Math.PI) / sectors);
      for (let j = 0; j < sectors; j++) {
        this.model.radiance(directionFromBearing(((j + 0.5) / sectors) * 2 * Math.PI, el, dir), c);
        sum += luminance(c.r, c.g, c.b) * weight;
      }
    }
    return sum;
  }

  /** Mean sky radiance around the horizon ring at `elevation` (rad). */
  private sampleHorizon(elevation: number, out: THREE.Color): THREE.Color {
    const dir = new THREE.Vector3();
    const c = new THREE.Color();
    const sectors = 24;
    out.setRGB(0, 0, 0);
    for (let j = 0; j < sectors; j++) {
      this.model.radiance(directionFromBearing(((j + 0.5) / sectors) * 2 * Math.PI, elevation, dir), c);
      out.r += c.r / sectors;
      out.g += c.g / sectors;
      out.b += c.b / sectors;
    }
    return out;
  }
}
