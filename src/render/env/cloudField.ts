// The cloud density field, on the CPU: parameters, the cover mapping, the panorama projection and a mirror of
// the shader's density function (`cloudShaders.ts`). The GPU ray-marches this field into the sky panorama; the
// CPU marches the same field toward the sun so the sun light dims when a visible cloud covers it (fully for cloud
// within a few kilometres along the sun's path, only partly for the distant cloud in front of a low sun).
//
// Keep `density()` in step with `CLOUD_DENSITY_GLSL`: same textures, same arithmetic, same order.
import type { CloudNoise, NoiseMap, NoiseVolume } from './cloudNoise';

// ---------------------------------------------------------------------------------------------------------
// Parameters

export interface CloudFieldParams {
  /** Altitude of the flat cloud bases (m). */
  base: number;
  /** Top of the cloud slab (m): the tallest tower stops here. */
  top: number;
  /** World size of one tile of each texture (m). */
  weatherTile: number;
  shapeTile: number;
  detailTile: number;
  /** A column holds cloud where the weather map's coverage signal exceeds this (1 − threshold = area fraction). */
  threshold: number;
  /** Width, in coverage units, of the ramp from a cloud's outline to its solid core. */
  edge: number;
  /** Width, in coverage units, over which a cloud grows from its outline to its full height. */
  rise: number;
  /** Height of the tallest clouds, as a fraction of the slab. */
  heightScale: number;
  /** Height of the lowest clouds relative to the tallest (the weather map's height channel blends between). */
  heightMin: number;
  /** How deeply the shape noise carves billows into a cloud (0…1). */
  erosion: number;
  /** How deeply the detail noise frays the edges (0…1). */
  detailErosion: number;
  /** Extinction of solid cloud (1/m). */
  sigma: number;
}

export const CLOUD_BASE_M = 950;
/**
 * The sky's cloud cover unless a setting says otherwise: scattered fair-weather cumulus that leave the boat in the
 * sun about two thirds of the time at 17:00 (see `sunTransmittance`).
 */
export const DEFAULT_CLOUD_COVER = 0.25;
export const CLOUD_TOP_M = 2450;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Fraction of the sea under cloud for a 0…1 cover. The weather map is histogram-equalised, so this is exact for
 * the cloud outlines; the billows then eat a little of each cloud, which the small lift below gives back.
 */
export function cloudAreaFraction(cover: number): number {
  const c = clamp01(cover);
  if (c <= 0.001) return 0;
  // Measured on the field (fraction of the sky with cloud overhead): the billows eat ≈ 0.145 of the outlines'
  // area, so the outlines are that much larger. Toward a full overcast the outlines overlap everywhere (> 1),
  // which closes the last gaps in the deck.
  return c + 0.145 * smoothstep(0, 0.08, c) + 0.2 * smoothstep(0.9, 1, c);
}

/**
 * Map a 0…1 cloud cover to the field: scattered fair-weather cumulus that tower (≈ 0.2–0.5), then broken and
 * finally an overcast stratocumulus deck that is lower and flatter (≥ 0.8).
 */
export function cloudFieldForCover(cover: number): CloudFieldParams {
  const c = clamp01(cover);
  const deck = smoothstep(0.5, 0.9, c);
  return {
    base: CLOUD_BASE_M,
    top: CLOUD_TOP_M,
    weatherTile: 48_000,
    // Billows of 300 / 150 / 75 m from the shape noise, 100 / 50 / 25 m from the detail noise.
    shapeTile: 1200,
    detailTile: 200,
    // Above 1 nothing passes: a clear sky.
    threshold: c <= 0.001 ? 2 : 1 - cloudAreaFraction(c),
    edge: mix(0.28, 0.3, deck),
    rise: mix(0.4, 0.5, deck),
    heightScale: mix(0.92, 0.5, deck),
    heightMin: mix(0.35, 0.6, deck),
    erosion: mix(0.92, 0.62, deck),
    detailErosion: mix(0.5, 0.4, deck),
    sigma: mix(0.05, 0.03, deck),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Panorama projection: the upper hemisphere on a disc. An equal-area azimuthal projection, warped so that the
// horizon — where most of the visible clouds are, small and far away — gets twice the radial resolution.

/** Warp strength: the radial scale at the horizon is (1 + B) / B times the equal-area one. */
export const PANO_WARP = 1;

/** Fraction of the half-size used by the disc for a panorama `size` texels wide (a two-texel margin). */
export const panoDisc = (size: number): number => 1 - 4 / size;

/** Unit direction (y up) → panorama uv. Directions below the horizon map to the rim. */
export function panoUv(dx: number, dy: number, dz: number, disc: number, out: { u: number; v: number }): { u: number; v: number } {
  const y = clamp01(dy);
  const x = 1 - Math.sqrt(1 - y);
  const r = 1 - (x * (1 + PANO_WARP)) / (x + PANO_WARP);
  const h = 1 / Math.sqrt(Math.max(dx * dx + dz * dz, 1e-12));
  out.u = 0.5 + 0.5 * disc * r * dx * h;
  out.v = 0.5 + 0.5 * disc * r * dz * h;
  return out;
}

/** Panorama uv → unit direction (y up). Outside the disc: the horizon in that azimuth. */
export function panoDirection(u: number, v: number, disc: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const qx = ((u - 0.5) * 2) / disc;
  const qz = ((v - 0.5) * 2) / disc;
  const r = Math.sqrt(qx * qx + qz * qz);
  const g = 1 - Math.min(r, 1);
  const x = (PANO_WARP * g) / (1 + PANO_WARP - g);
  const s = 1 - x;
  const y = 1 - s * s;
  const hl = Math.sqrt(Math.max(1 - y * y, 0));
  const inv = r > 1e-6 ? 1 / r : 0;
  out.x = r > 1e-6 ? qx * inv * hl : hl;
  out.y = y;
  out.z = qz * inv * hl;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Ray geometry shared with the shader

export const EARTH_RADIUS_M = 6_371_000;
/** Clouds farther than this are lost in the haze: the march stops here and the field fades out before it. */
export const CLOUD_MAX_DISTANCE_M = 45_000;
/** Nominal angular size of a panorama texel (rad): sets the noise level of detail with distance. */
export const PANO_TEXEL_RAD = 0.0026;
/** Mean of the detail noise: what the erosion uses where the detail is too small to resolve. */
export const DETAIL_MEAN = 0.48;

/**
 * Distance along a ray (elevation sine `dy` ≥ 0) from an observer `camHeight` above the sea to the spherical
 * shell at altitude `alt` (the stable form: no cancellation between two Earth-radius-sized terms).
 */
export function shellDistance(dy: number, camHeight: number, alt: number): number {
  const r = EARTH_RADIUS_M + camHeight;
  const rise = alt - camHeight;
  if (rise <= 0) return 0;
  const b = r * dy;
  return (rise * (2 * r + rise)) / (b + Math.sqrt(b * b + rise * (2 * r + rise)));
}

/** Altitude above the sea of the point `t` metres along the ray (second order in t / Earth radius). */
export function rayAltitude(t: number, dy: number, camHeight: number): number {
  return camHeight + t * dy + (t * t) / (2 * EARTH_RADIUS_M);
}

// ---------------------------------------------------------------------------------------------------------
// CPU texture sampling (the GPU's wrap + linear filtering, with box-filtered mip levels)

interface MipVolume {
  sizes: number[];
  levels: Float32Array[];
}

function mipVolume(v: NoiseVolume): MipVolume {
  const sizes = [v.size];
  const first = new Float32Array(v.data.length);
  for (let i = 0; i < first.length; i++) first[i] = v.data[i]! / 255;
  const levels = [first];
  for (let s = v.size; s > 1; s >>= 1) {
    const src = levels[levels.length - 1]!;
    const h = s >> 1;
    const dst = new Float32Array(h * h * h);
    for (let z = 0, o = 0; z < h; z++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < h; x++, o++) {
          const a = (2 * z * s + 2 * y) * s + 2 * x;
          const b = a + s * s;
          dst[o] = (src[a]! + src[a + 1]! + src[a + s]! + src[a + s + 1]! + src[b]! + src[b + 1]! + src[b + s]! + src[b + s + 1]!) / 8;
        }
      }
    }
    sizes.push(h);
    levels.push(dst);
  }
  return { sizes, levels };
}

const wrap = (i: number, n: number): number => ((i % n) + n) % n;

function sampleLevel(data: Float32Array, n: number, u: number, v: number, w: number): number {
  const x = u * n - 0.5;
  const y = v * n - 0.5;
  const z = w * n - 0.5;
  const xf = Math.floor(x);
  const yf = Math.floor(y);
  const zf = Math.floor(z);
  const fx = x - xf;
  const fy = y - yf;
  const fz = z - zf;
  const x0 = wrap(xf, n);
  const x1 = (x0 + 1) % n;
  const y0 = wrap(yf, n) * n;
  const y1 = ((wrap(yf, n) + 1) % n) * n;
  const z0 = wrap(zf, n) * n * n;
  const z1 = ((wrap(zf, n) + 1) % n) * n * n;
  const c00 = data[z0 + y0 + x0]! + (data[z0 + y0 + x1]! - data[z0 + y0 + x0]!) * fx;
  const c10 = data[z0 + y1 + x0]! + (data[z0 + y1 + x1]! - data[z0 + y1 + x0]!) * fx;
  const c01 = data[z1 + y0 + x0]! + (data[z1 + y0 + x1]! - data[z1 + y0 + x0]!) * fx;
  const c11 = data[z1 + y1 + x0]! + (data[z1 + y1 + x1]! - data[z1 + y1 + x0]!) * fx;
  const c0 = c00 + (c10 - c00) * fy;
  const c1 = c01 + (c11 - c01) * fy;
  return c0 + (c1 - c0) * fz;
}

/** `textureLod` on a mip-mapped, repeating 3-D texture (trilinear within a level, linear between levels). */
function sampleVolume(m: MipVolume, u: number, v: number, w: number, lod: number): number {
  const top = m.levels.length - 1;
  const l = lod <= 0 ? 0 : lod >= top ? top : lod;
  const l0 = Math.floor(l);
  const a = sampleLevel(m.levels[l0]!, m.sizes[l0]!, u, v, w);
  const f = l - l0;
  if (f <= 0) return a;
  return a + (sampleLevel(m.levels[l0 + 1]!, m.sizes[l0 + 1]!, u, v, w) - a) * f;
}

// ---------------------------------------------------------------------------------------------------------
// The field

/** Where the field has drifted to, in world metres (kept in doubles; the shader gets wrapped texture offsets). */
export interface CloudDrift {
  /** Horizontal drift of the whole field with the wind aloft. */
  x: number;
  z: number;
  /** Extra motion of the billows relative to the field (x, up, z): what makes clouds evolve. */
  shape: [number, number, number];
  detail: [number, number, number];
}

export const newCloudDrift = (): CloudDrift => ({ x: 0, z: 0, shape: [0, 0, 0], detail: [0, 0, 0] });

/** Steps of the CPU march toward the sun (the GPU's primary march uses its tier's count). */
const SUN_MARCH_STEPS = 96;
/** Direct sunlight that a fully opaque cloud still lets through (diffuse light under the cloud is in the IBL). */
export const OPAQUE_CLOUD_SUN = 0.06;
/**
 * Share of the optical depth that takes light out of the beam for lighting purposes: cloud droplets scatter
 * mostly forward, so thin cloud dims the sun's light less than it dims the sharp image of the disc.
 */
const BEAM_EXTINCTION = 0.15;
/**
 * Cloud further than this along the sun's path (m) dims the sunlight at most to FAR_CLOUD_SUN. A low sun crosses
 * tens of kilometres of the slab, so without this a sky with a third of it clouded would leave the boat in shade at
 * every low sun; a distant cloud in front of the sun is seen to dim it, not to put out the light.
 */
export const SUN_REACH_M = 6000;
export const FAR_CLOUD_SUN = 0.7;

export class CloudField {
  params: CloudFieldParams;
  readonly drift: CloudDrift = newCloudDrift();
  /** Lit sub-steps of the GPU march along a ray (coarse × sub; the high tier's by default): sets the noise detail. */
  drawnSteps = 160;
  private readonly weather: NoiseMap;
  private readonly shape: MipVolume;
  private readonly detail: MipVolume;
  private readonly shapeTexels: number;
  private readonly detailTexels: number;
  /** Scratch for the weather lookup: r, g, b. */
  private readonly w = [0, 0, 0];

  constructor(noise: CloudNoise, cover = DEFAULT_CLOUD_COVER) {
    this.weather = noise.weather;
    this.shape = mipVolume(noise.shape);
    this.detail = mipVolume(noise.detail);
    this.shapeTexels = noise.shape.size;
    this.detailTexels = noise.detail.size;
    this.params = cloudFieldForCover(cover);
  }

  setCover(cover: number): void {
    this.params = cloudFieldForCover(cover);
  }

  /** Bilinear, repeating lookup of the weather map at world (x, z); result in `this.w`. */
  private sampleWeather(x: number, z: number): void {
    const n = this.weather.size;
    const d = this.weather.data;
    const px = ((x - this.drift.x) / this.params.weatherTile) * n - 0.5;
    const pz = ((z - this.drift.z) / this.params.weatherTile) * n - 0.5;
    const xf = Math.floor(px);
    const zf = Math.floor(pz);
    const fx = px - xf;
    const fz = pz - zf;
    const x0 = wrap(xf, n);
    const x1 = (x0 + 1) % n;
    const z0 = wrap(zf, n) * n;
    const z1 = ((wrap(zf, n) + 1) % n) * n;
    for (let c = 0; c < 3; c++) {
      const a = d[(z0 + x0) * 4 + c]! + (d[(z0 + x1) * 4 + c]! - d[(z0 + x0) * 4 + c]!) * fx;
      const b = d[(z1 + x0) * 4 + c]! + (d[(z1 + x1) * 4 + c]! - d[(z1 + x0) * 4 + c]!) * fx;
      this.w[c] = (a + (b - a) * fz) / 255;
    }
  }

  /**
   * Cloud density, 0…1, at a world point (`alt` = metres above the sea). `lodShape` is the mip level of the
   * shape noise; `lodDetail` that of the detail noise, or negative to use its mean (too far to resolve).
   * Mirrors `cloudDensity` in the shader.
   */
  density(x: number, alt: number, z: number, lodShape = 0, lodDetail = 0): number {
    const p = this.params;
    const hf = (alt - p.base) / (p.top - p.base);
    if (hf <= 0 || hf >= 1) return 0;
    this.sampleWeather(x, z);
    const over = this.w[0]! - p.threshold;
    if (over <= 0) return 0;
    const m = Math.min(over / p.edge, 1);
    const grow = Math.min(over / p.rise, 1);
    const topF = p.heightScale * mix(p.heightMin, 1, this.w[1]!) * (TOP_AT_OUTLINE + (1 - TOP_AT_OUTLINE) * Math.sqrt(grow));
    const hrel = hf / topF;
    if (hrel >= 1) return 0;
    const envelope = m * Math.min(hf * BASE_RAMP, 1) * Math.min((1 - hrel) * TOP_RAMP, 1);
    const dr = this.drift;
    const shape = sampleVolume(
      this.shape,
      (x - dr.x - dr.shape[0]) / p.shapeTile,
      (alt - dr.shape[1]) / p.shapeTile,
      (z - dr.z - dr.shape[2]) / p.shapeTile,
      lodShape,
    );
    const carve = (1 - clamp01((shape - SHAPE_LOW) * SHAPE_GAIN)) * p.erosion * mix(CARVE_AT_BASE, 1, hrel);
    let d = (envelope - carve) / (1 - carve);
    if (d <= 0) return 0;
    const detail = lodDetail < 0 ? DETAIL_MEAN : sampleVolume(
      this.detail,
      (x - dr.x - dr.detail[0]) / p.detailTile,
      (alt - dr.detail[1]) / p.detailTile,
      (z - dr.z - dr.detail[2]) / p.detailTile,
      lodDetail,
    );
    const fray = (1 - detail) * p.detailErosion;
    d = (d - fray) / (1 - fray);
    if (d <= 0) return 0;
    return Math.min(d * DENSITY_GAIN, 1) * mix(DENSITY_AT_BASE, 1, hrel);
  }

  /**
   * Optical depth along a ray from an observer at world (ox, oy, oz) through the slab, stepping as the shader's
   * primary march does (uniform steps between the shell crossings, level of detail from the step and distance).
   */
  opticalDepth(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, steps: number = SUN_MARCH_STEPS, from = 0, to = Infinity,
  ): number {
    const p = this.params;
    if (dy <= 1e-4 || p.threshold >= 1) return 0;
    const cam = Math.min(Math.max(oy, 0), p.base - 1);
    const s0 = shellDistance(dy, cam, p.base);
    if (s0 >= CLOUD_MAX_DISTANCE_M) return 0;
    const s1 = Math.min(shellDistance(dy, cam, p.top), CLOUD_MAX_DISTANCE_M);
    // `from` … `to`: only this stretch of the ray (metres from the observer).
    const t0 = Math.max(s0, from), t1 = Math.min(s1, to);
    if (t1 <= t0) return 0;
    const step = (t1 - t0) / steps;
    // The noise level of detail is the picture's (the GPU's sub-step along this ray through the whole slab), not
    // this march's: every caller sees the same field whatever its step count or stretch.
    const drawnStep = (s1 - s0) / this.drawnSteps;
    const shapeTexel = p.shapeTile / this.shapeTexels;
    const detailTexel = p.detailTile / this.detailTexels;
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      const t = t0 + (i + 0.5) * step;
      const footprint = Math.max(FOOTPRINT_STEPS * drawnStep, FOOTPRINT_TEXELS * t * PANO_TEXEL_RAD);
      const lodShape = Math.max(0, Math.log2(footprint / shapeTexel));
      const lodDetail = Math.log2(footprint / detailTexel);
      const d = this.density(ox + dx * t, rayAltitude(t, dy, cam), oz + dz * t, lodShape, lodDetail > DETAIL_LOD_CUTOFF ? -1 : Math.max(0, lodDetail));
      if (d > 0) sum += d * (1 - smoothstep(FADE_START * CLOUD_MAX_DISTANCE_M, CLOUD_MAX_DISTANCE_M, t));
    }
    return sum * step * p.sigma;
  }

  /** What an observer at world (ox, oy, oz) sees of the sun's disc through the clouds, 0…1. */
  viewTransmittance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    return Math.exp(-this.opticalDepth(ox, oy, oz, dx, dy, dz));
  }

  /**
   * Fraction of the direct sunlight that reaches an observer at world (ox, oy, oz): cloud within SUN_REACH_M along
   * the sun's path dims it fully, cloud further along it at most to FAR_CLOUD_SUN (see there).
   */
  sunTransmittance(ox: number, oy: number, oz: number, sunX: number, sunY: number, sunZ: number, steps: number = SUN_MARCH_STEPS): number {
    const near = this.opticalDepth(ox, oy, oz, sunX, sunY, sunZ, steps, 0, SUN_REACH_M);
    const far = this.opticalDepth(ox, oy, oz, sunX, sunY, sunZ, steps, SUN_REACH_M);
    return sunLightThrough(near) * farCloudLight(far);
  }

  /**
   * Shift the field (its drift) so that an observer at world (ox, oy, oz) starts with the sun in a gap between
   * clouds: the widest gap a short search over shifts of up to ≈ 3 km finds. A session should open in sunlight;
   * after that the clouds come and go with the wind. Returns the sunlight fraction at the centre of the gap.
   */
  openSkyToward(ox: number, oy: number, oz: number, sunX: number, sunY: number, sunZ: number): number {
    if (this.params.threshold >= 1 || sunY <= 0.02) return 1;
    const light = (x: number, z: number): number => this.sunTransmittance(x, oy, z, sunX, sunY, sunZ, 24);
    // The least sunlight within ≈ 800 m of a spot: over a minute of clear sun whichever way the wind blows.
    const score = (x: number, z: number): number => {
      let least = light(x, z);
      for (let k = 0; k < 12 && least > 0.2; k++) {
        const r = k < 6 ? 350 : 800;
        const a = (k * Math.PI) / 3 + (k < 6 ? 0 : 0.5);
        least = Math.min(least, light(x + r * Math.cos(a), z + r * Math.sin(a)));
      }
      return least;
    };
    const before = light(ox, oz);
    let best = -1;
    let bestX = 0;
    let bestZ = 0;
    for (let i = 0; i < 64 && best < 0.98; i++) {
      // Shifts on a golden-angle spiral: nearest first, so a clear start is not moved at all.
      const r = 400 * Math.sqrt(i);
      const a = i * 2.39996323;
      const sx = r * Math.cos(a);
      const sz = r * Math.sin(a);
      const s = score(ox - sx, oz - sz);
      if (s > best) {
        best = s;
        bestX = sx;
        bestZ = sz;
      }
    }
    // With a low sun behind many clouds, or under a deck, there may be no gap to find: never make it worse.
    if (light(ox - bestX, oz - bestZ) < before) return before;
    this.drift.x += bestX;
    this.drift.z += bestZ;
    return light(ox, oz);
  }
}

/** Shape of the vertical profile: full density is reached this fast above the base (per unit of slab height)… */
export const BASE_RAMP = 1 / 0.035;
/** …and most of each cloud thins out toward its summit, which is what the billows carve into. */
export const TOP_RAMP = 1.3;
/** The shape noise is stretched from this range to 0…1 before it carves (its raw values bunch around 0.58). */
export const SHAPE_LOW = 0.3;
export const SHAPE_GAIN = 1 / 0.55;
/** Density reaches its full value this quickly inside the carved boundary: crisp edges instead of a wide fringe. */
export const DENSITY_GAIN = 3;
/** Height of a cloud at its outline relative to its middle (it grows toward the middle with the square root). */
export const TOP_AT_OUTLINE = 0.25;
/** How strongly the billows carve at a cloud's base relative to its top (bases stay flat). */
export const CARVE_AT_BASE = 0.6;
/** Density at a cloud's base relative to its top (liquid water grows with height above the base). */
export const DENSITY_AT_BASE = 0.55;
/** Noise footprint of a march sample: this share of the lit sub-step… */
export const FOOTPRINT_STEPS = 0.5;
/** …or this many panorama texels at the sample's distance, whichever is larger. */
export const FOOTPRINT_TEXELS = 1.5;
/** Detail-noise mip level beyond which the detail is replaced by its mean. */
export const DETAIL_LOD_CUTOFF = 4;
/** The field starts fading at this share of `CLOUD_MAX_DISTANCE_M` and is gone at the full distance. */
export const FADE_START = 0.7;

/** Direct sunlight left by an optical depth of cloud beyond SUN_REACH_M (1 for clear air, never below FAR_CLOUD_SUN). */
export function farCloudLight(opticalDepth: number): number {
  return FAR_CLOUD_SUN + (1 - FAR_CLOUD_SUN) * Math.exp(-BEAM_EXTINCTION * Math.max(0, opticalDepth));
}

/** Direct sunlight left after an optical depth of cloud (monotonic, 1 for clear air, never below the floor). */
export function sunLightThrough(opticalDepth: number): number {
  return OPAQUE_CLOUD_SUN + (1 - OPAQUE_CLOUD_SUN) * Math.exp(-BEAM_EXTINCTION * Math.max(0, opticalDepth));
}
