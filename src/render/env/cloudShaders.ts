// GLSL for the volumetric clouds (own implementation). The technique follows the published real-time cloud
// literature: A. Schneider, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn" (SIGGRAPH 2015) for the
// noise-carved density and S. Hillaire, "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite"
// (SIGGRAPH 2016) for the lighting terms. No code was taken from either.
//
// `CLOUD_DENSITY_GLSL` is mirrored on the CPU by `CloudField.density()` (cloudField.ts): change both together.
import { CLOUD_MAX_DISTANCE_M, DETAIL_MEAN, EARTH_RADIUS_M, PANO_TEXEL_RAD, PANO_WARP, BASE_RAMP, TOP_RAMP, SHAPE_LOW, SHAPE_GAIN, DENSITY_GAIN } from './cloudField';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** Full-screen triangle. */
export const CLOUD_VERT = /* glsl */ `precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Panorama projection (see cloudField.ts): direction ↔ uv on the warped equal-area disc. */
const PANO_GLSL = /* glsl */ `
const float PANO_WARP = ${f(PANO_WARP)};
vec3 panoDirection(vec2 uv, float disc) {
  vec2 q = (uv - 0.5) * 2.0 / disc;
  float r = length(q);
  float g = 1.0 - min(r, 1.0);
  float x = PANO_WARP * g / (1.0 + PANO_WARP - g);
  float s = 1.0 - x;
  float y = 1.0 - s * s;
  float hl = sqrt(max(1.0 - y * y, 0.0));
  vec2 h = r > 1e-6 ? q / r : vec2(1.0, 0.0);
  return vec3(h.x * hl, y, h.y * hl);
}`;

export const CLOUD_DENSITY_GLSL = /* glsl */ `
uniform sampler2D uWeather;
uniform sampler3D uShape;
uniform sampler3D uDetail;
uniform vec2 uWeatherOff;
uniform vec3 uShapeOff;
uniform vec3 uDetailOff;
/** 1 / tile size of the weather, shape and detail textures (1/m). */
uniform vec3 uTileInv;
/** base altitude, 1 / slab thickness, top altitude, extinction of solid cloud. */
uniform vec4 uSlab;
/** threshold, 1 / edge, 1 / rise, height scale. */
uniform vec4 uCover;
/** height floor, erosion, detail erosion. */
uniform vec3 uCarve;

const float DETAIL_MEAN = ${f(DETAIL_MEAN)};
const float BASE_RAMP = ${f(BASE_RAMP)};
const float TOP_RAMP = ${f(TOP_RAMP)};
const float SHAPE_LOW = ${f(SHAPE_LOW)};
const float SHAPE_GAIN = ${f(SHAPE_GAIN)};
const float DENSITY_GAIN = ${f(DENSITY_GAIN)};

// The cloud's smooth envelope from the weather map alone (one 2-D lookup): 0 outside every cloud.
// xz: metres from the panorama's origin; alt: metres above the sea; hrel: height within the local cloud, 0…1.
float cloudEnvelope(vec2 xz, float alt, out float hrel) {
  hrel = 0.0;
  float hf = (alt - uSlab.x) * uSlab.y;
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  vec4 w = textureLod(uWeather, xz * uTileInv.x + uWeatherOff, 0.0);
  float over = w.r - uCover.x;
  if (over <= 0.0) return 0.0;
  float m = min(over * uCover.y, 1.0);
  float grow = min(over * uCover.z, 1.0);
  float topF = uCover.w * mix(uCarve.x, 1.0, w.g) * (0.25 + 0.75 * sqrt(grow));
  hrel = hf / topF;
  if (hrel >= 1.0) return 0.0;
  return m * min(hf * BASE_RAMP, 1.0) * min((1.0 - hrel) * TOP_RAMP, 1.0);
}

// Carve billows (shape noise) and frayed edges (detail noise) into the envelope. lodDetail < 0: use the mean.
float cloudCarve(float envelope, float hrel, vec2 xz, float alt, float lodShape, float lodDetail) {
  vec3 p = vec3(xz.x, alt, xz.y);
  float shape = textureLod(uShape, p * uTileInv.y + uShapeOff, lodShape).r;
  float carve = (1.0 - clamp((shape - SHAPE_LOW) * SHAPE_GAIN, 0.0, 1.0)) * uCarve.y * mix(0.6, 1.0, hrel);
  float d = (envelope - carve) / (1.0 - carve);
  if (d <= 0.0) return 0.0;
  float detail = lodDetail < 0.0 ? DETAIL_MEAN : textureLod(uDetail, p * uTileInv.z + uDetailOff, lodDetail).r;
  float fray = (1.0 - detail) * uCarve.z;
  d = (d - fray) / (1.0 - fray);
  if (d <= 0.0) return 0.0;
  return min(d * DENSITY_GAIN, 1.0) * mix(0.55, 1.0, hrel);
}

float cloudDensity(vec2 xz, float alt, float lodShape, float lodDetail) {
  float hrel;
  float envelope = cloudEnvelope(xz, alt, hrel);
  return envelope > 0.0 ? cloudCarve(envelope, hrel, xz, alt, lodShape, lodDetail) : 0.0;
}`;

/**
 * Fragment shader of the panorama march. Output per texel:
 *   R  sunlight scattered toward the eye, per unit of sun radiance (phase and self-shadowing included)
 *   G  ambient light scattered toward the eye, per unit of ambient radiance
 *   B  the cloud's opacity weighted by its visibility through the haze (aerial perspective)
 *   A  transmittance of the sky behind
 * The dome multiplies R and G by the current sun and sky colours, so the time of day recolours the clouds at
 * once; only the pattern of light and shadow waits for the next panorama.
 */
export function cloudMarchFragment(steps: number, subSteps: number, lightSteps: number): string {
  return /* glsl */ `precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
#define CLOUD_STEPS ${steps}
#define SUB_STEPS ${subSteps}
#define LIGHT_STEPS ${lightSteps}
${CLOUD_DENSITY_GLSL}
${PANO_GLSL}
uniform vec2 uInvSize;
uniform vec2 uTileOrigin;
uniform float uDisc;
uniform vec3 uSunDir;
uniform float uCamHeight;
uniform float uJitter;
/** Metres per texel of the shape and the detail noise. */
uniform vec2 uTexel;
/** first light step (m), diffuse falloff, multiple-scattering strength, powder rate. */
uniform vec4 uLight;
/** forward g, backward g, share of the forward lobe. */
uniform vec3 uPhase;
/** ambient at the cloud base relative to its top, haze extinction (1/m). */
uniform vec2 uAmbient;
out vec4 outColor;

const float MAX_DIST = ${f(CLOUD_MAX_DISTANCE_M)};
const float EARTH_R = ${f(EARTH_RADIUS_M)};
const float TEXEL_RAD = ${f(PANO_TEXEL_RAD)};
const float INV_2R = ${f(1 / (2 * EARTH_RADIUS_M))};

float shellDistance(float dy, float alt) {
  float r = EARTH_R + uCamHeight;
  float rise = alt - uCamHeight;
  float b = r * dy;
  float c = rise * (2.0 * r + rise);
  return c / (b + sqrt(b * b + c));
}

// Henyey–Greenstein, scaled so that isotropic scattering is 1.
float hg(float c, float g) {
  float k = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (k * sqrt(k));
}

// Interleaved gradient noise: J. Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare",
// SIGGRAPH 2014 (a published formula). Any 3x3 block of pixels holds nine well-spread values.
float interleavedGradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// Optical depth of cloud between a point and the sun: a few samples, each step longer than the last.
float sunDepth(vec2 xz, float alt, float lod, float firstStep) {
  float sum = 0.0;
  float len = firstStep;
  float s = 0.5 * len;
  for (int j = 0; j < LIGHT_STEPS; j++) {
    sum += cloudDensity(xz + uSunDir.xz * s, alt + uSunDir.y * s, lod + 1.0 + 0.5 * float(j), -1.0) * len;
    s += 0.5 * len;
    len *= 1.7;
    s += 0.5 * len;
  }
  return sum * uSlab.w;
}

void main() {
  // The panorama is marched a tile at a time into a tile-sized target: uTileOrigin is the tile's corner.
  vec2 texel = gl_FragCoord.xy + uTileOrigin;
  vec3 dir = panoDirection(texel * uInvSize, uDisc);
  float dy = max(dir.y, 0.0);
  float t0 = shellDistance(dy, uSlab.x);
  vec4 result = vec4(0.0, 0.0, 0.0, 1.0);
  if (uCover.x < 1.0 && t0 < MAX_DIST) {
    float t1 = min(shellDistance(dy, uSlab.z), MAX_DIST);
    float stepLen = (t1 - t0) / float(CLOUD_STEPS);
    float jitter = fract(interleavedGradientNoise(texel) + uJitter);
    float cosSun = dot(dir, uSunDir);
    float phase = mix(hg(cosSun, uPhase.y), hg(cosSun, uPhase.x), uPhase.z);
    float subLen = stepLen / float(SUB_STEPS);
    float firstStep = max(uLight.x, 0.6 * subLen);
    float T = 1.0;
    vec3 sum = vec3(0.0);
    bool wasIn = false;
    // Coarse steps test the envelope alone (one 2-D lookup). Where a cloud is present — at this step or the one
    // before, so its far edge is not cut short — the step is refined into lit sub-steps.
    for (int i = 0; i < CLOUD_STEPS; i++) {
      float ts = t0 + float(i) * stepLen;
      float tc = ts + jitter * stepLen;
      float hrel;
      bool isIn = cloudEnvelope(dir.xz * tc, uCamHeight + tc * dy + tc * tc * INV_2R, hrel) > 0.0;
      if (isIn || wasIn) {
        for (int k = 0; k < SUB_STEPS; k++) {
          float t = ts + (float(k) + jitter) * subLen;
          float alt = uCamHeight + t * dy + t * t * INV_2R;
          vec2 xz = dir.xz * t;
          float envelope = cloudEnvelope(xz, alt, hrel);
          if (envelope <= 0.0) continue;
          float footprint = max(0.5 * subLen, 1.5 * t * TEXEL_RAD);
          float lodShape = max(0.0, log2(footprint / uTexel.x));
          float lodDetail = log2(footprint / uTexel.y);
          float d = cloudCarve(envelope, hrel, xz, alt, lodShape, lodDetail > 4.0 ? -1.0 : max(0.0, lodDetail));
          if (d <= 0.0) continue;
          d *= 1.0 - smoothstep(0.7 * MAX_DIST, MAX_DIST, t);
          float a = 1.0 - exp(-d * uSlab.w * subLen);
          // Sunlight: the direct beam with the droplets' forward-peaked phase, plus light that has scattered
          // many times on the way in (it fades slowly with depth and has forgotten its direction). Thin wisps
          // have little cloud around them to scatter light back, which the powder term stands for.
          float tauSun = sunDepth(xz, alt, lodShape, firstStep);
          float direct = exp(-tauSun);
          float diffuse = 1.0 / (1.0 + uLight.y * tauSun);
          float powder = 1.0 - exp(-uLight.w * d);
          float sun = phase * direct + uLight.z * diffuse * powder;
          float ambient = mix(uAmbient.x, 1.0, hrel);
          float w = T * a;
          sum += w * vec3(sun, ambient, exp(-uAmbient.y * t));
          T *= 1.0 - a;
          if (T < 0.004) break;
        }
        if (T < 0.004) { T = 0.0; break; }
      }
      wasIn = isIn;
    }
    result = vec4(sum, T);
  }
  outColor = result;
}`;
}

/**
 * Resolve pass, run once when a generation is complete. Each texel was marched with its own sub-step offset
 * (interleaved gradient noise: any 3×3 block holds nine well-spread offsets), which shows as a fine hatch in the
 * lighting. Here the light *per unit of opacity* is averaged over the 3×3 block and applied to the texel's own
 * opacity: the hatch goes, silhouettes keep their sharpness. `uSoften` blends a little of the block's mean
 * transmittance in as well, against scalloped edges on distant clouds.
 *
 * It also assembles the panorama: the tiles were marched into the layers of an array texture (layer = row ×
 * columns + column), so that no per-tile pass ever touches a large render target.
 */
export const CLOUD_RESOLVE_FRAG = /* glsl */ `precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uTiles;
/** tile edge (texels), tiles per row, panorama size (texels). */
uniform ivec3 uLayout;
uniform float uSoften;
out vec4 outColor;

// The marched texel at panorama position p. Texels beyond the panorama's half-size from its centre belong to
// corner tiles that are never marched: clear sky.
vec4 marched(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(uLayout.z - 1));
  vec2 c = vec2(p) + 0.5 - 0.5 * float(uLayout.z);
  if (dot(c, c) > 0.25 * float(uLayout.z * uLayout.z)) return vec4(0.0, 0.0, 0.0, 1.0);
  ivec2 t = p / uLayout.x;
  return texelFetch(uTiles, ivec3(p - t * uLayout.x, t.y * uLayout.y + t.x), 0);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = marched(p);
  vec3 light = vec3(0.0);
  float opacity = 0.0;
  float through = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec4 s = marched(p + ivec2(i, j));
      light += s.rgb;
      opacity += 1.0 - s.a;
      through += s.a;
    }
  }
  float T = mix(c.a, through / 9.0, uSoften);
  outColor = vec4(opacity > 1e-4 ? light / opacity * (1.0 - T) : vec3(0.0), T);
}`;

/** Uniform declarations and the panorama lookup for the sky dome's fragment shader. */
export const CLOUD_DOME_PARS_GLSL = /* glsl */ `
		uniform sampler2D cloudPanoA;
		uniform sampler2D cloudPanoB;
		uniform float cloudBlend;
		// xy: how far (m, world x/z) the clouds of each panorama have moved past the camera since it was rendered;
		// z: the panorama's disc scale.
		uniform vec3 cloudShiftA;
		uniform vec3 cloudShiftB;
		uniform float cloudRefAltitude;
		uniform vec3 cloudSunLight;
		uniform vec3 cloudAmbientLight;
		uniform vec3 cloudFadePower;
		uniform float cloudHazeGrey;

		vec4 cloudPanorama( sampler2D pano, vec3 d, vec3 shift ) {
			// The parcel now seen along d sat at d * s - shift when this panorama was rendered (s = the distance to
			// the cloud layer along d, on a spherical Earth).
			float y = max( d.y, 0.0 );
			float c = cloudRefAltitude * ( ${f(2 * EARTH_RADIUS_M)} + cloudRefAltitude );
			float b = ${f(EARTH_RADIUS_M)} * y;
			float s = c / ( b + sqrt( b * b + c ) );
			vec3 p = vec3( d.x * s - shift.x, y * s, d.z * s - shift.y );
			p *= inversesqrt( dot( p, p ) );
			float x = 1.0 - sqrt( 1.0 - clamp( p.y, 0.0, 1.0 ) );
			float r = 1.0 - x * ${f(1 + PANO_WARP)} / ( x + ${f(PANO_WARP)} );
			vec2 h = p.xz * inversesqrt( max( dot( p.xz, p.xz ), 1e-12 ) );
			return texture2D( pano, 0.5 + 0.5 * shift.z * r * h );
		}
`;

/**
 * Composite the cloud panorama over the sky colour `texColor` (which includes the sun disc `sundiscColor`).
 * Clouds fade toward the sky behind them with distance, a little faster in the blue.
 */
export const CLOUD_DOME_GLSL = /* glsl */ `
			{
				vec4 cloud = mix( cloudPanorama( cloudPanoA, direction, cloudShiftA ), cloudPanorama( cloudPanoB, direction, cloudShiftB ), cloudBlend );
				float cloudAlpha = 1.0 - cloud.a;
				if ( cloudAlpha > 0.0005 ) {
					// Distant cloud fades into the haze in front of it: the sky colour, greyed under a deck (as the fog is).
					vec3 skyBehind = texColor - sundiscColor;
					vec3 haze = mix( skyBehind, vec3( dot( skyBehind, vec3( 0.2126, 0.7152, 0.0722 ) ) * 0.9 ), cloudHazeGrey );
					float fade = clamp( cloud.b / cloudAlpha, 1e-4, 1.0 );
					vec3 visible = pow( vec3( fade ), cloudFadePower );
					vec3 lit = ( cloudSunLight * cloud.r + cloudAmbientLight * cloud.g ) / cloudAlpha;
					texColor = texColor * cloud.a + cloudAlpha * mix( haze, lit, visible );
				}
			}
`;
