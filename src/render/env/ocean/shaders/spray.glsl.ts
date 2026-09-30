// Bow spray sprites. Droplets are a forward-scattering mist: lit by the sky, bright with the sun behind
// them. Adapted from wave-riders `src/game/Wake.js` (SPRAY_VERT/SPRAY_FRAG). Copyright (c) 2026 Davi
// (Token-Gremlin), MIT License — adapted for sailing-school (our sky light, three.js tone mapping).

export const SPRAY_VERT = /* glsl */ `
attribute vec4 aData;       // size (m), age 0…1, seed, 0
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform sampler2D uSkyLight;
uniform float uPixelScale;  // projection[1][1] · viewport height / 2
varying vec4 vData;
varying vec3 vColor;
void main() {
  vData = aData;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.3);
  float size = aData.x * (1.0 + aData.y * 1.4);
  float px = size * uPixelScale / dist;
  gl_PointSize = clamp(px, 1.5, 24.0);
  // Droplets smaller than a pixel still scatter light: fade them instead of drawing oversized dots.
  vData.w = clamp(px / 1.5, 0.15, 1.0);
  vec3 look = normalize(position - cameraPosition);
  vec3 sky = texture(uSkyLight, vec2(0.5, 0.75)).rgb;
  float mu = dot(look, normalize(uSunDir));
  float g = 0.65;
  float phase = (1.0 - g * g) / (4.0 * 3.14159265 * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vColor = sky * 1.1 + uSunRadiance * (0.12 + phase * 0.5);
  gl_Position = projectionMatrix * mv;
}
`;

export const SPRAY_FRAG = /* glsl */ `
varying vec4 vData;
varying vec3 vColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = length(q + 0.2 * vec2(sin(vData.z * 31.0), cos(vData.z * 17.0)));
  if (d > 1.0) discard;
  float age = vData.y;
  float fade = smoothstep(0.0, 0.06, age) * pow(clamp(1.0 - age, 0.0, 1.0), 1.2);
  float a = pow(1.0 - d * d, 1.2) * fade * 0.7 * vData.w;
  gl_FragColor = vec4(vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
