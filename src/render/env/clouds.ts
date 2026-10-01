// Cloud layer: the 2-D cloud field built into three r186 `Sky.js` (MIT), made to drift with the upper wind
// instead of along the fixed diagonal of its `time * cloudSpeed` term, plus a CPU mirror of the same noise
// so the sun light dims when the sun disc is behind a cloud.
import * as THREE from 'three';
import { DEFAULT_CLOUD_COVER } from './cloudField';

export interface CloudParams {
  /** Sky.js `cloudCoverage`: fraction of sky above the carve threshold. */
  coverage: number;
  /** Sky.js `cloudDensity`: opacity build-up with depth. */
  density: number;
  /** Sky.js `cloudElevation`: 0 = high flat layer, 1 = low layer. */
  elevation: number;
  /** Sky.js `cloudScale`: projected-plane → noise scale (smaller = larger clouds). */
  scale: number;
  /** Width of the noise band over which a cloud edge fades in (Sky.js uses 0.3; smaller = crisper). */
  edge: number;
}

/** Map a 0…1 cloud cover to layer parameters (fair-weather cumulus → broken → overcast). */
export function cloudParamsForCover(cover: number): CloudParams {
  const c = THREE.MathUtils.clamp(cover, 0, 1);
  return {
    coverage: c <= 0.001 ? 0 : 0.12 + 0.88 * c,
    density: 0.45 + 0.5 * c,
    elevation: 0.55,
    scale: 0.00022,
    edge: 0.28,
  };
}

/** Cloud base height used to turn wind speed (m/s) into drift of the projected cloud plane. */
const CLOUD_BASE_M = 1500;
/** The wind aloft veers and strengthens relative to the surface wind (northern hemisphere). */
const UPPER_WIND_VEER = THREE.MathUtils.degToRad(20);
const UPPER_WIND_FACTOR = 1.8;
const MIN_DRIFT_MS = 3;
/** Billowing rate of the fbm octaves (noise units per second). */
const EVOLVE_PER_S = 0.004;
/** Direct sunlight a fully opaque cloud still lets through. */
const OPAQUE_CLOUD_SUN = 0.06;

const SHADER_PATCHES: Array<[string, string]> = [
  ['uniform float time;', 'uniform float time;\n\t\tuniform vec2 cloudOffset;\n\t\tuniform float cloudEvolve;\n\t\tuniform float cloudSunBoost;\n\t\tuniform vec3 cloudSunTransmittance;\n\t\tuniform float cloudEdge;\n\t\tuniform float cloudLightStep;\n\t\tuniform float cloudShadow;'],
  ['cloudUV += time * cloudSpeed;', 'cloudUV -= cloudOffset;'],
  ['float evolve = time * cloudSpeed * 300.0;', 'float evolve = cloudEvolve;'],
  // Sunlight reaching the cloud went through the atmosphere along the *sun's* path; Sky.js used the view
  // ray's extinction, which the aerial composite applies again (clouds turned pink at noon).
  ['vec3 sunColor = vSunE * Fex * 0.22 * 0.04;', 'vec3 sunColor = vSunE * cloudSunTransmittance * 0.22 * 0.04 * cloudSunBoost;'],
  ['smoothstep( threshold, threshold + 0.3, cloudNoise );', 'smoothstep( threshold, threshold + cloudEdge, cloudNoise );'],
  // 2.5-D light: cloud between this point and the sun (sampled one step sunward in the cloud plane)
  // shades it, so each cloud gets a bright sun-facing edge and a grey core instead of one flat tone.
  [
    'vec3 cloudColor = skyAmbient + sunColor * shade;',
    `float cloudLight = 1.0;
				float sunPlaneLen = length( vSunDirection.xz );
				if ( sunPlaneLen > 1e-3 ) {
					vec2 towardSun = cloudUV + vSunDirection.xz / sunPlaneLen * cloudLightStep;
					float sunward = clamp( fbm( towardSun * 1000.0, evolve ) * 0.7 + 0.5, 0.0, 1.0 );
					cloudLight = exp( - max( 0.0, sunward - threshold ) * cloudShadow );
				}
				// Cloud bases are lit by light scattered through the cloud and from all around: grey, not the
				// blue of the sky behind them (Sky.js used the local sky radiance, so overcast looked blue).
				// Light that has crossed thick cloud is neutral: the sun's hue survives only on thin, sunlit parts.
				float ambientLum = dot( skyAmbient, vec3( 0.2126, 0.7152, 0.0722 ) );
				float sunLum = dot( sunColor, vec3( 0.2126, 0.7152, 0.0722 ) );
				vec3 sunLight = mix( vec3( sunLum ), sunColor, cloudLight );
				vec3 cloudAmbient = mix( vec3( ambientLum ), skyAmbient, 0.1 ) + vec3( sunLum ) * 0.16;
				vec3 cloudColor = cloudAmbient * ( 0.7 + 0.3 * cloudLight ) + sunLight * shade * cloudLight;`,
  ],
  // Sky.js blends each cloud toward the sky with the extinction of the whole atmosphere column, as if the
  // cloud sat at its top; a cloud 1–3 km away sees far less, and the per-channel blend tinted grey decks
  // lilac. Raising Fex to a power < 1 keeps distant clouds dissolving into the haze near the horizon.
  ['vec3 cloudAerial = mix( texColor, cloudColor, Fex );', 'vec3 cloudAerial = mix( texColor, cloudColor, pow( Fex, vec3( 0.35 ) ) );'],
  // Two more octaves: crinkly, fluffy edges instead of smooth blobs.
  ['for ( int i = 0; i < 4; i ++ ) {', 'for ( int i = 0; i < CLOUD_OCTAVES; i ++ ) {'],
  ['uniform float mieDirectionalG;', '#define CLOUD_OCTAVES 6\n\t\tuniform float mieDirectionalG;'],
];

/** Apply the cloud patches to the Sky.js fragment shader source (throws if three changed the shader). */
export function patchCloudShader(fragmentShader: string): string {
  let out = fragmentShader;
  for (const [from, to] of SHADER_PATCHES) {
    if (!out.includes(from)) throw new Error(`clouds: Sky.js shader changed, cannot find "${from}"`);
    out = out.replace(from, to);
  }
  return out;
}

export function cloudUniforms(): Record<string, THREE.IUniform> {
  return {
    cloudOffset: { value: new THREE.Vector2() },
    cloudEvolve: { value: 0 },
    cloudEdge: { value: 0.3 },
    cloudLightStep: { value: 0.00025 },
    cloudShadow: { value: 4 },
    // Sunlit cloud tops as bright as a white surface under our calibrated sun (Sky.js lights them dimmer).
    cloudSunBoost: { value: 2.2 },
    /** Atmospheric transmittance toward the sun (set by the sky system from its Preetham model). */
    cloudSunTransmittance: { value: new THREE.Color(1, 1, 1) },
  };
}

// --- CPU mirror of the Sky.js cloud noise (same hash, gradient noise and fbm) -----------------------------

const fract = (x: number): number => x - Math.floor(x);

function gradientDot(ix: number, iy: number, fx: number, fy: number): number {
  let px = fract(ix * 0.1031);
  let py = fract(iy * 0.103);
  let pz = fract(ix * 0.0973);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d;
  py += d;
  pz += d;
  const gx = fract((px + py) * pz) * 2 - 1;
  const gy = fract((px + pz) * py) * 2 - 1;
  return gx * fx + gy * fy;
}

export function gradientNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = gradientDot(ix, iy, fx, fy);
  const b = gradientDot(ix + 1, iy, fx - 1, fy);
  const c = gradientDot(ix, iy + 1, fx, fy - 1);
  const d = gradientDot(ix + 1, iy + 1, fx - 1, fy - 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return (ab + (cd - ab) * uy) * 1.6;
}

const CLOUD_OCTAVES = 6;

function fbm(x: number, y: number, drift: number): number {
  let result = 0;
  let amplitude = 1;
  for (let i = 0; i < CLOUD_OCTAVES; i++) {
    result += amplitude * gradientNoise(x, y);
    amplitude *= 0.5;
    x = x * 2 + drift;
    y = y * 2 + drift;
  }
  return result;
}

export class CloudLayer {
  cover: number;
  params: CloudParams;
  /** Accumulated drift of the projected cloud plane (noise-plane units, world X/Z axes). */
  readonly offset = new THREE.Vector2();
  evolve = 0;

  constructor(cover = DEFAULT_CLOUD_COVER) {
    this.cover = cover;
    this.params = cloudParamsForCover(cover);
  }

  setCover(cover: number): void {
    this.cover = THREE.MathUtils.clamp(cover, 0, 1);
    this.params = cloudParamsForCover(this.cover);
  }

  /** Advance the drift: `windFrom` = surface wind FROM (rad, compass), `windSpeed` in m/s. */
  update(dt: number, windFrom: number, windSpeed: number): void {
    const from = windFrom + UPPER_WIND_VEER;
    const speed = Math.max(MIN_DRIFT_MS, windSpeed * UPPER_WIND_FACTOR);
    // Downwind (bearing from + π) in the three.js world: east = +X, north = −Z.
    const k = (speed * dt * this.params.scale) / (CLOUD_BASE_M * this.planeElevation());
    this.offset.x += -Math.sin(from) * k;
    this.offset.y += Math.cos(from) * k;
    this.evolve += EVOLVE_PER_S * dt;
  }

  applyTo(uniforms: Record<string, THREE.IUniform>): void {
    const p = this.params;
    uniforms['cloudCoverage']!.value = p.coverage;
    uniforms['cloudDensity']!.value = p.density;
    uniforms['cloudElevation']!.value = p.elevation;
    uniforms['cloudScale']!.value = p.scale;
    uniforms['cloudEdge']!.value = p.edge;
    (uniforms['cloudOffset']!.value as THREE.Vector2).copy(this.offset);
    uniforms['cloudEvolve']!.value = this.evolve;
  }

  /** Cloud opacity toward a direction — the same formula as the shader's `alpha`. */
  opacity(dir: THREE.Vector3): number {
    const p = this.params;
    if (dir.y <= 0 || p.coverage <= 0) return 0;
    const k = p.scale / (dir.y * this.planeElevation());
    const u = dir.x * k - this.offset.x;
    const v = dir.z * k - this.offset.y;
    const cloudNoise = THREE.MathUtils.clamp(fbm(u * 1000, v * 1000, this.evolve) * 0.7 + 0.5, 0, 1);
    const region = gradientNoise(u * 300, v * 300) * 0.37 + 0.5;
    const cov = THREE.MathUtils.clamp(p.coverage + (region - 0.5) * 0.6, 0, 1);
    const depth = Math.max(0, cloudNoise - (1 - cov));
    const horizonFade = THREE.MathUtils.smoothstep(dir.y, 0, 0.03 + 0.06 * p.elevation);
    return (1 - Math.exp(-12 * depth * p.density)) * horizonFade;
  }

  /** Fraction of direct sunlight that passes the cloud layer toward the sun. */
  sunTransmittance(sunDirection: THREE.Vector3): number {
    return 1 - (1 - OPAQUE_CLOUD_SUN) * this.opacity(sunDirection);
  }

  private planeElevation(): number {
    return THREE.MathUtils.lerp(1, 0.1, this.params.elevation);
  }
}
