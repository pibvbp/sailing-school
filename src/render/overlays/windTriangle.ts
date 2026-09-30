// Wind triangle (spec §8): true wind (blue) + wind from the boat's own motion (grey) = apparent wind (amber), drawn
// head-to-tail so the triangle closes, at the masthead and at deck level. The two apparent-wind arrows differ because
// the true wind is ~25 % weaker near the water (log gradient) while the boat-motion wind is the same — the gradient
// twist a trimmer sees in the telltales.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import type { SimSnapshot } from '../../sim/types';
import { KN } from '../../shared/math';
import { ARROW_BOLD, ARROW_MEDIUM, ARROW_THIN, type ArrowBatch } from './arrows';
import { windAtBodyPoint, pointWind, type BoatFrame } from './frames';
import type { Label, LabelLayer } from './labels';
import { COLORS, linearColor } from './palette';

/** Where the arrows arrive: above the masthead fitting, and just forward of the jib luff at deck level. */
const MAST_POINT = { x: BOAT.mast.x, y: 0, z: -(BOAT.mast.topH + 0.55) };
const DECK_POINT = { x: 3.72, y: 0, z: -1.75 };
/** Metres of arrow per m/s of wind; shrinks in strong wind so the triangle stays inside ~6 m. */
const SCALE_MAX = 0.6;
const SPAN_MAX = 6.5;

const cTrue = linearColor(COLORS.trueWind);
const cBoat = linearColor(COLORS.boatWind);
const cApp = linearColor(COLORS.apparentWind);

const fmtKn = (ms: number): string => `${(ms / KN).toFixed(1)} kn`;
const fmtDeg = (rad: number): string => `${Math.round(Math.abs(rad) * 180 / Math.PI)}°`;

export class WindTriangle {
  private scale = SCALE_MAX;
  private readonly wMast = pointWind();
  private readonly wDeck = pointWind();
  private readonly anchor = new THREE.Vector3();
  private readonly p0 = new THREE.Vector3();
  private readonly p1 = new THREE.Vector3();
  private readonly mid = new THREE.Vector3();
  private readonly centroid = new THREE.Vector3();
  private readonly labels: { t: Label; b: Label; a: Label; deck: Label };

  constructor(private readonly arrows: ArrowBatch, layer: LabelLayer) {
    this.labels = {
      t: layer.create({ color: COLORS.trueWind, priority: 8 }),
      b: layer.create({ color: COLORS.boatWind, priority: 7 }),
      a: layer.create({ color: COLORS.apparentWind, priority: 9 }),
      deck: layer.create({ color: COLORS.apparentWind, priority: 6 }),
    };
  }

  update(dt: number, s: SimSnapshot, frame: BoatFrame): void {
    windAtBodyPoint(s, MAST_POINT.x, MAST_POINT.y, MAST_POINT.z, this.wMast);
    windAtBodyPoint(s, DECK_POINT.x, DECK_POINT.y, DECK_POINT.z, this.wDeck);
    const span = Math.max(this.wMast.appW.length(), this.wMast.trueW.length(), this.wMast.boatW.length(), 1);
    const target = Math.min(SCALE_MAX, SPAN_MAX / span);
    this.scale += (target - this.scale) * Math.min(1, dt / 1.5);

    frame.point(MAST_POINT.x, MAST_POINT.y, MAST_POINT.z, this.anchor);
    this.triangle(this.wMast, true);
    // Side labels sit outside the triangle: pushed from its centroid through each side's midpoint.
    this.centroid.copy(this.p0).add(this.p1).add(this.anchor).multiplyScalar(1 / 3);
    const l = this.labels;
    l.t.text('True wind', fmtKn(s.wind.tws)).tip(this.midpoint(this.p0, this.p1), this.centroid, 6);
    l.b.text('Boat-motion wind', fmtKn(s.boat.speed)).tip(this.midpoint(this.p1, this.anchor), this.centroid, 6);
    l.a.text('Apparent wind', `${fmtKn(s.wind.aws)} · ${fmtDeg(s.wind.awa)}`).tip(this.midpoint(this.p0, this.anchor), this.centroid, 6);

    frame.point(DECK_POINT.x, DECK_POINT.y, DECK_POINT.z, this.anchor);
    this.triangle(this.wDeck, false);
    this.centroid.copy(this.p0).add(this.p1).add(this.anchor).multiplyScalar(1 / 3);
    // Deck values and the twist come from the two drawn triangles themselves (the same points, the same moment), not
    // from the sim's stern burgee, which differs from the bow while the boat turns.
    const awaMast = this.awa(this.wMast, s), awaDeck = this.awa(this.wDeck, s);
    const twist = Math.abs(awaMast) - Math.abs(awaDeck);
    l.deck.text('Apparent at deck', `${fmtKn(this.wDeck.appW.length())} · ${fmtDeg(awaDeck)} · twist ${Math.round(twist * 180 / Math.PI)}°`)
      .tip(this.midpoint(this.p0, this.anchor), this.centroid, 6);
  }

  hide(): void {
    for (const l of Object.values(this.labels)) l.hide();
  }

  private triangle(w: ReturnType<typeof pointWind>, top: boolean): void {
    const k = this.scale;
    // Apparent wind arrives at the anchor; true wind starts where the apparent does; boat-motion wind closes it.
    this.p0.copy(this.anchor).addScaledVector(w.appW, -k);
    this.p1.copy(this.p0).addScaledVector(w.trueW, k);
    const main = top ? ARROW_BOLD : ARROW_MEDIUM;
    const side = top ? ARROW_MEDIUM : ARROW_THIN;
    this.arrows.add(this.p0, this.p1, cTrue, side);
    this.arrows.add(this.p1, this.anchor, cBoat, side);
    this.arrows.add(this.p0, this.anchor, cApp, main);
  }

  /** Apparent wind angle (rad, + from starboard) of a drawn triangle, in the horizontal plane. */
  private awa(w: ReturnType<typeof pointWind>, s: SimSnapshot): number {
    const psi = s.boat.heading;
    const ax = w.appW.x * Math.sin(psi) - w.appW.z * Math.cos(psi); // along the heading
    const ay = w.appW.x * Math.cos(psi) + w.appW.z * Math.sin(psi); // to starboard
    return Math.atan2(-ay, -ax);
  }

  private midpoint(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
    return this.mid.copy(a).add(b).multiplyScalar(0.5);
  }
}
