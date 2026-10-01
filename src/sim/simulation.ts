// The boat simulation (spec §7.6): sails + appendages + hull + stability in one rigid body.
// Forces are computed at their real 3-D points in the (heeled) body frame, moments taken about the centre
// of gravity, then resolved into the level heading frame where surge, sway, yaw and roll are integrated.
import { BOAT } from '../shared/boatSpec';
import { DEG, KN, clamp, rotX, smoothstep, type Vec3 } from '../shared/math';
import { defaultControls, type BoatState, type Controls, type ForceReport, type ScenarioInit, type SimSnapshot, type WindSettings, type SpinnakerState } from './types';
import { WindField } from './wind';
import { airVelocityBody, awaAws, twaOf, type Kinematics } from './apparent';
import { MainModel } from './sails/main';
import { JibModel, sheetingAngle } from './sails/jib';
import { SpinnakerModel } from './sails/spinnaker';
import { SIDE_BAND_DOWNWIND, blanketFactor, interactionShifts, sideFromAwa, type AirContext, type Side } from './sails/common';
import { kheff } from './aero';
import { G, RHO_AIR, RHO_WATER } from './constants';
import { KEEL, RUDDER, WINDAGE_POINT, crossFlow, foilForce, hullResistance, rightingMoment, windage } from './hydro';
import { Helmsman } from './autopilot';
import { EventDetector } from './events';

export const DT = 1 / 120;

const CG: Vec3 = { x: 0, y: 0, z: -BOAT.mass.cgH };
const M = BOAT.mass.total;
const MX = M * (1 + BOAT.mass.addedSurge);
const MY = M * (1 + BOAT.mass.addedSway);
const IXX = BOAT.mass.ixx;
const IZZ = BOAT.mass.izz;
const ROLL_DAMP = 780;
const YAW_DAMP = 400;
const MAX_RUDDER = BOAT.rudder.maxAngleDeg * DEG;
const RUDDER_RATE = BOAT.rudder.rateDegS * DEG;
const MAX_HEEL = 85 * DEG;
const MASTHEAD: Vec3 = { x: BOAT.mast.x, y: 0, z: -BOAT.mast.topH };
const BURGEE: Vec3 = { x: -3.4, y: 0, z: -1.6 };
const MAIN_MID: Vec3 = { x: 0.3, y: 0, z: -6 };
const RIG_HEIGHT = 10.0;
const HULL_ASYM = 0.15;
const MUNK = 0.6;
/** Crew movement follows its target with this first-order lag (s): they climb, they don't teleport. */
const CREW_LAG = 1.0;
/** In light air the crew sits this far to leeward (fraction of the hiking reach) to help the sails set. */
const LIGHT_AIR_LEE = 0.15;
/** Dead downwind the boom must be this far across before a crossing counts as a gybe of the rig. */
const GYBE_BOOM = 5 * DEG;
/** An uncontrolled gybe is only called a crash gybe from this wind speed up (M12). */
const CRASH_SWING_TWS = 6 * KN;

/** Crew/autopilot hook run before each physics step (auto-trim, manoeuvres). */
export interface CrewHook {
  maneuver: SimSnapshot['maneuver'];
  update(dt: number, sim: Simulation): void;
  /** Forget any manoeuvre in progress (the scenario was reset); optional. */
  reset?(): void;
}

interface StepForces { X: number; Y: number; N: number; K: number; report: ForceReport }

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const momentOf = (p: Vec3, f: Vec3): Vec3 => {
  const rx = p.x - CG.x, ry = p.y - CG.y, rz = p.z - CG.z;
  return { x: ry * f.z - rz * f.y, y: rz * f.x - rx * f.z, z: rx * f.y - ry * f.x };
};

/** Replace any non-finite number in the controls by its default (a broken input must not poison the sim). */
function sanitizeControls(c: Controls): void {
  const d = defaultControls() as unknown as Record<string, unknown>;
  const x = c as unknown as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    if (typeof d[k] === 'number' && !Number.isFinite(x[k] as number)) x[k] = d[k];
  }
  if (typeof c.crewHike === 'number' && !Number.isFinite(c.crewHike)) c.crewHike = 'auto';
}

export class Simulation {
  controls!: Controls;
  wind!: WindField;
  boat!: BoatState;
  t = 0;
  towed: { speed: number } | null = null;
  main!: MainModel;
  jib!: JibModel;
  spin!: SpinnakerModel;
  crew: CrewHook | null = null;
  events!: EventDetector;
  /** Set by the crew during manoeuvres: steer with this rudder angle instead of the helm. */
  rudderOverride: number | null = null;
  /**
   * The side the rig is set on: +1 wind from starboard (boom and jib clew to port), −1 from port. It changes
   * outside a ±3° band head to wind; dead downwind only when the wind is clearly (15°) on the new side, when the
   * boom gybes across, or when the crew gybes the rig — never because the wind flickers across the stern.
   */
  side: 1 | -1 = 1;
  /** Side of the centreline the boom was last clearly on (0: not yet out of the centre band). */
  private boomSide: Side | 0 = 0;
  private helmsman = new Helmsman();
  /** Latest derived quantities, available to the crew hook. */
  twa = 0;
  twd = 0;
  tws = 0;
  awa = 0;
  aws = 0;
  speed = 0;
  private forces!: ForceReport;
  private clPrev = { main: 1, jib: 1 };
  private faultCount = 0;
  private warned = false;
  private readonly saved = new Float64Array(31);

  constructor(init: ScenarioInit) {
    this.reset(init);
  }

  /**
   * Steps the finite-state guard had to undo (a non-finite state was replaced by the previous step's, with the
   * angular rates zeroed). Defence in depth: the physics is meant to keep this at 0.
   */
  get faults(): number { return this.faultCount; }

  reset(init: ScenarioInit): void {
    this.t = 0;
    this.controls = { ...defaultControls(), ...init.controls, autoTrim: { ...defaultControls().autoTrim, ...init.controls?.autoTrim } };
    this.wind = new WindField(init.wind);
    this.boat = { e: 0, n: 0, psi: 0, u: 0, v: 0, r: 0, phi: 0, p: 0, rudder: 0, crewY: 0, ...init.boat };
    this.towed = init.towed ?? null;
    this.main = new MainModel();
    this.jib = new JibModel();
    this.spin = new SpinnakerModel();
    this.events = new EventDetector();
    this.clPrev = { main: 1, jib: 1 };
    this.rudderOverride = null;
    this.helmsman = new Helmsman();

    // Start with the sails on the correct side for the wind, every rope where the controls say.
    const twa = twaOf(this.boat.psi, init.wind.twd);
    const side: Side = twa >= 0 ? 1 : -1;
    this.side = side;
    this.boomSide = 0;
    this.main.tackSign = side;
    this.main.twistSide = side;
    this.main.syncControls(this.controls);
    const lim = this.main.limits(this.controls);
    this.main.beta = side > 0 ? lim.hi : lim.lo;
    this.jib.tackSide = side;
    this.jib.workingSide = side;
    this.jib.syncControls(this.controls);
    // A scenario that starts with the jib rolled away starts with it rolled away, not rolling.
    this.jib.furl = Math.min(1, Math.max(0, this.controls.jibFurl));
    this.jib.gamma = side * sheetingAngle(this.controls.jibLead);
    if (side > 0) { this.jib.sheetPort = this.controls.jibSheet; this.jib.sheetStbd = 0; }
    else { this.jib.sheetStbd = this.controls.jibSheet; this.jib.sheetPort = 0; }
    this.jib.placeHeld(this.controls, side, this.main.beta);
    this.spin.windwardSide = side;
    this.spin.syncControls(this.controls);
    if (init.spinnakerSet) {
      this.spin.hoist = 1;
      this.controls.spinHoist = true;
      this.controls.jibFurl = 1;
      this.jib.furl = 1;
    }
    if (this.towed) this.boat.u = this.towed.speed;
    this.crew?.reset?.();
    this.updateDerived();
    this.forces = this.computeForces(0).report;
  }

  setWind(patch: Partial<WindSettings>): void { this.wind.setSettings(patch); }

  setTowed(t: { speed: number } | null): void {
    this.towed = t;
    if (t) { this.boat.u = t.speed; this.boat.v = 0; this.boat.r = 0; }
  }

  /**
   * The crew's gybe sequence moves the rig across (jib sheets, traveler, spinnaker pole end-for-end) — the one
   * way besides the boom itself gybing to change sides dead downwind.
   */
  gybeRig(side: Side): void {
    this.side = side;
  }

  kinematics(): Kinematics {
    const b = this.boat;
    return { heading: b.psi, heel: b.phi, u: b.u, v: b.v, r: b.r, p: b.p };
  }

  /** True-wind air velocity at the boat's position and a height above the water. */
  readonly windAt = (h: number): { e: number; n: number } => this.wind.velocity(this.boat.e, this.boat.n, h);

  private apparentAt(p: Vec3, kin: Kinematics): { awa: number; aws: number } {
    const h = -rotX(p, kin.heel).z;
    return awaAws(airVelocityBody(p, kin, this.windAt(h)));
  }

  private updateDerived(): void {
    const b = this.boat;
    const w = this.wind.sample(b.e, b.n, 10);
    this.tws = w.speed;
    this.twd = w.dir;
    this.twa = twaOf(b.psi, w.dir);
    const a = this.apparentAt(MASTHEAD, this.kinematics());
    this.awa = a.awa;
    this.aws = a.aws;
    this.speed = Math.hypot(b.u, b.v);
  }

  step(dt = DT): void {
    this.saveState();
    this.advance(dt);
    if (!this.stateFinite()) this.recover();
  }

  private advance(dt: number): void {
    const b = this.boat;
    const c = this.controls;
    this.t += dt;
    this.wind.step(dt, b.e, b.n);
    this.updateDerived();
    this.crew?.update(dt, this);

    // Helm → rudder (rate-limited). The crew may override during manoeuvres.
    const target = this.rudderOverride !== null
      ? clamp(this.rudderOverride, -MAX_RUDDER, MAX_RUDDER)
      : c.helmMode === 'manual'
        ? clamp(c.tiller, -1, 1) * MAX_RUDDER
        : this.helmsman.command(c.helmMode, c.helmTarget, { heading: b.psi, twa: this.twa, awa: this.awa, r: b.r, speed: this.speed }, dt);
    b.rudder += clamp(target - b.rudder, -RUDDER_RATE * dt, RUDDER_RATE * dt);

    const hike = typeof c.crewHike === 'number' ? clamp(c.crewHike, -1, 1) : this.autoHike();
    b.crewY += (hike - b.crewY) * Math.min(1, dt / CREW_LAG);

    const f = this.computeForces(dt);
    this.forces = f.report;

    if (this.towed) {
      b.u = this.towed.speed;
      b.v = 0;
      b.r = 0;
    } else {
      const udot = (f.X + MY * b.v * b.r) / MX;
      const vdot = (f.Y - MX * b.u * b.r) / MY;
      b.u += udot * dt;
      b.v += vdot * dt;
      b.r += (f.N / IZZ) * dt;
    }
    b.p += (f.K / IXX) * dt;
    b.phi += b.p * dt;
    if (Math.abs(b.phi) > MAX_HEEL) { b.phi = Math.sign(b.phi) * MAX_HEEL; b.p = 0; }
    b.psi = (b.psi + b.r * dt) % (2 * Math.PI);
    if (b.psi < 0) b.psi += 2 * Math.PI;
    const s = Math.sin(b.psi), co = Math.cos(b.psi);
    b.e += (b.u * s + b.v * co) * dt;
    b.n += (b.u * co - b.v * s) * dt;

    this.updateDerived();
    const mainSecs = this.main.last!.sections;
    const jibSecs = this.jib.last!.sections;
    const avg = (xs: readonly { luffing: number }[]) => (xs.length ? xs.reduce((a, x) => a + x.luffing, 0) / xs.length : 0);
    // A crew-run tack or gybe controls the sheet, and a boom held by hand is controlled too: the boom crossing is
    // intended then, never a crash gybe (I2, M12).
    const crewSheet = this.crew?.maneuver === 'tack' || this.crew?.maneuver === 'gybe' || (c.boomPush ?? 0) !== 0;
    const swing = this.tws >= CRASH_SWING_TWS ? this.main.swingRate : 0;
    this.events.update({
      t: this.t,
      dt,
      twa: this.twa,
      speed: this.speed,
      heel: b.phi,
      yawRate: b.r,
      rudder: b.rudder,
      crashRate: crewSheet ? 0 : Math.max(this.main.crashRate, swing),
      spinEvents: this.spin.events,
      mainLuffing: avg(mainSecs),
      jibLuffing: avg(jibSecs),
      jibSet: this.jib.furl < 0.97,
      mainLuffBubble: avg(mainSecs.slice(2, 6)),
      mainLeechFull: mainSecs.slice(2, 6).every((x) => x.stall < 0.9) && avg(mainSecs) < 0.6,
    });
  }

  /**
   * Where the crew sits when hiking is automatic (−1 port … +1 starboard), spec §7.5. They hike out only against
   * heel to leeward (φL = −sign(TWA)·φ), so a boat heeled to windward never makes them hike harder; in light air
   * they sit a little to leeward; downwind they counter whatever heel there is.
   */
  private autoHike(): number {
    const b = this.boat;
    const side = Math.sign(this.twa);
    const heelToLee = -side * b.phi;
    const lightAir = smoothstep(0.3, 1.0, this.tws) * (1 - smoothstep(2.0, 3.1, this.tws));
    const upwind = side * (smoothstep(3 * DEG, 12 * DEG, heelToLee) - LIGHT_AIR_LEE * lightAir * (1 - smoothstep(0, 3 * DEG, heelToLee)));
    const downwind = -Math.sign(b.phi) * 0.6 * smoothstep(4 * DEG, 14 * DEG, Math.abs(b.phi));
    const w = smoothstep(100 * DEG, 120 * DEG, Math.abs(this.twa));
    return (1 - w) * upwind + w * downwind;
  }

  /**
   * Decide the rig side (C3). Head to wind and on a reach the wind decides (with a ±3° band); within 15° of dead
   * downwind the rig stays where it is unless the boom actually gybes across the centreline.
   */
  private updateSide(awaRef: number): void {
    let s = sideFromAwa(this.side, awaRef);
    const beta = this.main.beta;
    const boomNow = Math.abs(beta) > GYBE_BOOM ? (Math.sign(beta) as Side) : 0;
    const crossed = boomNow !== 0 && this.boomSide !== 0 && boomNow !== this.boomSide;
    if (boomNow !== 0) this.boomSide = boomNow;
    if (crossed && boomNow === -this.side && Math.abs(awaRef) >= SIDE_BAND_DOWNWIND) s = boomNow;
    this.side = s;
  }

  private computeForces(dt: number): StepForces {
    const b = this.boat;
    const c = this.controls;
    const kin = this.kinematics();
    const air: AirContext = { kin, windAt: this.windAt };

    // Reference apparent wind at mid-rig: decides which side the sails set on.
    const aRef = airVelocityBody(MAIN_MID, kin, this.windAt(-rotX(MAIN_MID, b.phi).z));
    const { awa: awaRef, aws: awsRef } = awaAws(aRef);
    const wl = Math.hypot(aRef.x, aRef.y) || 1;
    const w = { x: aRef.x / wl, y: aRef.y / wl };
    this.updateSide(awaRef);
    const side = this.side;

    // Main ↔ jib interaction (previous step's lift) and blanketing by the main.
    const jibWorking = this.jib.furl < 0.97 && !c.jibWhisker;
    const sameSide = jibWorking && Math.sign(this.jib.gamma) === Math.sign(this.main.beta);
    const jibArea = this.jib.last?.sum.area ?? BOAT.jib.area;
    const shift = interactionShifts(this.clPrev.main, this.clPrev.jib, BOAT.main.area, jibArea, sameSide);
    const mainCE = this.main.last?.sum.ce ?? { x: -0.4, y: 0, z: -5 };
    const perp = { x: -w.y, y: w.x };
    const boomDir = { x: -Math.cos(this.main.beta), y: -Math.sin(this.main.beta) };
    const halfWidth = 0.5 * Math.abs(BOAT.main.E * (boomDir.x * perp.x + boomDir.y * perp.y)) + 0.4;
    const offset = (ce: Vec3 | undefined) => (ce ? (ce.x - mainCE.x) * perp.x + (ce.y - mainCE.y) * perp.y : 0);
    const blJib = blanketFactor(Math.abs(awaRef), offset(this.jib.last?.sum.ce), halfWidth);
    const blSpin = blanketFactor(Math.abs(awaRef), offset(this.spin.last?.sum.ce), halfWidth);

    const mEv = this.main.step(dt, c, air, shift, 1, awaRef, side);
    const jEv = this.jib.step(dt, c, air, shift.jib, blJib, awaRef, side, this.main.beta);
    const spinActive = this.spin.hoist > 0 || c.spinHoist || !this.spin.last;
    const sEv = spinActive ? this.spin.step(dt, c, air, blSpin, awaRef, awsRef, side) : this.spin.last!;
    this.clPrev = { main: mEv.sum.cl, jib: jEv.sum.cl };

    // Sail forces, with moments taken section by section.
    const spinUp = this.spin.hoist > 0;
    let Fb: Vec3 = add(mEv.sum.force, jEv.sum.force);
    let area = mEv.sum.area + jEv.sum.area;
    if (spinUp) { Fb = add(Fb, sEv.sum.force); area += sEv.sum.area; }
    let Mb: Vec3 = { x: 0, y: 0, z: 0 };
    for (const r of mEv.sections) Mb = add(Mb, momentOf(r.point, r.force));
    for (const r of jEv.sections) Mb = add(Mb, momentOf(r.point, r.force));
    if (spinUp) for (const r of sEv.sections) Mb = add(Mb, momentOf(r.point, r.force));

    // Induced drag of the whole sail set (ORC eq. 5.34) along the reference flow at the sails' CE.
    const q = 0.5 * RHO_AIR * awsRef * awsRef;
    if (q > 0.05 && area > 0.5) {
      const along = Fb.x * w.x + Fb.y * w.y;
      const lift = Math.hypot(Fb.x - along * w.x, Fb.y - along * w.y);
      const hEff = (this.spin.hoist > 0.5 ? 1.0 : 1.1 * kheff(Math.abs(awaRef))) * RIG_HEIGHT;
      const di = (lift * lift) / (q * Math.PI * hEff * hEff);
      const fi = { x: di * w.x, y: di * w.y, z: 0 };
      const ceAll = this.combinedCE(mEv.sum, jEv.sum, spinUp ? sEv.sum : null);
      Fb = add(Fb, fi);
      Mb = add(Mb, momentOf(ceAll, fi));
    }
    const sailCE = this.combinedCE(mEv.sum, jEv.sum, spinUp ? sEv.sum : null);

    // Windage of hull, mast, rigging and crew.
    const aW = airVelocityBody(WINDAGE_POINT, kin, this.windAt(2.5));
    const Fw = windage(aW);
    Fb = add(Fb, Fw);
    Mb = add(Mb, momentOf(WINDAGE_POINT, Fw));
    const aeroForce = Fb;
    const aeroMomentX = Mb.x;

    // Keel and rudder: local water flow including yaw and roll rates.
    const waterRel = (pB: Vec3): Vec3 => {
      const rH = rotX(pB, b.phi);
      const vp = { x: b.u - b.r * rH.y, y: b.v + b.r * rH.x - b.p * rH.z, z: b.p * rH.y };
      return rotX({ x: -vp.x, y: -vp.y, z: -vp.z }, -b.phi);
    };
    const keelFoil = foilForce(KEEL, waterRel(KEEL.point), 0);
    const keel = keelFoil.force;
    // The rudder sits in the keel's downwash: the keel turns the water back toward the centreline, so the
    // rudder sees only part of the leeway (half the ideal finite-wing downwash 2·CL/(π·AR) at 3.4 m aft).
    // Only with way on: going astern the rudder is upstream of the keel (M4); blended in over 0…0.3 m/s.
    const rudWater = waterRel(RUDDER.point);
    const Ur = Math.hypot(rudWater.x, rudWater.y);
    const eps = (0.5 * 2 * Math.abs(keelFoil.cl)) / (Math.PI * KEEL.arEff);
    rudWater.y -= smoothstep(0, 0.3, b.u) * Math.sign(keel.y) * Math.min(eps, 0.15) * Ur;
    const vent = 1 - 0.6 * smoothstep(30 * DEG, 50 * DEG, Math.abs(b.phi));
    const rud0 = foilForce(RUDDER, rudWater, b.rudder).force;
    const rudder = { x: rud0.x * vent, y: rud0.y * vent, z: 0 };
    Fb = add(add(Fb, keel), rudder);
    Mb = add(add(Mb, momentOf(KEEL.point, keel)), momentOf(RUDDER.point, rudder));

    // Resolve into the level heading frame.
    const Fh = rotX(Fb, b.phi);
    const Mh = rotX(Mb, b.phi);
    const U = Math.hypot(b.u, b.v);
    // Hull resistance acts along the surge axis only; sideways motion belongs to the cross-flow model (M15).
    const res = hullResistance(b.u, b.phi).total * (b.u < 0 ? 1.5 : 1);
    const rx = Math.sign(b.u) * res;
    const cf = crossFlow(b.v, b.r);
    const kRight = rightingMoment(b.phi);
    const crewY = b.crewY * BOAT.mass.crewHikeY;
    const kCrew = BOAT.mass.crew * G * crewY * Math.cos(b.phi);

    // A heeled hull is asymmetric in the water and turns its bow toward the wind (grows with heel²);
    // with the rudder losing grip at big heel this is what makes an over-powered boat round up.
    const hullAsym = -Math.sign(b.phi) * HULL_ASYM * 0.5 * RHO_WATER * U * U * BOAT.hull.lateralArea * BOAT.hull.lwl * Math.sin(b.phi) ** 2;

    // Munk moment: a slender hull moving at a drift angle is turned further across the flow (destabilising).
    // Sliding to leeward it swings the bow to windward — why real boats carry weather helm although the
    // sails' centre of effort sits ahead of the keel. Reduced for stern separation.
    const munk = -MUNK * (MY - MX) * b.u * b.v;

    const X = Fh.x - rx;
    const Y = Fh.y + cf.Y;
    const N = Mh.z + cf.N + hullAsym + munk - YAW_DAMP * b.r;
    const K = Mh.x + kRight + kCrew - ROLL_DAMP * b.p;

    const aeroH = rotX(aeroForce, b.phi);
    const gz = Math.abs(kRight) / (M * G);
    const cbH = { x: 0, y: Math.sign(b.phi) * gz, z: CG.z };
    return {
      X, Y, N, K,
      report: {
        aero: { force: aeroForce, point: sailCE },
        drive: aeroH.x,
        sideForce: aeroH.y,
        keel: { force: keel, point: KEEL.point },
        rudder: { force: rudder, point: RUDDER.point },
        resistance: res,
        heelingMoment: aeroMomentX + momentOf(KEEL.point, keel).x + momentOf(RUDDER.point, rudder).x,
        rightingMoment: kRight,
        crewMoment: kCrew,
        cg: CG,
        cb: rotX(cbH, -b.phi),
      },
    };
  }

  private combinedCE(...sums: ReadonlyArray<{ force: Vec3; ce: Vec3 } | null>): Vec3 {
    let w = 0, x = 0, y = 0, z = 0;
    for (const s of sums) {
      if (!s) continue;
      const m = Math.hypot(s.force.x, s.force.y) + 1e-9;
      w += m; x += s.ce.x * m; y += s.ce.y * m; z += s.ce.z * m;
    }
    return w > 0 ? { x: x / w, y: y / w, z: z / w } : { x: 0.3, y: 0, z: -5 };
  }

  // ------------------------------------------------------------------ finite-state guard (defence in depth)

  private saveState(): void {
    const s = this.saved, b = this.boat, m = this.main, j = this.jib, p = this.spin;
    s[0] = b.e; s[1] = b.n; s[2] = b.psi; s[3] = b.u; s[4] = b.v; s[5] = b.r; s[6] = b.phi; s[7] = b.p;
    s[8] = b.rudder; s[9] = b.crewY;
    s[10] = m.beta; s[11] = m.betaDot; s[12] = m.twist; s[13] = m.twistSide; s[14] = m.sheet; s[15] = m.carY;
    s[16] = j.gamma; s[17] = j.gammaDot; s[18] = j.furl; s[19] = j.sheet; s[20] = j.sheetPort; s[21] = j.sheetStbd;
    s[22] = j.held ?? Number.NaN;
    s[23] = p.psi; s[24] = p.hoist; s[25] = p.collapsed; s[26] = p.curl; s[27] = p.alphaTrim; s[28] = p.sheet;
    s[29] = this.clPrev.main; s[30] = this.clPrev.jib;
  }

  private restoreState(): void {
    const s = this.saved, b = this.boat, m = this.main, j = this.jib, p = this.spin;
    b.e = s[0]!; b.n = s[1]!; b.psi = s[2]!; b.u = s[3]!; b.v = s[4]!; b.r = s[5]!; b.phi = s[6]!; b.p = s[7]!;
    b.rudder = s[8]!; b.crewY = s[9]!;
    m.beta = s[10]!; m.betaDot = s[11]!; m.twist = s[12]!; m.twistSide = s[13]!; m.sheet = s[14]!; m.carY = s[15]!;
    j.gamma = s[16]!; j.gammaDot = s[17]!; j.furl = s[18]!; j.sheet = s[19]!; j.sheetPort = s[20]!; j.sheetStbd = s[21]!;
    j.held = Number.isNaN(s[22]!) ? null : s[22]!;
    p.psi = s[23]!; p.hoist = s[24]!; p.collapsed = s[25]!; p.curl = s[26]!; p.alphaTrim = s[27]!; p.sheet = s[28]!;
    this.clPrev = { main: s[29]!, jib: s[30]! };
  }

  private stateFinite(): boolean {
    const b = this.boat, m = this.main, j = this.jib, p = this.spin;
    return Number.isFinite(
      b.e + b.n + b.psi + b.u + b.v + b.r + b.phi + b.p + b.rudder + b.crewY
      + m.beta + m.betaDot + m.twist + m.twistSide + m.sheet + m.carY
      + j.gamma + j.gammaDot + j.furl + j.sheet + (j.held ?? 0)
      + p.psi + p.hoist + p.collapsed + p.alphaTrim + p.sheet
      + this.twa + this.awa + this.aws + this.speed,
    );
  }

  /** Undo a step that produced a non-finite state: previous state, angular rates zeroed, forces re-evaluated. */
  private recover(): void {
    this.restoreState();
    const b = this.boat;
    b.r = 0;
    b.p = 0;
    this.main.betaDot = 0;
    this.jib.gammaDot = 0;
    sanitizeControls(this.controls);
    if (!this.stateFinite()) {
      // The saved state itself was bad (e.g. a non-finite scenario): bring the boat to rest where it can.
      for (const k of Object.keys(b) as (keyof BoatState)[]) if (!Number.isFinite(b[k])) b[k] = 0;
    }
    // The sails' last evaluations came from the failed step; re-evaluate from scratch at the restored state.
    this.main.last = null;
    this.jib.last = null;
    this.spin.last = null;
    this.updateDerived();
    this.forces = this.computeForces(0).report;
    if (!this.stateFinite()) {
      // Last resort: sails back to a neutral set on the current side.
      const lim = this.main.appliedLimits();
      this.main.beta = this.side > 0 ? lim.hi : lim.lo;
      this.main.twist = 8 * DEG;
      this.main.twistSide = this.side;
      this.jib.gamma = this.side * sheetingAngle(this.controls.jibLead);
      this.jib.held = null;
      this.spin.psi = 100 * DEG;
      this.main.last = this.jib.last = null;
      this.spin.last = null;
      this.forces = this.computeForces(0).report;
    }
    this.faultCount++;
    if (!this.warned) {
      this.warned = true;
      console.warn(`Simulation: non-finite state at t = ${this.t.toFixed(2)} s — restored the previous step with the angular rates zeroed (further faults are counted in sim.faults, not logged).`);
    }
  }

  snapshot(): SimSnapshot {
    const b = this.boat;
    const c = this.controls;
    const kin = this.kinematics();
    const deck = this.apparentAt(BURGEE, kin);
    const ve = b.u * Math.sin(b.psi) + b.v * Math.cos(b.psi);
    const vn = b.u * Math.cos(b.psi) - b.v * Math.sin(b.psi);
    const spin: SpinnakerState = this.spin.state(this.spin.last!, c, b.phi);
    return {
      t: this.t,
      boat: {
        pos: { x: b.e, y: b.n },
        heading: b.psi,
        heel: b.phi,
        yawRate: b.r,
        rollRate: b.p,
        u: b.u,
        v: b.v,
        speed: this.speed,
        cog: Math.atan2(ve, vn),
        leeway: this.speed > 0.1 ? Math.atan2(b.v, Math.max(b.u, 0.05)) : 0,
        rudder: b.rudder,
        vmg: ve * Math.sin(this.twd) + vn * Math.cos(this.twd),
        crewHike: b.crewY,
      },
      wind: {
        tws: this.tws,
        twd: this.twd,
        twa: this.twa,
        aws: this.aws,
        awa: this.awa,
        awsDeck: deck.aws,
        awaDeck: deck.awa,
        puffs: this.wind.puffs.map((p) => ({ ...p })),
      },
      sails: {
        main: this.main.state(this.main.last!, b.phi),
        jib: this.jib.state(this.jib.last!, c, b.phi, this.awa),
        spinnaker: spin,
      },
      forces: this.forces,
      events: this.events.drain(),
      maneuver: this.crew?.maneuver ?? null,
      towed: this.towed !== null,
    };
  }
}
