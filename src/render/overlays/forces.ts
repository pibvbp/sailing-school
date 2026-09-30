// Force vectors (spec §8): total sail force (red) at the centre of effort split into drive (green, along the
// centreline) and heeling force (purple, across the rig — the part that heels the boat), with the parallelogram
// dashed in; each sail's lift and drag (perpendicular / parallel to the local apparent wind); keel lift (cyan),
// rudder force and hull resistance under water; the righting couple (weight down at G, buoyancy up at B, lever GZ)
// once the boat heels; and a helm-balance tag at the tiller.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import type { SailState, SimSnapshot } from '../../sim/types';
import { DEG } from '../../shared/math';
import { ARROW_BOLD, ARROW_MEDIUM, ARROW_THIN, type ArrowBatch, type ArrowStyle } from './arrows';
import { rigAir, type BoatFrame } from './frames';
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

const C = {
  sail: linearColor(COLORS.sailForce),
  drive: linearColor(COLORS.drive),
  heel: linearColor(COLORS.heel),
  keel: linearColor(COLORS.keel),
  rudder: linearColor(COLORS.rudder),
  resistance: linearColor(COLORS.resistance),
  lift: linearColor(COLORS.lift),
  drag: linearColor(COLORS.drag),
  weight: linearColor(COLORS.weight),
  buoyancy: linearColor(COLORS.buoyancy),
  white: linearColor(COLORS.white),
};

const UNDERWATER: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.6 };
const UNDERWATER_XRAY: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.95 };
const RUDDER: ArrowStyle = { ...UNDERWATER, width: 3, head: 12, headWidth: 10 };
const RUDDER_XRAY: ArrowStyle = { ...UNDERWATER_XRAY, width: 3, head: 12, headWidth: 10 };
const COUPLE: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.5 };
const COUPLE_XRAY: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.9 };
const SAIL_PART: ArrowStyle = { ...ARROW_THIN, alpha: 0.9, hidden: 0.4 };
const PRIMARY: ArrowStyle = { ...ARROW_BOLD, hidden: 0.8 };
const COMPONENT: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.75 };
const WEIGHT_N = BOAT.mass.total * 9.81;

export const fmtForce = (n: number): string => (Math.abs(n) < 995 ? `${Math.round(n)} N` : `${(n / 1000).toFixed(2)} kN`);

const SAIL_NAMES: Record<SailState['id'], string> = { main: 'Main', jib: 'Jib', spinnaker: 'Spinnaker' };

export class ForceOverlay {
  private scale = M_PER_N;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly tipDrive = new THREE.Vector3();
  private readonly tipHeel = new THREE.Vector3();
  private readonly tipTotal = new THREE.Vector3();
  private readonly air = { x: 0, y: 0 };
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
    const fAero = f.aero.force;
    const biggest = Math.max(Math.hypot(fAero.x, fAero.y, fAero.z), Math.hypot(f.keel.force.x, f.keel.force.y), 1);
    const target = Math.min(M_PER_N, LONGEST / biggest);
    this.scale += (target - this.scale) * Math.min(1, dt / 1.2);
    const k = this.scale;

    // Total sail force, drive and heeling force, all from the centre of effort.
    const ce = f.aero.point;
    frame.point(ce.x, ce.y, ce.z, this.a);
    frame.vector(fAero.x * k, fAero.y * k, fAero.z * k, this.v);
    this.tipTotal.copy(this.a).add(this.v);
    frame.vector(fAero.x * k, 0, 0, this.v);
    this.tipDrive.copy(this.a).add(this.v);
    frame.vector(0, fAero.y * k, fAero.z * k, this.v);
    this.tipHeel.copy(this.a).add(this.v);
    this.arrows.add(this.a, this.tipDrive, C.drive, COMPONENT);
    this.arrows.add(this.a, this.tipHeel, C.heel, COMPONENT);
    this.arrows.add(this.a, this.tipTotal, C.sail, PRIMARY);
    this.dashed(this.tipDrive, this.tipTotal);
    this.dashed(this.tipHeel, this.tipTotal);
    L.total.text('Sail force', fmtForce(Math.hypot(fAero.x, fAero.y, fAero.z))).tip(this.tipTotal, this.a);
    L.drive.text('Drive', fmtForce(fAero.x)).tip(this.tipDrive, this.a);
    L.heel.text('Heeling force', fmtForce(Math.hypot(fAero.y, fAero.z))).tip(this.tipHeel, this.a);

    // Each sail: lift ⟂ and drag ∥ to the apparent wind at its centre of effort.
    for (const sail of [s.sails.main, s.sails.jib, s.sails.spinnaker] as const) this.sailParts(sail, s, frame);

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
      frame.point(RESISTANCE_POINT.x, RESISTANCE_POINT.y, RESISTANCE_POINT.z, this.a);
      // Resistance opposes the motion through the water (heading frame, horizontal) → body → world.
      const hx = -f.resistance * (s.boat.u / U) * k, hy = -f.resistance * (s.boat.v / U) * k;
      const c = Math.cos(s.boat.heel), sn = Math.sin(s.boat.heel);
      frame.vector(hx, hy * c, -hy * sn, this.v);
      this.b.copy(this.a).add(this.v);
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
    for (const l of [L.total, L.drive, L.heel, L.keel, L.rudder, L.resistance, L.weight, L.buoyancy, L.helm]) l.hide();
    for (const p of Object.values(L.sails)) { p.lift.hide(); p.drag.hide(); }
  }

  private sailParts(sail: SailState, s: SimSnapshot, frame: BoatFrame): void {
    const lab = this.labels.sails[sail.id];
    const F = sail.force;
    const mag = Math.hypot(F.x, F.y);
    if (!sail.set || mag < 2) { lab.lift.hide(); lab.drag.hide(); return; }
    rigAir(s, sail.ce.x, sail.ce.y, sail.ce.z, this.air);
    const al = Math.hypot(this.air.x, this.air.y) || 1;
    const wx = this.air.x / al, wy = this.air.y / al;
    const along = F.x * wx + F.y * wy;
    const k = this.scale;
    frame.point(sail.ce.x, sail.ce.y, sail.ce.z, this.a);
    // Lift: the force component across the flow.
    frame.vector((F.x - along * wx) * k, (F.y - along * wy) * k, 0, this.v);
    this.b.copy(this.a).add(this.v);
    const lift = Math.hypot(F.x - along * wx, F.y - along * wy);
    this.arrows.add(this.a, this.b, C.lift, SAIL_PART);
    lab.lift.text(`${SAIL_NAMES[sail.id]} lift`, fmtForce(lift)).tip(this.b, this.a);
    // Drag: along the flow (often tiny next to lift — that is the point of a good sail).
    frame.vector(along * wx * k, along * wy * k, 0, this.v);
    this.b.copy(this.a).add(this.v);
    this.arrows.add(this.a, this.b, C.drag, SAIL_PART);
    if (Math.abs(along) * k > 0.35) lab.drag.text(`${SAIL_NAMES[sail.id]} drag`, fmtForce(Math.abs(along))).tip(this.b, this.a);
    else lab.drag.hide();
  }

  /** Weight down through G, buoyancy up through B: the couple that rights the boat, lever arm GZ. */
  private couple(s: SimSnapshot, frame: BoatFrame, xray: boolean): void {
    const L = this.labels;
    const f = s.forces;
    if (Math.abs(s.boat.heel) < 3 * DEG) { L.weight.hide(); L.buoyancy.hide(); return; }
    const style = xray ? COUPLE_XRAY : COUPLE;
    frame.point(f.cg.x, f.cg.y, f.cg.z, this.a);
    this.b.copy(this.a);
    this.b.y -= COUPLE_LEN;
    this.arrows.add(this.a, this.b, C.weight, style);
    L.weight.text('Weight', fmtForce(WEIGHT_N)).tip(this.b, this.a);
    const g = this.tipDrive.copy(this.a); // reuse: G in world
    frame.point(f.cb.x, f.cb.y, f.cb.z, this.a);
    this.b.copy(this.a);
    this.b.y += COUPLE_LEN;
    this.arrows.add(this.a, this.b, C.buoyancy, style);
    L.buoyancy.text('Buoyancy', `righting moment ${(Math.abs(f.rightingMoment) / 1000).toFixed(1)} kN·m`).tip(this.b, this.a);
    // The lever arm GZ, a short bar between the two lines of action.
    this.buf[0] = g.x; this.buf[1] = g.y; this.buf[2] = g.z;
    this.buf[3] = this.a.x; this.buf[4] = g.y; this.buf[5] = this.a.z;
    this.lines.add(this.buf, 2, C.white, { width: 2, alpha: 0.85 });
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
    this.lines.add(this.buf, 2, C.white, { width: 1.6, alpha: 0.55, dash: 0.28, duty: 0.55 });
  }
}
