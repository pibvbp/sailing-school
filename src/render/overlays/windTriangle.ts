// Wind triangle (spec §8): true wind (blue) + wind from the boat's own motion (grey) = apparent wind (amber), drawn
// head-to-tail so the triangle closes, at the masthead and at deck level. The two apparent-wind arrows differ because
// the true wind is ~25 % weaker near the water (log gradient) while the boat-motion wind is the same — the gradient
// twist a trimmer sees in the telltales.
//
// The triangle must be readable in every camera, so it stays inside the safe area (the part of the window the HUD
// leaves free): it sits at the masthead when the whole triangle shows there, and otherwise slides down the mast to
// the highest place where it does — still on the mast, so still plainly the boat's own wind — and shrinks only if
// even that is not enough. Seen from far away (the top view) it is drawn larger.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import type { SimSnapshot } from '../../sim/types';
import { KN } from '../../shared/math';
import { ARROW_BOLD, ARROW_MEDIUM, ARROW_THIN, type ArrowBatch } from './arrows';
import { windAtBodyPoint, pointWind, type BoatFrame } from './frames';
import type { Label, LabelLayer } from './labels';
import type { OverlayView } from './overlayMaterial';
import { COLORS, linearColor } from './palette';

/** Where the arrows arrive: above the masthead fitting, and just forward of the jib luff at deck level. */
const MAST_POINT = { x: BOAT.mast.x, y: 0, z: -(BOAT.mast.topH + 0.55) };
const DECK_POINT = { x: 3.72, y: 0, z: -1.75 };
/** The lowest place on the mast the triangle slides to (m above the waterline): clear of the boom and the crew. */
const MAST_LOW_H = BOAT.boom.gooseneck.h + 1.6;
/** Places tried on the way down, and the margin (px) the triangle keeps from the edge of the safe area. */
const MAST_STEPS = 12;
const EDGE_PX = 18;
/** Metres of arrow per m/s of wind; shrinks in strong wind so the triangle stays inside ~6 m. */
const SCALE_MAX = 0.6;
const SPAN_MAX = 6.5;
/** From far away the triangle is drawn larger, by up to this factor. */
const FAR_SCALE_MAX = 1.8;
/** It is never shrunk below this fraction to fit the safe area. */
const FIT_MIN = 0.4;

const cTrue = linearColor(COLORS.trueWind);
const cBoat = linearColor(COLORS.boatWind);
const cApp = linearColor(COLORS.apparentWind);

const fmtKn = (ms: number): string => `${(ms / KN).toFixed(1)} kn`;
const fmtDeg = (rad: number): string => `${Math.round(Math.abs(rad) * 180 / Math.PI)}°`;

export class WindTriangle {
  private scale = SCALE_MAX;
  /** Height on the mast (m above the waterline) where the upper triangle is drawn, and its fit factor; both eased. */
  private mastH = -MAST_POINT.z;
  private fit = 1;
  private fresh = true;
  private readonly wMast = pointWind();
  private readonly wDeck = pointWind();
  private readonly anchor = new THREE.Vector3();
  private readonly p0 = new THREE.Vector3();
  private readonly p1 = new THREE.Vector3();
  private readonly mid = new THREE.Vector3();
  private readonly centroid = new THREE.Vector3();
  private readonly q = new THREE.Vector3();
  private readonly labels: { t: Label; b: Label; a: Label; deck: Label };

  constructor(private readonly arrows: ArrowBatch, layer: LabelLayer) {
    this.labels = {
      t: layer.create({ color: COLORS.trueWind, priority: 8 }),
      b: layer.create({ color: COLORS.boatWind, priority: 7 }),
      a: layer.create({ color: COLORS.apparentWind, priority: 9 }),
      deck: layer.create({ color: COLORS.apparentWind, priority: 6 }),
    };
  }

  update(dt: number, s: SimSnapshot, frame: BoatFrame, view: OverlayView): void {
    windAtBodyPoint(s, MAST_POINT.x, MAST_POINT.y, MAST_POINT.z, this.wMast);
    windAtBodyPoint(s, DECK_POINT.x, DECK_POINT.y, DECK_POINT.z, this.wDeck);
    const span = Math.max(this.wMast.appW.length(), this.wMast.trueW.length(), this.wMast.boatW.length(), 1);
    const target = Math.min(SCALE_MAX, SPAN_MAX / span) * Math.min(FAR_SCALE_MAX, view.scale);
    this.scale = this.fresh ? target : this.scale + (target - this.scale) * Math.min(1, dt / 1.5);

    // Where on the mast, and how large, does the whole upper triangle show inside the safe area?
    const top = -MAST_POINT.z;
    let h = top, fit = 1;
    if (view.camera && this.overflow(frame, view, top, this.scale) > 0) {
      let best = Infinity;
      for (let i = 1; i <= MAST_STEPS; i++) {
        const hi = top + (MAST_LOW_H - top) * (i / MAST_STEPS);
        const o = this.overflow(frame, view, hi, this.scale);
        if (o < best) { best = o; h = hi; }
        if (o <= 0) break;
      }
      // Still not inside (a close camera, a narrow window): shrink it where it shows best.
      for (let i = 0; i < 5 && best > 0 && fit > FIT_MIN; i++) {
        fit = Math.max(FIT_MIN, fit * 0.8);
        best = this.overflow(frame, view, h, this.scale * fit);
      }
    }
    const ease = this.fresh ? 1 : Math.min(1, dt / 0.3);
    this.mastH += (h - this.mastH) * ease;
    this.fit += (fit - this.fit) * ease;
    this.fresh = false;

    frame.point(MAST_POINT.x, MAST_POINT.y, -this.mastH, this.anchor);
    this.triangle(this.wMast, true, this.scale * this.fit);
    // Side labels sit outside the triangle: pushed from its centroid through each side's midpoint.
    this.centroid.copy(this.p0).add(this.p1).add(this.anchor).multiplyScalar(1 / 3);
    const l = this.labels;
    l.t.text('True wind', fmtKn(s.wind.tws)).tip(this.midpoint(this.p0, this.p1), this.centroid, 6);
    l.b.text('Boat-motion wind', fmtKn(s.boat.speed)).tip(this.midpoint(this.p1, this.anchor), this.centroid, 6);
    l.a.text('Apparent wind', `${fmtKn(s.wind.aws)} · ${fmtDeg(s.wind.awa)}`).tip(this.midpoint(this.p0, this.anchor), this.centroid, 6);

    // The deck-level triangle: drawn where it shows; it is the smaller, second reading.
    frame.point(DECK_POINT.x, DECK_POINT.y, DECK_POINT.z, this.anchor);
    const deckScale = this.scale * this.fit;
    this.p0.copy(this.anchor).addScaledVector(this.wDeck.appW, -deckScale);
    this.p1.copy(this.p0).addScaledVector(this.wDeck.trueW, deckScale);
    if (view.camera && Math.max(this.outside(this.anchor, view), this.outside(this.p0, view), this.outside(this.p1, view)) > 0) {
      l.deck.hide();
      return;
    }
    this.triangle(this.wDeck, false, deckScale);
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
    this.fresh = true;
  }

  /** How far (px) the upper triangle, drawn `h` m up the mast at scale `k`, reaches outside the safe area (0: inside). */
  private overflow(frame: BoatFrame, view: OverlayView, h: number, k: number): number {
    frame.point(MAST_POINT.x, MAST_POINT.y, -h, this.q);
    let worst = this.outside(this.q, view);
    this.q.addScaledVector(this.wMast.appW, -k);
    worst = Math.max(worst, this.outside(this.q, view));
    this.q.addScaledVector(this.wMast.trueW, k);
    return Math.max(worst, this.outside(this.q, view));
  }

  /** Distance (px) of a world point outside the safe area shrunk by EDGE_PX; 0 inside it, huge behind the camera. */
  private outside(p: THREE.Vector3, view: OverlayView): number {
    const cam = view.camera!;
    this.mid.copy(p).applyMatrix4(cam.matrixWorldInverse);
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera && this.mid.z > -(cam as THREE.PerspectiveCamera).near) return 1e6;
    this.mid.applyMatrix4(cam.projectionMatrix);
    const x = (this.mid.x * 0.5 + 0.5) * view.width, y = (0.5 - this.mid.y * 0.5) * view.height;
    return Math.max(view.x0 + EDGE_PX - x, x - (view.x1 - EDGE_PX), view.y0 + EDGE_PX - y, y - (view.y1 - EDGE_PX), 0);
  }

  private triangle(w: ReturnType<typeof pointWind>, top: boolean, k: number): void {
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
