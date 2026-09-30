// Public contract of the ocean module (plan Task 11). All angles are compass radians (clockwise from
// north) and positions are sim-world (east, north) metres; see spec §5 for the frames.

export interface OceanParams {
  /** Mean true wind speed at 10 m (m/s). Feed the mean, not the gusting value: the sea responds to minutes of wind. */
  windSpeed: number;
  /** Direction the wind blows FROM (rad, compass). */
  windFrom: number;
  /** Open-water fetch upwind (km); a sheltered sailing area is ≈ 15 km. */
  fetchKm: number;
  /** Significant height of the distant swell (m). */
  swellHeight: number;
  /** Direction the swell comes FROM (rad, compass). */
  swellFrom: number;
  /** Swell peak period (s). */
  swellPeriod: number;
  /** Horizontal (Tessendorf λ) displacement factor; 1 ≈ natural, higher sharpens crests. */
  choppiness: number;
}

/** A gust (+) or lull (−) patch as the ocean draws it (from the sim's `Puff`: strength × envelope). */
export interface PuffPatch {
  e: number;
  n: number;
  /** Semi-axis along the patch's wind direction (m). */
  radiusAlong: number;
  /** Semi-axis across the wind (m). */
  radiusAcross: number;
  /** Fractional wind-speed change at the centre (−0.3 … +0.45). */
  strength: number;
  /** Wind direction inside the patch (FROM, rad compass); orients the ellipse. */
  windFrom: number;
}

export interface OceanBoat {
  e: number;
  n: number;
  /** Compass heading of the bow (rad). */
  heading: number;
  /** Speed through the water (m/s). */
  speed: number;
  /** Heel (rad, + = starboard side down). */
  heel: number;
}

/**
 * Height and normal of the drawn sea on the CPU, one frame late (0 / straight up until the first
 * readback lands, 2–3 frames after start).
 *  • Queries farther than a few metres from the boat (marks, the camera) register themselves and are
 *    exact from the next readback on: the drawn surface at the mesh's level of detail there, including
 *    the boat's Kelvin and near-field waves and the camera-relative earth curvature. Until then, and
 *    beyond 24 registered points, they fall back to the grids below.
 *  • The boat's own queries (within ≈ 4.5 m of it) use a fine 40 m grid of the wind sea and swell only —
 *    a hull must not heave on the waves it makes itself; beyond that a coarse 1.6 km grid (≈ 25 m nodes,
 *    swell and long waves only).
 */
export interface OceanSampler {
  /** Height of the drawn surface above mean sea level (m) at sim-world (e, n) and time t (s). */
  heightAt(e: number, n: number, t: number): number;
  /** Unit surface normal in the three.js world frame (X east, Y up, Z south); fills `out` when given. */
  normalAt(e: number, n: number, t: number, out?: { x: number; y: number; z: number }): { x: number; y: number; z: number };
}
