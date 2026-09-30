// Height probe: renders the surface height and slope on two square grids (fine around the boat, coarse
// for distant marks) with exactly the displacement the surface vertex shader uses.
// Adapted from wave-riders `src/game/WaveField.js` (PROBE shader). Copyright (c) 2026 Davi
// (Token-Gremlin), MIT License — adapted for sailing-school: two grids in one target, mip level matched
// to the grid spacing (no aliasing of short waves), slope from the analytic derivative cascades.
import { OCEAN_SAMPLE_GLSL } from './oceanSample.glsl';

export const PROBE_FRAG = /* glsl */ `
${OCEAN_SAMPLE_GLSL}
uniform sampler2D uOceanDeriv0, uOceanDeriv1, uOceanDeriv2;
uniform float uCells;
uniform vec4 uFine;    // origin x, origin z, node spacing, footprint for LOD
uniform vec4 uCoarse;
layout(location = 0) out vec4 oOut;

vec2 slopeAt(vec2 q, vec3 lods) {
  vec4 d = textureLod(uOceanDeriv0, q / uOceanScales.x, lods.x) * uCascadeGain.x;
  if (lods.y < 7.5) d += textureLod(uOceanDeriv1, q / uOceanScales.y, lods.y) * uCascadeGain.y;
  if (uCascadeGain.z > 0.001 && lods.z < 7.5) d += textureLod(uOceanDeriv2, q / uOceanScales.z, lods.z) * uCascadeGain.z;
  return vec2(d.x / max(1.0 + d.z, 0.05), d.y / max(1.0 + d.w, 0.05));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int cells = int(uCells);
  bool coarse = p.x >= cells;
  vec4 g = coarse ? uCoarse : uFine;
  vec2 node = vec2(float(coarse ? p.x - cells : p.x), float(p.y));
  vec2 world = g.xy + node * g.z;
  vec3 lods = oceanLods(g.w);
  vec3 s = oceanSurfaceAt(world, lods);
  oOut = vec4(s.x, slopeAt(oceanWarp(s.yz), lods), 1.0);
}
`;
