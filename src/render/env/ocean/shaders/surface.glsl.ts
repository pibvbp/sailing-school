// Ocean surface: screen-space projected grid (vertex) and water shading (fragment).
// Adapted from ABYSSAL `src/ocean/OceanMesh.js` (projected grid onto the spherical sea with horizon
// snapping and skirt, footprint-based cascade LOD, derivative normals, Cox–Munk roughness split into
// resolved/unresolved slope, Jacobian foam carved by windrow textures, GGX sun, Fresnel sky,
// sub-surface scattering in crests). Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for
// sailing-school: disaster fields, clouds and atmosphere LUTs removed; sky, sun and haze come from our
// SkyState (PMREM env map); gust/lull patches, boat wake foam/slick, hull cut-out and x-ray added.
import { OCEAN_SAMPLE_GLSL } from './oceanSample.glsl';
import { BRDF_GLSL } from './common.glsl';
import { HULL_WAVE_GLSL } from './hullWave.glsl';

export const MAX_PUFFS = 24;

export const ENV_GLSL = /* glsl */ `
#ifdef ENVMAP_TYPE_CUBE_UV
uniform sampler2D uEnvMap;
#include <cube_uv_reflection_fragment>
vec3 oceanEnv(vec3 dir, float roughness) { return textureCubeUV(uEnvMap, dir, roughness).rgb; }
#else
uniform vec3 uFallbackHorizon;
uniform vec3 uFallbackZenith;
vec3 oceanEnv(vec3 dir, float roughness) { return mix(uFallbackHorizon, uFallbackZenith, sqrt(clamp(dir.y, 0.0, 1.0))); }
#endif
`;

/**
 * Sky light the water needs everywhere, baked once per sky change into a 32×2 texture: row 0 = the
 * horizon radiance around the compass (haze colour), row 1 = the sky's cosine-weighted ambient.
 */
export const SKYLIGHT_BAKE = /* glsl */ `
#define texture2D texture
${ENV_GLSL}
layout(location = 0) out vec4 oOut;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float az = (float(p.x) + 0.5) / 32.0 * 6.2831853;
  vec3 c = p.y == 0 ? oceanEnv(normalize(vec3(cos(az), 0.035, sin(az))), 0.3) : oceanEnv(vec3(0.0, 1.0, 0.0), 1.0);
  oOut = vec4(c, 1.0);
}
`;

/**
 * The sky reflected by the water, baked from the PMREM into a mipmapped lat-long map of the upper
 * hemisphere (v = sqrt(elevation sine) keeps texels near the horizon, where water reflects most).
 * One trilinear lookup replaces textureCubeUV's face branching in the per-pixel shader.
 */
export const ENV_EQUIRECT_BAKE = /* glsl */ `
#define texture2D texture
${ENV_GLSL}
uniform vec2 uSize;
layout(location = 0) out vec4 oOut;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float phi = (uv.x - 0.5) * 6.2831853;
  float y = uv.y * uv.y;
  float r = sqrt(max(1.0 - y * y, 0.0));
  oOut = vec4(oceanEnv(vec3(cos(phi) * r, y, sin(phi) * r), 0.0), 1.0);
}
`;

const ENV_LOOKUP_GLSL = /* glsl */ `
uniform sampler2D uEnvEquirect;
uniform float uEnvWidth;
/** Sky radiance around direction d, averaged over a patch of sky about 2 × spread radians across. */
vec3 skyReflection(vec3 d, float spread) {
  vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, sqrt(clamp(d.y, 0.0, 1.0)));
  float lod = log2(max(spread * uEnvWidth / 6.2831853, 1.0));
  return textureLod(uEnvEquirect, uv, lod).rgb;
}
`;

/**
 * The water seen through the x-ray window. Not the deep-sea body colour (a dark hull over dark water shows nothing):
 * lit like clear water over pale sand, so the hull's bottom, the keel and the rudder stand out against it. It is a
 * teaching view — clarity beats realism here.
 */
export const BACKDROP_VERT = /* glsl */ `
uniform sampler2D uSkyLight;
varying vec3 vSkyAmb;
void main() {
  vSkyAmb = texture(uSkyLight, vec2(0.5, 0.75)).rgb;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

export const BACKDROP_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform vec3 uWaterScatter;
uniform vec3 uWaterAbsorb;
varying vec3 vSkyAmb;
void main() {
  vec3 beam = uSunRadiance * max(uSunDir.y, 0.0) * 0.97 / 3.14159265;
  vec3 light = beam + vSkyAmb * 0.94;
  vec3 deep = (uWaterScatter * light + uWaterAbsorb * vSkyAmb * 0.8) * 1.15;
  vec3 clear = vec3(0.03, 0.135, 0.175) * light;
  gl_FragColor = vec4(mix(deep, clear, 0.85), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const SURFACE_VERT = /* glsl */ `
#define MAX_PUFFS ${MAX_PUFFS}
attribute vec2 aGrid;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec2 uGridSize;
uniform vec4 uGridNdc;
uniform float uSkirt;
uniform float uRMax;
uniform float uEarthCurvature;
uniform vec4 uPuffA[MAX_PUFFS];
uniform vec4 uPuffB[MAX_PUFFS];
uniform int uPuffCount;
uniform sampler2D uKelvinTex;
uniform vec4 uWakeRect;   // origin x, origin z, 1 / size, enabled
uniform sampler2D uSkyLight;
uniform vec4 uBoat;       // world x, z, forward x, forward z
uniform vec4 uHullState;  // enabled, heel (rad), x-ray 0..1, speed (m/s)
${OCEAN_SAMPLE_GLSL}
${HULL_WAVE_GLSL}

varying vec3 vWorldPos;
varying vec2 vQ;
varying float vDist;
varying float vWaveY;
varying float vGust;
varying vec3 vSkyAmb;
varying vec3 vHaze;

const float EARTH_R = 6371000.0;

vec3 rayFor(vec2 ndc) {
  vec4 a = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvViewProj * vec4(ndc, 1.0, 1.0);
  return normalize(b.xyz / b.w - a.xyz / a.w);
}

/** Distance along a view ray to the curved sea surface; y = 1 when the ray missed and was snapped to the horizon. */
vec2 seaHit(vec3 dir, float eye) {
  float a = max((1.0 - dir.y * dir.y) * uEarthCurvature / (2.0 * EARTH_R), 1e-14);
  float b = dir.y;
  float disc = b * b - 4.0 * a * eye;
  float t = 0.0;
  bool miss = true;
  if (disc >= 0.0) {
    // Citardauq form: the textbook root cancels catastrophically because a ~ 1e-8.
    float sq = sqrt(disc);
    float qq = -0.5 * (b + (b >= 0.0 ? sq : -sq));
    float r1 = qq / a;
    float r2 = abs(qq) > 1e-20 ? eye / qq : -1.0;
    float lo = min(r1, r2), hi = max(r1, r2);
    t = lo > 0.02 ? lo : hi;
    miss = t <= 0.02;
  }
  if (miss || t > uRMax) {
    // Snap to the tangent point: lands exactly on the geometric horizon.
    float rh = uEarthCurvature > 0.5 ? sqrt(max(2.0 * EARTH_R * eye, 1.0)) : uRMax;
    rh = min(rh, uRMax);
    return vec2(rh / max(length(dir.xz), 1e-5), 1.0);
  }
  return vec2(t, 0.0);
}

vec2 gridNdc(vec2 g) {
  return vec2(mix(uGridNdc.x, uGridNdc.y, g.x), mix(uGridNdc.z, uGridNdc.w, g.y));
}

/** Sum of gust (+) / lull (−) strengths at p; ragged edges from large-scale noise. */
float puffField(vec2 p) {
  float g = 0.0;
  if (uPuffCount == 0) return 0.0;
  float n = textureLod(uNoiseTex, p * (1.0 / 420.0), 0.0).z - 0.5;
  float n2 = textureLod(uNoiseTex, p * (1.0 / 97.0) + vec2(0.3, 0.7), 0.0).z - 0.5;
  for (int i = 0; i < MAX_PUFFS; i++) {
    if (i >= uPuffCount) break;
    vec4 a = uPuffA[i];
    vec4 b = uPuffB[i];
    vec2 d = p - a.xy;
    vec2 local = vec2(dot(d, b.xy), dot(d, vec2(-b.y, b.x))) * a.zw;
    float r = length(local) * (1.0 + 0.55 * n + 0.3 * n2);
    g += b.z * (1.0 - smoothstep(0.35, 1.0, r));
  }
  return g;
}

void main() {
  // Outermost ring thrown well outside the frustum so displaced edges never uncover the frame.
  vec2 cellIdx = aGrid * uGridSize;
  vec2 atMin = step(cellIdx, vec2(0.5));
  vec2 atMax = step(uGridSize - 0.5, cellIdx);
  vec2 ndc = gridNdc(aGrid) + (atMax - atMin) * uSkirt;
  vec3 dir = rayFor(ndc);
  float eye = max(uCamPos.y, 0.35);
  vec2 hit = seaHit(dir, eye);
  float t = hit.x;
  float snapped = hit.y;
  vec2 world = uCamPos.xz + dir.xz * t;

  // Footprint of one grid cell on the water picks the cascade mip the mesh can actually resolve.
  vec3 dirU = rayFor(gridNdc(aGrid + vec2(1.0 / uGridSize.x, 0.0)));
  vec3 dirV = rayFor(gridNdc(aGrid + vec2(0.0, 1.0 / uGridSize.y)));
  vec2 wu = uCamPos.xz + dirU.xz * seaHit(dirU, eye).x;
  vec2 wv = uCamPos.xz + dirV.xz * seaHit(dirV, eye).x;
  float pixel = t * length(dirU - dir);
  float cell = max(max(length(wu - world), length(wv - world)), max(0.015, pixel));

  vec2 q = oceanWarp(world);
  vec3 disp = oceanDisplacement(q, oceanLods(cell));
  // Keep the silhouette clean where rays were snapped onto the horizon ring.
  disp *= 1.0 - snapped * 0.92;
  // The boat's own waves: near field around the hull, Kelvin pattern behind it.
  if (uWakeRect.w > 0.5) {
    vec2 wuv = (world - uWakeRect.xy) * uWakeRect.z;
    if (all(greaterThan(wuv, vec2(0.0))) && all(lessThan(wuv, vec2(1.0)))) disp.y += textureLod(uKelvinTex, wuv, 0.0).g;
  }
  if (uHullState.x > 0.5) {
    vec2 hrel = world - uBoat.xy;
    disp.y += hullWave(vec2(dot(hrel, uBoat.zw), dot(hrel, vec2(-uBoat.w, uBoat.z))), uHullState.w).x;
  }

  vec3 wp = vec3(world.x + disp.x, disp.y, world.y + disp.z);
  vec2 rel = world - uCamPos.xz;
  wp.y -= uEarthCurvature * dot(rel, rel) / (2.0 * EARTH_R);

  vWorldPos = wp;
  vQ = q;
  vDist = length(wp - uCamPos);
  vWaveY = disp.y;
  vGust = puffField(world);
  vSkyAmb = texture(uSkyLight, vec2(0.5, 0.75)).rgb;
  vHaze = texture(uSkyLight, vec2(atan(rel.y, rel.x + 1e-4) / 6.2831853, 0.25)).rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const SURFACE_FRAG = /* glsl */ `
uniform vec3 uCamPos;
// Texture lookups use coordinates relative to a reference near the camera; every large offset (the
// reference's own position, drift with time) is wrapped in double precision on the CPU, so the finest
// textures stay sharp and still after hours of sailing and kilometres from the origin.
uniform vec2 uRef;
uniform vec4 uOffRipple;   // ripple layer 0 xy, layer 1 xy
uniform vec4 uOffFoamA;    // whitecap lace fx0 xy, fx1 xy
uniform vec4 uOffFoamB;    // fx2 xy, boat-foam lace (coarse) xy
uniform vec4 uOffFoamC;    // boat-foam lace (fine) xy, windrow drift, 0
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform vec3 uWaterScatter;
uniform vec3 uWaterAbsorb;
uniform float uWindSpeed;
uniform vec2 uWindDirTo;
uniform float uHs;
uniform float uMssMean;
uniform float uUnresolvedMss;
uniform vec3 uCascadeMss;
uniform vec3 uBandLambdaMin;
uniform vec3 uBandOctaves;
uniform float uAnisoMax;
uniform float uFogDensity;
uniform float uHazeMax;
uniform float uStreaks;   // 0…1 wind-aligned foam streaks (fresh breeze and up)
uniform sampler2D uOceanDeriv0, uOceanDeriv1, uOceanDeriv2;
uniform sampler2D uOceanTurb0, uOceanTurb1, uOceanTurb2;
uniform vec3 uOceanScales;
uniform vec3 uCascadeGain;
uniform sampler2D uFoamTex;
uniform sampler2D uRippleTex;
uniform sampler2D uNoiseTex;
uniform sampler2D uWakeTex;
uniform sampler2D uKelvinTex;
uniform vec4 uWakeRect;   // origin x, origin z, 1 / size, enabled
uniform vec2 uKelvinStep; // one Kelvin texel in uv and in metres
uniform vec4 uBoat;       // world x, z, forward x, forward z
uniform vec4 uHullShape;  // stem x, transom x, max-beam x, half beam (boat-local, m)
uniform vec4 uHullState;  // enabled, heel (rad), x-ray 0..1, speed (m/s)
uniform float uDebugMode; // 0 off, 1 wake trail, 2 foam, 3 normal, 4 roughness, 5 gusts, 6 Fresnel, 7 Kelvin
uniform sampler2D uReflection;
uniform mat4 uReflectionMatrix;   // mirror camera view-projection
uniform float uReflectionOn;
${BRDF_GLSL}
${ENV_LOOKUP_GLSL}
${HULL_WAVE_GLSL}

varying vec3 vWorldPos;
varying vec2 vQ;
varying float vDist;
varying float vWaveY;
varying float vGust;
varying vec3 vSkyAmb;
varying vec3 vHaze;

/** 1 inside the hull's waterplane (shrunk to stay inside the hull at any heel). */
float insideHull(vec2 l) {
  float stem = uHullShape.x, transom = uHullShape.y, xm = uHullShape.z, hb = uHullShape.w;
  if (l.x > stem || l.x < transom) return 0.0;
  float half_;
  if (l.x >= xm) { float u = (l.x - xm) / (stem - xm); half_ = hb * pow(max(1.0 - u * u, 0.0), 0.7); }
  else { float u = (xm - l.x) / (xm - transom); half_ = hb * (1.0 - 0.28 * u * u); }
  // The windward side lifts out as the boat heels; its waterline moves inboard.
  float s = sin(uHullState.y);
  float lo = -half_ + max(s, 0.0) * 0.9;
  float hi = half_ - max(-s, 0.0) * 0.9;
  return step(lo, l.y) * step(l.y, hi);
}

float coxMunk(float u) { return 0.002 + 0.00512 * u * smoothstep(0.6, 3.0, u); }

void main() {
  // ------------------------------------------------------------------ boat frame
  vec2 rel = vWorldPos.xz - uBoat.xy;
  vec2 fwd = uBoat.zw;
  vec2 boatLocal = vec2(dot(rel, fwd), dot(rel, vec2(-fwd.y, fwd.x)));
  // Water inside the hull's waterplane (the cockpit) is discarded at the very end, after every
  // implicit-derivative texture tap (a discard before them leaves derivatives undefined in the quad).
  bool insideCutout = uHullState.x > 0.5 && insideHull(boatLocal) > 0.5;

  vec2 q = vQ;
  vec2 qr = q - uRef;
  vec2 ddx = dFdx(q);
  vec2 ddy = dFdy(q);
  // Pixel footprint on the water: the minor axis is what anisotropic taps still resolve; roughness is
  // charged for the geometric mean so grazing water averages its light honestly.
  float fpA = length(ddx), fpB = length(ddy);
  float fpMajor = max(fpA, fpB);
  float fpMinor = max(max(min(fpA, fpB), fpMajor / max(uAnisoMax, 1.0)), 1e-5);
  float fpShade = sqrt(fpMinor * fpMajor);

  // ------------------------------------------------------------ wind & wake
  float gust = clamp(vGust, -0.75, 1.2);
  float localWind = max(uWindSpeed * (1.0 + gust), 0.0);
  vec4 wake = vec4(0.0);
  vec2 kelvinSlope = vec2(0.0);
  float kelvinFoam = 0.0;
  if (uWakeRect.w > 0.5) {
    vec2 wuv = (vWorldPos.xz - uWakeRect.xy) * uWakeRect.z;
    if (all(greaterThan(wuv, vec2(0.0))) && all(lessThan(wuv, vec2(1.0)))) {
      wake = texture(uWakeTex, wuv);
      vec2 k0 = texture(uKelvinTex, wuv).rg;
      kelvinFoam = k0.r;
      // Most of the window is outside the Kelvin wedge: only fetch the slope taps inside it.
      if (abs(k0.g) > 1e-4) {
        float e = uKelvinStep.x;
        kelvinSlope = vec2(texture(uKelvinTex, wuv + vec2(e, 0.0)).g - k0.g, texture(uKelvinTex, wuv + vec2(0.0, e)).g - k0.g) / uKelvinStep.y;
      }
    }
  }
  // The hull's near-field waves: slope by central differences, and the white water where the bow
  // crest breaks against the stem.
  vec2 hullSlope = vec2(0.0);
  float hullBreak = 0.0;
  if (uHullState.x > 0.5 && dot(boatLocal, boatLocal) < 144.0) {
    float e = 0.08, v = uHullState.w;
    vec2 w0 = hullWave(boatLocal, v);
    hullBreak = max(w0.y, hullRimFoam(boatLocal, v));
    vec2 g = vec2(hullWave(boatLocal + vec2(e, 0.0), v).x - w0.x, hullWave(boatLocal + vec2(0.0, e), v).x - w0.x) / e;
    hullSlope = g.x * fwd + g.y * vec2(-fwd.y, fwd.x);
  }
  float slick = clamp(wake.b, 0.0, 1.0);
  // Capillaries answer the local wind within seconds: gusts roughen, lulls and wake slicks go glassy.
  float gustRough = clamp(1.0 + gust * 1.8, 0.15, 2.6);
  float rough = gustRough * (1.0 - 0.75 * slick);
  // Longer (0.5–2 m) waves react less to a gust but are still flattened by the turbulent wake.
  float rough1 = mix(1.0, gustRough, 0.35) * (1.0 - 0.45 * slick);

  // --------------------------------------------------------------- normal
  // Top-level (uniform control flow) lookups use implicit derivatives: identical footprint, cheaper.
  vec4 d0 = texture(uOceanDeriv0, q / uOceanScales.x) * uCascadeGain.x;
  vec4 d1 = texture(uOceanDeriv1, q / uOceanScales.y) * uCascadeGain.y;
  vec4 d2 = texture(uOceanDeriv2, q / uOceanScales.z) * uCascadeGain.z;
  vec4 dsum = d0 + vec4(d1.xy * rough1, d1.zw) + vec4(d2.xy * rough, d2.zw);
  vec2 slope = vec2(dsum.x / max(1.0 + dsum.z, 0.05), dsum.y / max(1.0 + dsum.w, 0.05)) + kelvinSlope + hullSlope;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  // Capillary ripples below the finest cascade (≈ 12 cm and 4 cm tiles), wind-driven: they are what
  // makes a cat's paw visible up close. Only where a pixel can resolve them.
  float microFade = 1.0 - smoothstep(0.004, 0.04, fpShade);
  float rippleAmp = smoothstep(0.8, 5.0, localWind) * rough * 0.1;
  if (microFade > 0.004) {
    mat2 rotA = mat2(0.8339, 0.5519, -0.5519, 0.8339);
    vec2 qA = rotA * qr;
    vec3 r0 = textureGrad(uRippleTex, qr * 8.3 + uOffRipple.xy, ddx * 8.3, ddy * 8.3).xyz * 2.0 - 1.0;
    vec3 r1 = textureGrad(uRippleTex, qA * 23.0 + uOffRipple.zw, rotA * ddx * 23.0, rotA * ddy * 23.0).xyz * 2.0 - 1.0;
    vec2 micro = (r0.xz * 0.6 + (r1.xz * rotA) * 0.4) * microFade * rippleAmp;
    N = normalize(N + vec3(micro.x, 0.0, micro.y));
  }

  // -------------------------------------------------------------- roughness
  // Only the slope the pixel cannot resolve becomes GGX roughness: the capillary remainder of the
  // Cox–Munk total plus each cascade's variance lost to filtering at this footprint.
  float windRatio = coxMunk(localWind) / max(uMssMean, 1e-4);
  vec3 lost = clamp(log2(max(2.0 * fpShade / uBandLambdaMin, vec3(1.0))) / uBandOctaves, 0.0, 1.0);
  float mssLost = dot(uCascadeMss * vec3(1.0, rough1 * rough1, rough * rough), lost);
  float mssRipple = 0.12 * rippleAmp * rippleAmp * (1.0 - microFade);
  // Sub-millimetre capillaries ride on everything even where the ripple texture is resolved: a small
  // floor near the eye keeps close water satin rather than a crumpled mirror.
  float mssCapillary = 0.1 * coxMunk(localWind) * microFade * (1.0 - 0.75 * slick);
  float mssUnres = uUnresolvedMss * windRatio * (1.0 - 0.75 * slick) + mssLost + mssRipple + mssCapillary + 0.0004;
  float alpha = clamp(sqrt(mssUnres) * 1.15, 0.018, 0.65);
  float roughness = sqrt(alpha);

  // ------------------------------------------------------------------- foam
  // Coverage comes from the two energetic cascades; the carving textures are only fetched where
  // there is foam to carve (most of the sea has none, and those taps dominate the shader's cost).
  vec4 t0 = texture(uOceanTurb0, q / uOceanScales.x);
  vec4 t1 = texture(uOceanTurb1, q / uOceanScales.y);
  // Residual foam (accumulated) plus the crest that is breaking right now, which is the bright part.
  float rawFoam = max(t0.r, t1.r * 0.9);
  float breakingNow = max(t0.b, t1.b * 0.8);
  // Bubble plumes are local and short-lived: only the dense part under recent breaking counts.
  float bubbles = smoothstep(0.05, 0.5, max(t0.g, t1.g)) * 0.6 + wake.g * 0.9;
  // The active cap sits on the upper, leeward face of the crest (fine-scale shape from the surface): a band along
  // the top of the wave, not the whole of its back.
  float crestMask = smoothstep(0.15, 0.75, vWaveY / max(uHs * 0.5, 0.05));
  float front = smoothstep(-0.02, 0.12, -dot(slope, uWindDirTo));
  // Coverage: only the tumbling front of a breaker is nearly solid, a band along the crest and not the whole patch
  // that is breaking a little; the foam it leaves behind is lace that thins as it decays.
  float activeCap = smoothstep(0.10, 0.55, breakingNow) * crestMask * (0.4 + 0.6 * front);
  float residual = 0.5 * smoothstep(0.05, 0.9, rawFoam);
  float foamMask = (max(activeCap, residual) + 0.3 * min(activeCap, residual)) * (1.0 + max(gust, 0.0));
  float wakeDensity = max(max(wake.r, kelvinFoam), hullBreak);
  // Foam organises into streaks along the wind (Langmuir windrows), so every foam lookup is stretched
  // downwind (qs.x runs along the wind). From a fresh breeze old foam lies in long lines between the caps.
  vec2 wd = uWindDirTo;
  mat2 windFrame = mat2(wd.x, -wd.y, wd.y, wd.x);
  vec2 qs = windFrame * q;
  vec2 qsr = windFrame * qr;
  vec2 gx = windFrame * ddx, gy = windFrame * ddy;
  if (uStreaks > 0.001) {
    // Ridges of a meandering noise across the wind make continuous lines a few metres apart; a second,
    // coarser noise breaks them into patches tens of metres long.
    float meander = texture(uNoiseTex, qs * 0.0021).x - 0.5;
    float n = texture(uNoiseTex, vec2(qs.x * 0.0035 + uOffFoamC.z, qs.y * 0.043 + meander * 0.9)).z;
    float line = smoothstep(0.86, 0.97, 1.0 - abs(n * 2.0 - 1.0));
    float patches = smoothstep(0.42, 0.7, texture(uNoiseTex, vec2(qs.x * 0.009, qs.y * 0.035) + 0.37).w);
    foamMask += line * patches * 0.3 * uStreaks;
  }
  float foam = 0.0, foamThin = 0.0, foamFine = 0.5;
  if (foamMask > 0.015 || wakeDensity > 0.015) {
    vec2 stretch = vec2(0.22, 1.0);
    vec4 fx1 = textureGrad(uFoamTex, qsr * 0.145 * stretch + uOffFoamA.zw, gx * 0.145 * stretch, gy * 0.145 * stretch);
    vec4 fx2 = textureGrad(uFoamTex, qr * 0.62 + uOffFoamB.xy, ddx * 0.62, ddy * 0.62);
    foamFine = fx2.g * 0.6 + fx1.g * 0.4;
    if (foamMask > 0.015) {
      // Coverage, not paint: the local foam amount decides what fraction of a lace pattern (bubble-raft
      // cells + wind streaks) turns white, so even dense foam keeps its holes and ragged edges.
      vec4 fx0 = textureGrad(uFoamTex, qsr * 0.031 * stretch + uOffFoamA.xy, gx * 0.031 * stretch, gy * 0.031 * stretch);
      float lace = fx2.r * 0.45 + fx1.a * 0.3 + fx0.a * 0.25;
      // Past a few metres a pixel no longer resolves the lace, and its filtered value tends to the pattern's mean.
      // Thresholding that would paint a whole patch white with a hard outline — an ice floe. So the threshold
      // widens with the footprint into what the pixel really holds, the fraction of its lace that is white: old
      // foam fades out toward its edges, and only a crest breaking right now stays dense. That part is boosted
      // a little with distance, so that white horses carry to the horizon.
      float unresolved = smoothstep(0.02, 0.5, fpShade);
      float cover = clamp(foamMask + 0.5 * activeCap * unresolved, 0.0, 0.74);
      float edge = 1.0 - cover;
      float soft = mix(0.06, 0.32, unresolved);
      foam = smoothstep(edge - soft, edge + soft, lace + 0.12 * (fx2.g - 0.5));
      foamThin = smoothstep(edge - 0.18 - soft, edge + 0.04, lace) * (1.0 - foam) * 0.7;
    }
    if (wakeDensity > 0.015) {
      // Boat foam, lace not paint: the density decides what fraction of a bubble-raft pattern turns
      // white. The pattern is fixed in the water, so the hull slides through it and the foam streams aft.
      vec4 wf = textureGrad(uFoamTex, qr * 0.23 + uOffFoamB.zw, ddx * 0.23, ddy * 0.23);
      // A 4× finer layer keeps close-ups bubbly (cells of a few centimetres).
      vec4 wn = textureGrad(uFoamTex, qr * 0.92 + uOffFoamC.xy, ddx * 0.92, ddy * 0.92);
      float lace = wf.r * 0.42 + wn.r * 0.33 + fx2.r * 0.15 + wf.a * 0.1;
      float edge = 1.0 - clamp(wakeDensity * 0.95, 0.0, 0.95);
      float wakeFoam = smoothstep(edge - 0.05, edge + 0.05, lace);
      foam = max(foam, wakeFoam);
      foamThin = max(foamThin, smoothstep(edge - 0.2, edge, lace) * 0.55 * (1.0 - wakeFoam));
    }
    N = normalize(N + vec3(fx2.r - fx2.b, 0.0, fx2.g - fx2.a) * foam * 0.3 * microFade);
  }

  // --------------------------------------------------------------- lighting
  vec3 V = normalize(uCamPos - vWorldPos);
  float NoVraw = dot(N, V);
  if (NoVraw < 0.02) N = normalize(N + V * (0.02 - NoVraw));
  float NoV = max(dot(N, V), 1e-4);
  vec3 L = normalize(uSunDir);
  float NoL = dot(N, L);
  vec3 sunRad = uSunRadiance;

  // Light leaving the water body: sun and sky entering, scattered by the volume (a few percent,
  // blue-green), backlit crests glowing where the water is thin, bubbles brightening broken water.
  vec3 skyAmb = vSkyAmb;
  vec3 bodyR = uWaterScatter;
  // Sunlight through a thin crest reaches the eye filtered by a metre of water: red is gone, so the
  // glow is green-cyan (not the deep blue of the volume seen from above).
  float crest = clamp(0.5 + vWaveY / max(uHs, 0.05), 0.0, 1.5);
  float backlit = crest * pow(clamp(dot(L, -V), 0.0, 1.0), 4.0) * pow(clamp(0.5 - 0.5 * dot(L, N), 0.0, 1.0), 3.0);
  vec3 scatter = vec3(0.012, 0.095, 0.08) * sunRad * backlit;
  float sunUp = max(L.y, 0.0);
  vec3 beam = sunRad * sunUp * (1.0 - oFresnelWater(max(sunUp, 1e-3), 0.0)) / 3.14159265;
  vec3 bodyLight = bodyR * (beam + skyAmb * 0.94);
  scatter += bodyLight;
  // Light entering the thin upper part of a wave and leaving through a face turned toward the eye: the
  // translucent cyan-green of wave faces, at any sun angle (the troughs stay deep blue). Weighted by
  // the transmission (1 − F) through the mix with the reflection below.
  float thin = smoothstep(0.05, 0.95, vWaveY / max(uHs * 0.5, 0.05));
  vec2 eyeDir = V.xz / max(length(V.xz), 1e-4);
  float towardEye = smoothstep(0.03, 0.25, dot(N.xz, eyeDir));
  scatter += vec3(0.006, 0.042, 0.052) * (beam + skyAmb) * thin * towardEye;
  // Entrained bubbles under the surface scatter strongly: aerated water (a breaking crest, the churn
  // behind a transom) turns light turquoise before any white foam shows on top.
  scatter += vec3(0.30, 0.78, 0.82) * 0.16 * clamp(bubbles, 0.0, 1.0) * (beam + skyAmb);
  vec3 refracted = scatter + uWaterAbsorb * skyAmb * 0.8;

  // Masking on a rough surface seen at grazing angles favours facets tilted toward the eye, whose
  // mirror directions point higher into the (darker) sky, and lowers the effective reflectance. That
  // is what makes a gust patch (cat's paw) read darker and matte, and a lull glassy and silvery.
  float gustUp = smoothstep(0.0, 0.4, gust), gustDown = smoothstep(0.0, 0.3, -gust);
  vec3 R = reflect(-V, N);
  R = normalize(R + vec3(0.0, mssUnres * (2.5 + 5.0 * gustUp) * (1.0 - NoV), 0.0));
  // A mirror direction below the horizon hits the back of the next wave: it sees sea, not sky — the
  // water's own colour plus the grazing (rough, so well below total) reflection of the low sky. These
  // darker facets are most of the contrast of the far sea.
  vec3 Rsky = normalize(vec3(R.x, max(R.y, 0.0) + 0.02, R.z));
  // How much sky one pixel of sea reflects. A mirror direction turns by twice the tilt of its facet, and the facets
  // that count are all the slopes of a wind-ruffled sea (Cox–Munk: about ±11° in 12 knots), not only those this
  // pixel cannot resolve: the cascades and ripple maps carry part of that variance at best. So the sky is never
  // mirrored as a shape — a bright cloud lightens a stretch of water — except in a calm, where the slopes vanish and
  // the reflection sharpens. (The sun's glitter below keeps the narrow lobe of the unresolved slopes.)
  float skySpread = 2.0 * max(alpha, 0.6 * sqrt(coxMunk(localWind)));
  vec3 env = skyReflection(Rsky, skySpread);
  float below = smoothstep(0.0, -0.06, R.y);
  env = mix(env, bodyLight + uWaterAbsorb * skyAmb * 0.8 + 0.35 * env, below);
  if (uReflectionOn > 0.5) {
    // Project the displaced surface point itself through the mirror camera: objects near the water
    // (hull, a floating mark) then mirror about the local surface, not about mean sea level, so their
    // reflections stay attached as the waves lift them. (A lookAt camera cannot flip handedness, so the
    // mirrored image is not a screen-space copy.) The surface's tilt away from flat breaks it up.
    vec4 rc = uReflectionMatrix * vec4(vWorldPos, 1.0);
    vec2 ruv = rc.xy / max(rc.w, 1e-4) * 0.5 + 0.5;
    vec2 tilt = (mat3(viewMatrix) * (N - vec3(0.0, 1.0, 0.0))).xy;
    vec4 mirrored = texture(uReflection, ruv + tilt * 0.11);
    float hold = 1.0 - smoothstep(0.3, 0.62, roughness);
    env = env * (1.0 - mirrored.a * hold) + mirrored.rgb * hold;
  }
  // Facets too small to resolve are seen tilted toward the eye (the ones facing away are hidden), so
  // at grazing views the effective incidence is steeper than the mean surface's: Fresnel of a rough
  // sea tops out near 0.35–0.4 (the sky dome's distant sea uses the same cap).
  float NoVfacets = max(NoV, sqrt(mssUnres));
  float F = oFresnelWater(NoVfacets, roughness) * (1.0 - 0.38 * gustUp) * (1.0 + 0.2 * gustDown);

  vec3 spec = vec3(0.0);
  if (NoL > 0.0) {
    vec3 H = normalize(L + V);
    float NoH = max(dot(N, H), 0.0);
    float VoH = max(dot(V, H), 1e-4);
    // Widen the lobe by the sun's angular radius so calm water shows a disc, not a pin-prick.
    float aP = clamp(alpha + 0.0047, 0.0, 1.0);
    float D = oGgxD(NoH, aP) * (alpha * alpha) / (aP * aP);
    float Vis = oSmithGgxCorrelated(NoV, max(NoL, 1e-4), alpha);
    float Fs = 0.02 + 0.98 * pow(clamp(1.0 - VoH, 0.0, 1.0), 5.0);
    spec = sunRad * D * Vis * Fs * NoL;
  }

  vec3 color = mix(refracted, env, clamp(F, 0.0, 1.0)) + spec * (1.0 - 0.3 * gustUp);

  // ------------------------------------------------------------------ foam lit
  if (foam > 0.002 || foamThin > 0.002) {
    vec3 foamAlbedo = vec3(0.93, 0.96, 0.985) * mix(0.5, 1.0, foamFine);
    float wrapNoL = clamp((dot(N, L) + 0.45) / 1.45, 0.0, 1.0);
    vec3 foamLit = foamAlbedo * (sunRad * wrapNoL * 0.30 + skyAmb * 0.95);
    foamLit += foamAlbedo * sunRad * pow(clamp(dot(V, -L), 0.0, 1.0), 3.0) * 0.10 * foamFine;
    color = mix(color, foamLit, foam);
    // The bubble slick trailing a breaker is translucent: it lifts the water, it is not paint.
    color = mix(color, mix(color, foamLit, 0.2), foamThin * (1.0 - foam));
  }

  // ------------------------------------------------------------------- haze
  float fog = 1.0 - exp(-(uFogDensity * vDist) * (uFogDensity * vDist));
  color = mix(color, vHaze, clamp(fog, 0.0, 1.0) * uHazeMax);

  // ------------------------------------------------------------------ x-ray
  // Round the boat the water turns see-through, showing the hull's bottom, keel and rudder against a clear backdrop:
  // a window wide enough for the leeway picture ahead of and astern of the keel. It is a teaching view, so it stays
  // see-through at grazing angles (the chase camera) and under the wake's foam, and it has a faint bright edge — a
  // window cut in the water, not a calm patch.
  // A convex blend (not premultiplied) so it also behaves when a renderer tone-maps per draw.
  float xr = 0.0;
  if (uHullState.z > 0.001) {
    float d = length(boatLocal / vec2(11.0, 6.0));
    xr = uHullState.z * (1.0 - smoothstep(0.62, 1.0, d));
    float edge = smoothstep(0.9, 0.96, d) * (1.0 - smoothstep(0.96, 1.02, d));
    color += uHullState.z * edge * 0.2 * (vSkyAmb + beam) * vec3(0.45, 1.3, 1.5);
  }
  float T = xr * 0.94 * (1.0 - 0.7 * foam) * (1.0 - 0.3 * F);
  gl_FragColor = vec4(color, 1.0 - T);
  if (uDebugMode > 0.5) {
    int m = int(uDebugMode + 0.5);
    vec3 dbg = m == 1 ? wake.rgb : m == 2 ? vec3(foam, foamThin, rawFoam) : m == 3 ? N * 0.5 + 0.5
      : m == 4 ? vec3(roughness) : m == 5 ? vec3(max(gust, 0.0), max(-gust, 0.0), 0.0)
      : m == 6 ? vec3(F) : vec3(kelvinFoam, 0.5 + kelvinSlope * 2.0);
    gl_FragColor = vec4(dbg, 1.0);
  }
  if (insideCutout) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
