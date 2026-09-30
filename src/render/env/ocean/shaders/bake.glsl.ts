// One-off procedural texture bakes for the ocean (no image assets are loaded).
// Adapted from ABYSSAL `src/gfx/ProceduralTextures.js` (foam rafts, micro-ripple normals, curl field).
// Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school.
import { NOISE_GLSL } from './common.glsl';

/** r = bubble-raft clusters, g = fine bubbles, b = fbm detail, a = dissolve mask with streaks. */
export const FOAM_BAKE = /* glsl */ `
${NOISE_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 oCol;
void main() {
  vec2 p = vUv;
  float w1 = 1.0 - oWorleyTiled(p, 6.0);
  float w2 = 1.0 - oWorleyTiled(p, 14.0);
  float w3 = 1.0 - oWorleyTiled(p, 32.0);
  float w4 = 1.0 - oWorleyTiled(p, 72.0);
  float clusters = pow(clamp(w1 * 0.55 + w2 * 0.3 + w3 * 0.18, 0.0, 1.0), 1.35);
  float bubbles = smoothstep(0.32, 0.92, clamp(w3 * 0.5 + w4 * 0.7, 0.0, 1.0));
  float fbm = oFbmTiled(p, 4.0, 6);
  float streak = oFbmTiled(vec2(p.x, p.y), 4.0, 5);
  float dissolve = clamp(fbm * 0.6 + w2 * 0.4, 0.0, 1.0);
  oCol = vec4(clusters, bubbles, clamp(fbm * 1.15, 0.0, 1.0), dissolve * 0.75 + streak * 0.25);
}
`;

/** Rounded capillary wavelets as a tangent-space normal (xyz) + height (w). */
export const RIPPLE_BAKE = /* glsl */ `
${NOISE_GLSL}
uniform float uRes;
uniform float uSlope;
in vec2 vUv;
layout(location = 0) out vec4 oCol;
float h(vec2 p) {
  float a = oFbmTiled(p, 6.0, 5);
  float b = oFbmTiled(p + vec2(0.371, 0.129), 13.0, 4);
  float c = smoothstep(0.10, 0.95, 1.0 - oWorleyTiled(p, 30.0));
  return a * 0.56 + b * 0.30 + c * 0.14;
}
void main() {
  float e = 1.0 / uRes;
  float gx = (h(vUv + vec2(e, 0.0)) - h(vUv - vec2(e, 0.0))) / (2.0 * e);
  float gy = (h(vUv + vec2(0.0, e)) - h(vUv - vec2(0.0, e))) / (2.0 * e);
  vec3 n = normalize(vec3(-gx * uSlope, 1.0, -gy * uSlope));
  oCol = vec4(n * 0.5 + 0.5, h(vUv));
}
`;

/**
 * Large-scale noise. rg = two smooth, low-gradient fields (2 octaves) for the anti-tiling warp;
 * b = detailed fbm for ragged gust-patch edges; a = medium fbm for foam/streak modulation.
 */
export const NOISE_BAKE = /* glsl */ `
${NOISE_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 oCol;
void main() {
  oCol = vec4(
    oFbmTiled(vUv, 4.0, 2),
    oFbmTiled(vUv + vec2(0.37, 0.61), 4.0, 2),
    oFbmTiled(vUv, 8.0, 5),
    oFbmTiled(vUv + vec2(0.19, 0.83), 3.0, 4));
}
`;
