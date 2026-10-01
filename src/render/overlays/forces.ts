// Force vectors (spec §8), consistent with the simulation's force report:
//  * Aerodynamic force (red): everything the air does to the boat — the sails, their induced drag and the windage of
//    hull, rig and crew — drawn horizontal from the sails' centre of effort and split into drive (green, along the
//    heading) and heeling force (purple, across it). These are exactly `forces.drive` and `forces.sideForce`, the
//    numbers lesson 6 and the Sail Lab use; the parallelogram is dashed in.
//  * Each sail's lift (⟂ to the apparent wind at its centre of effort) and drag (∥, including its share of the sail
//    set's induced drag), plus the windage: together they add up to the red arrow.
//  * Keel lift (cyan), rudder force and hull resistance under water; the righting couple once the boat heels (weight
//    down at G, buoyancy up at B, the lever GZ = righting moment ÷ weight); a helm-balance tag at the tiller.
//
// A lesson step can reduce the overlay to the pieces it talks about (`setParts`). Asked for without the red total, a
// sail's lift and drag become the main picture, a textbook figure drawn on the real sail: its section at the height of the
// centre of effort, the apparent wind (amber) arriving at the luff, lift (pink) at right angles to it and drag
// (lilac) along it — and, with the angle-of-attack overlay on, the chord line and the angle between it and the wind,
// in the groove meter's colours. While the boat is towed (the sail lab) the underwater forces, the righting couple
// and the helm tag are left out: the tow, not the keel, holds the boat there.
//
// Arrow lengths are metres per newton, the same for every arrow in the picture. The scale grows with the camera's
// distance so the arrows keep a readable size on screen in the top view too.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { airVelocityBody } from '../../sim/apparent';
import { WINDAGE_POINT, windage } from '../../sim/hydro';
import { gradientFactor } from '../../sim/wind';
import type { ForcePart } from '../../lessons/types';
import type { SailState, SimSnapshot } from '../../sim/types';
import { DEG, KN } from '../../shared/math';
import { ARROW_BOLD, ARROW_MEDIUM, ARROW_THIN, type ArrowBatch, type ArrowStyle } from './arrows';
import { CAMBER_PTS, newSliceElement, sailCutAt } from './flowField';
import { hyp, pointWind, windAtBodyPoint, type BoatFrame } from './frames';
import type { Label, LabelLayer } from './labels';
import type { LineBatch } from './lines';
import { COLORS, linearColor } from './palette';

/** Metres of arrow per newton, shrinking so the longest arrow stays under this length (at the chase camera's distance). */
const M_PER_N = 1 / 300;
const LONGEST = 5.2;
/**
 * A reduced set of pieces is the subject of the picture, and its forces may be small (a lone mainsail in 10 kn makes
 * ~300 N): a larger scale, set by the largest of the drawn forces seen since the set was chosen and held for as long
 * as it stays chosen — so an arrow visibly shrinks when the sail luffs or is depowered and grows back when it is
 * trimmed, instead of the scale following it.
 */
const M_PER_N_FOCUS = 1 / 55;
const LONGEST_FOCUS = 3.6;
/**
 * The lift/drag picture: the apparent-wind arrow is this long per m/s of wind and stops `GAUGE_R` short of the luff;
 * the chord line runs on that far ahead of the luff, and the angle-of-attack arc sits between the two.
 */
const WIND_M_PER_MS = 0.42;
const GAUGE_R = 2.1;
const ARC_PTS = 9;
/** Weight and buoyancy are ~16 kN — drawn at a fixed length; their lever arm is the lesson. */
const COUPLE_LEN = 1.9;
const RESISTANCE_POINT = { x: -0.35, y: 0, z: 0.18 };
const TILLER_TAG = { x: -2.2, y: 0, z: -0.95 };
const WEIGHT_N = BOAT.mass.total * 9.81;
/** Height (m) at which the simulation takes the wind for windage. */
const WINDAGE_WIND_H = 2.5;

/** One bit per piece of the overlay. */
const BIT: Readonly<Record<ForcePart, number>> = {
  total: 1, drive: 2, heel: 4, liftDrag: 8, windage: 16, keel: 32, rudder: 64, resistance: 128, righting: 256, helm: 512,
};
const ALL = 1023;

/** Left out while the boat is towed. */
const NOT_UNDER_TOW = BIT.keel | BIT.rudder | BIT.resistance | BIT.righting | BIT.helm;

const C = {
  wind: linearColor(COLORS.apparentWind),
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
  luffing: linearColor(COLORS.luffing),
  groove: linearColor(COLORS.groove),
  stalled: linearColor(COLORS.stalled),
  casing: new THREE.Color('#04101f'),
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
/** Drag in the lift/drag picture: often a tenth of the lift, so a fine arrow that still reads at 20 px. */
const DRAG_MAIN: ArrowStyle = { width: 3.6, head: 14, headWidth: 12, glow: 4, alpha: 1, hidden: 0.75 };
/** Dash period (m) of the construction lines at the chase camera's distance; it grows with the view scale. */
const DASH_M = 0.28;
const GZ_BAR = { width: 2, alpha: 0.85 };
/** The sail's section in the lift/drag picture: a bright line on a dark casing. */
const SECTION_CASING = { width: 10.5, alpha: 0.85 };
const SECTION = { width: 4.6, alpha: 1 };
const ARC = { width: 3.2, alpha: 1, glow: 2 };

export const fmtForce = (n: number): string => (Math.abs(n) < 995 ? `${Math.round(n)} N` : `${(n / 1000).toFixed(2)} kN`);

const SAIL_NAMES: Record<SailState['id'], string> = { main: 'Main', jib: 'Jib', spinnaker: 'Spinnaker' };
const SAIL_IDS: readonly SailState['id'][] = ['main', 'jib', 'spinnaker'];
const LIFT_NAMES: Record<SailState['id'], string> = { main: 'Main lift', jib: 'Jib lift', spinnaker: 'Spinnaker lift' };
const DRAG_NAMES: Record<SailState['id'], string> = { main: 'Main drag', jib: 'Jib drag', spinnaker: 'Spinnaker drag' };
const AOA_NAMES: Record<SailState['id'], string> = { main: 'Main angle of attack', jib: 'Jib angle of attack', spinnaker: 'Spinnaker angle of attack' };

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

/** Largest force among the arrows a reduced set draws (N, at least 1); the righting couple has a fixed length. */
function drawnMax(s: SimSnapshot, m: number, onSail: boolean): number {
  const f = s.forces;
  let n = 1;
  if (m & BIT.total) n = Math.max(n, hyp(f.drive, f.sideForce));
  if (m & BIT.drive) n = Math.max(n, Math.abs(f.drive));
  if (m & BIT.heel) n = Math.max(n, Math.abs(f.sideForce));
  if (m & BIT.liftDrag || onSail) {
    // A sail's lift and drag are each no longer than its horizontal force plus its share of the induced drag.
    const c = Math.cos(s.boat.heel), sn = Math.sin(s.boat.heel);
    for (const sail of [s.sails.main, s.sails.jib, s.sails.spinnaker]) {
      if (sail.set) n = Math.max(n, hyp(sail.force.x, sail.force.y * c - sail.force.z * sn));
    }
  }
  if (m & BIT.keel) n = Math.max(n, hyp(f.keel.force.x, f.keel.force.y));
  if (m & BIT.rudder) n = Math.max(n, hyp(f.rudder.force.x, f.rudder.force.y));
  if (m & BIT.resistance) n = Math.max(n, f.resistance);
  return n;
}

export class ForceOverlay {
  private scale = M_PER_N;
  private mask = ALL;
  private reduced = false;
  /** Largest drawn force (N) since the reduced set was chosen: sets its scale, and never decays. */
  private peak = 0;
  /** Just switched on or re-configured: take the scale at once instead of easing to it. */
  private fresh = true;
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
  private readonly cut = newSliceElement();
  private readonly section = new Float32Array(3 * CAMBER_PTS);
  private readonly arc = new Float32Array(3 * ARC_PTS);
  private readonly luff = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  /** Axis the angle-of-attack arc turns about: from the chord toward the wind. */
  private readonly axis = new THREE.Vector3();
  private readonly sectionColor = new THREE.Color();
  /** Construction lines (parallelograms; the chord and wind lines of the angle of attack): the dash period follows the view scale. */
  private readonly dash = { width: 1.6, alpha: 0.55, dash: DASH_M, duty: 0.55 };
  private readonly ray = { width: 2, alpha: 0.85, dash: DASH_M, duty: 0.6 };
  private readonly labels;

  constructor(private readonly arrows: ArrowBatch, private readonly lines: LineBatch, layer: LabelLayer) {
    const mk = (color: string, priority: number, kind: 'value' | 'tag' = 'value') => layer.create({ color, priority, kind });
    const sail = () => ({ lift: mk(COLORS.lift, 3), drag: mk(COLORS.drag, 2), aoa: mk(COLORS.groove, 4) });
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
      wind: mk(COLORS.apparentWind, 5),
      sails: { main: sail(), jib: sail(), spinnaker: sail() } as Record<SailState['id'], { lift: Label; drag: Label; aoa: Label }>,
    };
  }

  /**
   * A lesson asked for the figure on the sail (lift and drag, or the drive, without the red total): other overlays
   * then keep their own tags out of the picture.
   */
  get figureWanted(): boolean {
    return this.reduced && (this.mask & BIT.total) === 0 && (this.mask & (BIT.liftDrag | BIT.drive)) !== 0;
  }

  /** Draw only these pieces of the overlay; `null` draws them all. */
  setParts(parts: readonly ForcePart[] | null): void {
    let mask = ALL;
    if (parts) {
      mask = 0;
      for (const p of parts) mask |= BIT[p] ?? 0;
    }
    if (mask === this.mask && (parts !== null) === this.reduced) return;
    this.mask = mask;
    this.reduced = parts !== null;
    this.peak = 0;
    this.hide();
  }

  /**
   * `viewScale` stretches the arrows for a distant camera (1 at the chase camera's distance): arrow lengths are
   * world metres, and a top view from 70 m would otherwise show them a quarter the size. `sliceOn`: the flow slice
   * already draws the sails' sections; `aoaOn`: the angle-of-attack overlay is on (the lift/drag picture then shows
   * the angle itself).
   */
  update(dt: number, s: SimSnapshot, frame: BoatFrame, xray: boolean, viewScale = 1, sliceOn = false, aoaOn = false): void {
    const f = s.forces;
    this.dash.dash = this.ray.dash = DASH_M * viewScale;
    const L = this.labels;
    const m = s.towed ? this.mask & ~NOT_UNDER_TOW : this.mask;
    const fA = f.aero.force;
    const biggest = Math.max(Math.sqrt(fA.x * fA.x + fA.y * fA.y + fA.z * fA.z), m & BIT.keel ? hyp(f.keel.force.x, f.keel.force.y) : 0, 1);
    let target: number;
    if (this.reduced) {
      this.peak = Math.max(this.peak, drawnMax(s, m, this.figureWanted));
      target = Math.min(M_PER_N_FOCUS, LONGEST_FOCUS / this.peak) * viewScale;
    } else {
      target = Math.min(M_PER_N, LONGEST / biggest) * viewScale;
    }
    this.scale = this.fresh ? target : this.scale + (target - this.scale) * Math.min(1, dt / 1.2);
    this.fresh = false;
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
    // A reduced picture without the red total is drawn on the sail itself (see `figure`).
    const onSail = this.figureWanted;
    if (m & BIT.drive) {
      // On its own it is the subject of the picture.
      this.arrows.add(this.a, this.tipDrive, C.drive, m & (BIT.total | BIT.heel | BIT.liftDrag) ? COMPONENT : PRIMARY);
      L.drive.text('Drive', fmtForce(f.drive)).tip(this.tipDrive, this.a);
    } else L.drive.hide();
    if (m & BIT.heel) {
      this.arrows.add(this.a, this.tipHeel, C.heel, COMPONENT);
      L.heel.text('Heeling force', fmtForce(Math.abs(f.sideForce))).tip(this.tipHeel, this.a);
    } else L.heel.hide();
    if (m & BIT.total) {
      this.arrows.add(this.a, this.tipTotal, C.aero, PRIMARY);
      if (m & BIT.drive) this.dashed(this.tipDrive, this.tipTotal);
      if (m & BIT.heel) this.dashed(this.tipHeel, this.tipTotal);
      L.total.text('Aerodynamic force', fmtForce(hyp(f.drive, f.sideForce))).tip(this.tipTotal, this.a);
    } else L.total.hide();

    // Its sources: each sail's lift and drag (with its share of the induced drag), and the windage.
    // On the sail they are the picture itself; next to the red total, thin supporting arrows.
    if (m & BIT.liftDrag || onSail) this.sailParts(s, frame, k, viewScale, onSail, (m & BIT.liftDrag) !== 0, sliceOn, aoaOn);
    else this.hideSails();
    if (m & BIT.windage) {
      const w = (m & BIT.liftDrag ? this.split : aeroSplit(s, this.split)).windage;
      frame.point(WINDAGE_POINT.x, WINDAGE_POINT.y, WINDAGE_POINT.z, this.b);
      this.v.copy(this.b).addScaledVector(this.xH, w.x * k).addScaledVector(this.yH, w.y * k);
      const wN = hyp(w.x, w.y);
      this.arrows.add(this.b, this.v, C.windage, SAIL_PART, wN > 15 ? 1 : 0);
      if (wN * k > 0.3 * viewScale) L.windage.text('Windage', fmtForce(wN)).tip(this.v, this.b); else L.windage.hide();
    } else L.windage.hide();

    // Underwater: keel, rudder, hull resistance (drawn through the water, brighter with x-ray).
    const uw = xray ? UNDERWATER_XRAY : UNDERWATER;
    if (m & BIT.keel) {
      const kf = f.keel.force, kp = f.keel.point;
      frame.point(kp.x, kp.y, kp.z, this.a);
      frame.vector(kf.x * k, kf.y * k, kf.z * k, this.v);
      this.b.copy(this.a).add(this.v);
      this.arrows.add(this.a, this.b, C.keel, uw);
      L.keel.text('Keel lift', fmtForce(hyp(kf.x, kf.y))).tip(this.b, this.a);
    } else L.keel.hide();

    if (m & BIT.rudder) {
      const rf = f.rudder.force, rp = f.rudder.point;
      frame.point(rp.x, rp.y, rp.z, this.a);
      frame.vector(rf.x * k, rf.y * k, rf.z * k, this.v);
      this.b.copy(this.a).add(this.v);
      const rudderN = hyp(rf.x, rf.y);
      this.arrows.add(this.a, this.b, C.rudder, xray ? RUDDER_XRAY : RUDDER, rudderN > 5 ? 1 : 0);
      if (rudderN * k > 0.3 * viewScale) L.rudder.text('Rudder', fmtForce(rudderN)).tip(this.b, this.a); else L.rudder.hide();
    } else L.rudder.hide();

    const U = hyp(s.boat.u, s.boat.v);
    if (m & BIT.resistance && U > 0.05 && f.resistance > 1) {
      // Resistance opposes the motion through the water, horizontally (as the simulation applies it).
      frame.point(RESISTANCE_POINT.x, RESISTANCE_POINT.y, RESISTANCE_POINT.z, this.a);
      this.b.copy(this.a).addScaledVector(this.xH, -f.resistance * (s.boat.u / U) * k).addScaledVector(this.yH, -f.resistance * (s.boat.v / U) * k);
      this.arrows.add(this.a, this.b, C.resistance, uw);
      L.resistance.text('Hull resistance', fmtForce(f.resistance)).tip(this.b, this.a);
    } else {
      L.resistance.hide();
    }

    if (m & BIT.righting) this.couple(s, frame, xray, viewScale);
    else { L.weight.hide(); L.buoyancy.hide(); }
    if (m & BIT.helm) this.helm(s, frame);
    else L.helm.hide();
  }

  hide(): void {
    this.peak = 0;
    const L = this.labels;
    for (const l of [L.total, L.drive, L.heel, L.keel, L.rudder, L.resistance, L.windage, L.weight, L.buoyancy, L.helm]) l.hide();
    this.hideSails();
    this.fresh = true;
  }

  private hideSails(): void {
    const L = this.labels;
    for (let i = 0; i < SAIL_IDS.length; i++) {
      const p = L.sails[SAIL_IDS[i]!];
      p.lift.hide(); p.drag.hide(); p.aoa.hide();
    }
    L.wind.hide();
  }

  /**
   * Each sail's lift (⟂ to the apparent wind at its centre of effort) and drag (along it), when `arrows` is set.
   * `main`: the picture is drawn on the sail — its section, the apparent wind, the angle of attack — and lift and
   * drag, if shown, are bold.
   */
  private sailParts(s: SimSnapshot, frame: BoatFrame, k: number, viewScale: number, main: boolean, arrows: boolean, sliceOn: boolean, aoaOn: boolean): void {
    const split = aeroSplit(s, this.split);
    const c = Math.cos(s.boat.heel), sn = Math.sin(s.boat.heel);
    let n = 0;
    let liftSum = 0;
    let drawn = 0;
    for (const sail of split.sails) {
      const p = this.pieces[n++]!;
      p.sail = sail;
      // Horizontal part of the sail's force (heading frame) and the horizontal apparent wind at its centre of effort.
      p.fx = sail.force.x;
      p.fy = sail.force.y * c - sail.force.z * sn;
      windAtBodyPoint(s, sail.ce.x, sail.ce.y, sail.ce.z, this.pw);
      const ax = this.pw.appW.dot(this.xH), ay = this.pw.appW.dot(this.yH);
      const al = hyp(ax, ay) || 1;
      p.wx = ax / al;
      p.wy = ay / al;
      const along = p.fx * p.wx + p.fy * p.wy;
      p.lift = hyp(p.fx - along * p.wx, p.fy - along * p.wy);
      liftSum += p.lift;
      if (sail.set && hyp(p.fx, p.fy) >= 2) drawn++;
    }
    const ind = split.induced;
    const L = this.labels;
    let windDrawn = false;
    for (let i = 0; i < 3; i++) {
      const id = SAIL_IDS[i]!;
      const lab = L.sails[id];
      let p: Piece | null = null;
      for (let j = 0; j < n; j++) if (this.pieces[j]!.sail.id === id) p = this.pieces[j]!;
      if (!p || !p.sail.set || hyp(p.fx, p.fy) < 2) { lab.lift.hide(); lab.drag.hide(); lab.aoa.hide(); continue; }
      const share = liftSum > 1e-6 ? p.lift / liftSum : 1 / n;
      const along = p.fx * p.wx + p.fy * p.wy;
      const liftX = p.fx - along * p.wx, liftY = p.fy - along * p.wy;
      const dragX = along * p.wx + share * ind.x, dragY = along * p.wy + share * ind.y;
      const ce = p.sail.ce;
      const single = drawn === 1;
      if (main) {
        // First, so the arrows lie on top of the section and the construction lines.
        const first = !windDrawn;
        windDrawn = true;
        this.figure(s, frame, p, viewScale, sliceOn, aoaOn, first, single);
      } else {
        lab.aoa.hide();
      }
      if (!arrows) { lab.lift.hide(); lab.drag.hide(); continue; }
      frame.point(ce.x, ce.y, ce.z, this.a);
      // Drag, then lift on top of it.
      this.v.copy(this.a).addScaledVector(this.xH, dragX * k).addScaledVector(this.yH, dragY * k);
      this.arrows.add(this.a, this.v, C.drag, main ? DRAG_MAIN : SAIL_PART);
      const drag = hyp(dragX, dragY);
      if (main || drag * k > 0.35 * viewScale) lab.drag.text(main && single ? 'Drag' : DRAG_NAMES[id], fmtForce(drag)).tip(this.v, this.a);
      else lab.drag.hide();
      this.b.copy(this.a).addScaledVector(this.xH, liftX * k).addScaledVector(this.yH, liftY * k);
      this.arrows.add(this.a, this.b, C.lift, main ? PRIMARY : SAIL_PART);
      lab.lift.text(main && single ? 'Lift' : LIFT_NAMES[id], fmtForce(hyp(liftX, liftY))).tip(this.b, this.a);
    }
    if (!windDrawn) L.wind.hide();
  }

  /**
   * The figure behind a sail's lift and drag: its section at the height of the centre of effort (from above the
   * cloth itself is a hairline), the apparent wind arriving at the luff (for the first sail), and — with the
   * angle-of-attack overlay on — the chord line run on ahead of the luff and the angle between it and the wind,
   * coloured as the groove meter shows it.
   */
  private figure(s: SimSnapshot, frame: BoatFrame, p: Piece, viewScale: number, sliceOn: boolean, aoaOn: boolean, wind: boolean, single: boolean): void {
    const L = this.labels;
    const sail = p.sail;
    const lab = L.sails[sail.id];
    const h = -sail.ce.z;
    const R = GAUGE_R * viewScale;
    // The groove, read as the trim panel reads it: means over the sail's sections.
    let aoa = 0, luffing = 0, stall = 0;
    const secs = sail.sections;
    for (let i = 0; i < secs.length; i++) { const sec = secs[i]!; aoa += sec.aoa; luffing += sec.luffing; stall += sec.stall; }
    if (secs.length > 0) { aoa /= secs.length; luffing /= secs.length; stall /= secs.length; }
    const state = luffing > 0.35 ? 0 : stall > 0.35 ? 2 : 1;
    const stateColor = state === 0 ? C.luffing : state === 2 ? C.stalled : C.groove;
    const cut = this.cut;
    const hasCut = sailCutAt(sail, h, cut);
    // Unit vectors in the world: up the apparent wind, and along the chord from the leech through the luff.
    this.up.copy(this.xH).multiplyScalar(-p.wx).addScaledVector(this.yH, -p.wy);
    if (hasCut) {
      frame.point(cut.leX, cut.leY, -h, this.luff);
      frame.vector(-cut.dirX, -cut.dirY, 0, this.fwd).normalize();
      if (!sliceOn) {
        for (let q = 0; q < CAMBER_PTS; q++) {
          frame.point(cut.pts[2 * q]!, cut.pts[2 * q + 1]!, -h, this.g);
          this.section[3 * q] = this.g.x; this.section[3 * q + 1] = this.g.y; this.section[3 * q + 2] = this.g.z;
        }
        if (aoaOn) this.sectionColor.copy(C.groove).lerp(C.luffing, Math.min(1, luffing * 1.6)).lerp(C.stalled, Math.min(1, stall * 1.6));
        else this.sectionColor.copy(C.white);
        this.lines.add(this.section, CAMBER_PTS, C.casing, SECTION_CASING);
        this.lines.add(this.section, CAMBER_PTS, this.sectionColor, SECTION);
      }
    } else {
      frame.point(sail.ce.x, sail.ce.y, sail.ce.z, this.luff);
    }
    if (wind) {
      // The apparent wind the split is measured against, arriving at the luff.
      windAtBodyPoint(s, sail.ce.x, sail.ce.y, sail.ce.z, this.pw);
      const aws = this.pw.appW.length();
      if (aws > 0.3) {
        const len = Math.min(Math.max(aws * WIND_M_PER_MS, 1.4), 3.4) * viewScale;
        this.b.copy(this.luff).addScaledVector(this.up, R);
        this.v.copy(this.b).addScaledVector(this.up, len);
        this.arrows.add(this.v, this.b, C.wind, COMPONENT);
        L.wind.text('Apparent wind', `${(aws / KN).toFixed(1)} kn`).tip(this.v, this.b);
        // …and its line carried on to the luff.
        this.buf[0] = this.b.x; this.buf[1] = this.b.y; this.buf[2] = this.b.z;
        this.buf[3] = this.luff.x; this.buf[4] = this.luff.y; this.buf[5] = this.luff.z;
        this.lines.add(this.buf, 2, C.wind, this.ray);
      } else {
        L.wind.hide();
      }
    }
    if (!aoaOn || !hasCut) { lab.aoa.hide(); return; }
    // The chord: the straight line from leech to luff, run on ahead of the luff.
    frame.point(cut.teX, cut.teY, -h, this.g);
    this.buf[0] = this.g.x; this.buf[1] = this.g.y; this.buf[2] = this.g.z;
    this.g.copy(this.luff).addScaledVector(this.fwd, R);
    this.buf[3] = this.g.x; this.buf[4] = this.g.y; this.buf[5] = this.g.z;
    this.lines.add(this.buf, 2, C.white, this.ray);
    // The angle of attack: an arc from the chord line, turning toward the wind by the angle in the tag. That is the
    // effective angle the sail works at (the trim panel's number), a few degrees less than the angle to the drawn
    // apparent wind: the sail bends the air ahead of it (downwash), so the arc stops just short of the wind's line.
    const r = 0.74 * R;
    this.axis.crossVectors(this.fwd, this.up);
    if (this.axis.lengthSq() < 1e-6) this.axis.set(0, 1, 0); else this.axis.normalize();
    for (let q = 0; q < ARC_PTS; q++) {
      this.g.copy(this.fwd).applyAxisAngle(this.axis, (aoa * q) / (ARC_PTS - 1));
      this.arc[3 * q] = this.luff.x + this.g.x * r; this.arc[3 * q + 1] = this.luff.y + this.g.y * r; this.arc[3 * q + 2] = this.luff.z + this.g.z * r;
    }
    this.lines.add(this.arc, ARC_PTS, stateColor, ARC);
    // Its tag stands beside the arc, on the chord's side — clear of the wind arrow and of both lines.
    const mid = 3 * ((ARC_PTS - 1) >> 1);
    this.g.set(this.arc[mid]!, this.arc[mid + 1]!, this.arc[mid + 2]!);
    this.v.copy(this.fwd).addScaledVector(this.up, -this.fwd.dot(this.up));
    if (this.v.lengthSq() < 4e-4) this.v.set(this.up.z, 0, -this.up.x); // chord along the wind: any side will do
    this.v.normalize().multiplyScalar(-0.5 * R).add(this.g);
    lab.aoa.color(state === 0 ? COLORS.luffing : state === 2 ? COLORS.stalled : COLORS.groove)
      .text(single ? 'Angle of attack' : AOA_NAMES[sail.id], `${Math.round(aoa / DEG)}° · ${state === 0 ? 'luffing' : state === 2 ? 'stalled' : 'in the groove'}`)
      .tip(this.g, this.v, 16);
  }

  /** Weight down through G, buoyancy up through B: the couple that rights the boat, lever arm GZ. */
  private couple(s: SimSnapshot, frame: BoatFrame, xray: boolean, viewScale: number): void {
    const L = this.labels;
    const f = s.forces;
    if (Math.abs(s.boat.heel) < 3 * DEG) { L.weight.hide(); L.buoyancy.hide(); return; }
    const style = xray ? COUPLE_XRAY : COUPLE;
    const len = COUPLE_LEN * viewScale;
    frame.point(f.cg.x, f.cg.y, f.cg.z, this.g);
    this.b.copy(this.g);
    this.b.y -= len;
    this.arrows.add(this.g, this.b, C.weight, style);
    L.weight.text('Weight', fmtForce(WEIGHT_N)).tip(this.b, this.g);
    // B sits GZ = righting moment ÷ weight to leeward of G (heel > 0: starboard side down, B moves to starboard).
    const gz = Math.abs(f.rightingMoment) / WEIGHT_N;
    this.a.copy(this.g).addScaledVector(this.yH, Math.sign(s.boat.heel) * gz);
    this.b.copy(this.a);
    this.b.y += len;
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
    this.lines.add(this.buf, 2, C.white, this.dash);
  }
}
