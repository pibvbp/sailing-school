// Wind triangle (spec §8): true wind (blue) + wind from the boat's own motion (grey) = apparent wind (amber), drawn
// head-to-tail so the triangle closes, at the masthead and at deck level. The two apparent-wind arrows differ because
// the true wind is ~25 % weaker near the water (log gradient) while the boat-motion wind is the same — the gradient
// twist a trimmer sees in the telltales.
//
// The triangle must be readable in every camera, so it stays inside the safe area (the part of the window the HUD
// leaves free): it sits at the masthead when the whole triangle shows there, and otherwise slides down the mast to
// the highest place where it does — still on the mast, so still plainly the boat's own wind — and shrinks only if
// even that is not enough. Seen from far away (the top view) it is drawn larger. From a camera close under the rig
// (the sail view, the helm), where no place on the mast shows it whole, both triangles are drawn as an inset in the
// top right corner of the safe area, a few metres in front of the camera — still in the world's directions, so they turn
// with the boat like the real wind. The deck triangle shrinks to fit rather than vanish.
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
/** The inset: drawn this far (m) in front of the camera, the upper triangle this large on screen (px), with this gap (px) below it to the deck one. */
const INSET_DEPTH = 8;
const INSET_PX = 150;
const INSET_GAP = 34;
/** Its margin (px) from the edge of the safe area: a little more than EDGE_PX, so the placing's rounding never touches it. */
const INSET_PAD = EDGE_PX + 2;

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
  /** Drawn as an inset (no place on the mast shows it whole); left only once the masthead shows it whole again. */
  private inset = false;
  private readonly wMast = pointWind();
  private readonly wDeck = pointWind();
  private readonly anchor = new THREE.Vector3();
  private readonly p0 = new THREE.Vector3();
  private readonly p1 = new THREE.Vector3();
  private readonly mid = new THREE.Vector3();
  private readonly centroid = new THREE.Vector3();
  private readonly q = new THREE.Vector3();
  private readonly box = { x0: 0, y0: 0, x1: 0, y1: 0 };
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
    const persp = (view.camera as THREE.PerspectiveCamera | null)?.isPerspectiveCamera === true;
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
      if (best > 0 && persp) this.inset = true;
    } else {
      this.inset = false;
    }
    if (this.inset) {
      this.drawInset(s, view);
      this.fresh = true; // back on the mast, it takes its place at once
      return;
    }
    const ease = this.fresh ? 1 : Math.min(1, dt / 0.3);
    this.mastH += (h - this.mastH) * ease;
    this.fit += (fit - this.fit) * ease;
    this.fresh = false;

    frame.point(MAST_POINT.x, MAST_POINT.y, -this.mastH, this.anchor);
    this.triangle(this.wMast, true, this.scale * this.fit);
    this.upperTags(s);

    // The deck-level triangle: the smaller, second reading, shrunk to fit if it must.
    frame.point(DECK_POINT.x, DECK_POINT.y, DECK_POINT.z, this.anchor);
    let deckScale = this.scale * this.fit;
    for (let i = 0; view.camera && this.deckOverflow(view, deckScale) > 0; i++) {
      if (i === 5) { this.labels.deck.hide(); return; }
      deckScale *= 0.75;
    }
    this.triangle(this.wDeck, false, deckScale);
    this.deckTag(s);
  }

  /**
   * Both triangles as an inset in the top right corner of the safe area, the deck one under the upper one,
   * INSET_DEPTH in front of the camera and sized on screen rather than in metres.
   */
  private drawInset(s: SimSnapshot, view: OverlayView): void {
    const cam = view.camera as THREE.PerspectiveCamera;
    const focal = (0.5 * view.height) / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const span = Math.max(this.wMast.appW.length(), this.wMast.trueW.length(), this.wMast.boatW.length(), 1);
    const k = (INSET_PX * INSET_DEPTH) / (focal * span);
    // Start in the middle of the safe area, then move the anchor on screen so the triangle's box sits in the top
    // right corner (the triangles are nearly flat to the camera at this depth, so two corrections settle it).
    let ax = 0.5 * (view.x0 + view.x1), ay = 0.5 * (view.y0 + view.y1);
    for (let i = 0; i < 3; i++) {
      this.unproject(cam, view, ax, ay, this.anchor);
      this.screenBox(this.wMast, k, cam, view);
      ax += view.x1 - INSET_PAD - this.box.x1;
      ay += view.y0 + INSET_PAD - this.box.y0;
    }
    this.unproject(cam, view, ax, ay, this.anchor);
    this.triangle(this.wMast, true, k);
    this.upperTags(s);
    // The deck triangle under it, a little smaller, right edges aligned.
    this.screenBox(this.wMast, k, cam, view);
    const below = this.box.y1 + INSET_GAP;
    const kd = 0.8 * k;
    let dx = ax, dy = ay;
    for (let i = 0; i < 3; i++) {
      this.unproject(cam, view, dx, dy, this.anchor);
      this.screenBox(this.wDeck, kd, cam, view);
      dx += view.x1 - INSET_PAD - this.box.x1;
      dy += below - this.box.y0;
    }
    this.unproject(cam, view, dx, dy, this.anchor);
    if (this.deckOverflow(view, kd) > 0) { this.labels.deck.hide(); return; }
    this.triangle(this.wDeck, false, kd);
    this.deckTag(s);
  }

  private upperTags(s: SimSnapshot): void {
    // Side labels sit outside the triangle: pushed from its centroid through each side's midpoint.
    this.centroid.copy(this.p0).add(this.p1).add(this.anchor).multiplyScalar(1 / 3);
    const l = this.labels;
    l.t.text('True wind', fmtKn(s.wind.tws)).tip(this.midpoint(this.p0, this.p1), this.centroid, 6);
    l.b.text('Boat-motion wind', fmtKn(s.boat.speed)).tip(this.midpoint(this.p1, this.anchor), this.centroid, 6);
    l.a.text('Apparent wind', `${fmtKn(s.wind.aws)} · ${fmtDeg(s.wind.awa)}`).tip(this.midpoint(this.p0, this.anchor), this.centroid, 6);
  }

  private deckTag(s: SimSnapshot): void {
    this.centroid.copy(this.p0).add(this.p1).add(this.anchor).multiplyScalar(1 / 3);
    // Deck values and the twist come from the two drawn triangles themselves (the same points, the same moment), not
    // from the sim's stern burgee, which differs from the bow while the boat turns.
    const awaMast = this.awa(this.wMast, s), awaDeck = this.awa(this.wDeck, s);
    const twist = Math.abs(awaMast) - Math.abs(awaDeck);
    this.labels.deck.text('Apparent at deck', `${fmtKn(this.wDeck.appW.length())} · ${fmtDeg(awaDeck)} · twist ${Math.round(twist * 180 / Math.PI)}°`)
      .tip(this.midpoint(this.p0, this.anchor), this.centroid, 6);
  }

  /** How far (px) the deck triangle at `this.anchor`, scale `k`, reaches outside the safe area (0: inside). */
  private deckOverflow(view: OverlayView, k: number): number {
    this.p0.copy(this.anchor).addScaledVector(this.wDeck.appW, -k);
    this.p1.copy(this.p0).addScaledVector(this.wDeck.trueW, k);
    return Math.max(this.outside(this.anchor, view), this.outside(this.p0, view), this.outside(this.p1, view));
  }

  /** World point `INSET_DEPTH` in front of the camera that shows at screen point (x, y) (CSS px). */
  private unproject(cam: THREE.PerspectiveCamera, view: OverlayView, x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    const t = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * INSET_DEPTH;
    out.set(((x / view.width) * 2 - 1) * t * (view.width / view.height), (1 - (y / view.height) * 2) * t, -INSET_DEPTH);
    return out.applyMatrix4(cam.matrixWorld);
  }

  /** Screen box (CSS px) of the triangle of `w` at `this.anchor`, scale `k`, into `this.box`. */
  private screenBox(w: ReturnType<typeof pointWind>, k: number, cam: THREE.Camera, view: OverlayView): void {
    const b = this.box;
    b.x0 = b.y0 = Infinity; b.x1 = b.y1 = -Infinity;
    this.q.copy(this.anchor);
    for (let i = 0; i < 3; i++) {
      if (i === 1) this.q.addScaledVector(w.appW, -k);
      if (i === 2) this.q.addScaledVector(w.trueW, k);
      this.mid.copy(this.q).project(cam);
      const x = (this.mid.x * 0.5 + 0.5) * view.width, y = (0.5 - this.mid.y * 0.5) * view.height;
      b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y);
    }
  }

  hide(): void {
    for (const l of Object.values(this.labels)) l.hide();
    this.fresh = true;
    this.inset = false;
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
