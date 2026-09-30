// The simulation ↔ everything-else contract (spec §7.9).
// Frames and signs (spec §5): body x fwd / y stbd / z down; heel > 0 = starboard side down;
// TWA/AWA > 0 = wind from starboard; boom/clew angles > 0 = out to port; compass clockwise, TWD = from.
import type { Vec2, Vec3 } from '../shared/math';

export type SailId = 'main' | 'jib' | 'spinnaker';
export type HelmMode = 'manual' | 'heading' | 'twa' | 'awa';

export interface Controls {
  helmMode: HelmMode;
  /** Manual helm −1…1; + turns the bow to starboard (the tiller itself moves to port). */
  tiller: number;
  /** Target for autopilot modes (rad): heading, or signed TWA/AWA. */
  helmTarget: number;
  mainSheet: number;   // 0 eased … 1 trimmed
  traveler: number;    // −1 to leeward … +1 to windward (relative to the current tack)
  vang: number;        // 0…1
  outhaul: number;     // 0…1
  cunningham: number;  // 0…1
  backstay: number;    // 0…1
  jibSheet: number;    // 0…1 (the working/leeward sheet)
  jibLead: number;     // −1 aft … +1 forward
  jibFurl: number;     // 0 fully out … 1 furled
  jibBacked: boolean;  // hold the clew to windward
  jibWhisker: boolean; // whisker pole: jib held out on the windward side
  spinHoist: boolean;  // requested state
  spinPole: number;    // 0 on the forestay … 1 squared back (90°)
  spinPoleHeight: number; // 0…1 (maps to BOAT.spinnaker.poleTipH)
  spinSheet: number;   // 0 eased … 1 trimmed
  crewHike: 'auto' | number; // lateral position −1 (port) … +1 (stbd) or automatic
  autoTrim: { main: boolean; jib: boolean; spinnaker: boolean };
  /** One-shot manoeuvre request, consumed by the simulation. */
  command: null | 'tack' | 'gybe';
}

export interface WindSettings {
  /** True wind speed at 10 m (m/s). */
  tws: number;
  /** True wind direction the wind blows FROM (rad, compass). */
  twd: number;
  /** 0 steady … 1 very gusty. */
  gustiness: number;
  /** Oscillating shift amplitude (rad). */
  shiftAmplitude: number;
  /** Oscillating shift period (s). */
  shiftPeriod: number;
  seed: number;
}

export interface Puff {
  id: number;
  e: number;
  n: number;
  radiusAlong: number;
  radiusAcross: number;
  /** Fractional speed change at the centre (+ gust, − lull). */
  strength: number;
  /** Direction change at the centre (rad, + veer). */
  dirOffset: number;
  /** 0…1 fade in/out. */
  envelope: number;
}

export type TelltaleState = 'streaming' | 'lifting' | 'stalled' | 'fluttering';

export interface Telltale {
  id: string;
  /** Body-frame position on the sail surface. */
  pos: Vec3;
  side: 'port' | 'stbd' | 'leech';
  state: TelltaleState;
  /** 0…1 strength of the current state (e.g. how hard it is lifting). */
  intensity: number;
}

export interface SailSection {
  /** Height fraction 0 (foot) … 1 (head). */
  h: number;
  /** Luff point (body frame). */
  luff: Vec3;
  /** Unit chord direction luff → leech (body frame, rig plane). */
  chordDir: Vec3;
  chord: number;
  /** Depth / chord. */
  camber: number;
  /** Position of maximum depth, fraction of chord. */
  draft: number;
  /**
   * Belly side factor s ∈ [−1, 1]: the cloth bellies toward s · (chordDir.y, −chordDir.x, 0).
   * For the main and jib (chord pointing aft) this is simply −1 = belly to port, +1 = belly to starboard;
   * it passes through 0 while the sail flips during a tack/gybe. For the spinnaker (chord across the
   * boat on a run) use the vector form.
   */
  leewardY: number;
  /** Effective angle of attack (rad). */
  aoa: number;
  luffing: number;
  stall: number;
  cl: number;
  cd: number;
  /** Dynamic pressure (Pa). */
  q: number;
}

export interface SailState {
  id: SailId;
  set: boolean;
  /** Working area now (m²). */
  area: number;
  tack: Vec3;
  clew: Vec3;
  head: Vec3;
  sections: SailSection[];
  /** Total aerodynamic force (body frame, N) and centre of effort. */
  force: Vec3;
  ce: Vec3;
  lift: number;
  drag: number;
  /** Horizontal components along/across the boat's centreline (N). */
  drive: number;
  heelForce: number;
  telltales: Telltale[];
}

export interface MainState extends SailState {
  /** Boom angle (rad, + out to port). */
  boomAngle: number;
  boomRate: number;
  twistDeg: number;
}

export interface JibState extends SailState {
  /** Clew angle seen from the tack (rad, + out to port). */
  clewAngle: number;
  furl: number;
  backed: boolean;
  whisker: boolean;
}

export interface SpinnakerState extends SailState {
  /** 0 stowed … 1 fully hoisted. */
  hoist: number;
  /** Pole angle from the centreline toward windward (rad). */
  poleAngle: number;
  poleTip: Vec3;
  poleHeight: number;
  /** 0 full … 1 collapsed. */
  collapsed: number;
  /** 0 none … 1 strong luff curl. */
  curl: number;
}

export interface ForceAt { force: Vec3; point: Vec3 }

export interface ForceReport {
  aero: ForceAt;
  drive: number;
  sideForce: number;
  keel: ForceAt;
  rudder: ForceAt;
  resistance: number;
  heelingMoment: number;
  rightingMoment: number;
  crewMoment: number;
  cg: Vec3;
  cb: Vec3;
}

export type SimEventType =
  | 'crashGybe' | 'inIrons' | 'tackComplete' | 'gybeComplete'
  | 'spinCollapse' | 'spinRefill' | 'roundUp' | 'luffing' | 'backwinded';

export interface SimEvent { type: SimEventType; t: number; data?: Record<string, number> }

export interface SimSnapshot {
  t: number;
  boat: {
    pos: Vec2;           // (east, north) m
    heading: number;     // rad compass
    heel: number;        // rad, + starboard down
    yawRate: number;
    rollRate: number;
    u: number;           // surge m/s
    v: number;           // sway m/s (+ to starboard)
    speed: number;       // m/s
    cog: number;         // course over ground, rad compass
    leeway: number;      // rad, + sliding to starboard
    rudder: number;      // rad, + turns the boat to starboard
    vmg: number;         // m/s toward the true wind (+ upwind)
    crewHike: number;    // crew lateral position −1…1
  };
  wind: {
    tws: number; twd: number; twa: number;
    aws: number; awa: number;           // at 10 m (masthead instrument)
    awsDeck: number; awaDeck: number;   // at deck height (burgee)
    puffs: Puff[];
  };
  sails: { main: MainState; jib: JibState; spinnaker: SpinnakerState };
  forces: ForceReport;
  events: SimEvent[];
  maneuver: null | 'tack' | 'gybe' | 'hoist' | 'douse';
  towed: boolean;
}

export interface BoatState {
  e: number; n: number; psi: number;
  u: number; v: number; r: number;
  phi: number; p: number;
  rudder: number;
  crewY: number;
}

export interface ScenarioInit {
  wind: WindSettings;
  boat?: Partial<BoatState>;
  controls?: Partial<Controls>;
  spinnakerSet?: boolean;
  /** Sail lab: hold speed and heading ("towed") while forces keep computing. */
  towed?: { speed: number } | null;
}

export function defaultControls(): Controls {
  return {
    helmMode: 'manual',
    tiller: 0,
    helmTarget: 0,
    mainSheet: 0.7,
    traveler: 0,
    vang: 0.3,
    outhaul: 0.5,
    cunningham: 0.2,
    backstay: 0.3,
    jibSheet: 0.7,
    jibLead: 0,
    jibFurl: 0,
    jibBacked: false,
    jibWhisker: false,
    spinHoist: false,
    spinPole: 0.5,
    spinPoleHeight: 0.5,
    spinSheet: 0.5,
    crewHike: 'auto',
    autoTrim: { main: true, jib: true, spinnaker: true },
    command: null,
  };
}
