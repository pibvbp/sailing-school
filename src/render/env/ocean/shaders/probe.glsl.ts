// Height probe: renders the surface height and slope with exactly the displacement the surface vertex
// shader uses, on three blocks of one target:
//   rows [0, cells): fine grid around the boat (columns [0, cells)) and coarse grid ([cells, 2·cells)),
//     FFT sea only — the boat's own heave must not include the waves it makes itself;
//   rows [cells, cells + 5): a 5 × 5 stencil per registered point (marks, camera), at the level of
//     detail the drawn mesh uses there, plus the boat's Kelvin and near-field waves and the camera-
//     relative earth curvature — everything the vertex shader adds, so marks ride the drawn water.
// Adapted from wave-riders `src/game/WaveField.js` (PROBE shader). Copyright (c) 2026 Davi
// (Token-Gremlin), MIT License — adapted for sailing-school: several blocks in one target, mip level
// matched to the sample spacing (no aliasing), slope from the analytic derivative cascades.
import { HULL_WAVE_GLSL } from './hullWave.glsl';
import { OCEAN_SAMPLE_GLSL } from './oceanSample.glsl';

/** Registered points probed per readback (one 5-column stencil each within the 128-wide target). */
export const MAX_PROBE_POINTS = 24;
/** Stencil: 5 × 5 nodes, 0.6 m apart — the marks' slope span, so their ±0.6 m queries hit nodes. */
export const STENCIL_NODES = 5;
export const STENCIL_SPACING = 0.6;

export const PROBE_FRAG = /* glsl */ `
#define MAX_POINTS ${MAX_PROBE_POINTS}
#define STENCIL ${STENCIL_NODES}
${OCEAN_SAMPLE_GLSL}
uniform sampler2D uOceanDeriv0, uOceanDeriv1, uOceanDeriv2;
uniform float uCells;
uniform vec4 uFine;    // origin x, origin z, node spacing, footprint for LOD
uniform vec4 uCoarse;
uniform vec4 uPoints[MAX_POINTS];   // centre x, centre z, mesh footprint (m), active
uniform sampler2D uKelvinTex;
uniform vec4 uWakeRect;             // origin x, origin z, 1 / size, enabled
uniform vec4 uBoat;                 // world x, z, forward x, forward z
uniform vec4 uHullState;            // enabled, heel, x-ray, speed
uniform vec3 uCamPos;
uniform float uEarthCurvature;
${HULL_WAVE_GLSL}
layout(location = 0) out vec4 oOut;

vec2 slopeAt(vec2 q, vec3 lods) {
  vec4 d = textureLod(uOceanDeriv0, q / uOceanScales.x, lods.x) * uCascadeGain.x;
  if (lods.y < 7.5) d += textureLod(uOceanDeriv1, q / uOceanScales.y, lods.y) * uCascadeGain.y;
  if (uCascadeGain.z > 0.001 && lods.z < 7.5) d += textureLod(uOceanDeriv2, q / uOceanScales.z, lods.z) * uCascadeGain.z;
  return vec2(d.x / max(1.0 + d.z, 0.05), d.y / max(1.0 + d.w, 0.05));
}

/** The boat's own waves at world point w, as the surface vertex shader adds them. */
float boatWaves(vec2 w) {
  float h = 0.0;
  if (uWakeRect.w > 0.5) {
    vec2 uv = (w - uWakeRect.xy) * uWakeRect.z;
    if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) h += textureLod(uKelvinTex, uv, 0.0).g;
  }
  if (uHullState.x > 0.5) {
    vec2 rel = w - uBoat.xy;
    h += hullWave(vec2(dot(rel, uBoat.zw), dot(rel, vec2(-uBoat.w, uBoat.z))), uHullState.w).x;
  }
  return h;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int cells = int(uCells);
  if (p.y >= cells) {
    int k = p.x / STENCIL;
    if (k >= MAX_POINTS) { oOut = vec4(0.0); return; }
    vec4 pt = uPoints[k];
    if (pt.w < 0.5) { oOut = vec4(0.0); return; }
    vec2 node = vec2(float(p.x - k * STENCIL), float(p.y - cells)) - float(STENCIL - 1) * 0.5;
    vec2 world = pt.xy + node * ${STENCIL_SPACING.toFixed(2)};
    vec3 lods = oceanLods(pt.z);
    vec3 s = oceanSurfaceAt(world, lods);
    vec2 slope = slopeAt(oceanWarp(s.yz), lods);
    // The vertex shader adds the boat's waves and the curvature drop at the undisplaced point x0 = s.yz.
    float e = 0.1;
    float b0 = boatWaves(s.yz);
    slope += vec2(boatWaves(s.yz + vec2(e, 0.0)) - b0, boatWaves(s.yz + vec2(0.0, e)) - b0) / e;
    vec2 rel = s.yz - uCamPos.xz;
    float drop = uEarthCurvature * dot(rel, rel) / (2.0 * 6371000.0);
    oOut = vec4(s.x + b0 - drop, slope, 1.0);
    return;
  }
  bool coarse = p.x >= cells;
  vec4 g = coarse ? uCoarse : uFine;
  vec2 node = vec2(float(coarse ? p.x - cells : p.x), float(p.y));
  vec2 world = g.xy + node * g.z;
  vec3 lods = oceanLods(g.w);
  vec3 s = oceanSurfaceAt(world, lods);
  oOut = vec4(s.x, slopeAt(oceanWarp(s.yz), lods), 1.0);
}
`;
