// Part labels for lesson 1 "Meet the boat" (spec §8, §11.2): callouts with leader lines naming the parts of the
// Kestrel 25, fanned out around the boat. Anchors come from the boat spec and the live snapshot, so the boom, clew
// and sheets follow the trim, and "windward shroud" is always on the side the wind comes from.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import type { SimSnapshot } from '../../sim/types';
import type { BoatFrame } from './frames';
import type { Label, LabelLayer } from './labels';
import { COLORS } from './palette';

interface Part {
  name: string;
  priority: number;
  color?: string;
  /** Body-frame anchor (x fwd, y stbd, z down) for this snapshot, or null to hide. */
  at(s: SimSnapshot, out: { x: number; y: number; z: number }): boolean;
}

const set = (o: { x: number; y: number; z: number }, x: number, y: number, h: number): boolean => { o.x = x; o.y = y; o.z = -h; return true; };
const G = BOAT.boom.gooseneck;
const lerpStay = (a: { x: number; h: number }, b: { x: number; h: number }, t: number, o: { x: number; y: number; z: number }) =>
  set(o, a.x + (b.x - a.x) * t, 0, a.h + (b.h - a.h) * t);

export const PARTS: readonly Part[] = [
  { name: 'Bow', priority: 9, at: (_s, o) => set(o, BOAT.hull.stemDeck.x, 0, BOAT.hull.stemDeck.h + 0.05) },
  { name: 'Stern', priority: 9, at: (_s, o) => set(o, BOAT.hull.transomDeck.x + 0.05, 0, BOAT.hull.transomDeck.h) },
  { name: 'Port', priority: 10, color: COLORS.port, at: (_s, o) => set(o, 0.3, -BOAT.hull.beam / 2 - 0.02, 0.55) },
  { name: 'Starboard', priority: 10, color: COLORS.starboard, at: (_s, o) => set(o, 0.3, BOAT.hull.beam / 2 + 0.02, 0.55) },
  { name: 'Mast', priority: 8, at: (_s, o) => set(o, BOAT.mast.x, 0, 7.6) },
  {
    name: 'Boom', priority: 8,
    at: (s, o) => { const b = s.sails.main.boomAngle; return set(o, G.x - Math.cos(b) * 2.2, -Math.sin(b) * 2.2, G.h); },
  },
  { name: 'Mainsail', priority: 8, at: (s, o) => { const c = s.sails.main.ce; return set(o, c.x, c.y, -c.z + 0.6); } },
  { name: 'Jib', priority: 8, at: (s, o) => { const j = s.sails.jib; if (!j.set || j.furl > 0.9) return false; return set(o, j.ce.x, j.ce.y, -j.ce.z); } },
  {
    name: 'Spinnaker', priority: 8,
    at: (s, o) => { const p = s.sails.spinnaker; if (!p.set || p.hoist < 0.5) return false; return set(o, p.ce.x, p.ce.y, -p.ce.z); },
  },
  { name: 'Forestay', priority: 5, at: (_s, o) => lerpStay(BOAT.forestay.tack, BOAT.forestay.head, 0.1, o) },
  { name: 'Backstay', priority: 5, at: (_s, o) => lerpStay(BOAT.backstay.bottom, BOAT.backstay.top, 0.45, o) },
  {
    name: 'Shroud', priority: 4,
    at: (s, o) => {
      const side = s.wind.twa >= 0 ? 1 : -1; // the windward one carries the load
      const c = BOAT.chainplates;
      return set(o, c.x + 0.04, side * (c.y - 0.12), c.h + 1.8);
    },
  },
  { name: 'Tiller', priority: 9, at: (_s, o) => set(o, BOAT.rudder.stockX + 0.55, 0, BOAT.tiller.headH + 0.02) },
  { name: 'Rudder', priority: 7, at: (_s, o) => set(o, BOAT.rudder.cp.x, 0, BOAT.rudder.cp.h) },
  { name: 'Keel', priority: 7, at: (_s, o) => set(o, BOAT.keel.cp.x, 0, BOAT.keel.cp.h - 0.1) },
  { name: 'Cockpit', priority: 6, at: (_s, o) => set(o, -2.2, 0, BOAT.cockpit.seatH) },
  { name: 'Cabin', priority: 5, at: (_s, o) => set(o, 0.9, 0, 1.12) },
  { name: 'Hull', priority: 6, at: (_s, o) => set(o, 2.0, 1.05, 0.3) },
  {
    name: 'Mainsheet', priority: 5,
    at: (s, o) => {
      const b = s.sails.main.boomAngle;
      const ex = G.x - Math.cos(b) * BOAT.boom.sheetAttach, ey = -Math.sin(b) * BOAT.boom.sheetAttach;
      return set(o, 0.5 * (ex + BOAT.boom.traveler.x), 0.5 * ey, 0.5 * (G.h + BOAT.boom.traveler.h));
    },
  },
  {
    name: 'Jib sheet', priority: 4,
    at: (s, o) => {
      const j = s.sails.jib;
      if (!j.set || j.furl > 0.9) return false;
      const lee = j.clew.y >= 0 ? 1 : -1;
      return set(o, 0.5 * (j.clew.x + BOAT.jib.lead.xAft), 0.5 * (j.clew.y + lee * BOAT.jib.lead.y), 0.5 * (-j.clew.z + BOAT.jib.lead.h));
    },
  },
  { name: 'Head', priority: 3, at: (s, o) => { const h = s.sails.main.head; return set(o, h.x, h.y, -h.z); } },
  { name: 'Tack', priority: 3, at: (s, o) => { const t = s.sails.main.tack; return set(o, t.x, t.y, -t.z + 0.1); } },
  { name: 'Clew', priority: 3, at: (s, o) => { const c = s.sails.main.clew; return set(o, c.x, c.y, -c.z + 0.1); } },
];

export class PartLabels {
  private readonly labels: Label[];
  private readonly p = { x: 0, y: 0, z: 0 };
  private readonly w = new THREE.Vector3();

  constructor(private readonly layer: LabelLayer) {
    this.labels = PARTS.map((part) => layer.create({ kind: 'part', leader: true, radial: 40, priority: 20 + part.priority, color: part.color }).text(part.name));
  }

  update(s: SimSnapshot, frame: BoatFrame): void {
    frame.point(0.3, 0, -3.2, this.w);
    this.layer.setFocus(this.w);
    for (let i = 0; i < PARTS.length; i++) {
      const part = PARTS[i]!;
      const label = this.labels[i]!;
      if (!part.at(s, this.p)) { label.hide(); continue; }
      frame.point(this.p.x, this.p.y, this.p.z, this.w);
      label.at(this.w);
    }
  }

  hide(): void {
    for (const l of this.labels) l.hide();
  }
}
