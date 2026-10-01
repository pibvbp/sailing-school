// X-ray view (spec §8 "X-ray water: … show keel, rudder, leeway and underwater forces") — the overlay half of it. The
// ocean makes the water round the hull see-through; this draws what the learner is meant to see there:
//  * the keel and the rudder as bright ghosts, drawn through the hull and the water, so they show from every camera
//    (from the chase camera the keel hides behind the heeled hull). The rudder ghost turns with the helm;
//  * the leeway picture at the keel: a white arrow where the boat points (her heading), a yellow arrow where she
//    actually goes through the water (her track), the wedge between them filled in, and the angle named —
//    "Leeway 3.8°". Astern, marks drift away along the track at the boat's speed, like weed in the water: that is
//    how the water meets the keel — at the leeway angle, the keel's angle of attack.
// The picture lies level with the keel and is drawn through whatever is in front of it; the stretch under the boat
// herself is drawn faint, so the two arrows visibly come out from under the bow instead of lying across the deck.
// This is a teaching view: clarity beats realism.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import type { SimSnapshot } from '../../sim/types';
import { DEG } from '../../shared/math';
import { buildKeelGeometry, buildRudderBlade } from '../boat/appendages';
import { ARROW_MEDIUM, type ArrowBatch, type ArrowStyle } from './arrows';
import { hyp, type BoatFrame } from './frames';
import type { Label, LabelLayer } from './labels';
import { LineBatch, type LineStyle } from './lines';
import { OVERLAY_COMMON, OVERLAY_OUTPUT, bindOverlayMesh, overlayUniforms, type OverlayContext, type OverlayView } from './overlayMaterial';
import { COLORS, linearColor } from './palette';

/** The leeway picture starts at the keel's centre of pressure (body frame: x forward, z down). */
const KEEL = { x: BOAT.keel.cp.x, y: 0, z: -BOAT.keel.cp.h };
/** From the keel, the hull reaches this far forward and aft (m, with a little margin): the faint stretch. */
const UNDER_FWD = BOAT.hull.stemDeck.x - KEEL.x;
const UNDER_AFT = KEEL.x - BOAT.hull.transomDeck.x + 0.2;
/** The arrows reach this far ahead of the keel and the lines run this far on astern (m, at the chase camera's distance). */
const AHEAD = 9.5;
const ASTERN = 7.5;
/** From far away the picture is drawn larger, by up to this factor. */
const FAR_SCALE_MAX = 2.4;
/** Radius of the angle's arc, as a fraction of the arrows' length. */
const ARC_AT = 0.72;
const ARC_PTS = 7;
/** Below this speed through the water (m/s) "where she goes" means nothing; the picture fades out. */
const MIN_SPEED = 0.35;
/** Seconds to fade in and out with the x-ray, like the water does. */
const FADE_S = 0.35;
/** Strength of the stretch under the boat. */
const UNDER_BOAT = 0.28;
/** Water marks along the track astern: dashes one period (m) apart, drifting aft at the boat's speed. */
const MARK_M = 1.2;

const cHeading = linearColor(COLORS.heading);
const cTrack = linearColor(COLORS.track);

const HEADING_ARROW: ArrowStyle = { ...ARROW_MEDIUM, width: 3.4, head: 16, headWidth: 13, glow: 5, hidden: 0.95 };
const TRACK_ARROW: ArrowStyle = { ...ARROW_MEDIUM, hidden: 0.95 };

const GHOST_VERT = /* glsl */ `
${OVERLAY_COMMON}
varying vec3 vN;
varying vec3 vV;
void main() {
  if (uVisible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

// A fin seen as on an X-ray plate: faint where it faces the eye, bright along its edges.
const GHOST_FRAG = /* glsl */ `
${OVERLAY_COMMON}
uniform vec3 uColor;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main() {
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float rim = 1.0 - facing;
  float a = (0.3 + 0.65 * rim * rim) * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(overlayColor(uColor), a);
  ${OVERLAY_OUTPUT}
}
`;

const WEDGE_VERT = /* glsl */ `
${OVERLAY_COMMON}
attribute float aFade;
varying float vFade;
void main() {
  if (uVisible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WEDGE_FRAG = /* glsl */ `
${OVERLAY_COMMON}
uniform vec3 uColor;
uniform float uAlpha;
varying float vFade;
void main() {
  float a = uAlpha * vFade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(overlayColor(uColor), a);
  ${OVERLAY_OUTPUT}
}
`;

export class XrayOverlay {
  /** Keel and rudder ghosts: boat-local, add under the boat root. */
  readonly boatGroup = new THREE.Group();
  /** The leeway wedge and lines: world space, add to the scene. */
  readonly worldGroup = new THREE.Group();
  private readonly rudder = new THREE.Group();
  private readonly ghost: THREE.ShaderMaterial;
  private readonly wedge: THREE.ShaderMaterial;
  private readonly wedgeGeo = new THREE.BufferGeometry();
  private readonly wedgePos: THREE.BufferAttribute;
  private readonly lines: LineBatch;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly labels: { leeway: Label; heading: Label; track: Label };
  private readonly o = new THREE.Vector3();
  private readonly xH = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly buf = new Float32Array(3 * Math.max(ARC_PTS, 2));
  // Line styles (their strength and dash length follow the fade and the view scale).
  private readonly faint = { width: 2, alpha: UNDER_BOAT };
  private readonly dashed = { width: 2, alpha: 0.6, dash: 0.5, duty: 0.55 };
  private readonly marks = { width: 3, alpha: 0.95, dash: MARK_M, duty: 0.42, dashSpeed: 1, dashFloor: 0.12, glow: 2 };
  private readonly arc = { width: 3, alpha: 1, glow: 2 };
  private fade = 0;
  private want = false;
  /** Leeway angle on show (rad, + to starboard), eased so the picture does not twitch, and how far it is faded in. */
  private angle = 0;
  private shown = 0;
  /** Metres the boat has gone through the water (wrapped): the water marks drift aft by it. */
  private travel = 0;
  private lastT = NaN;

  constructor(ctx: OverlayContext, private readonly arrows: ArrowBatch, layer: LabelLayer) {
    const u = overlayUniforms();
    this.ghost = new THREE.ShaderMaterial({
      uniforms: { ...u, uColor: { value: new THREE.Color('#b9f6ff') }, uAlpha: { value: 0 } },
      vertexShader: GHOST_VERT,
      fragmentShader: GHOST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false, // through the hull and the water
      premultipliedAlpha: true,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    const keel = buildKeelGeometry(16, 8);
    const blade = buildRudderBlade(14);
    this.geometries.push(keel, blade);
    const keelMesh = new THREE.Mesh(keel, this.ghost);
    const bladeMesh = new THREE.Mesh(blade, this.ghost);
    // The rudder blade is modelled about its stock (origin on the stock at the waterline), as in the boat model.
    this.rudder.position.set(0, 0, -BOAT.rudder.stockX);
    this.rudder.add(bladeMesh);
    for (const m of [keelMesh, bladeMesh]) {
      m.renderOrder = 15;
      bindOverlayMesh(m, u, ctx);
    }
    this.boatGroup.add(keelMesh, this.rudder);
    this.boatGroup.name = 'overlay-xray-fins';
    this.boatGroup.visible = false;

    // The wedge between heading and track: two triangles (ahead of the keel and astern), faint under the boat.
    const uw = overlayUniforms();
    this.wedge = new THREE.ShaderMaterial({
      uniforms: { ...uw, uColor: { value: cTrack }, uAlpha: { value: 0 } },
      vertexShader: WEDGE_VERT,
      fragmentShader: WEDGE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.wedgePos = new THREE.BufferAttribute(new Float32Array(18), 3);
    this.wedgePos.setUsage(THREE.DynamicDrawUsage);
    this.wedgeGeo.setAttribute('position', this.wedgePos);
    this.wedgeGeo.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array([0.1, 1, 1, 0.1, 0.6, 0.6]), 1));
    const wedgeMesh = new THREE.Mesh(this.wedgeGeo, this.wedge);
    wedgeMesh.renderOrder = 14;
    bindOverlayMesh(wedgeMesh, uw, ctx);
    this.lines = new LineBatch(ctx, 32, { depthTest: false, renderOrder: 18 });
    this.worldGroup.add(wedgeMesh, this.lines.group);
    this.worldGroup.name = 'overlay-xray-leeway';
    this.worldGroup.visible = false;

    this.labels = {
      leeway: layer.create({ kind: 'tag', color: COLORS.track, priority: 8 }),
      heading: layer.create({ color: COLORS.heading, priority: 4 }),
      track: layer.create({ color: COLORS.track, priority: 4 }),
    };
  }

  setVisible(on: boolean): void {
    this.want = on;
    if (!on) this.hideLabels();
  }

  /** On, or still fading out: `update` has work to do. */
  get active(): boolean {
    return this.want || this.fade > 0;
  }

  /** Per frame while x-ray is on or still fading out; adds the heading and track arrows to the shared batch. */
  update(dt: number, s: SimSnapshot, frame: BoatFrame, view: OverlayView): void {
    this.fade = Math.min(1, Math.max(0, this.fade + (this.want ? dt : -dt) / FADE_S));
    this.boatGroup.visible = this.fade > 0;
    this.rudder.rotation.y = s.boat.rudder;
    this.ghost.uniforms['uAlpha']!.value = this.fade;

    // Leeway: only while she moves ahead through the water under her own sails.
    const b = s.boat;
    const moving = !s.towed && b.u > MIN_SPEED && Math.abs(b.leeway) < 50 * DEG;
    this.shown = Math.min(1, Math.max(0, this.shown + (moving && this.want ? dt : -dt) / FADE_S));
    const k = this.shown * this.fade;
    this.worldGroup.visible = k > 0.01;
    this.lines.begin();
    if (k <= 0.01) {
      this.lines.end();
      this.hideLabels();
      if (!moving) this.angle = 0;
      return;
    }
    if (moving) this.angle += (b.leeway - this.angle) * Math.min(1, dt / 0.35);
    const scale = Math.min(FAR_SCALE_MAX, view.scale);
    const ahead = AHEAD * scale, astern = ASTERN * scale;
    frame.point(KEEL.x, KEEL.y, KEEL.z, this.o);
    // Heading and track, level, in the world: the track is the heading turned by the leeway (+ to starboard).
    const psi = b.heading;
    this.xH.set(Math.sin(psi), 0, -Math.cos(psi));
    this.dir.set(Math.sin(psi + this.angle), 0, -Math.cos(psi + this.angle));

    // Under the boat both lines are faint; where they come out — ahead of the bow, astern of the transom — they are
    // the picture: two arrows ahead, and astern the heading dashed and the track marked by weed drifting away.
    this.faint.alpha = UNDER_BOAT * k;
    this.span(this.xH, -UNDER_AFT, UNDER_FWD, cHeading, this.faint);
    this.span(this.dir, -UNDER_AFT, UNDER_FWD, cTrack, this.faint);
    this.dashed.alpha = 0.6 * k;
    this.dashed.dash = 0.5 * scale;
    this.span(this.xH, -astern, -UNDER_AFT, cHeading, this.dashed);
    const ds = s.t - this.lastT;
    this.lastT = s.t;
    const period = MARK_M * scale;
    if (ds > 0 && ds < 0.5) this.travel = (this.travel + hyp(b.u, b.v) * ds) % (64 * period);
    this.lines.setTime(this.travel);
    this.marks.alpha = 0.95 * k;
    this.marks.dash = period;
    this.span(this.dir, -UNDER_AFT, -astern, cTrack, this.marks);
    this.a.copy(this.o).addScaledVector(this.xH, ahead);
    this.b.copy(this.o).addScaledVector(this.dir, ahead);
    this.arrows.add(this.c.copy(this.o).addScaledVector(this.xH, UNDER_FWD), this.a, cHeading, HEADING_ARROW, k);
    this.arrows.add(this.c.copy(this.o).addScaledVector(this.dir, UNDER_FWD), this.b, cTrack, TRACK_ARROW, k);

    // The wedge between them, ahead and astern.
    const p = this.wedgePos.array as Float32Array;
    this.put(p, 0, this.o); this.put(p, 3, this.a); this.put(p, 6, this.b);
    this.put(p, 9, this.o);
    this.put(p, 12, this.c.copy(this.o).addScaledVector(this.xH, -astern));
    this.put(p, 15, this.c.copy(this.o).addScaledVector(this.dir, -astern));
    this.wedgePos.needsUpdate = true;
    this.wedge.uniforms['uAlpha']!.value = 0.5 * k;

    // The angle's arc and its name.
    const r = ARC_AT * ahead;
    for (let i = 0; i < ARC_PTS; i++) {
      const t = psi + (this.angle * i) / (ARC_PTS - 1);
      this.buf[3 * i] = this.o.x + Math.sin(t) * r;
      this.buf[3 * i + 1] = this.o.y;
      this.buf[3 * i + 2] = this.o.z - Math.cos(t) * r;
    }
    this.arc.alpha = k;
    this.lines.add(this.buf, ARC_PTS, cTrack, this.arc);
    this.lines.end();

    const L = this.labels;
    // The angle's tag stands on the track's side of the arc, pushed out across the track line.
    const mid = psi + 0.5 * this.angle;
    this.c.set(this.o.x + Math.sin(mid) * r, this.o.y, this.o.z - Math.cos(mid) * r);
    const side = this.angle >= 0 ? 1 : -1;
    this.dir.set(Math.cos(psi) * side, 0, Math.sin(psi) * side); // to the track's side of the heading
    L.leeway.text('Leeway', `${Math.abs(b.leeway / DEG).toFixed(1)}°`).tip(this.c, this.xH.copy(this.c).addScaledVector(this.dir, -1), 14);
    L.heading.text('Heading').tip(this.a, this.o);
    L.track.text('Track').tip(this.b, this.o);
  }

  hide(): void {
    this.want = false;
    this.fade = 0;
    this.shown = 0;
    this.boatGroup.visible = false;
    this.worldGroup.visible = false;
    this.hideLabels();
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.wedgeGeo.dispose();
    this.ghost.dispose();
    this.wedge.dispose();
    this.lines.dispose();
  }

  private hideLabels(): void {
    this.labels.leeway.hide();
    this.labels.heading.hide();
    this.labels.track.hide();
  }

  private put(p: Float32Array, at: number, v: THREE.Vector3): void {
    p[at] = v.x; p[at + 1] = v.y; p[at + 2] = v.z;
  }

  /** A straight piece of the heading or track line: from `from` to `to` metres along `d` from the keel. */
  private span(d: THREE.Vector3, from: number, to: number, color: THREE.Color, style: LineStyle): void {
    const o = this.o;
    this.buf[0] = o.x + d.x * from; this.buf[1] = o.y; this.buf[2] = o.z + d.z * from;
    this.buf[3] = o.x + d.x * to; this.buf[4] = o.y; this.buf[5] = o.z + d.z * to;
    this.lines.add(this.buf, 2, color, style);
  }
}
