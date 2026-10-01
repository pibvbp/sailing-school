// Camera modes (spec §5.7 of the plan / §3): chase, helm, top (wind-up), sail-view, free.
// All modes follow the boat smoothly, never dip below the waves, and accept drag-to-look / wheel-to-zoom.
// The subject is kept in the middle of the part of the view that panels do not cover (setSafeArea).
import * as THREE from 'three';
import type { CameraKey } from '../../lessons/types';
import { BOAT } from '../../shared/boatSpec';

export interface CameraFrame {
  /** Boat root world matrix (heading, heel, pitch, heave applied). */
  boatMatrix: THREE.Matrix4;
  /** Boat position in the world (three.js). */
  boatPos: THREE.Vector3;
  /** Compass heading (rad). */
  heading: number;
  heel: number;
  /** Direction the true wind blows FROM (compass rad) — the top view puts it at the top of the screen. */
  twd: number;
  /** +1 wind from starboard (starboard is windward), −1 from port. */
  windSide: number;
  /** Mainsail boom angle (rad, + out to port): the sail view sits beside the boom. Omitted = on the centreline. */
  boomAngle?: number;
  /** Water surface height at a world point (for keeping the camera dry). */
  waterHeight(x: number, z: number): number;
}

interface Settings { fov: number; dist: number; minDist: number; maxDist: number; yaw: number; pitch: number }

const MODES: Record<CameraKey, Settings> = {
  chase: { fov: 50, dist: 17, minDist: 7, maxDist: 60, yaw: 0.45, pitch: 0.22 },
  helm: { fov: 62, dist: 0, minDist: 0, maxDist: 0, yaw: 0, pitch: 0 },
  top: { fov: 35, dist: 70, minDist: 25, maxDist: 400, yaw: 0, pitch: 0 },
  sail: { fov: 70, dist: 0, minDist: 0, maxDist: 0, yaw: 0, pitch: 0 },
  free: { fov: 50, dist: 24, minDist: 5, maxDist: 250, yaw: 0.9, pitch: 0.3 },
};

/** Part of the view covered by panels, as insets from its edges (CSS px). */
export interface ViewInsets { top: number; right: number; bottom: number; left: number }

/**
 * Sail view, in metres: the camera stands `off` to windward of the boom, `along` it from the gooseneck and `below`
 * it, and looks square at the sail, at a point `aimH` above the waterline. From there the foot runs level along the
 * bottom of the picture and the head sits in its upper third.
 */
const SAIL_VIEW = { along: 0.42 * BOAT.main.E, off: 1.3, below: 0.45, aimH: 3.5 };
/** How fast the views ease (1/s): across the cockpit in a tack, after the boom, and to a new safe area. */
const EASE = { side: 2.5, boom: 4, centre: 6 };
/** The subject is never pushed further off centre than this fraction of the view. */
const MAX_OFF_CENTRE = 0.2;
/**
 * What the orbit cameras keep in the picture: they aim at `aimH` above the waterline, and start far enough away for
 * `height` × `width` metres of boat (waterline to masthead, and the hull seen from the quarter) to fill no more than
 * `fill` of the uncovered view. On a desktop that is the mode's own distance; on a phone it is further away.
 */
const SUBJECT = { aimH: 4.6, height: 11, width: 7.2, fill: 0.88 };

/**
 * Helm view, in boat-local metres (X to the windward side, Y above the waterline, Z aft): the eye, and the point it
 * looks at — up the slot between the sails, low enough to keep the bow and the sea ahead in the picture.
 */
const HELM_EYE = { x: 0.6, y: 1.7, z: 2.45 };
const HELM_AIM = { x: -0.1, y: 3.3, z: -2.9 };

const tmpV = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const CAMERA_X = new THREE.Vector3(1, 0, 0);

export class CameraRig {
  mode: CameraKey = 'chase';
  private yaw = MODES.chase.yaw;
  private pitch = MODES.chase.pitch;
  private dist = MODES.chase.dist;
  /** Free-look offsets for helm and sail views. */
  private lookYaw = 0;
  private lookPitch = 0;
  private readonly pos = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private snapped = false;
  /** The crew's side (±1), eased across in a tack: the helm view walks over the cockpit instead of cutting. */
  private side = 1;
  /** Boom angle the sail view follows, smoothed so that a flogging boom does not shake the picture. */
  private boom = 0;
  /** Middle of the uncovered view relative to the canvas centre (CSS px, +x right, +y down): wanted and eased. */
  private readonly centreWanted = { x: 0, y: 0 };
  private readonly centre = { x: 0, y: 0 };
  private viewHeight = 0;
  /** Size of the uncovered part of the view (CSS px); 0 until the app reports it. */
  private readonly free = { w: 0, h: 0 };
  /** The learner has zoomed since the view was chosen: their distance stands, the automatic fit steps back. */
  private zoomed = false;
  private dragging: { x: number; y: number; id: number } | null = null;
  private pinch: { d: number } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly dom: HTMLElement) {
    dom.addEventListener('pointerdown', this.onDown);
    addEventListener('pointermove', this.onMove);
    addEventListener('pointerup', this.onUp);
    addEventListener('pointercancel', this.onUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.setMode('chase');
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointermove', this.onMove);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('pointercancel', this.onUp);
    this.dom.removeEventListener('wheel', this.onWheel);
  }

  /** Jump to the boat on the next update instead of easing there (a new scenario may start far away). */
  snap(): void {
    this.snapped = false;
  }

  /**
   * The part of the view that panels cover, as insets from the canvas edges (CSS px; null = none), with the canvas
   * size. The rig keeps its subject in the middle of what is left, easing there when the panels move.
   */
  setSafeArea(insets: ViewInsets | null, width: number, height: number): void {
    const limit = (v: number, size: number) => THREE.MathUtils.clamp(v, -MAX_OFF_CENTRE * size, MAX_OFF_CENTRE * size);
    this.centreWanted.x = insets ? limit((insets.left - insets.right) / 2, width) : 0;
    this.centreWanted.y = insets ? limit((insets.top - insets.bottom) / 2, height) : 0;
    this.viewHeight = height;
    this.free.w = Math.max(1, width - (insets ? insets.left + insets.right : 0));
    this.free.h = Math.max(1, height - (insets ? insets.top + insets.bottom : 0));
  }

  /** Distance at which the whole boat fits the uncovered view (orbit cameras), never closer than the mode's own. */
  private fitDist(): number {
    const s = MODES[this.mode];
    if (this.viewHeight <= 0) return s.dist;
    const focal = (0.5 * this.viewHeight) / Math.tan(THREE.MathUtils.degToRad(s.fov) / 2); // px
    const fit = (focal / SUBJECT.fill) * Math.max(SUBJECT.height / this.free.h, SUBJECT.width / this.free.w);
    return THREE.MathUtils.clamp(fit, s.dist, s.maxDist);
  }

  setMode(m: CameraKey): void {
    this.mode = m;
    const s = MODES[m];
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.dist = s.dist;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.zoomed = false;
    this.camera.fov = s.fov;
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
    this.snapped = false;
  }

  /**
   * Stand this far from the boat (orbit and top cameras; metres, kept inside the mode's limits). Like a zoom by the
   * learner, it stands until the view is chosen again.
   */
  setDistance(metres: number): void {
    const s = MODES[this.mode];
    if (s.maxDist === 0 || !Number.isFinite(metres)) return;
    this.dist = THREE.MathUtils.clamp(metres, s.minDist, s.maxDist);
    this.zoomed = true;
  }

  private onDown = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) this.dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
      this.dragging = null;
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      this.zoom(this.pinch.d / Math.max(d, 1));
      this.pinch.d = d;
      return;
    }
    if (!this.dragging || this.dragging.id !== e.pointerId) return;
    const prevX = this.dragging.x, prevY = this.dragging.y;
    const dx = e.clientX - prevX;
    const dy = e.clientY - prevY;
    this.dragging.x = e.clientX;
    this.dragging.y = e.clientY;
    const k = 0.005;
    // Drags move the world with the pointer (as in a map or a 3-D viewer), in every mode and both directions: drag
    // right and the scene goes right, drag down and it goes down. The orbit cameras swing the other way round the
    // boat; the helm and sail views look the other way.
    if (this.mode === 'helm' || this.mode === 'sail') {
      this.lookYaw += dx * k;
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch + dy * k, -1.2, 1.4);
    } else if (this.mode === 'top') {
      // Turn the chart with the pointer: by the angle the pointer sweeps round the middle of the view (the boat),
      // so it follows the hand whether it is grabbed above, below or beside the boat.
      const r = this.dom.getBoundingClientRect();
      const cx = r.left + r.width / 2 + this.centre.x, cy = r.top + r.height / 2 + this.centre.y;
      if (Math.hypot(e.clientX - cx, e.clientY - cy) > 12 && Math.hypot(prevX - cx, prevY - cy) > 12) {
        let da = Math.atan2(e.clientY - cy, e.clientX - cx) - Math.atan2(prevY - cy, prevX - cx);
        if (da > Math.PI) da -= 2 * Math.PI;
        else if (da < -Math.PI) da += 2 * Math.PI;
        this.yaw -= da;
      }
    } else {
      this.yaw += dx * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, 0.02, 1.45);
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.dragging?.id === e.pointerId) this.dragging = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * 0.0012));
  };

  private zoom(factor: number): void {
    const s = MODES[this.mode];
    this.zoomed = true;
    if (s.maxDist === 0) {
      this.camera.fov = THREE.MathUtils.clamp(this.camera.fov * factor, 25, 90);
      this.camera.updateProjectionMatrix();
      return;
    }
    this.dist = THREE.MathUtils.clamp(this.dist * factor, s.minDist, s.maxDist);
  }

  /** Boat-local point (X stbd, Y up, Z aft) → world. */
  private local(f: CameraFrame, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, y, z).applyMatrix4(f.boatMatrix);
  }

  update(dt: number, f: CameraFrame): void {
    const ease = (rate: number) => (this.snapped ? 1 - Math.exp(-dt * rate) : 1);
    const follow = ease(5);
    this.side += (f.windSide - this.side) * ease(EASE.side);
    this.boom += ((f.boomAngle ?? 0) - this.boom) * ease(EASE.boom);
    this.centre.x += (this.centreWanted.x - this.centre.x) * ease(EASE.centre);
    this.centre.y += (this.centreWanted.y - this.centre.y) * ease(EASE.centre);
    const cam = this.camera;
    switch (this.mode) {
      case 'chase':
      case 'free': {
        // Until the learner zooms, stand far enough back for the whole rig to show between the panels.
        if (!this.zoomed) this.dist += (this.fitDist() - this.dist) * ease(EASE.centre);
        // Chase orbits relative to the stern; free orbits in world space.
        const base = this.mode === 'chase' ? f.heading : 0;
        const a = base + Math.PI + this.yaw;
        const horiz = this.dist * Math.cos(this.pitch);
        tmpV.set(f.boatPos.x + Math.sin(a) * horiz, f.boatPos.y + 2 + this.dist * Math.sin(this.pitch), f.boatPos.z - Math.cos(a) * horiz);
        tmpT.set(f.boatPos.x, f.boatPos.y + SUBJECT.aimH, f.boatPos.z);
        this.pos.lerp(tmpV, this.snapped ? follow : 1);
        this.target.lerp(tmpT, this.snapped ? 1 - Math.exp(-dt * 8) : 1);
        this.keepDry(f, this.pos, 0.8);
        cam.position.copy(this.pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(this.target);
        break;
      }
      case 'top': {
        // Straight down, rotated so the wind comes from the top of the screen.
        tmpV.set(f.boatPos.x, f.boatPos.y + this.dist, f.boatPos.z);
        this.pos.lerp(tmpV, follow);
        cam.position.copy(this.pos);
        const w = f.twd + this.yaw;
        cam.up.set(Math.sin(w), 0, -Math.cos(w));
        cam.lookAt(this.pos.x, f.boatPos.y, this.pos.z);
        break;
      }
      case 'helm': {
        // Standing at the tiller just inboard of the crew on the windward rail, eyes ≈ 1.7 m above the waterline:
        // their heads stay below and beside the picture instead of filling it.
        this.local(f, HELM_EYE.x * this.side, HELM_EYE.y, HELM_EYE.z, this.pos);
        this.local(f, HELM_AIM.x * this.side, HELM_AIM.y, HELM_AIM.z, tmpT);
        cam.position.copy(this.pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(tmpT);
        this.applyLook(cam, -0.5 * f.heel);
        this.keepDry(f, cam.position, 0.3);
        break;
      }
      case 'sail': {
        // Beside the boom at mid-foot, on the windward side, looking up the mainsail: the mast up one side of the
        // picture, the leech up the other and the draft stripes across it — the view for judging twist and draft.
        // (Boat-local X is starboard and Z aft; a positive boom angle is out to port.)
        const g = BOAT.boom.gooseneck, v = SAIL_VIEW;
        const alongX = -Math.sin(this.boom), alongZ = Math.cos(this.boom);
        const offX = f.windSide * Math.cos(this.boom), offZ = f.windSide * Math.sin(this.boom);
        this.local(f, alongX * v.along + offX * v.off, g.h - v.below, -g.x + alongZ * v.along + offZ * v.off, this.pos);
        this.local(f, alongX * v.along, v.aimH, -g.x + alongZ * v.along, tmpT);
        cam.position.copy(this.pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(tmpT);
        this.applyLook(cam, 0);
        break;
      }
    }
    this.applyCentre(cam);
    this.snapped = true;
  }

  /** Turn the camera (or, looking straight down, slide it) so its subject sits at the middle of the uncovered view. */
  private applyCentre(cam: THREE.PerspectiveCamera): void {
    const { x, y } = this.centre;
    if ((x === 0 && y === 0) || this.viewHeight <= 0) return;
    const focal = (0.5 * this.viewHeight) / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2); // px
    if (this.mode === 'top') {
      // Nothing to turn about when looking straight down: slide over the chart instead.
      const mPerPx = this.dist / focal;
      cam.translateX(-x * mPerPx);
      cam.translateY(y * mPerPx);
      return;
    }
    // Left/right about the world's vertical, so the horizon stays level (a steep view needs a bigger turn for the same
    // shift on screen); up/down in the camera's own frame.
    cam.getWorldDirection(tmpV);
    const level = Math.max(0.25, Math.hypot(tmpV.x, tmpV.z));
    tmpQ.setFromAxisAngle(WORLD_UP, Math.atan2(x, focal * level));
    cam.quaternion.premultiply(tmpQ);
    tmpQ.setFromAxisAngle(CAMERA_X, Math.atan2(y, focal));
    cam.quaternion.multiply(tmpQ);
  }

  private applyLook(cam: THREE.PerspectiveCamera, roll: number): void {
    // Look left/right about the world's vertical (the horizon stays level however far the head turns), then up/down
    // and the heel-following roll in the camera's own frame.
    tmpQ.setFromAxisAngle(WORLD_UP, this.lookYaw);
    cam.quaternion.premultiply(tmpQ);
    tmpE.set(this.lookPitch, 0, roll, 'YXZ');
    tmpQ.setFromEuler(tmpE);
    cam.quaternion.multiply(tmpQ);
  }

  private keepDry(f: CameraFrame, p: THREE.Vector3, clearance: number): void {
    const h = f.waterHeight(p.x, p.z) + clearance;
    if (p.y < h) p.y = h;
  }
}
