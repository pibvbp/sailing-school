// Near-field wave system of the moving hull: the water heaped at the stem, the bow-wave crest running
// aft and outward along the forward topsides, the trough amidships and the stern wave at the transom.
// Evaluated in boat-local metres (x forward, y starboard) in both the vertex shader (height) and the
// fragment shader (slope and breaking), so close-ups of the hull see the waves it makes. Further aft the
// Kelvin ribbon (wake.glsl.ts) carries the pattern on.
//
// Amplitudes scale with the stagnation head V²/2g; for a 6.4 m waterline at 5 kn (Fn ≈ 0.32) the bow
// crest stands ≈ 12 cm and breaks white at the stem, and near hull speed it grows toward 20 cm.

export const HULL_WAVE_GLSL = /* glsl */ `
uniform vec4 uHullWL;   // stem x, transom x, max-beam x, half beam at the waterline (boat-local m)

float hullHalfBeam(float x) {
  if (x >= uHullWL.z) { float u = (x - uHullWL.z) / (uHullWL.x - uHullWL.z); return uHullWL.w * pow(max(1.0 - u * u, 0.0), 0.7); }
  float u = (uHullWL.z - x) / (uHullWL.z - uHullWL.y);
  return uHullWL.w * (1.0 - 0.28 * u * u);
}

/** Distance from the waterline outline (0 on the hull side, the stem or the transom corner). */
float hullDistance(vec2 l) {
  if (l.x > uHullWL.x) return length(vec2(l.x - uHullWL.x, l.y));
  if (l.x < uHullWL.y) return length(vec2(uHullWL.y - l.x, max(abs(l.y) - uHullWL.w * 0.72, 0.0)));
  return max(abs(l.y) - hullHalfBeam(l.x), 0.0);
}

float hwSq(float x) { return x * x; }   // not pow(x, 2.0): undefined for x < 0 in GLSL ES

/** (height m, breaking 0..1) of the hull's own waves at boat-local point l for speed V (m/s). */
vec2 hullWave(vec2 l, float speed) {
  float amp = min(speed * speed / 19.62, 0.6) * 0.35;
  if (amp < 0.003 || dot(l, l) > 144.0) return vec2(0.0);
  float stem = uHullWL.x, transom = uHullWL.y;
  float lwl = stem - transom;
  float d = hullDistance(l);
  // Crests are swept aft as they spread away from the hull (about 35°) and decay with distance.
  float xb = stem - 0.08 * lwl - d * 1.45;
  float bow = exp(-hwSq((l.x - xb) / (0.07 * lwl + 0.12 * d))) * exp(-d / (0.35 * lwl));
  vec2 s = l - vec2(stem, 0.0);
  float heap = exp(-dot(s, s) / 0.3);
  float xm = stem - 0.5 * lwl - d * 1.2;
  float trough = exp(-hwSq((l.x - xm) / (0.17 * lwl))) * exp(-d / (0.3 * lwl));
  float xs = transom + 0.02 * lwl - d * 1.25;
  float sternWave = exp(-hwSq((l.x - xs) / (0.1 * lwl))) * exp(-d / (0.3 * lwl));
  float h = amp * (1.05 * bow + 0.7 * heap - 0.6 * trough + 0.65 * sternWave);
  // The crest spills where it is steepest: hard against the stem, thinning along the first metres of
  // topside (the shader breaks it into lace).
  float breaking = smoothstep(0.4, 1.0, bow + 0.9 * heap) * smoothstep(0.04, 0.12, amp) * (1.0 - smoothstep(0.15, 1.1, d));
  return vec2(h, breaking);
}

/**
 * Foam streaming aft along the topsides: what the bow wave spills, dragged along by the hull's boundary
 * layer, widest just aft of the bow wave and thinning toward the transom, plus the thin aerated rim
 * where waves slap the hull even at rest. Analytic, so it stays sharp in close-ups.
 */
float hullRimFoam(vec2 l, float speed) {
  float d = hullDistance(l);
  if (d > 0.8) return 0.0;
  float lwl = uHullWL.x - uHullWL.y;
  float along = clamp((uHullWL.x - l.x) / lwl, 0.0, 1.2);   // 0 stem … 1 transom
  float work = smoothstep(0.5, 3.5, speed);
  float width = 0.08 + work * (0.34 * smoothstep(0.02, 0.18, along) * (1.0 - 0.55 * along));
  float band = 1.0 - smoothstep(width * 0.35, width, d);
  return band * (0.18 + 0.42 * work) * (1.0 - smoothstep(1.0, 1.2, along));
}
`;
