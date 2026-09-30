import { describe, it, expect, beforeEach } from 'vitest';
import { defaultControls } from '../../sim/types';
import { DEG } from '../../shared/math';
import { INPUT_RATES, InputController, focusKind, keyId, type KeyLike, type UiCommands } from '../input';
import { OVERLAY_KEYS, type AppApi, type ControlKey, type OverlayKey } from '../../lessons/types';

type Handler = (e: Event) => void;

/** Just enough of Window for the controller: listeners we can fire by hand. */
class FakeTarget {
  private readonly handlers = new Map<string, Set<Handler>>();
  addEventListener(type: string, fn: Handler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.handlers.get(type)?.delete(fn);
  }
  fire(type: string, e: unknown): void {
    for (const fn of this.handlers.get(type) ?? []) fn(e as Event);
  }
  count(type: string): number { return this.handlers.get(type)?.size ?? 0; }
}

const CODES: Record<string, string> = {
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ' ': 'Space', ',': 'Comma', '.': 'Period', '?': 'Slash', Escape: 'Escape', Shift: 'ShiftLeft',
};
const codeFor = (key: string): string => CODES[key] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key);

interface Ev extends KeyLike { defaultPrevented: boolean }
function ev(key: string, extra: Partial<KeyLike> = {}): Ev {
  const e: Ev = {
    key, code: codeFor(key), shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
    target: null, defaultPrevented: false,
    preventDefault() { e.defaultPrevented = true; },
    ...extra,
  };
  return e;
}

type MockApp = AppApi & { calls: string[]; overlayState: Record<OverlayKey, boolean> };
function mockApp(): MockApp {
  const calls: string[] = [];
  const overlayState = Object.fromEntries(OVERLAY_KEYS.map((k) => [k, false])) as Record<OverlayKey, boolean>;
  return {
    controls: defaultControls(),
    calls,
    overlayState,
    setMode: (m) => { calls.push(`mode:${m}`); },
    setCamera: (c) => { calls.push(`camera:${c}`); },
    setOverlay: (k, on) => { overlayState[k] = on; calls.push(`overlay:${k}=${on}`); },
    overlays: () => ({ ...overlayState }),
    setWind: () => {},
    setTimeOfDay: () => {},
    setTimeScale: (s) => { calls.push(`scale:${s}`); },
    togglePause: () => { calls.push('pause'); },
    setQuality: () => {},
    setSound: () => {},
    scenario: () => {},
    startLesson: () => {},
    setMarks: () => {},
  };
}

let app: MockApp;
let target: FakeTarget;
let input: InputController;
const down = (key: string, extra: Partial<KeyLike> = {}) => { const e = ev(key, extra); target.fire('keydown', e); return e; };
const up = (key: string, extra: Partial<KeyLike> = {}) => { const e = ev(key, extra); target.fire('keyup', e); return e; };
/** Advance in 1/60 s frames. */
const run = (seconds: number) => { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) input.update(1 / 60); };

beforeEach(() => {
  app = mockApp();
  app.controls.autoTrim = { main: false, jib: false, spinnaker: false };
  target = new FakeTarget();
  input = new InputController(app, target as unknown as Window);
});

describe('InputController: held keys at the specified rates', () => {
  it('W / S trim and ease the mainsheet at 0.35 per second, clamped to 0…1', () => {
    app.controls.mainSheet = 0.5;
    down('w');
    run(1);
    expect(app.controls.mainSheet).toBeCloseTo(0.85, 5);
    run(1);
    expect(app.controls.mainSheet).toBe(1);
    up('w');
    down('s');
    run(2);
    expect(app.controls.mainSheet).toBeCloseTo(0.3, 5);
  });

  it('↑ / ↓ trim and ease the jib sheet at 0.35 per second', () => {
    app.controls.jibSheet = 0.4;
    down('ArrowUp');
    run(1);
    expect(app.controls.jibSheet).toBeCloseTo(0.75, 5);
    up('ArrowUp');
    down('ArrowDown');
    run(0.5);
    expect(app.controls.jibSheet).toBeCloseTo(0.575, 5);
  });

  it('Q / Z move the traveler to windward / leeward at 0.5 per second, clamped to ±1', () => {
    down('q');
    run(1);
    expect(app.controls.traveler).toBeCloseTo(0.5, 5);
    run(2);
    expect(app.controls.traveler).toBe(1);
    up('q');
    down('z');
    run(3);
    expect(app.controls.traveler).toBeCloseTo(-0.5, 5);
  });

  it('I / K trim the spinnaker sheet; J / L move the pole forward / aft', () => {
    app.controls.spinSheet = 0.5;
    app.controls.spinPole = 0.5;
    down('i');
    run(1);
    expect(app.controls.spinSheet).toBeCloseTo(0.85, 5);
    up('i');
    down('j');
    run(1);
    expect(app.controls.spinPole).toBeCloseTo(0.5 - INPUT_RATES.pole, 5);
    up('j');
    down('l');
    run(1);
    expect(app.controls.spinPole).toBeCloseTo(0.5, 5);
  });

  it('Shift gives fine control (quarter rate)', () => {
    app.controls.mainSheet = 0.5;
    down('Shift', { shiftKey: true });
    down('W', { shiftKey: true });
    run(1);
    expect(app.controls.mainSheet).toBeCloseTo(0.5 + 0.35 * INPUT_RATES.fine, 5);
    up('Shift', { shiftKey: false });
    run(1);
    expect(app.controls.mainSheet).toBeCloseTo(0.5 + 0.35 * INPUT_RATES.fine + 0.35, 5);
  });
});

describe('InputController: helm', () => {
  it('← / A turn the bow to port: the tiller slews at 2 per second toward −1', () => {
    down('ArrowLeft');
    run(0.25);
    expect(app.controls.tiller).toBeCloseTo(-0.5, 5);
    run(1);
    expect(app.controls.tiller).toBe(-1);
  });

  it('→ / D turn the bow to starboard (positive tiller command)', () => {
    down('d');
    run(0.25);
    expect(app.controls.tiller).toBeCloseTo(0.5, 5);
  });

  it('releasing the key self-centres the tiller at 2 per second', () => {
    down('ArrowRight');
    run(1);
    expect(app.controls.tiller).toBe(1);
    up('ArrowRight');
    run(0.25);
    expect(app.controls.tiller).toBeCloseTo(0.5, 5);
    run(0.5);
    expect(app.controls.tiller).toBe(0);
    run(0.5);
    expect(app.controls.tiller).toBe(0);
  });

  it('sticky tiller mode keeps the helm where it was released', () => {
    input.tillerMode = 'sticky';
    down('a');
    run(0.2);
    up('a');
    run(1);
    expect(app.controls.tiller).toBeCloseTo(-0.4, 5);
  });

  it('opposite keys cancel; Shift slows the slew', () => {
    down('ArrowLeft');
    down('ArrowRight');
    run(0.5);
    expect(app.controls.tiller).toBe(0);
    up('ArrowRight');
    down('Shift', { shiftKey: true });
    run(0.5);
    expect(app.controls.tiller).toBeCloseTo(-2 * INPUT_RATES.fine * 0.5, 5);
  });

  it('the on-screen tiller holds a value and self-centres on release', () => {
    input.holdTiller(0.6);
    run(0.2);
    expect(app.controls.tiller).toBeCloseTo(0.6, 5);
    input.holdTiller(null);
    run(0.1);
    expect(app.controls.tiller).toBeCloseTo(0.4, 5);
  });

  it('grabbing the on-screen tiller takes the helm back from the autopilot', () => {
    const notes: string[] = [];
    input.setCommands({
      togglePause() {}, stepTimeScale() {}, setCamera() {}, cycleCamera() {}, toggleOverlay() {}, toggleHelp() {}, escape() {},
      notify: (m) => notes.push(m),
    });
    app.controls.helmMode = 'twa';
    input.holdTiller(-0.3);
    run(0.1);
    expect(app.controls.helmMode).toBe('manual');
    expect(app.controls.tiller).toBeCloseTo(-0.3, 5);
    expect(notes).toEqual(['Autopilot off — you have the helm']);
  });

  it('in autopilot modes ←/→ nudge the target instead (heading up = lower |TWA| on starboard tack)', () => {
    app.controls.helmMode = 'heading';
    app.controls.helmTarget = 350 * DEG;
    down('ArrowRight');
    run(2);
    expect(app.controls.helmTarget).toBeCloseTo(10 * DEG, 5); // wrapped through north
    expect(app.controls.tiller).toBe(0);
    up('ArrowRight');
    app.controls.helmMode = 'twa';
    app.controls.helmTarget = 45 * DEG;
    down('ArrowRight');
    run(0.5);
    expect(app.controls.helmTarget).toBeCloseTo(40 * DEG, 5);
  });

  it('losing window focus releases every held key', () => {
    down('ArrowLeft');
    run(0.5);
    target.fire('blur', {});
    run(0.5);
    expect(app.controls.tiller).toBe(0);
  });
});

describe('InputController: one-shot keys', () => {
  it('T / G request a tack / gybe; H toggles the spinnaker; F furls over time', () => {
    down('t');
    expect(app.controls.command).toBe('tack');
    down('g');
    expect(app.controls.command).toBe('gybe');
    down('h');
    expect(app.controls.spinHoist).toBe(true);
    up('h');
    down('h');
    expect(app.controls.spinHoist).toBe(false);
    down('f');
    run(1);
    expect(app.controls.jibFurl).toBeCloseTo(INPUT_RATES.furl, 5);
    run(3);
    expect(app.controls.jibFurl).toBe(1);
    down('f');
    run(1);
    expect(app.controls.jibFurl).toBeCloseTo(1 - INPUT_RATES.furl, 5);
  });

  it('B pushes the boom out to port, then to starboard, then lets go', () => {
    expect(app.controls.boomPush).toBe(0);
    down('b'); up('b');
    expect(app.controls.boomPush).toBe(1);
    down('b'); up('b');
    expect(app.controls.boomPush).toBe(-1);
    down('b'); up('b');
    expect(app.controls.boomPush).toBe(0);
  });

  it('key repeat does not re-fire one-shot actions', () => {
    down('h');
    down('h', { repeat: true });
    down('h', { repeat: true });
    expect(app.controls.spinHoist).toBe(true);
  });

  it('1–5 pick cameras, C cycles; V / O / P toggle forces, flow and the points-of-sail wheel', () => {
    down('3');
    expect(app.calls).toContain('camera:top');
    down('c');
    expect(app.calls[app.calls.length - 1]).toBe('camera:sail');
    down('v');
    down('o');
    down('p');
    expect(app.overlayState).toMatchObject({ forces: true, flow: true, wheel: true });
    down('v');
    expect(app.overlayState.forces).toBe(false);
  });

  it('Space pauses (and does not scroll); , and . step the time scale through 0.25–2×', () => {
    const e = down(' ');
    expect(app.calls).toContain('pause');
    expect(e.defaultPrevented).toBe(true);
    down('.');
    down('.');
    down('.');
    down(',');
    expect(app.calls.filter((c) => c.startsWith('scale:'))).toEqual(['scale:2', 'scale:2', 'scale:2', 'scale:1']);
    down(',');
    down(',');
    down(',');
    expect(app.calls[app.calls.length - 1]).toBe('scale:0.25');
  });

  it('? and Esc go to the HUD commands when attached', () => {
    const log: string[] = [];
    const cmds: UiCommands = {
      togglePause: () => log.push('pause'), stepTimeScale: (d) => log.push(`scale${d}`), setCamera: (c) => log.push(`cam:${c}`),
      cycleCamera: () => log.push('cycle'), toggleOverlay: (k) => log.push(`ov:${k}`), toggleHelp: () => log.push('help'),
      escape: () => log.push('esc'), notify: (m) => log.push(`note:${m}`),
    };
    input.setCommands(cmds);
    down('?', { shiftKey: true });
    down('Escape');
    down('1');
    down(' ');
    expect(log).toEqual(['help', 'esc', 'cam:chase', 'pause']);
    expect(app.calls).toEqual([]);
  });

  it('ignores browser shortcuts (Ctrl / Cmd / Alt)', () => {
    down('w', { metaKey: true });
    down('t', { ctrlKey: true });
    run(1);
    expect(app.controls.mainSheet).toBe(0.7);
    expect(app.controls.command).toBeNull();
  });
});

describe('InputController: focus and typing', () => {
  const textField = { tagName: 'INPUT', type: 'text', isContentEditable: false, getAttribute: () => null };
  const rangeField = { tagName: 'INPUT', type: 'range', isContentEditable: false, getAttribute: () => null };
  const button = { tagName: 'BUTTON', isContentEditable: false, getAttribute: () => null };
  const editable = { tagName: 'DIV', isContentEditable: true, getAttribute: () => null };

  it('ignores every key while typing in a text field or contenteditable', () => {
    down('w', { target: textField as unknown as EventTarget });
    down('t', { target: editable as unknown as EventTarget });
    down(' ', { target: textField as unknown as EventTarget });
    run(1);
    expect(app.controls.mainSheet).toBe(0.7);
    expect(app.controls.command).toBeNull();
    expect(app.calls).toEqual([]);
  });

  it('leaves arrow keys to a focused slider but still handles letter keys', () => {
    app.controls.mainSheet = 0.5;
    down('ArrowLeft', { target: rangeField as unknown as EventTarget });
    down('w', { target: rangeField as unknown as EventTarget });
    run(1);
    expect(app.controls.tiller).toBe(0);
    expect(app.controls.mainSheet).toBeCloseTo(0.85, 5);
  });

  it('leaves Space / Enter to a focused button but still steers', () => {
    down(' ', { target: button as unknown as EventTarget });
    expect(app.calls).toEqual([]);
    down('ArrowLeft', { target: button as unknown as EventTarget });
    run(0.25);
    expect(app.controls.tiller).toBeCloseTo(-0.5, 5);
  });

  it('classifies focus targets', () => {
    expect(focusKind(null)).toBeNull();
    expect(focusKind(textField as unknown as EventTarget)).toBe('text');
    expect(focusKind({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe('text');
    expect(focusKind(rangeField as unknown as EventTarget)).toBe('slider');
    expect(focusKind(button as unknown as EventTarget)).toBe('widget');
    expect(focusKind({ tagName: 'DIV', getAttribute: (n: string) => (n === 'role' ? 'slider' : null) } as unknown as EventTarget)).toBe('slider');
    expect(focusKind({ tagName: 'CANVAS', getAttribute: () => null } as unknown as EventTarget)).toBeNull();
  });

  it('maps keys by character, falling back to the physical key on non-Latin layouts', () => {
    expect(keyId({ key: 'W', code: 'KeyW' })).toBe('w');
    expect(keyId({ key: 'ц', code: 'KeyW' })).toBe('w');
    expect(keyId({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBe('arrowleft');
    expect(keyId({ key: '?', code: 'Slash' })).toBe('?');
  });
});

describe('InputController: dialogs, stuck keys, locked controls', () => {
  const log: string[] = [];
  const cmds: UiCommands = {
    togglePause: () => log.push('pause'), stepTimeScale: (d) => log.push(`scale${d}`), setCamera: (c) => log.push(`cam:${c}`),
    cycleCamera: () => log.push('cycle'), toggleOverlay: (k) => log.push(`ov:${k}`), toggleHelp: () => log.push('help'),
    escape: () => log.push('esc'), notify: (m) => log.push(`note:${m}`),
  };
  beforeEach(() => { log.length = 0; input.setCommands(cmds); });

  it('while a dialog is open, sailing keys are ignored and left to the dialog (no preventDefault); ? and Esc still work', () => {
    down('ArrowRight');
    run(0.25);
    expect(app.controls.tiller).toBeCloseTo(0.5, 5);
    input.setSuspended(true); // releases the held key
    run(0.25);
    expect(app.controls.tiller).toBeCloseTo(0, 5); // self-centred, not steering
    const arrow = down('ArrowDown');
    const space = down(' ');
    down('w');
    down('t');
    run(0.5);
    expect(arrow.defaultPrevented).toBe(false);
    expect(space.defaultPrevented).toBe(false);
    expect(app.controls.jibSheet).toBe(0.7);
    expect(app.controls.mainSheet).toBe(0.7);
    expect(app.controls.command).toBeNull();
    down('?', { shiftKey: true });
    down('Escape');
    expect(log).toEqual(['help', 'esc']);
    input.holdTiller(0.8);
    run(0.1);
    expect(app.controls.tiller).toBe(0);
    input.setSuspended(false);
    up('w');
    down('w');
    run(1);
    expect(app.controls.mainSheet).toBeCloseTo(1, 5);
  });

  it('holding ? does not toggle the dialog closed again on auto-repeat', () => {
    down('?', { shiftKey: true }); // not suspended yet: opens help
    input.setSuspended(true); // the dialog opened
    down('?', { shiftKey: true, repeat: true });
    down('?', { shiftKey: true, repeat: true });
    down('Escape', { repeat: true });
    expect(log).toEqual(['help']);
    up('?', { shiftKey: true });
    down('?', { shiftKey: true }); // a fresh press closes it
    expect(log).toEqual(['help', 'help']);
  });

  it('a key pressed with ⌘ (or whose keyup is swallowed) cannot stay stuck', () => {
    down('ArrowLeft');
    run(0.2);
    down('Tab', { metaKey: true }); // Cmd-Tab away: macOS never sends the ArrowLeft keyup
    run(1);
    expect(app.controls.tiller).toBe(0);
    down('ArrowLeft');
    target.fire('visibilitychange', {});
    run(1);
    expect(app.controls.tiller).toBe(0);
  });

  it('a tiller locked by the lesson self-centres instead of freezing (even in sticky mode)', () => {
    input.tillerMode = 'sticky';
    down('a');
    run(0.3);
    up('a');
    expect(app.controls.tiller).toBeCloseTo(-0.6, 5);
    input.setControlFilter((k) => k !== 'tiller');
    run(0.5);
    expect(app.controls.tiller).toBe(0);
  });

  it('a focused radio group owns the arrow keys and Space', () => {
    const radio = { tagName: 'BUTTON', isContentEditable: false, getAttribute: (n: string) => (n === 'role' ? 'radio' : null) } as unknown as EventTarget;
    expect(focusKind(radio)).toBe('group');
    down('ArrowRight', { target: radio });
    down(' ', { target: radio });
    run(0.25);
    expect(app.controls.tiller).toBe(0);
    expect(log).toEqual([]);
  });
});

describe('InputController: auto-trim hand-over and lesson gating', () => {
  it('trimming a sail by key takes it off crew auto-trim and says so', () => {
    const notes: string[] = [];
    input.setCommands({
      togglePause() {}, stepTimeScale() {}, setCamera() {}, cycleCamera() {}, toggleOverlay() {}, toggleHelp() {}, escape() {},
      notify: (m) => notes.push(m),
    });
    app.controls.autoTrim = { main: true, jib: true, spinnaker: true };
    down('w');
    run(0.5);
    expect(app.controls.autoTrim).toEqual({ main: false, jib: true, spinnaker: true });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Mainsail/);
  });

  it('ignores controls the current lesson step has locked', () => {
    const live = new Set<ControlKey>(['tiller']);
    input.setControlFilter((k) => live.has(k));
    down('w');
    down('t');
    down('h');
    down('ArrowLeft');
    run(0.25);
    expect(app.controls.mainSheet).toBe(0.7);
    expect(app.controls.command).toBeNull();
    expect(app.controls.spinHoist).toBe(false);
    expect(app.controls.tiller).toBeCloseTo(-0.5, 5);
    input.setControlFilter(null);
    run(0.5);
    expect(app.controls.mainSheet).toBeCloseTo(0.7 + 0.35 * 0.5, 5);
  });

  it('dispose removes its listeners', () => {
    expect(target.count('keydown')).toBe(1);
    expect(target.count('visibilitychange')).toBe(1);
    input.dispose();
    expect(target.count('keydown')).toBe(0);
    expect(target.count('keyup')).toBe(0);
    expect(target.count('blur')).toBe(0);
    expect(target.count('visibilitychange')).toBe(0);
  });
});
