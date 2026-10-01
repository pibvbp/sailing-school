// Camera modes (spec §5.7 of the plan / §3): chase, helm, top (wind-up), sail-view, free.
// All modes follow the boat smoothly, never dip below the waves, and accept drag-to-look / wheel-to-zoom.
import * as THREE from 'three';
import type { CameraKey } from '../../lessons/types';

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
  /** Water surface height at a world point (for keeping the camera dry). */
  waterHeight(x: number, z: number): number;
}

interface Settings { fov: number; dist: number; minDist: number; maxDist: number; yaw: number; pitch: number }

const MODES: Record<CameraKey, Settings> = {
  chase: { fov: 50, dist: 17, minDist: 7, maxDist: 60, yaw: 0.45, pitch: 0.22 },
  helm: { fov: 62, dist: 0, minDist: 0, maxDist: 0, yaw: 0, pitch: 0 },
  top: { fov: 35, dist: 70, minDist: 25, maxDist: 400, yaw: 0, pitch: 0 },
  sail: { fov: 72, dist: 0, minDist: 0, maxDist: 0, yaw: 0, pitch: 0 },
  free: { fov: 50, dist: 24, minDist: 5, maxDist: 250, yaw: 0.9, pitch: 0.3 },
};

const tmpV = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

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

  setMode(m: CameraKey): void {
    this.mode = m;
    const s = MODES[m];
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.dist = s.dist;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.camera.fov = s.fov;
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
    this.snapped = false;
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
    const dx = e.clientX - this.dragging.x;
    const dy = e.clientY - this.dragging.y;
    this.dragging.x = e.clientX;
    this.dragging.y = e.clientY;
    const k = 0.005;
    // Horizontal drags move the world with the pointer (as in a map or a 3-D viewer): drag right and the scene turns
    // right — the orbit cameras swing the other way round the boat, the helm and sail views look the other way.
    if (this.mode === 'helm' || this.mode === 'sail') {
      this.lookYaw += dx * k;
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * k, -1.2, 1.4);
    } else if (this.mode === 'top') {
      this.yaw += dx * k;
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
    const follow = this.snapped ? 1 - Math.exp(-dt * 5) : 1;
    const cam = this.camera;
    switch (this.mode) {
      case 'chase':
      case 'free': {
        // Chase orbits relative to the stern; free orbits in world space.
        const base = this.mode === 'chase' ? f.heading : 0;
        const a = base + Math.PI + this.yaw;
        const horiz = this.dist * Math.cos(this.pitch);
        tmpV.set(f.boatPos.x + Math.sin(a) * horiz, f.boatPos.y + 2 + this.dist * Math.sin(this.pitch), f.boatPos.z - Math.cos(a) * horiz);
        tmpT.set(f.boatPos.x, f.boatPos.y + 3.2, f.boatPos.z);
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
        // Seated on the windward side of the cockpit, eyes ≈ 1.45 m above the waterline.
        this.local(f, 0.95 * f.windSide, 1.45, 2.3, this.pos);
        this.local(f, -0.2 * f.windSide, 4.2, -2.9, tmpT);
        cam.position.copy(this.pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(tmpT);
        this.applyLook(cam, -0.5 * f.heel);
        this.keepDry(f, cam.position, 0.3);
        break;
      }
      case 'sail': {
        // Under the boom by the mast, looking up the mainsail to judge twist and draft.
        this.local(f, 0.35 * f.windSide, 1.55, 0.2, this.pos);
        this.local(f, -1.1 * f.windSide, 7.5, 1.4, tmpT);
        cam.position.copy(this.pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(tmpT);
        this.applyLook(cam, 0);
        break;
      }
    }
    this.snapped = true;
  }

  private applyLook(cam: THREE.PerspectiveCamera, roll: number): void {
    tmpE.set(this.lookPitch, this.lookYaw, roll, 'YXZ');
    tmpQ.setFromEuler(tmpE);
    cam.quaternion.multiply(tmpQ);
  }

  private keepDry(f: CameraFrame, p: THREE.Vector3, clearance: number): void {
    const h = f.waterHeight(p.x, p.z) + clearance;
    if (p.y < h) p.y = h;
  }
}
