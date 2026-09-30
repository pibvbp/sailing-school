// Boat wake shaders. Two world-space targets share one window that scrolls with the boat:
//   trail (accumulating): r = churn / bow-wave foam, g = entrained bubbles, b = wake slick
//     (turbulence flattens the capillaries behind the hull; long-lived)
//   kelvin (redrawn every frame from a ribbon of past stern positions):
//     r = Kelvin-arm foam, g = Kelvin wave height (m)
// Kelvin ribbon adapted from wave-riders `src/game/Wake.js` (19.47° half-angle, rows laid along the
// stern's path, arms at the ribbon edges fading with age). Copyright (c) 2026 Davi (Token-Gremlin), MIT
// License — adapted for sailing-school: drawn into targets the ocean samples instead of floating over
// the sea (the foam rides the displaced surface exactly), plus transverse/divergent wave height.

export const WAKE_UPDATE_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform ivec2 uShift;
uniform float uRes;
uniform vec2 uOrigin;
uniform float uTexel;
uniform float uDt;
uniform vec4 uBoat;       // world x, z, forward x, forward z
uniform vec4 uMotion;     // speed m/s, heel rad, active, 0
uniform vec4 uHull;       // stem x, transom x, max-beam x, half beam at the waterline
layout(location = 0) out vec4 oOut;

vec4 prevAt(ivec2 q) {
  if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, ivec2(int(uRes))))) return vec4(0.0);
  return texelFetch(uPrev, q, 0);
}

float halfBeam(float x) {
  if (x > uHull.x || x < uHull.y) return -1.0;
  if (x >= uHull.z) { float u = (x - uHull.z) / (uHull.x - uHull.z); return uHull.w * pow(max(1.0 - u * u, 0.0), 0.7); }
  float u = (uHull.z - x) / (uHull.z - uHull.y);
  return uHull.w * (1.0 - 0.28 * u * u);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 src = p + uShift;
  vec4 c = prevAt(src);
  // The turbulent wake spreads slowly sideways.
  vec4 nb = (prevAt(src + ivec2(1, 0)) + prevAt(src - ivec2(1, 0)) + prevAt(src + ivec2(0, 1)) + prevAt(src - ivec2(0, 1))) * 0.25;
  vec4 v = mix(c, nb, clamp(uDt * 0.7, 0.0, 0.25));
  float foam = v.r * exp(-uDt / 2.4);
  float bubbles = v.g * exp(-uDt / 9.0);
  float slick = v.b * exp(-uDt / 60.0);

  if (uMotion.z > 0.5) {
    vec2 world = uOrigin + (vec2(p) + 0.5) * uTexel;
    vec2 rel = world - uBoat.xy;
    vec2 fwd = uBoat.zw;
    vec2 l = vec2(dot(rel, fwd), dot(rel, vec2(-fwd.y, fwd.x)));
    float speed = uMotion.x;
    float work = smoothstep(0.5, 4.0, speed);
    float hb = halfBeam(l.x);
    float outside = hb >= 0.0 ? abs(l.y) - hb : 1e3;
    // Bow wave: water heaped against the stem breaks along the first metre or two of topside.
    float forward = smoothstep(uHull.x - 2.6, uHull.x - 0.3, l.x);
    float stem = smoothstep(uHull.x - 1.4, uHull.x - 0.1, l.x);
    float bow = (forward + stem * 1.5) * step(-0.1, outside) * (1.0 - smoothstep(0.0, 0.14 + 0.4 * work, outside));
    // Stern: the flow closing in behind the transom entrains air.
    float behind = uHull.y - l.x;
    float transomHalf = uHull.w * 0.72;
    float across = 1.0 - smoothstep(transomHalf * 0.4, transomHalf * 1.05, abs(l.y));
    float stern = step(0.0, behind) * (1.0 - smoothstep(0.3, 2.5, behind)) * across;
    // Aerated rim where waves slap the topsides, even at rest.
    float wet = step(-0.1, outside) * (1.0 - smoothstep(0.0, 0.14, outside));
    foam += ((bow * 1.4 + stern * 0.95) * work * work + wet * (0.12 + 0.35 * work)) * uDt * 2.2;
    bubbles += (stern * work + bow * 0.4 * work) * uDt * 0.9;
    slick += (stern * work + wet * 0.15) * uDt * 1.6;
  }
  oOut = vec4(clamp(foam, 0.0, 1.2), clamp(bubbles, 0.0, 1.0), clamp(slick, 0.0, 1.0), 0.0);
}
`;

export const WAKE_RIBBON_VERT = /* glsl */ `
precision highp float;
in vec3 position;     // world x, 0, world z
in vec4 aData;        // across −1…1, age (s), strength 0…1, distance behind the bow (m)
uniform vec2 uOrigin;
uniform float uSize;
out vec4 vData;
void main() {
  vData = aData;
  vec2 uv = (position.xz - uOrigin) / uSize;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const WAKE_RIBBON_FRAG = /* glsl */ `
precision highp float;
uniform float uSpeed;       // m/s
uniform float uLwl;         // waterline length (m)
uniform float uKelvin;      // tan(19.47°)
uniform float uFoamLife;    // seconds the arms keep their foam
in vec4 vData;
layout(location = 0) out vec4 oOut;
void main() {
  float u = abs(vData.x);
  float age = vData.y;
  float strength = vData.z;
  float fromBow = vData.w;
  float half_ = max(fromBow * uKelvin, 0.2);
  // Transverse waves follow the boat at its own speed: wavelength 2πV²/g, first crest at the bow.
  float lambdaT = max(6.2832 * uSpeed * uSpeed / 9.81, 0.5);
  float decayT = inversesqrt(1.0 + fromBow / uLwl);
  float decayD = pow(1.0 + fromBow / uLwl, -0.33);
  float amp = 0.08 * smoothstep(0.6, 2.4, uSpeed) * min(uSpeed * uSpeed / 6.6, 1.6);
  float inner = 1.0 - smoothstep(0.5, 0.92, u);
  float transverse = cos(6.2832 * fromBow / lambdaT) * inner * decayT;
  // Divergent waves pile up into the cusp line at the wedge edge, with short oblique crests.
  float c = (u - 0.84) / 0.16;
  float cusp = exp(-c * c);
  float divergent = cos(6.2832 * (fromBow + u * half_ * 1.3) / (0.62 * lambdaT)) * cusp * decayD * 1.6;
  float fade = 1.0 - smoothstep(0.75, 1.0, age / 14.0);
  float height = amp * (transverse * 0.7 + divergent) * fade;
  // Breaking at the cusps only once the boat is really pushing (hull speed ≈ 6 kn for a 25-footer).
  float arms = smoothstep(0.62, 0.8, u) * (1.0 - smoothstep(0.9, 1.0, u)) * pow(max(1.0 - age / uFoamLife, 0.0), 2.0);
  oOut = vec4(arms * strength, height, 0.0, 0.0);
}
`;
