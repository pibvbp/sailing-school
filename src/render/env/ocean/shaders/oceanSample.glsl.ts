// Cascade sampling shared by the surface vertex shader and the height probe, so the boat rides exactly
// the surface that is drawn. Adapted from ABYSSAL `src/ocean/OceanSampleGLSL.js` (cascade fetching with
// explicit LOD, lookup-coordinate warp) and wave-riders `surfaceHeightAt` (inverse of the horizontal
// displacement). Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school:
// disaster fields removed; the warp is a smooth static field (no drift, no normalisation seams).

export const OCEAN_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uOceanDisp0, uOceanDisp1, uOceanDisp2;
uniform vec3 uOceanScales;
uniform float uOceanTexels;
uniform vec3 uCascadeGain;
uniform sampler2D uNoiseTex;
uniform float uWarpStrength;

/**
 * Offsets the cascade lookups by a smooth static field (≈ 1 km features, ±uWarpStrength m). Adjacent
 * 250 m tiles are then shifted by different amounts, so the lattice never lines up into a visible
 * repeat, while wave shapes are stretched by only a few percent.
 */
vec2 oceanWarp(vec2 p) {
  vec2 n = textureLod(uNoiseTex, p * 0.00025, 0.0).xy;
  return p + (n - 0.5) * 2.0 * uWarpStrength;
}

/** Mip level per cascade for a sample footprint of \`cell\` metres. */
vec3 oceanLods(float cell) {
  return log2(max(vec3(cell) / (uOceanScales / uOceanTexels), vec3(1.0)));
}

/** Sum of the cascades' (x, y, z) displacement at warped coordinates q. */
vec3 oceanDisplacement(vec2 q, vec3 lods) {
  vec3 d = textureLod(uOceanDisp0, q / uOceanScales.x, lods.x).xyz * uCascadeGain.x;
  if (lods.y < 7.5) d += textureLod(uOceanDisp1, q / uOceanScales.y, lods.y).xyz * uCascadeGain.y;
  if (uCascadeGain.z > 0.001 && lods.z < 7.5) d += textureLod(uOceanDisp2, q / uOceanScales.z, lods.z).xyz * uCascadeGain.z;
  return d;
}

/**
 * Height of the displaced surface above world point p: find the undisplaced point x0 with
 * x0 + D(x0) = p by fixed-point iteration (converges while the sea is not folding), then read D.y.
 * Returns (height, x0.x, x0.y).
 */
vec3 oceanSurfaceAt(vec2 p, vec3 lods) {
  vec2 x0 = p;
  vec3 d = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    d = oceanDisplacement(oceanWarp(x0), lods);
    x0 = p - d.xz;
  }
  d = oceanDisplacement(oceanWarp(x0), lods);
  return vec3(d.y, x0);
}
`;
