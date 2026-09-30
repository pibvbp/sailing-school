// Roller-furling jib (spec §7.4).
// The clew swings about the luff (forestay). Each jib sheet is a rope from the clew to its lead: a
// trimmed sheet pins the clew near the sheeting angle from BOTH sides, an eased sheet lets it swing out
// (and across). Normal crew work: when the bow passes through the wind the old sheet is released and the
// new one hauled in over ~2.5 s (the jib flogs meanwhile). "Back the jib" keeps the old sheet made fast.
import { BOAT } from '../../shared/boatSpec';
import { DEG, clamp, lerp, rotZ, smoothstep, type Vec3 } from '../../shared/math';
import type { Controls, JibState } from '../types';
import { JIB_AERO } from '../aero';
import { evaluateSection, luffTelltales, sumSections, type AirContext, type SailSum, type SectionGeom, type SectionResult } from './common';

const N_SECTIONS = 8;
const J = BOAT.jib;
const TACK = { x: J.tack.x, y: 0, z: -J.tack.h };
const HEAD = { x: J.head.x, y: 0, z: -J.head.h };
const FOOT_H = Math.sqrt(J.foot * J.foot - (J.clewH - J.tack.h) ** 2);
const Z_BOTTOM = J.tack.h + 0.08;
const Z_TOP = J.head.h - 0.3;
const I_CLEW = J.inertia;
const SHEET_K = 30000;
const SHEET_C = 600;
const AIR_DAMP = 8;
const HAUL_S = 2.5;
const OUT_MAX = 29 * DEG;
const IN_MAX = 100 * DEG;
const WHISKER_ANGLE = 70 * DEG;

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });

export interface JibEvaluation { sections: SectionResult[]; sum: SailSum; luffMoment: number; clew: Vec3 }

/** Sheeting angle of the lead (rad): lead forward → slightly wider. */
export function sheetingAngle(jibLead: number): number {
  const leadX = lerp(J.lead.xAft, J.lead.xFwd, (clamp(jibLead, -1, 1) + 1) / 2);
  return Math.atan2(J.lead.y, J.tack.x - leadX);
}

export class JibModel {
  /** Clew angle seen from the tack (rad, + out to port). */
  gamma = 11 * DEG;
  gammaDot = 0;
  /** Side whose sheet is working: +1 clew to port (wind from starboard), −1 to starboard. */
  workingSide: 1 | -1 = 1;
  sheetPort = 0.7;
  sheetStbd = 0;
  furl = 0;
  private haulT = HAUL_S;
  last: JibEvaluation | null = null;

  clewPoint(gamma: number, furl: number): Vec3 {
    const f = clamp(furl, 0, 1);
    const full = { x: TACK.x - FOOT_H * Math.cos(gamma), y: -FOOT_H * Math.sin(gamma), z: -J.clewH };
    // Rolling the sail round the forestay pulls the clew up and onto the luff.
    const h = J.clewH + 2.0 * f;
    const onLuff = lerp3(TACK, HEAD, (h - J.tack.h) / (J.head.h - J.tack.h));
    return { x: lerp(full.x, onLuff.x, f), y: lerp(full.y, 0, f), z: lerp(full.z, onLuff.z, f) };
  }

  geometry(c: Controls, gamma: number, furl: number): SectionGeom[] {
    const clew = this.clewPoint(gamma, furl);
    const clewH = -clew.z;
    const twist = (4 + 14 * (1 - (clamp(c.jibLead, -1, 1) + 1) / 2) + 8 * (1 - clamp(c.jibSheet, 0, 1))) * DEG;
    const side = clamp(gamma / (5 * DEG), -1, 1);
    const dz = (Z_TOP - Z_BOTTOM) / N_SECTIONS;
    const out: SectionGeom[] = [];
    for (let i = 0; i < N_SECTIONS; i++) {
      const z = Z_BOTTOM + (i + 0.5) * dz;
      const s = (z - J.tack.h) / (J.head.h - J.tack.h);
      const luff = lerp3(TACK, HEAD, s);
      const leech = z >= clewH
        ? lerp3(clew, HEAD, (z - clewH) / (J.head.h - clewH))
        : lerp3(TACK, clew, (z - J.tack.h) / Math.max(clewH - J.tack.h, 1e-3));
      let dx = leech.x - luff.x, dy = leech.y - luff.y;
      const chord = Math.max(Math.hypot(dx, dy), 0.02);
      dx /= chord; dy /= chord;
      const dir = rotZ({ x: dx, y: dy, z: 0 }, side * twist * Math.pow(s, 1.2));
      out.push({
        h: s,
        luff: { x: luff.x, y: 0, z: -z },
        chordDir: dir,
        chord,
        height: dz,
        camber: J.camberBase - 0.02 * c.backstay + 0.012 * clamp(c.jibLead, -1, 1) * (1 - s),
        draft: J.draftBase,
      });
    }
    return out;
  }

  evaluate(c: Controls, gamma: number, furl: number, air: AirContext, alphaShift: number, blanket = 1, gammaDot = 0): JibEvaluation {
    const geom = this.geometry(c, gamma, furl);
    const q = furl > 0.97 ? 0 : blanket; // a furled jib is a tight roll on the forestay
    const sections = geom.map((g) => evaluateSection(g, JIB_AERO, air, { alphaShift, blanket: q, rotationRate: gammaDot }));
    let luffMoment = 0;
    for (const r of sections) luffMoment += (r.point.x - r.luff.x) * r.force.y - (r.point.y - r.luff.y) * r.force.x;
    return { sections, sum: sumSections(sections, { x: 0, y: 0, z: -BOAT.mass.cgH }), luffMoment, clew: this.clewPoint(gamma, furl) };
  }

  /** Allowed clew range from both sheets (and the whisker pole), rad. */
  limits(c: Controls, tackSign: number): { lo: number; hi: number } {
    if (c.jibWhisker) {
      const a = -tackSign * WHISKER_ANGLE;
      return { lo: a, hi: a };
    }
    const gc = sheetingAngle(c.jibLead);
    const out = (s: number) => OUT_MAX * Math.pow(1 - s, 1.3);
    const inn = (s: number) => IN_MAX * Math.pow(1 - s, 1.1);
    const lo = Math.max(gc - inn(this.sheetPort), -gc - out(this.sheetStbd));
    const hi = Math.min(gc + out(this.sheetPort), -gc + inn(this.sheetStbd));
    return lo <= hi ? { lo, hi } : { lo: (lo + hi) / 2, hi: (lo + hi) / 2 };
  }

  step(dt: number, c: Controls, air: AirContext, alphaShift: number, blanket: number, awaRef: number): JibEvaluation {
    // Furling follows the control at a realistic winding rate.
    this.furl += clamp(c.jibFurl - this.furl, -0.3 * dt, 0.3 * dt);

    const tackSign = awaRef > 3 * DEG ? 1 : awaRef < -3 * DEG ? -1 : this.workingSide;
    if (!c.jibBacked && !c.jibWhisker && tackSign !== this.workingSide) {
      this.workingSide = tackSign as 1 | -1; // release the old sheet, start hauling the new one
      this.haulT = 0;
    }
    this.haulT = Math.min(HAUL_S, this.haulT + dt);
    const working = clamp(c.jibSheet, 0, 1) * smoothstep(0, HAUL_S, this.haulT);
    if (c.jibBacked) {
      // Old sheet stays made fast; the lazy one is slack.
      if (this.workingSide === 1) { this.sheetPort = clamp(c.jibSheet, 0, 1); this.sheetStbd = 0; }
      else { this.sheetStbd = clamp(c.jibSheet, 0, 1); this.sheetPort = 0; }
    } else if (this.workingSide === 1) { this.sheetPort = working; this.sheetStbd = 0; }
    else { this.sheetStbd = working; this.sheetPort = 0; }

    const ev = this.evaluate(c, this.gamma, this.furl, air, alphaShift, blanket, this.gammaDot);
    this.last = ev;
    const { lo, hi } = this.limits(c, tackSign);
    let m = ev.luffMoment - AIR_DAMP * this.gammaDot;
    // While the rope is stretched it damps both ways (rope hysteresis, block friction) — no elastic bounce.
    if (this.gamma > hi) m += -SHEET_K * (this.gamma - hi) - SHEET_C * this.gammaDot;
    else if (this.gamma < lo) m += -SHEET_K * (this.gamma - lo) - SHEET_C * this.gammaDot;
    this.gammaDot += (m / I_CLEW) * dt;
    this.gamma = clamp(this.gamma + this.gammaDot * dt, -95 * DEG, 95 * DEG);
    return ev;
  }

  state(ev: JibEvaluation, c: Controls, heel: number, awaRef: number): JibState {
    const s = ev.sum;
    const leewardSide = awaRef >= 0 ? 1 : -1;
    const set = this.furl < 0.97;
    return {
      id: 'jib',
      set,
      area: s.area,
      tack: TACK,
      clew: ev.clew,
      head: HEAD,
      sections: ev.sections,
      force: s.force,
      ce: s.ce,
      lift: ev.sections.reduce((a, r) => a + r.cl * r.q * r.area, 0),
      drag: ev.sections.reduce((a, r) => a + r.cd * r.q * r.area, 0),
      drive: s.force.x,
      heelForce: s.force.y * Math.cos(heel) - s.force.z * Math.sin(heel),
      telltales: set ? luffTelltales('jib', ev.sections, JIB_AERO, [0.25, 0.5, 0.75]) : [],
      clewAngle: this.gamma,
      furl: this.furl,
      backed: set && !c.jibWhisker && Math.sign(this.gamma) !== 0 && Math.sign(this.gamma) !== leewardSide && Math.abs(awaRef) > 5 * DEG,
      whisker: c.jibWhisker,
    };
  }
}
