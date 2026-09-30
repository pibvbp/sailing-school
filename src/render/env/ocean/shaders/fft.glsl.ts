// GPU FFT shaders for the ocean cascades.
// Adapted from ABYSSAL `src/ocean/OceanFFT.js` (Tessendorf / JONSWAP spectrum, Cooley–Tukey butterfly
// IFFT, Jacobian + steepness foam accumulation).
// Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school: all cascades are
// packed side by side in one (C·N)×N buffer so every butterfly stage is a single pass for all of them,
// each cascade has its own random field, the spectrum normalisation reproduces the analytic Hs, and the
// spreading is always centred on the wind.
//
// Conventions: texel (i, j) of a cascade ↔ wavenumber k = ((i, j) − N/2)·2π/L in world (x, z). The
// inverse transform is h(x) = Σ h̃(k) e^{+ik·x} with h̃(k, t) = h0(k) e^{iωt} + conj(h0(−k)) e^{−iωt},
// so spectral energy centred on direction k̂ produces waves travelling toward −k̂: the spectrum is
// centred on the direction the wind comes FROM.

const COMMON = /* glsl */ `
const float PI = 3.14159265358979;
const float G = 9.81;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
float pick3(vec3 v, int c) { return c == 0 ? v.x : (c == 1 ? v.y : v.z); }
`;

/** h0(k) for every cascade. Re-run only when the sea state changes. */
export const SPECTRUM_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uNoise;
uniform float uN;
uniform vec3 uLength;
uniform vec3 uCutLow;
uniform vec3 uCutHigh;
// a: amplitude scale (0 = off), centre angle, swell narrowing 0..1, short-wave fade length (m)
// b: alpha, peak omega, gamma
uniform vec4 uWindA, uWindB, uSwellA, uSwellB;
layout(location = 0) out vec4 oH0;

float jonswap(float omega, vec4 b) {
  float sigma = omega <= b.y ? 0.07 : 0.09;
  float d = omega - b.y;
  float r = exp(-d * d / (2.0 * sigma * sigma * b.y * b.y));
  float inv = 1.0 / max(omega, 1e-5);
  float inv2 = inv * inv;
  return b.x * G * G * inv2 * inv2 * inv * exp(-1.25 * pow(b.y * inv, 4.0)) * pow(b.z, r);
}
float cos2sNorm(float s) {
  float s2 = s * s, s3 = s2 * s, s4 = s3 * s;
  if (s < 5.0) return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163;
  return -4.8e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 5.9e-2 * s + 3.93e-1;
}
float spreadPower(float omega, float peak, float swell) {
  float r = max(omega / peak, 1e-5);
  float s = r > 1.0 ? 9.77 * pow(r, -2.5) : 6.97 * pow(r, 5.0);
  return s + 16.0 * tanh(min(r, 20.0)) * swell * swell;
}
float density(vec2 k, float kLen, vec4 a, vec4 b) {
  if (a.x <= 0.0 || b.x <= 0.0) return 0.0;
  float omega = sqrt(G * kLen);
  float dOmegaDk = G / (2.0 * omega);
  float s = spreadPower(omega, b.y, a.z);
  float theta = atan(k.y, k.x) - a.y;
  float spread = cos2sNorm(s) * pow(max(abs(cos(0.5 * theta)), 1e-5), 2.0 * s);
  float fade = exp(-(a.w * kLen) * (a.w * kLen));
  return a.x * jonswap(omega, b) * spread * fade * dOmegaDk / kLen;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = int(uN);
  int c = p.x / n;
  vec2 local = vec2(float(p.x - c * n), float(p.y));
  float dk = 2.0 * PI / pick3(uLength, c);
  vec2 k = (local - uN * 0.5) * dk;
  float kLen = length(k);
  vec2 h0 = vec2(0.0);
  if (kLen >= pick3(uCutLow, c) && kLen < pick3(uCutHigh, c) && kLen > 1e-6) {
    float S = density(k, kLen, uWindA, uWindB) + density(k, kLen, uSwellA, uSwellB);
    // E|h0|² = S·dk²/2 so that Σ|h̃|² over all modes equals ∫S dk (the variance m0).
    h0 = texelFetch(uNoise, p, 0).xy * 0.5 * sqrt(max(S, 0.0)) * dk;
  }
  oH0 = vec4(h0, 0.0, 0.0);
}
`;

/** Packs (h0(k), conj(h0(−k))) so the per-frame pass needs one fetch. */
export const CONJUGATE_FRAG = /* glsl */ `
uniform sampler2D uH0;
uniform float uN;
layout(location = 0) out vec4 oH0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = int(uN);
  int c = p.x / n;
  ivec2 local = ivec2(p.x - c * n, p.y);
  ivec2 mirror = ivec2(c * n + (n - local.x) % n, (n - local.y) % n);
  vec2 hk = texelFetch(uH0, p, 0).xy;
  vec2 hmk = texelFetch(uH0, mirror, 0).xy;
  oH0 = vec4(hk, hmk.x, -hmk.y);
}
`;

/**
 * h̃(k, t) and the seven derived fields, packed pairwise as f + i·g (valid because each field's
 * spectrum is Hermitian):  0.rg = Dx + i·Dz, 0.ba = Dy + i·∂Dy/∂x, 1.rg = ∂Dy/∂z + i·∂Dx/∂x,
 * 1.ba = ∂Dz/∂z + i·∂Dx/∂z.  D = +i·k̂·h gives Gerstner-like crest sharpening for λ > 0.
 */
export const TIME_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uH0;
uniform float uN;
uniform vec3 uLength;
uniform float uTime;
layout(location = 0) out vec4 oBuf0;
layout(location = 1) out vec4 oBuf1;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = int(uN);
  int c = p.x / n;
  vec2 local = vec2(float(p.x - c * n), float(p.y));
  vec4 h0 = texelFetch(uH0, p, 0);
  float dk = 2.0 * PI / pick3(uLength, c);
  vec2 k = (local - uN * 0.5) * dk;
  float kLen = max(length(k), 1e-5);
  vec2 kn = k / kLen;
  float phase = sqrt(G * kLen) * uTime;
  vec2 e = vec2(cos(phase), sin(phase));
  vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
  vec2 ih = vec2(-h.y, h.x);
  vec2 dx = ih * kn.x;
  vec2 dz = ih * kn.y;
  vec2 dyDx = ih * k.x;
  vec2 dyDz = ih * k.y;
  vec2 dxDx = -h * k.x * kn.x;
  vec2 dzDz = -h * k.y * kn.y;
  vec2 dxDz = -h * k.y * kn.x;
  oBuf0 = vec4(dx.x - dz.y, dx.y + dz.x, h.x - dyDx.y, h.y + dyDx.x);
  oBuf1 = vec4(dyDz.x - dxDx.y, dyDz.y + dxDx.x, dzDz.x - dxDz.y, dzDz.y + dxDz.x);
}
`;

/** One radix-2 stage of the inverse FFT along rows (uVertical = 0) or columns (1), all cascades at once. */
export const BUTTERFLY_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uButterfly;
uniform sampler2D uSrc0;
uniform sampler2D uSrc1;
uniform float uN;
uniform int uStage;
uniform int uVertical;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = int(uN);
  int c = p.x / n;
  int idx = uVertical == 1 ? p.y : p.x - c * n;
  vec4 bf = texelFetch(uButterfly, ivec2(uStage, idx), 0);
  ivec2 a = uVertical == 1 ? ivec2(p.x, int(bf.z)) : ivec2(c * n + int(bf.z), p.y);
  ivec2 b = uVertical == 1 ? ivec2(p.x, int(bf.w)) : ivec2(c * n + int(bf.w), p.y);
  vec4 pa = texelFetch(uSrc0, a, 0), pb = texelFetch(uSrc0, b, 0);
  o0 = vec4(pa.rg + cmul(bf.xy, pb.rg), pa.ba + cmul(bf.xy, pb.ba));
  vec4 qa = texelFetch(uSrc1, a, 0), qb = texelFetch(uSrc1, b, 0);
  o1 = vec4(qa.rg + cmul(bf.xy, qb.rg), qa.ba + cmul(bf.xy, qb.ba));
}
`;

/**
 * Unpacks one cascade into displacement / derivatives and integrates its foam.
 *  disp  = (λDx, Dy, λDz, Jacobian)      deriv = (∂Dy/∂x, ∂Dy/∂z, λ∂Dx/∂x, λ∂Dz/∂z)
 *  turb  = (foam coverage, sub-surface bubbles, instantaneous breaking, 0)
 */
export const ASSEMBLE_FRAG = /* glsl */ `
uniform sampler2D uBuf0;
uniform sampler2D uBuf1;
uniform sampler2D uPrevTurb;
uniform int uOffset;
uniform float uLambda;
uniform float uFoamBias;
// Steepness threshold in units of this cascade's RMS slope; elevation/slope normalisers of the band.
uniform float uSteepBias;
uniform float uInvSigma;
uniform float uInvSlopeSigma;
uniform vec2 uUpwind;
uniform float uFoamMul;
uniform float uFoamDecay;
uniform float uBubbleDecay;
uniform float uDt;
layout(location = 0) out vec4 oDisp;
layout(location = 1) out vec4 oDeriv;
layout(location = 2) out vec4 oTurb;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 src = ivec2(p.x + uOffset, p.y);
  // Undo the centred-spectrum shift: e^{ik·x} with k offset by N/2 multiplies texel x by (−1)^x.
  float perm = ((p.x + p.y) % 2 == 0) ? 1.0 : -1.0;
  vec4 b0 = texelFetch(uBuf0, src, 0) * perm;
  vec4 b1 = texelFetch(uBuf1, src, 0) * perm;
  float dx = b0.x, dz = b0.y, dy = b0.z, dyDx = b0.w;
  float dyDz = b1.x, dxDx = b1.y, dzDz = b1.z, dxDz = b1.w;
  float lx = uLambda * dxDx, lz = uLambda * dzDz, lxz = uLambda * dxDz;
  float jacobian = (1.0 + lx) * (1.0 + lz) - lxz * lxz;
  oDisp = vec4(uLambda * dx, dy, uLambda * dz, jacobian);
  oDeriv = vec4(dyDx, dyDz, lx, lz);

  // Breaking = folding (Jacobian → 0, plunging) or excess steepness (spilling), gated to the upper
  // part of the wave and to its leeward face where air is actually entrained. Foam integrates a
  // *rate* so only water that breaks repeatedly saturates (ABYSSAL).
  vec4 prev = texelFetch(uPrevTurb, p, 0);
  float fold = smoothstep(uFoamBias, uFoamBias - 0.30, jacobian);
  // Slope of the *displaced* surface: chop compresses crests (1 + λ∂Dx/∂x < 1), which is where waves
  // actually get steep enough to spill; the linear slope peaks at mid-face instead.
  vec2 grad = vec2(dyDx / max(1.0 + lx, 0.2), dyDz / max(1.0 + lz, 0.2));
  float slope = length(grad);
  float lee = 0.55 + 0.45 * clamp(dot(grad / max(slope, 1e-4), uUpwind), -1.0, 1.0);
  float above = smoothstep(0.2, 1.2, dy * uInvSigma);
  float steep = smoothstep(uSteepBias, uSteepBias + 0.5, slope * uInvSlopeSigma) * lee * above;
  float breaking = max(fold, steep);
  float foam = prev.r * exp(-uDt * uFoamDecay) + breaking * uFoamMul * uDt;
  foam = max(foam - uDt * 0.012, 0.0);
  float bubbles = prev.g * exp(-uDt * uBubbleDecay) + breaking * uFoamMul * uDt * 0.55;
  oTurb = vec4(clamp(foam, 0.0, 1.0), clamp(bubbles, 0.0, 1.0), breaking, 0.0);
}
`;
