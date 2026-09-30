// Keyboard input (spec §3.3). Held keys change controls at fixed rates in update(dt); one-shot keys fire
// commands. Helm is "hold to turn, release to centre" by default; Shift gives fine control. Keys are
// ignored while the learner types in a text field, and native keys of focused widgets are left alone.
// No DOM access at import time: the controller only needs add/removeEventListener on its target.
import { clamp, DEG, wrapPi } from '../shared/math';
import { CAMERA_KEYS, type AppApi, type CameraKey, type ControlKey, type OverlayKey } from '../lessons/types';

/** Key-hold rates (per second). Sheets/traveler/tiller are the spec values; pole/furl/autopilot are ours. */
export const INPUT_RATES = {
  sheet: 0.35,
  traveler: 0.5,
  tillerSlew: 2,
  tillerCentre: 2,
  pole: 0.3,
  furl: 0.4,
  /** Autopilot target change while ←/→ are held in heading/TWA/AWA mode (rad/s). */
  autopilot: 10 * DEG,
  /** Multiplier while Shift is held. */
  fine: 0.25,
} as const;

export const TIME_SCALES: readonly number[] = [0.25, 0.5, 1, 2];

/** UI-level actions; the Hud supplies an implementation that keeps its buttons in sync. */
export interface UiCommands {
  togglePause(): void;
  stepTimeScale(dir: -1 | 1): void;
  setCamera(c: CameraKey): void;
  cycleCamera(): void;
  toggleOverlay(k: OverlayKey): void;
  toggleHelp(): void;
  /** Esc: close whatever is open, else open the menu. */
  escape(): void;
  /** Short informational message (e.g. "Main: you're trimming"). */
  notify(msg: string): void;
}

/** Commands that talk to the app directly (used until a Hud is attached). */
export function directCommands(app: AppApi): UiCommands {
  let scale = TIME_SCALES.indexOf(1);
  let cam = 0;
  return {
    togglePause: () => app.togglePause(),
    stepTimeScale: (dir) => {
      scale = clamp(scale + dir, 0, TIME_SCALES.length - 1);
      app.setTimeScale(TIME_SCALES[scale]!);
    },
    setCamera: (c) => {
      cam = Math.max(0, CAMERA_KEYS.indexOf(c));
      app.setCamera(c);
    },
    cycleCamera: () => {
      cam = (cam + 1) % CAMERA_KEYS.length;
      app.setCamera(CAMERA_KEYS[cam]!);
    },
    toggleOverlay: (k) => app.setOverlay(k, !app.overlays()[k]),
    toggleHelp: () => {},
    escape: () => {},
    notify: () => {},
  };
}

type Held =
  | 'port' | 'stbd' | 'mainIn' | 'mainOut' | 'jibIn' | 'jibOut' | 'travUp' | 'travDown'
  | 'spinIn' | 'spinOut' | 'poleFwd' | 'poleAft';

const HELD_KEYS: Readonly<Record<string, Held>> = {
  arrowleft: 'port', a: 'port',
  arrowright: 'stbd', d: 'stbd',
  w: 'mainIn', s: 'mainOut',
  arrowup: 'jibIn', arrowdown: 'jibOut',
  q: 'travUp', z: 'travDown',
  i: 'spinIn', k: 'spinOut',
  j: 'poleFwd', l: 'poleAft',
};

const OVERLAY_HOTKEYS: Readonly<Record<string, OverlayKey>> = { v: 'forces', o: 'flow', p: 'wheel' };

const NAV_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown']);

/** Minimal shape of the keyboard events we read (tests pass plain objects). */
export interface KeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

/** 'text' = the learner is typing; 'slider' = a focused range/slider owns the arrow keys; 'widget' = owns Space/Enter. */
export function focusKind(target: EventTarget | null | undefined): 'text' | 'slider' | 'widget' | null {
  const el = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown; getAttribute?: (n: string) => string | null } | null;
  if (!el || typeof el.tagName !== 'string') return null;
  if (el.isContentEditable === true) return 'text';
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 'text';
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
  if (tag === 'INPUT') {
    const type = String(el.type ?? 'text').toLowerCase();
    if (type === 'range') return 'slider';
    if (['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(type)) return 'widget';
    return 'text';
  }
  if (role === 'slider') return 'slider';
  if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A' || role === 'button' || role === 'radio' || role === 'switch') return 'widget';
  return null;
}

/** Layout-aware key id: Latin letters by character, other layouts by physical key, the rest by key name. */
export function keyId(e: Pick<KeyLike, 'key' | 'code'>): string {
  const k = e.key ?? '';
  if (k.length === 1) {
    const lower = k.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return lower;
    if (/^Key[A-Z]$/.test(e.code ?? '')) return e.code.slice(3).toLowerCase();
    return k;
  }
  return k.toLowerCase();
}

function cameraFromCode(code: string): CameraKey | null {
  const m = /^(?:Digit|Numpad)([1-5])$/.exec(code);
  return m ? CAMERA_KEYS[Number(m[1]) - 1]! : null;
}

/** Move `x` toward `target` by at most `step` (snapping the last float crumb so rest is exactly `target`). */
function approach(x: number, target: number, step: number): number {
  if (Math.abs(target - x) <= step + 1e-9) return target;
  return x < target ? x + step : x - step;
}

const SAIL_LABEL = { main: 'Mainsail', jib: 'Jib', spinnaker: 'Spinnaker' } as const;

export class InputController {
  /** 'spring': the tiller returns to centre when released (default); 'sticky': it stays where it is. */
  tillerMode: 'spring' | 'sticky' = 'spring';
  private readonly held = new Map<string, Held>();
  private shift = false;
  private touchTiller: number | null = null;
  private furlTarget: number | null = null;
  private live: ((k: ControlKey) => boolean) | null = null;
  private commands: UiCommands;
  private readonly onKeyDown = (e: Event) => this.keyDown(e as unknown as KeyLike);
  private readonly onKeyUp = (e: Event) => this.keyUp(e as unknown as KeyLike);
  private readonly onBlur = () => this.releaseAll();

  constructor(private readonly app: AppApi, private readonly target: Window) {
    this.commands = directCommands(app);
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  /** Route UI-level commands (pause, cameras, overlays, help, menu) through the HUD. */
  setCommands(c: UiCommands | null): void {
    this.commands = c ?? directCommands(this.app);
  }

  /** Lesson gating: controls for which the filter returns false are ignored. */
  setControlFilter(f: ((k: ControlKey) => boolean) | null): void {
    this.live = f;
  }

  /**
   * On-screen tiller (touch/mouse): a value while held, null on release (the tiller then self-centres).
   * Grabbing the tiller while an autopilot steers takes the helm back, as on a real boat.
   */
  holdTiller(v: number | null): void {
    this.touchTiller = v === null ? null : clamp(v, -1, 1);
    const c = this.app.controls;
    if (v !== null && c.helmMode !== 'manual' && this.allowed('helmMode') && this.allowed('tiller')) {
      c.helmMode = 'manual';
      this.commands.notify('Autopilot off — you have the helm');
    }
  }

  /** Whether any steering input is active (keys or on-screen tiller). */
  get steering(): boolean {
    return this.touchTiller !== null || this.isHeld('port') || this.isHeld('stbd');
  }

  update(dt: number): void {
    const h = clamp(dt, 0, 0.1);
    const c = this.app.controls;
    const fine = this.shift ? INPUT_RATES.fine : 1;

    // Helm.
    const steer = (this.isHeld('stbd') ? 1 : 0) - (this.isHeld('port') ? 1 : 0);
    if (c.helmMode === 'manual') {
      if (this.allowed('tiller')) {
        if (this.touchTiller !== null) c.tiller = this.touchTiller;
        else if (steer !== 0) c.tiller = approach(c.tiller, steer, INPUT_RATES.tillerSlew * fine * h);
        else if (this.tillerMode === 'spring') c.tiller = approach(c.tiller, 0, INPUT_RATES.tillerCentre * h);
      }
    } else if (steer !== 0 && this.allowed('helmTarget')) {
      // Autopilot: ←/→ nudge the target. Bow to starboard raises the heading and lowers the signed TWA/AWA.
      const d = steer * INPUT_RATES.autopilot * fine * h;
      if (c.helmMode === 'heading') {
        const x = (c.helmTarget + d) % (2 * Math.PI);
        c.helmTarget = x < 0 ? x + 2 * Math.PI : x;
      } else {
        c.helmTarget = wrapPi(c.helmTarget - d);
      }
    }

    // Sheets, traveler, pole.
    this.adjust('mainSheet', 'main', this.axis('mainIn', 'mainOut'), INPUT_RATES.sheet * fine * h, 0, 1);
    this.adjust('traveler', 'main', this.axis('travUp', 'travDown'), INPUT_RATES.traveler * fine * h, -1, 1);
    this.adjust('jibSheet', 'jib', this.axis('jibIn', 'jibOut'), INPUT_RATES.sheet * fine * h, 0, 1);
    this.adjust('spinSheet', 'spinnaker', this.axis('spinIn', 'spinOut'), INPUT_RATES.sheet * fine * h, 0, 1);
    this.adjust('spinPole', 'spinnaker', this.axis('poleAft', 'poleFwd'), INPUT_RATES.pole * fine * h, 0, 1);

    // Roller furling runs to its target over a few seconds.
    if (this.furlTarget !== null) {
      c.jibFurl = approach(c.jibFurl, this.furlTarget, INPUT_RATES.furl * h);
      if (c.jibFurl === this.furlTarget) this.furlTarget = null;
    }
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.releaseAll();
  }

  // ---- internals -----------------------------------------------------------------------------

  private allowed(k: ControlKey): boolean {
    return this.live === null || this.live(k);
  }

  private isHeld(a: Held): boolean {
    for (const v of this.held.values()) if (v === a) return true;
    return false;
  }

  private axis(plus: Held, minus: Held): number {
    return (this.isHeld(plus) ? 1 : 0) - (this.isHeld(minus) ? 1 : 0);
  }

  private adjust(
    key: 'mainSheet' | 'traveler' | 'jibSheet' | 'spinSheet' | 'spinPole',
    sail: 'main' | 'jib' | 'spinnaker',
    dir: number, step: number, lo: number, hi: number,
  ): void {
    if (dir === 0 || !this.allowed(key)) return;
    const c = this.app.controls;
    if (c.autoTrim[sail]) {
      // Grabbing a sheet means the learner is trimming: the crew lets go of that sail.
      c.autoTrim[sail] = false;
      this.commands.notify(`${SAIL_LABEL[sail]}: you're trimming — crew auto-trim off`);
    }
    c[key] = clamp(c[key] + dir * step, lo, hi);
  }

  private releaseAll(): void {
    this.held.clear();
    this.shift = false;
  }

  private keyDown(e: KeyLike): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const kind = focusKind(e.target);
    const id = keyId(e);
    this.shift = e.shiftKey;
    if (kind === 'text') return;
    if (kind === 'widget' && (id === ' ' || id === 'enter')) return;
    if (kind === 'slider' && NAV_KEYS.has(id)) return;

    const held = HELD_KEYS[id];
    if (held) {
      e.preventDefault();
      if (!e.repeat) this.held.set(e.code || id, held);
      return;
    }
    if (id === ' ') e.preventDefault();
    if (e.repeat) return;

    const cam = cameraFromCode(e.code);
    if (cam) {
      this.commands.setCamera(cam);
      return;
    }
    const overlay = OVERLAY_HOTKEYS[id];
    if (overlay) {
      this.commands.toggleOverlay(overlay);
      return;
    }
    const c = this.app.controls;
    switch (id) {
      case 't': if (this.allowed('tack')) c.command = 'tack'; break;
      case 'g': if (this.allowed('gybe')) c.command = 'gybe'; break;
      case 'h': if (this.allowed('spinHoist')) c.spinHoist = !c.spinHoist; break;
      case 'f':
        if (this.allowed('jibFurl')) {
          const current = this.furlTarget ?? c.jibFurl;
          this.furlTarget = current > 0.5 ? 0 : 1;
        }
        break;
      case 'c': this.commands.cycleCamera(); break;
      case ' ': this.commands.togglePause(); break;
      case ',': case '<': this.commands.stepTimeScale(-1); break;
      case '.': case '>': this.commands.stepTimeScale(1); break;
      case '?': this.commands.toggleHelp(); break;
      case 'escape': this.commands.escape(); break;
      default: return;
    }
  }

  private keyUp(e: KeyLike): void {
    this.shift = e.shiftKey;
    this.held.delete(e.code || keyId(e));
  }
}
