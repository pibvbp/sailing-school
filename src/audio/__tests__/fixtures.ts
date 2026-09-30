// A fake SimSnapshot built from a handful of numbers — shared by the unit tests, the offline-render harness and the
// audio demo page. Only the fields the soundscape reads are meaningful; everything else is filled with zeros.
import type { JibState, MainState, SailSection, SimEvent, SimEventType, SimSnapshot, SpinnakerState } from '../../sim/types';

export interface Frame {
  /** Simulation time (s) — must advance while the "simulation" runs. */
  t?: number;
  /** Apparent wind speed (m/s) and angle (rad, + = wind from starboard). */
  aws?: number;
  awa?: number;
  heading?: number;
  /** Boat speed (m/s). */
  speed?: number;
  heel?: number;
  rollRate?: number;
  /** Mean section luffing of main and jib (0…1). */
  mainLuff?: number;
  jibLuff?: number;
  jibSet?: boolean;
  spinSet?: boolean;
  spinCollapsed?: number;
  spinCurl?: number;
  /** Main boom angle (rad, + out to port) and rate (rad/s), jib clew angle (rad): a sheet being hauled shows up here. */
  boomAngle?: number;
  boomRate?: number;
  clewAngle?: number;
  /** Compass bearing (rad) the camera looks along. Not part of the snapshot: passed to update() next to it. */
  yaw?: number;
  events?: SimEvent[];
}

export const FRAME_DEFAULTS: Required<Omit<Frame, 'events'>> = {
  t: 0, aws: 6, awa: 0.7, heading: 0, speed: 2.5, heel: 0.2, rollRate: 0,
  mainLuff: 0, jibLuff: 0, jibSet: true, spinSet: false, spinCollapsed: 0, spinCurl: 0, boomAngle: 0, boomRate: 0, clewAngle: 0, yaw: 0,
};

const v3 = () => ({ x: 0, y: 0, z: 0 });

function sections(n: number, luffing: number): SailSection[] {
  return Array.from({ length: n }, (_, i) => ({
    h: (i + 0.5) / n, luff: v3(), chordDir: { x: -1, y: 0, z: 0 }, chord: 2, camber: 0.1, draft: 0.45, leewardY: 1,
    aoa: 0, luffing, stall: 0, cl: 0, cd: 0, q: 0,
  }));
}

const sailBase = (n: number, luffing: number) => ({
  set: true, area: 10, tack: v3(), clew: v3(), head: v3(), sections: sections(n, luffing), force: v3(), ce: v3(),
  lift: 0, drag: 0, drive: 0, heelForce: 0, telltales: [],
});

export function snapshotFrom(f: Frame = {}): SimSnapshot {
  const p = { ...FRAME_DEFAULTS, ...f };
  const main: MainState = { ...sailBase(8, p.mainLuff), id: 'main', boomAngle: p.boomAngle, boomRate: p.boomRate, twistDeg: 8 };
  const jib: JibState = { ...sailBase(8, p.jibLuff), id: 'jib', set: p.jibSet, clewAngle: p.clewAngle, furl: p.jibSet ? 0 : 1, backed: false, whisker: false };
  const spin: SpinnakerState = {
    ...sailBase(6, 0), id: 'spinnaker', set: p.spinSet, hoist: p.spinSet ? 1 : 0, poleAngle: 0, poleTip: v3(), poleHeight: 0.5,
    collapsed: p.spinCollapsed, curl: p.spinCurl,
  };
  return {
    t: p.t,
    boat: {
      pos: { x: 0, y: 0 }, heading: p.heading, heel: p.heel, yawRate: 0, rollRate: p.rollRate, u: p.speed, v: 0,
      speed: p.speed, cog: p.heading, leeway: 0, rudder: 0, vmg: 0, crewHike: 0,
    },
    wind: { tws: p.aws, twd: 0, twa: p.awa, aws: p.aws, awa: p.awa, awsDeck: p.aws, awaDeck: p.awa, puffs: [] },
    sails: { main, jib, spinnaker: spin },
    forces: {
      aero: { force: v3(), point: v3() }, drive: 0, sideForce: 0, keel: { force: v3(), point: v3() },
      rudder: { force: v3(), point: v3() }, resistance: 0, heelingMoment: 0, rightingMoment: 0, crewMoment: 0, cg: v3(), cb: v3(),
    },
    events: f.events ?? [],
    maneuver: null,
    towed: false,
  };
}

export const event = (type: SimEventType, t: number, data?: Record<string, number>): SimEvent => (data ? { type, t, data } : { type, t });
