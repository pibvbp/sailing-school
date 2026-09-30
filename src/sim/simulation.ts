// The boat simulation (spec §7.6): sails + appendages + hull + stability in one rigid body.
// Forces are computed at their real 3-D points in the (heeled) body frame, moments taken about the centre
// of gravity, then resolved into the level heading frame where surge, sway, yaw and roll are integrated.
import { BOAT } from '../shared/boatSpec';
import { DEG, clamp, rotX, smoothstep, type Vec3 } from '../shared/math';
import { defaultControls, type BoatState, type Controls, type ForceReport, type ScenarioInit, type SimSnapshot, type WindSettings, type SpinnakerState } from './types';
import { WindField } from './wind';
import { airVelocityBody, awaAws, twaOf, type Kinematics } from './apparent';
import { MainModel } from './sails/main';
import { JibModel, sheetingAngle } from './sails/jib';
import { SpinnakerModel } from './sails/spinnaker';
import { blanketFactor, interactionShifts, type AirContext } from './sails/common';
import { kheff } from './aero';
import { G, KEEL, RUDDER, WINDAGE_POINT, crossFlow, foilForce, hullResistance, rightingMoment, windage } from './hydro';
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
const RHO_W = 1025;

/** Crew/autopilot hook run before each physics step (auto-trim, manoeuvres). */
export interface CrewHook {
  maneuver: SimSnapshot['maneuver'];
  update(dt: number, sim: Simulation): void;
}

interface StepForces { X: number; Y: number; N: number; K: number; report: ForceReport }

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const momentOf = (p: Vec3, f: Vec3): Vec3 => {
  const rx = p.x - CG.x, ry = p.y - CG.y, rz = p.z - CG.z;
  return { x: ry * f.z - rz * f.y, y: rz * f.x - rx * f.z, z: rx * f.y - ry * f.x };
};

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

  constructor(init: ScenarioInit) {
    this.reset(init);
  }

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

    // Start with the sails on the correct side for the wind.
    const twa = twaOf(this.boat.psi, init.wind.twd);
    const side: 1 | -1 = twa >= 0 ? 1 : -1;
    this.main.tackSign = side;
    const lim = this.main.limits(this.controls);
    this.main.beta = side > 0 ? lim.hi : lim.lo;
    this.jib.workingSide = side;
    this.jib.gamma = side * sheetingAngle(this.controls.jibLead);
    if (side > 0) { this.jib.sheetPort = this.controls.jibSheet; this.jib.sheetStbd = 0; }
    else { this.jib.sheetStbd = this.controls.jibSheet; this.jib.sheetPort = 0; }
    this.spin.windwardSide = side;
    if (init.spinnakerSet) {
      this.spin.hoist = 1;
      this.controls.spinHoist = true;
      this.controls.jibFurl = 1;
      this.jib.furl = 1;
    }
    if (this.towed) this.boat.u = this.towed.speed;
    this.updateDerived();
    this.forces = this.computeForces(0).report;
  }

  setWind(patch: Partial<WindSettings>): void { this.wind.setSettings(patch); }

  setTowed(t: { speed: number } | null): void {
    this.towed = t;
    if (t) { this.boat.u = t.speed; this.boat.v = 0; this.boat.r = 0; }
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
    const b = this.boat;
    const c = this.controls;
    this.t += dt;
    this.wind.step(dt, b.e, b.n);
    this.updateDerived();
    this.crew?.update(dt, this);

    // Helm → rudder (rate-limited). The crew may override during manoeuvres.
    const target = this.rudderOverride !== null
      ? this.rudderOverride
      : c.helmMode === 'manual'
        ? clamp(c.tiller, -1, 1) * MAX_RUDDER
        : this.helmsman.command(c.helmMode, c.helmTarget, { heading: b.psi, twa: this.twa, awa: this.awa, r: b.r, speed: this.speed }, dt);
    b.rudder += clamp(target - b.rudder, -RUDDER_RATE * dt, RUDDER_RATE * dt);

    // Crew weight: hike to windward when sailing across/up the wind, counter-balance downwind.
    let hike: number;
    if (typeof c.crewHike === 'number') hike = clamp(c.crewHike, -1, 1);
    else if (Math.abs(this.twa) < 110 * DEG) hike = Math.sign(this.twa || 1) * clamp(0.35 + smoothstep(2 * DEG, 12 * DEG, Math.abs(b.phi)), 0, 1);
    else hike = -Math.sign(b.phi) * 0.6 * smoothstep(4 * DEG, 14 * DEG, Math.abs(b.phi));
    b.crewY += clamp(hike - b.crewY, -0.8 * dt, 0.8 * dt);

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
    this.events.update({
      t: this.t,
      dt,
      twa: this.twa,
      speed: this.speed,
      heel: b.phi,
      yawRate: b.r,
      rudder: b.rudder,
      crashRate: this.main.crashRate,
      spinEvents: this.spin.events,
      mainLuffing: avg(mainSecs),
      jibLuffing: avg(jibSecs),
      jibSet: this.jib.furl < 0.97,
      mainLuffBubble: avg(mainSecs.slice(2, 6)),
      mainLeechFull: mainSecs.slice(2, 6).every((x) => x.stall < 0.9) && avg(mainSecs) < 0.6,
    });
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

    const mEv = this.main.step(dt, c, air, shift, 1, awaRef);
    const jEv = this.jib.step(dt, c, air, shift.jib, blJib, awaRef);
    const spinActive = this.spin.hoist > 0 || c.spinHoist || !this.spin.last;
    const sEv = spinActive ? this.spin.step(dt, c, air, blSpin, awaRef, awsRef) : this.spin.last!;
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
    const q = 0.5 * 1.225 * awsRef * awsRef;
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
    const rudWater = waterRel(RUDDER.point);
    const Ur = Math.hypot(rudWater.x, rudWater.y);
    const eps = (0.5 * 2 * Math.abs(keelFoil.cl)) / (Math.PI * KEEL.arEff);
    rudWater.y -= Math.sign(keel.y) * Math.min(eps, 0.15) * Ur;
    const vent = 1 - 0.6 * smoothstep(30 * DEG, 50 * DEG, Math.abs(b.phi));
    const rud0 = foilForce(RUDDER, rudWater, b.rudder).force;
    const rudder = { x: rud0.x * vent, y: rud0.y * vent, z: 0 };
    Fb = add(add(Fb, keel), rudder);
    Mb = add(add(Mb, momentOf(KEEL.point, keel)), momentOf(RUDDER.point, rudder));

    // Resolve into the level heading frame.
    const Fh = rotX(Fb, b.phi);
    const Mh = rotX(Mb, b.phi);
    const U = Math.hypot(b.u, b.v);
    const res = hullResistance(U, b.phi).total * (b.u < 0 ? 1.5 : 1);
    const rx = U > 1e-4 ? (res * b.u) / U : 0;
    const ry = U > 1e-4 ? (res * b.v) / U : 0;
    const cf = crossFlow(b.v, b.r);
    const kRight = rightingMoment(b.phi);
    const crewY = b.crewY * BOAT.mass.crewHikeY;
    const kCrew = BOAT.mass.crew * G * crewY * Math.cos(b.phi);

    // A heeled hull is asymmetric in the water and turns its bow toward the wind (grows with heel²);
    // with the rudder losing grip at big heel this is what makes an over-powered boat round up.
    const hullAsym = -Math.sign(b.phi) * HULL_ASYM * 0.5 * RHO_W * U * U * BOAT.hull.lateralArea * BOAT.hull.lwl * Math.sin(b.phi) ** 2;

    // Munk moment: a slender hull moving at a drift angle is turned further across the flow (destabilising).
    // Sliding to leeward it swings the bow to windward — why real boats carry weather helm although the
    // sails' centre of effort sits ahead of the keel. Reduced for stern separation.
    const munk = -MUNK * (MY - MX) * b.u * b.v;

    const X = Fh.x - rx;
    const Y = Fh.y - ry + cf.Y;
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
