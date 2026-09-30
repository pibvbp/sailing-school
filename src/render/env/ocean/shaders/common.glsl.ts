// Shared GLSL for the ocean: tileable noise and the water BRDF pieces.
// Adapted from ABYSSAL `src/gfx/NoiseGLSL.js` and `src/gfx/ShadingGLSL.js`.
// Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school (subset, renamed
// to avoid clashing with three.js shader chunks).

export const NOISE_GLSL = /* glsl */ `
float oHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 oHash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float oValueNoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = oHash12(i), b = oHash12(i + vec2(1.0, 0.0)), c = oHash12(i + vec2(0.0, 1.0)), d = oHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float oValueNoiseTiled(vec2 x, float period) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = oHash12(mod(i, period)), b = oHash12(mod(i + vec2(1.0, 0.0), period));
  float c = oHash12(mod(i + vec2(0.0, 1.0), period)), d = oHash12(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float oFbmTiled(vec2 p, float period, int octaves) {
  float f = 0.0, amp = 0.5, per = period;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    f += amp * oValueNoiseTiled(p * per, per);
    per *= 2.0; amp *= 0.5;
  }
  return f;
}
float oWorleyTiled(vec2 p, float cells) {
  p *= cells;
  vec2 i = floor(p), f = fract(p);
  float best = 1e9;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 pt = o + oHash22(mod(i + o, vec2(cells)));
    best = min(best, dot(pt - f, pt - f));
  }
  return clamp(sqrt(best), 0.0, 1.0);
}
`;

export const BRDF_GLSL = /* glsl */ `
float oGgxD(float NoH, float a) {
  float a2 = a * a;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(3.14159265 * d * d, 1e-8);
}
float oSmithGgxCorrelated(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-6);
}
/** Schlick with F0 = 0.02 (water); a rough surface loses the sharp grazing peak. */
float oFresnelWater(float NoV, float roughness) {
  float f = 0.02 + 0.98 * pow(clamp(1.0 - NoV, 0.0, 1.0), 5.0);
  return mix(f, clamp(f * 0.72 + 0.06, 0.0, 1.0), clamp(roughness * 1.5, 0.0, 1.0));
}
float oLuminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;
