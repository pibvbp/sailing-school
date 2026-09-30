// Pure parameter mappings: simulation quantities → sound parameters (spec §10). No WebAudio in here, so the
// whole "what does the boat sound like" policy is unit-tested in Node. Gains are linear amplitudes of unit-RMS
// noise *before* the layer's filters; the numbers were calibrated by rendering each layer alone (see the tests).
import { KN, clamp, smoothstep, wrapPi } from '../shared/math';

/** Apparent-wind speed (m/s) at which the wind curves reach their reference level (≈ 23 kn). */
export const AWS_REF = 12;
/** Boat speed (m/s) at which the water curves reach their reference level (≈ 7 kn, about hull speed). */
export const SPEED_REF = 3.6;
/** Apparent wind (m/s) that gives "1.0" of flogging loudness (≈ 12 kn). */
export const FLOG_REF_AWS = 6.2;

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** NaN/±Infinity guard for numbers that come from outside (a broken snapshot must never throw in the frame loop). */
export const finiteOr = (x: number, fallback: number): number => (x - x === 0 ? x : fallback);

// ---- wind ------------------------------------------------------------------------------------------------

const windU = (aws: number): number => clamp(aws / AWS_REF, 0, 2);
/**
 * The wind's loudness follows AWS² up to ~20 kn (u = 0.85), then its growth is halved, so a gale is louder but does not
 * lean on the limiter (30 kn ends up ≈ 3 dB under the pure square law, 40 kn ≈ 5 dB).
 */
const windLevelU = (aws: number): number => {
  const u = windU(aws);
  return u <= 0.85 ? u : 0.85 + (u - 0.85) * 0.5;
};

/** Low "roar" of the wind: level ∝ AWS² (spec: level grows ~ AWS²), flattening above ~20 kn. */
export const windRoarLevel = (aws: number): number => 0.52 * windLevelU(aws) ** 2;
/** Roar low-pass cut-off (Hz) — the wind gets brighter as it builds. */
export const windRoarCutoff = (aws: number): number => 120 + 560 * Math.min(windU(aws), 1.5);
/** Mid/high "hiss" of the air: steeper than AWS² so light air is mostly the soft low sound. */
export const windHissLevel = (aws: number): number => 0.31 * windLevelU(aws) ** 2.3;
export const windHissCutoff = (aws: number): number => 380 + 1500 * Math.min(windU(aws), 1.5) ** 0.85;
/** Rigging whistle 0…1: absent below ~13 kn, fully in by ~22 kn apparent ("a subtle whistle band above ~15 kn"). */
export const whistleDrive = (aws: number): number => smoothstep(13 * KN, 22 * KN, aws);
/** Two wire tones whose pitch follows the wind (vortex shedding: f ∝ speed). */
export const whistleFreqA = (aws: number): number => clamp(88 * aws, 500, 2600);
export const whistleFreqB = (aws: number): number => clamp(137 * aws, 800, 4000);

// ---- water -----------------------------------------------------------------------------------------------

const waterV = (speed: number): number => clamp(speed / SPEED_REF, 0, 2);

/** Hull rush: level rises faster than linearly with speed (a boat at 2 kn is nearly silent, at 7 kn it hisses). */
export const waterRushLevel = (speed: number): number => 0.075 * waterV(speed) ** 2.2;
export const waterRushCutoff = (speed: number): number => 260 + 1700 * Math.min(waterV(speed), 1.5) ** 0.9;

/**
 * Bow-wave "swoosh" drive 0…~1.5 from how fast the boat is rolling (`rollActivity`, rad/s, already smoothed),
 * how far it is heeled (the leeward hull digs in) and its speed (nothing to swoosh when stopped).
 */
export function swooshDrive(rollActivity: number, heel: number, speed: number): number {
  const v = Math.min(waterV(speed), 1);
  const roll = clamp(rollActivity / 0.22, 0, 1.5);
  const lean = Math.min(Math.abs(heel) / 0.5, 1);
  return (roll * (0.25 + 0.75 * v)) + 0.3 * lean * v;
}
export const swooshLevel = (drive: number): number => 0.2 * Math.min(drive, 1.5) ** 1.3;
export const swooshCentre = (drive: number): number => 450 + 900 * Math.min(drive, 1.5);

// ---- sail flogging ---------------------------------------------------------------------------------------

/**
 * Gate + level from a sail's mean section luffing (0…1): nothing below ~0.18, half-way at the spec's 0.3,
 * full gate from ~0.42, and the level keeps growing with the luffing after that ("level ∝ luffing").
 */
export function luffDrive(meanLuffing: number): number {
  const l = clamp01(meanLuffing);
  return smoothstep(0.18, 0.42, l) * (0.35 + 0.65 * l);
}

/** Flutter rate (Hz) of a flogging sail: 3 Hz in light air rising to 8 Hz in a gale (spec: 3–8 Hz rising with AWS). */
export const flutterRate = (aws: number): number => 3 + 5 * smoothstep(2, 14, aws);

/** Loudness of the flogging: luffing × AWS² (capped so a gale is louder, not deafening). */
export const flogLevel = (drive: number, aws: number): number => drive * Math.min(1.7, (aws / FLOG_REF_AWS) ** 2);

// ---- spinnaker -------------------------------------------------------------------------------------------

/** Rustle of a collapsed / curling spinnaker: 0…1, only while it is hoisted. */
export function spinRustleDrive(collapsed: number, curl: number, aws: number): number {
  const c = Math.max(smoothstep(0.08, 0.55, collapsed), 0.3 * smoothstep(0.3, 0.9, curl));
  return c * (0.2 + 0.8 * Math.min(1.5, (aws / 6) ** 1.6));
}

/** "Whump" of the sail filling: harder in more wind. */
export const refillLevel = (aws: number): number => 0.5 + 0.5 * smoothstep(2, 10, aws);
export const collapseLevel = (aws: number): number => 0.3 + 0.5 * smoothstep(2, 10, aws);

// ---- boom crash ------------------------------------------------------------------------------------------

/** Boom-crash loudness 0.55…1 from the impact rate (rad/s; the simulation only reports crashes above 1.5). */
export const crashLevel = (rate: number): number => 0.55 + 0.45 * smoothstep(1.5, 5, finiteOr(rate, 1.5));

// ---- stereo placement ------------------------------------------------------------------------------------

/**
 * Bearing (rad, + = to the listener's right) of something that sits `angleFromBow` (rad, + clockwise) off the bow,
 * for a listener looking along the compass direction `cameraYaw`.
 */
export const relativeBearing = (heading: number, angleFromBow: number, cameraYaw: number): number =>
  wrapPi(heading + angleFromBow - cameraYaw);

/** Equal-ish-power pan (−1 left … +1 right) for a bearing; `width` < 1 keeps diffuse sources from hard-panning. */
export const panFor = (bearing: number, width: number): number => clamp(Math.sin(bearing) * width, -1, 1);

/**
 * Compass yaw (rad, clockwise from north — the convention of `boat.heading`) of a camera whose forward vector in
 * three.js world coordinates is (x, ·, z): X = east, Z = −north, so bearing = atan2(east, north) = atan2(x, −z).
 * Degenerate when the camera looks straight down (x and z are then rounding noise): use `cameraYawFromBasis`.
 */
export const cameraYawFromForward = (x: number, z: number): number => Math.atan2(x, -z);

/** Anything with x, y, z: a three.js Vector3, or a plain object. */
export interface Vec3Like { x: number; y: number; z: number }

/**
 * Compass yaw (rad, clockwise from north) the listener faces, from a camera's world-space axes — three.js: X = east,
 * Y = up, Z = −north — `forward` = where it looks (its −Z axis), `up` = the top of the screen (its +Y axis). Both are
 * read from the camera matrix, e.g. `camera.getWorldDirection(forward)` and `up.setFromMatrixColumn(camera.matrixWorld, 1)`.
 *
 * For a level or tilted view the answer is the horizontal part of `forward`. Looking straight down (the top view)
 * that part is rounding noise, and "ahead" is the top of the screen: the horizontal part of `up`. Looking down, `up`
 * leans the same way as `forward` for a camera without roll, so the two horizontal parts simply add, `up`'s weight
 * fading in as the view steepens (from about 37° below the horizon, full at about 72°): the yaw never flips and is exact
 * at the top view, where `up` is the wind-up bearing the rig sets.
 */
export function cameraYawFromBasis(forward: Vec3Like, up: Vec3Like): number {
  const fl = Math.hypot(forward.x, forward.y, forward.z);
  const ul = Math.hypot(up.x, up.y, up.z);
  if (!(fl > 1e-9)) return 0;
  const fx = forward.x / fl, fy = forward.y / fl, fz = forward.z / fl;
  // 0 when level or looking up … 1 when (nearly) straight down.
  const down = smoothstep(0.6, 0.95, -fy);
  const k = ul > 1e-9 ? down / ul : 0;
  const x = fx + up.x * k;
  const z = fz + up.z * k;
  if (Math.hypot(x, z) > 1e-6) return Math.atan2(x, -z);
  // Looking straight up (nothing horizontal in `forward`): the top of the screen is all there is.
  return ul > 1e-9 && Math.hypot(up.x, up.z) > 1e-9 ? Math.atan2(up.x, -up.z) : 0;
}

/** Mean of `luffing` over a sail's sections (0 for none); a loop, so no per-frame allocation. */
export function meanLuffing(sections: ReadonlyArray<{ luffing: number }>): number {
  const n = sections.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += finiteOr(sections[i]!.luffing, 0);
  return sum / n;
}

/** Time constants (s) of the exponential glides applied to the continuous parameters (nothing steps → no clicks). */
export const GLIDE = {
  wind: 0.45,
  windTone: 0.35,
  pan: 0.25,
  water: 0.35,
  swoosh: 0.12,
  flogBed: 0.07,
  spin: 0.2,
  master: 0.25,
  mute: 0.12,
  duck: 0.15,
} as const;
