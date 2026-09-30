// Force vectors (spec §8), consistent with the simulation's force report:
//  * Aerodynamic force (red): everything the air does to the boat — the sails, their induced drag and the windage of
//    hull, rig and crew — drawn horizontal from the sails' centre of effort and split into drive (green, along the
//    heading) and heeling force (purple, across it). These are exactly `forces.drive` and `forces.sideForce`, the
//    numbers lesson 6 and the Sail Lab use; the parallelogram is dashed in.
//  * Each sail's lift (⟂ to the apparent wind at its centre of effort) and drag (∥, including its share of the sail
//    set's induced drag), plus the windage: together they add up to the red arrow.
//  * Keel lift (cyan), rudder force and hull resistance under water; the righting couple once the boat heels (weight
//    down at G, buoyancy up at B, the lever GZ = righting moment ÷ weight); a helm-balance tag at the tiller.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { airVelocityBody } from '../../sim/apparent';
import { WINDAGE_POINT, windage } from '../../sim/hydro';
import { gradientFactor } from '../../sim/wind';
import type { SailState, SimSnapshot } from '../../sim/types';
import { DEG } from '../../shared/math';
import { ARROW_BOLD, ARROW_MEDIUM, ARROW_THIN, type ArrowBatch, type ArrowStyle } from './arrows';
import { pointWind, windAtBodyPoint, type BoatFrame } from './frames';
import type { Label, LabelLayer } from './labels';
import type { LineBatch } from './lines';
import { COLORS, linearColor } from './palette';

/** Metres of arrow per newton, shrinking so the longest arrow stays under this length. */
const M_PER_N = 1 / 300;
const LONGEST = 5.2;
/** Weight and buoyancy are ~16 kN — drawn at a fixed length; their lever arm is the lesson. */
const COUPLE_LEN = 1.9;
const RESISTANCE_POINT = { x: -0.35, y: 0, z: 0.18 };
const TILLER_TAG = { x: -2.2, y: 0, z: -0.95 };
const WEIGHT_N = BOAT.mass.total * 9.81;
/** Height (m) at which the simulation takes the wind for windage. */
const WINDAGE_WIND_H = 2.5;

const C = {
  aero: linearColor(COLORS.sailForce),
  drive: linearColor(COLORS.drive),
  heel: linearColor(COLORS.heel),
  keel: linearColor(COLORS.keel),
  rudder: linearColor(COLORS.rudder),
  resistance: linearColor(COLORS.resistance),
  lift: linearColor(COLORS.lift),
  drag: linearColor(COLORS.drag),
  windage: linearColor(COLORS.boatWind),
  weight: linearColor(COLORS.weight),
  buoyancy: linearColor(COLORS.buoyancy),
  white: linearColor(COLORS.white),
};

const PRIMARY: ArrowStyle = { ...ARROW_BOLD, hidden: 0.8 };
const COMPONENT: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.75 };
const UNDERWATER: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.6 };
const UNDERWATER_XRAY: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.95 };
const RUDDER: ArrowStyle = { ...UNDERWATER, width: 3, head: 12, headWidth: 10 };
const RUDDER_XRAY: ArrowStyle = { ...UNDERWATER_XRAY, width: 3, head: 12, headWidth: 10 };
const COUPLE: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.5 };
const COUPLE_XRAY: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.9 };
const SAIL_PART: ArrowStyle = { ...ARROW_THIN, alpha: 0.9, hidden: 0.4 };
const DASHED = { width: 1.6, alpha: 0.55, dash: 0.28, duty: 0.55 };
const GZ_BAR = { width: 2, alpha: 0.85 };

export const fmtForce = (n: number): string => (Math.abs(n) < 995 ? `${Math.round(n)} N` : `${(n / 1000).toFixed(2)} kN`);

const SAIL_NAMES: Record<SailState['id'], string> = { main: 'Main', jib: 'Jib', spinnaker: 'Spinnaker' };

/** Sail pieces for one frame: horizontal force (heading frame) and lift magnitude, per sail. */
interface Piece { sail: SailState; fx: number; fy: number; wx: number; wy: number; lift: number }

/**
 * Split of the simulation's aerodynamic force into its sources, in the heading frame (x along the heading, y to
 * starboard, horizontal): the sails' own forces, the sail set's induced drag and the windage. Uses the simulation's
 * own windage model and air kinematics, so `sails + induced + windage` equals `forces.aero` exactly.
 */
export interface AeroSplit {
  windage: { x: number; y: number };
  induced: { x: number; y: number };
  /** Sails included in the simulation's sum (the spinnaker counts once it starts going up). */
  sails: SailState[];
}

const windEN = { e: 0, n: 0 };
const kin = { heading: 0, heel: 0, u: 0, v: 0, r: 0, p: 0 };

export function aeroSplit(s: SimSnapshot, out: AeroSplit): AeroSplit {
  const b = s.boat;
  const c = Math.cos(b.heel), sn = Math.sin(b.heel);
  const speed = s.wind.tws * gradientFactor(WINDAGE_WIND_H);
  windEN.e = -speed * Math.sin(s.wind.twd);
  windEN.n = -speed * Math.cos(s.wind.twd);
  kin.heading = b.heading; kin.heel = b.heel; kin.u = b.u; kin.v = b.v; kin.r = b.yawRate; kin.p = b.rollRate;
  const fw = windage(airVelocityBody(WINDAGE_POINT, kin, windEN));
  out.sails.length = 0;
  out.sails.push(s.sails.main, s.sails.jib);
  if (s.sails.spinnaker.hoist > 0) out.sails.push(s.sails.spinnaker);
  const a = s.forces.aero.force;
  let ix = a.x - fw.x, iy = a.y - fw.y, iz = a.z - fw.z;
  for (const sail of out.sails) { ix -= sail.force.x; iy -= sail.force.y; iz -= sail.force.z; }
  // Body → heading frame (rotation about x by the heel), horizontal part.
  out.windage.x = fw.x;
  out.windage.y = fw.y * c - fw.z * sn;
  out.induced.x = ix;
  out.induced.y = iy * c - iz * sn;
  return out;
}

export class ForceOverlay {
  private scale = M_PER_N;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly xH = new THREE.Vector3();
  private readonly yH = new THREE.Vector3();
  private readonly tipDrive = new THREE.Vector3();
  private readonly tipHeel = new THREE.Vector3();
  private readonly tipTotal = new THREE.Vector3();
  private readonly g = new THREE.Vector3();
  private readonly pw = pointWind();
  private readonly split: AeroSplit = { windage: { x: 0, y: 0 }, induced: { x: 0, y: 0 }, sails: [] };
  private readonly pieces: Piece[] = [0, 1, 2].map(() => ({ sail: null as unknown as SailState, fx: 0, fy: 0, wx: 1, wy: 0, lift: 0 }));
  private readonly buf = new Float32Array(6);
  private readonly labels;

  constructor(private readonly arrows: ArrowBatch, private readonly lines: LineBatch, layer: LabelLayer) {
    const mk = (color: string, priority: number, kind: 'value' | 'tag' = 'value') => layer.create({ color, priority, kind });
    this.labels = {
      total: mk(COLORS.sailForce, 9),
      drive: mk(COLORS.drive, 8),
      heel: mk(COLORS.heel, 8),
      keel: mk(COLORS.keel, 7),
      rudder: mk(COLORS.rudder, 4),
      resistance: mk(COLORS.resistance, 6),
      windage: mk(COLORS.boatWind, 3),
      weight: mk(COLORS.weight, 5),
      buoyancy: mk(COLORS.buoyancy, 5),
      helm: mk(COLORS.white, 7, 'tag'),
      sails: {
        main: { lift: mk(COLORS.lift, 3), drag: mk(COLORS.drag, 2) },
        jib: { lift: mk(COLORS.lift, 3), drag: mk(COLORS.drag, 2) },
        spinnaker: { lift: mk(COLORS.lift, 3), drag: mk(COLORS.drag, 2) },
      } as Record<SailState['id'], { lift: Label; drag: Label }>,
    };
  }

  update(dt: number, s: SimSnapshot, frame: BoatFrame, xray: boolean): void {
    const f = s.forces;
    const L = this.labels;
    const fA = f.aero.force;
    const biggest = Math.max(Math.hypot(fA.x, fA.y, fA.z), Math.hypot(f.keel.force.x, f.keel.force.y), 1);
    const target = Math.min(M_PER_N, LONGEST / biggest);
    this.scale += (target - this.scale) * Math.min(1, dt / 1.2);
    const k = this.scale;
    // Heading-frame axes in the world: x along the heading, y to starboard, both horizontal.
    const psi = s.boat.heading;
    this.xH.set(Math.sin(psi), 0, -Math.cos(psi));
    this.yH.set(Math.cos(psi), 0, Math.sin(psi));

    // Aerodynamic force and its drive / heeling split, horizontal, from the centre of effort.
    const ce = f.aero.point;
    frame.point(ce.x, ce.y, ce.z, this.a);
    this.tipDrive.copy(this.a).addScaledVector(this.xH, f.drive * k);
    this.tipHeel.copy(this.a).addScaledVector(this.yH, f.sideForce * k);
    this.tipTotal.copy(this.tipDrive).addScaledVector(this.yH, f.sideForce * k);
    this.arrows.add(this.a, this.tipDrive, C.drive, COMPONENT);
    this.arrows.add(this.a, this.tipHeel, C.heel, COMPONENT);
    this.arrows.add(this.a, this.tipTotal, C.aero, PRIMARY);
    this.dashed(this.tipDrive, this.tipTotal);
    this.dashed(this.tipHeel, this.tipTotal);
    L.total.text('Aerodynamic force', fmtForce(Math.hypot(f.drive, f.sideForce))).tip(this.tipTotal, this.a);
    L.drive.text('Drive', fmtForce(f.drive)).tip(this.tipDrive, this.a);
    L.heel.text('Heeling force', fmtForce(Math.abs(f.sideForce))).tip(this.tipHeel, this.a);

    // Its sources: each sail's lift and drag (with its share of the induced drag), and the windage.
    this.sailParts(s, frame, k);
    const w = this.split.windage;
    frame.point(WINDAGE_POINT.x, WINDAGE_POINT.y, WINDAGE_POINT.z, this.b);
    this.v.copy(this.b).addScaledVector(this.xH, w.x * k).addScaledVector(this.yH, w.y * k);
    const wN = Math.hypot(w.x, w.y);
    this.arrows.add(this.b, this.v, C.windage, SAIL_PART, wN > 15 ? 1 : 0);
    if (wN * k > 0.3) L.windage.text('Windage', fmtForce(wN)).tip(this.v, this.b); else L.windage.hide();

    // Underwater: keel, rudder, hull resistance (drawn through the water, brighter with x-ray).
    const uw = xray ? UNDERWATER_XRAY : UNDERWATER;
    const kf = f.keel.force, kp = f.keel.point;
    frame.point(kp.x, kp.y, kp.z, this.a);
    frame.vector(kf.x * k, kf.y * k, kf.z * k, this.v);
    this.b.copy(this.a).add(this.v);
    this.arrows.add(this.a, this.b, C.keel, uw);
    L.keel.text('Keel lift', fmtForce(Math.hypot(kf.x, kf.y))).tip(this.b, this.a);

    const rf = f.rudder.force, rp = f.rudder.point;
    frame.point(rp.x, rp.y, rp.z, this.a);
    frame.vector(rf.x * k, rf.y * k, rf.z * k, this.v);
    this.b.copy(this.a).add(this.v);
    const rudderN = Math.hypot(rf.x, rf.y);
    this.arrows.add(this.a, this.b, C.rudder, xray ? RUDDER_XRAY : RUDDER, rudderN > 5 ? 1 : 0);
    if (rudderN * k > 0.3) L.rudder.text('Rudder', fmtForce(rudderN)).tip(this.b, this.a); else L.rudder.hide();

    const U = Math.hypot(s.boat.u, s.boat.v);
    if (U > 0.05 && f.resistance > 1) {
      // Resistance opposes the motion through the water, horizontally (as the simulation applies it).
      frame.point(RESISTANCE_POINT.x, RESISTANCE_POINT.y, RESISTANCE_POINT.z, this.a);
      this.b.copy(this.a).addScaledVector(this.xH, -f.resistance * (s.boat.u / U) * k).addScaledVector(this.yH, -f.resistance * (s.boat.v / U) * k);
      this.arrows.add(this.a, this.b, C.resistance, uw);
      L.resistance.text('Hull resistance', fmtForce(f.resistance)).tip(this.b, this.a);
    } else {
      L.resistance.hide();
    }

    this.couple(s, frame, xray);
    this.helm(s, frame);
  }

  hide(): void {
    const L = this.labels;
    for (const l of [L.total, L.drive, L.heel, L.keel, L.rudder, L.resistance, L.windage, L.weight, L.buoyancy, L.helm]) l.hide();
    for (const p of Object.values(L.sails)) { p.lift.hide(); p.drag.hide(); }
  }

  private sailParts(s: SimSnapshot, frame: BoatFrame, k: number): void {
    const split = aeroSplit(s, this.split);
    const c = Math.cos(s.boat.heel), sn = Math.sin(s.boat.heel);
    let n = 0;
    let liftSum = 0;
    for (const sail of split.sails) {
      const p = this.pieces[n++]!;
      p.sail = sail;
      // Horizontal part of the sail's force (heading frame) and the horizontal apparent wind at its centre of effort.
      p.fx = sail.force.x;
      p.fy = sail.force.y * c - sail.force.z * sn;
      windAtBodyPoint(s, sail.ce.x, sail.ce.y, sail.ce.z, this.pw);
      const ax = this.pw.appW.dot(this.xH), ay = this.pw.appW.dot(this.yH);
      const al = Math.hypot(ax, ay) || 1;
      p.wx = ax / al;
      p.wy = ay / al;
      const along = p.fx * p.wx + p.fy * p.wy;
      p.lift = Math.hypot(p.fx - along * p.wx, p.fy - along * p.wy);
      liftSum += p.lift;
    }
    const ind = split.induced;
    for (let i = 0; i < 3; i++) {
      const id = i === 0 ? 'main' : i === 1 ? 'jib' : 'spinnaker';
      const lab = this.labels.sails[id];
      let p: Piece | null = null;
      for (let j = 0; j < n; j++) if (this.pieces[j]!.sail.id === id) p = this.pieces[j]!;
      if (!p || !p.sail.set || Math.hypot(p.fx, p.fy) < 2) { lab.lift.hide(); lab.drag.hide(); continue; }
      const share = liftSum > 1e-6 ? p.lift / liftSum : 1 / n;
      const along = p.fx * p.wx + p.fy * p.wy;
      const liftX = p.fx - along * p.wx, liftY = p.fy - along * p.wy;
      const dragX = along * p.wx + share * ind.x, dragY = along * p.wy + share * ind.y;
      const ce = p.sail.ce;
      frame.point(ce.x, ce.y, ce.z, this.a);
      this.b.copy(this.a).addScaledVector(this.xH, liftX * k).addScaledVector(this.yH, liftY * k);
      this.arrows.add(this.a, this.b, C.lift, SAIL_PART);
      lab.lift.text(`${SAIL_NAMES[id]} lift`, fmtForce(Math.hypot(liftX, liftY))).tip(this.b, this.a);
      this.b.copy(this.a).addScaledVector(this.xH, dragX * k).addScaledVector(this.yH, dragY * k);
      this.arrows.add(this.a, this.b, C.drag, SAIL_PART);
      const drag = Math.hypot(dragX, dragY);
      if (drag * k > 0.35) lab.drag.text(`${SAIL_NAMES[id]} drag`, fmtForce(drag)).tip(this.b, this.a);
      else lab.drag.hide();
    }
  }

  /** Weight down through G, buoyancy up through B: the couple that rights the boat, lever arm GZ. */
  private couple(s: SimSnapshot, frame: BoatFrame, xray: boolean): void {
    const L = this.labels;
    const f = s.forces;
    if (Math.abs(s.boat.heel) < 3 * DEG) { L.weight.hide(); L.buoyancy.hide(); return; }
    const style = xray ? COUPLE_XRAY : COUPLE;
    frame.point(f.cg.x, f.cg.y, f.cg.z, this.g);
    this.b.copy(this.g);
    this.b.y -= COUPLE_LEN;
    this.arrows.add(this.g, this.b, C.weight, style);
    L.weight.text('Weight', fmtForce(WEIGHT_N)).tip(this.b, this.g);
    // B sits GZ = righting moment ÷ weight to leeward of G (heel > 0: starboard side down, B moves to starboard).
    const gz = Math.abs(f.rightingMoment) / WEIGHT_N;
    this.a.copy(this.g).addScaledVector(this.yH, Math.sign(s.boat.heel) * gz);
    this.b.copy(this.a);
    this.b.y += COUPLE_LEN;
    this.arrows.add(this.a, this.b, C.buoyancy, style);
    L.buoyancy.text('Buoyancy', `righting moment ${(Math.abs(f.rightingMoment) / 1000).toFixed(1)} kN·m`).tip(this.b, this.a);
    // The lever arm GZ, a short horizontal bar between the two lines of action.
    this.buf[0] = this.g.x; this.buf[1] = this.g.y; this.buf[2] = this.g.z;
    this.buf[3] = this.a.x; this.buf[4] = this.a.y; this.buf[5] = this.a.z;
    this.lines.add(this.buf, 2, C.white, GZ_BAR);
  }

  private helm(s: SimSnapshot, frame: BoatFrame): void {
    // Weather helm: the rudder is held to turn the bow away from the wind (bear away).
    const side = Math.sign(s.wind.twa) || 1;
    const weather = (-side * s.boat.rudder) / DEG;
    const kind = Math.abs(weather) < 1 ? 'neutral' : weather > 0 ? 'weather' : 'lee';
    const color = kind === 'lee' ? '#7fb8ff' : weather > 8 ? '#ffb547' : '#3ee07f';
    frame.point(TILLER_TAG.x, TILLER_TAG.y, TILLER_TAG.z, this.a);
    this.labels.helm.color(color).text('Helm', kind === 'neutral' ? 'balanced' : `${Math.abs(weather).toFixed(1)}° ${kind} helm`).at(this.a, 0, 22);
  }

  private dashed(from: THREE.Vector3, to: THREE.Vector3): void {
    this.buf[0] = from.x; this.buf[1] = from.y; this.buf[2] = from.z;
    this.buf[3] = to.x; this.buf[4] = to.y; this.buf[5] = to.z;
    this.lines.add(this.buf, 2, C.white, DASHED);
  }
}
