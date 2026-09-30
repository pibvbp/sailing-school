// Bottom-right cluster (spec §3.2): camera buttons and overlay toggles (with their hotkeys), plus the
// polar chart toggle. Reflects the App's overlay state, which lessons may change.
import { CAMERA_KEYS, OVERLAY_KEYS, type CameraKey, type OverlayKey } from '../lessons/types';
import { blurAfterMouse, h, icon, Segmented, setClass, type IconName } from './dom';

export const OVERLAY_META: Record<OverlayKey, { label: string; title: string; icon: IconName; key?: string }> = {
  windTriangle: { label: 'Wind', title: 'Wind triangle: true, boat-motion and apparent wind', icon: 'windTriangle' },
  forces: { label: 'Forces', title: 'Force vectors: sail force, drive, heel, keel', icon: 'forces', key: 'V' },
  wheel: { label: 'Wheel', title: 'Points-of-sail wheel', icon: 'wheel', key: 'P' },
  flow: { label: 'Flow', title: 'Airflow streamlines around the sails', icon: 'flow', key: 'O' },
  flowSlice: { label: 'Slice', title: 'Flow slice: a textbook cross-section of the sails, live', icon: 'flowSlice' },
  aoa: { label: 'AoA', title: 'Angle-of-attack colours on the sails', icon: 'aoa' },
  xray: { label: 'X-ray', title: 'See-through water: keel, rudder and leeway', icon: 'xray' },
  labels: { label: 'Labels', title: 'Name the parts of the boat', icon: 'labels' },
  laylines: { label: 'Laylines', title: 'Laylines to the mark', icon: 'laylines' },
  track: { label: 'Track', title: 'Track trail', icon: 'track' },
  telltaleCam: { label: 'Tell cam', title: 'Telltale camera (picture-in-picture)', icon: 'telltaleCam' },
};

export const CAMERA_META: Record<CameraKey, { label: string; title: string }> = {
  chase: { label: 'Chase', title: 'Chase camera (1)' },
  helm: { label: 'Helm', title: 'Helmsman\'s view (2)' },
  top: { label: 'Top', title: 'Top-down view (3)' },
  sail: { label: 'Sail', title: 'Looking up the sails (4)' },
  free: { label: 'Free', title: 'Free orbit — drag to rotate (5)' },
};

export interface OverlayBarHooks {
  setCamera(c: CameraKey): void;
  toggleOverlay(k: OverlayKey): void;
  togglePolar(): void;
}

export class OverlayBar {
  readonly el: HTMLElement;
  private readonly cams: Segmented<CameraKey>;
  private readonly buttons = new Map<OverlayKey, HTMLButtonElement>();
  private readonly state = new Map<OverlayKey, boolean>();
  private readonly polarBtn: HTMLButtonElement;
  private polarOn = false;

  constructor(hooks: OverlayBarHooks) {
    this.cams = new Segmented('Camera', CAMERA_KEYS.map((c) => ({ value: c, ...CAMERA_META[c] })), hooks.setCamera, 'sx-cams');
    const grid = h('div', { class: 'sx-ovl-grid', attrs: { role: 'group', 'aria-label': 'Overlays' } });
    for (const k of OVERLAY_KEYS) {
      const m = OVERLAY_META[k];
      const b = h('button', {
        class: 'sx-ovl',
        title: m.key ? `${m.title} (${m.key})` : m.title,
        attrs: { type: 'button', 'aria-pressed': 'false', 'aria-label': m.title },
        on: { click: () => hooks.toggleOverlay(k) },
      }, [icon(m.icon, 18), h('span', { class: 'sx-ovl-label', text: m.label })]);
      blurAfterMouse(b);
      this.buttons.set(k, b);
      grid.append(b);
    }
    this.polarBtn = h('button', {
      class: 'sx-ovl',
      title: 'Polar diagram: target speed at every wind angle',
      attrs: { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Polar diagram' },
      on: { click: () => hooks.togglePolar() },
    }, [icon('chart', 18), h('span', { class: 'sx-ovl-label', text: 'Polar' })]);
    blurAfterMouse(this.polarBtn);
    grid.append(this.polarBtn);
    this.el = h('div', { class: 'sx-view', attrs: { role: 'region', 'aria-label': 'View' } }, [
      h('div', 'sx-view-row', [h('span', { class: 'sx-view-k', text: 'Camera' }), this.cams.el]),
      grid,
    ]);
  }

  sync(camera: CameraKey, overlays: Record<OverlayKey, boolean>, polarOpen: boolean): void {
    this.cams.set(camera);
    for (const k of OVERLAY_KEYS) {
      const on = overlays[k] === true;
      if (this.state.get(k) === on) continue;
      this.state.set(k, on);
      const b = this.buttons.get(k)!;
      b.setAttribute('aria-pressed', String(on));
      setClass(b, 'is-on', on);
    }
    if (polarOpen !== this.polarOn) {
      this.polarOn = polarOpen;
      this.polarBtn.setAttribute('aria-pressed', String(polarOpen));
      setClass(this.polarBtn, 'is-on', polarOpen);
    }
  }
}
