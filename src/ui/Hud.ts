// The HUD (spec §3.2): top bar, lesson dock (left), trim dock (right), instrument cluster with the round
// wind instrument (bottom), camera/overlay bar (bottom-right), toasts, menu, help, polar chart, and on
// phones bottom sheets + on-screen tiller/sheet sliders. Vanilla DOM: digits refresh at ~15 Hz, needles
// and bars every frame, nothing reads layout inside update().
//
// Wiring (App, Task 16):
//   const hud = new Hud(document.getElementById('ui')!, app);
//   const input = new InputController(app, window); hud.attachInput(input);
//   const runner = new LessonRunner(curriculum, app, hud.lessonPanel);
//   hud.setControlFilter((k) => runner.isLive(k));          // also gates the keyboard
//   per frame: input.update(dt); …sim…; hud.update(snapshot, dt); runner.update(snapshot, simOrFrameDt);
//   App.setCamera/setMode/togglePause/setTimeScale/setWind/…: call hud.syncState({...}) so the HUD shows
//   changes made by lessons or code (changes made from the HUD itself are reflected immediately).
import './styles.css';
import type { SimEventType, SimSnapshot, WindSettings } from '../sim/types';
import type { QualityTier } from '../render/core/types';
import { CAMERA_KEYS, type AppApi, type AppMode, type CameraKey, type ControlKey, type OverlayKey } from '../lessons/types';
import { TIME_SCALES, type InputController, type UiCommands } from './input';
import { button, h, icon, installGlossaryTips, Popover, RateGate, setClass, TextSlot } from './dom';
import { Instruments } from './instruments';
import { WindDial } from './windDial';
import { TouchDeck, TrimPanel, type TrimHooks } from './trimPanel';
import { TopBar } from './topBar';
import { OverlayBar } from './overlayBar';
import { EVENT_TOASTS, Toasts, type ToastKind } from './toasts';
import { SettingsDialog } from './settings';
import { HelpDialog } from './help';
import { PolarChart, type PolarModel } from './polarChart';
import { LessonPanel } from './lessonPanel';

export type { AppApi, AppMode, CameraKey, ControlKey, OverlayKey } from '../lessons/types';
export { CAMERA_KEYS, OVERLAY_KEYS } from '../lessons/types';
export type { PolarModel } from './polarChart';

/** What the HUD displays about the App; the App keeps it current through syncState(). */
export interface HudState {
  mode: AppMode;
  camera: CameraKey;
  paused: boolean;
  timeScale: number;
  sound: boolean;
  quality: QualityTier | 'auto';
  /** Tier the governor chose while quality is 'auto' (shown as "Auto · high"). */
  qualityActual: QualityTier | null;
  hour: number;
  /** Configured wind; null until the App reports it (the wind chip then shows the live wind). */
  wind: WindSettings | null;
  tillerMode: 'spring' | 'sticky';
}

type Sheet = 'lesson' | 'trim' | 'view';

const COMPACT_QUERY = '(max-width: 900px)';

export class Hud {
  readonly lessonPanel: LessonPanel;
  /** Commands the InputController uses once attached (kept public for custom bindings). */
  readonly commands: UiCommands;
  private readonly state: HudState = {
    mode: 'lessons', camera: 'chase', paused: false, timeScale: 1, sound: true, quality: 'auto', qualityActual: null,
    hour: 17, wind: null, tillerMode: 'spring',
  };
  private readonly topBar: TopBar;
  private readonly instruments = new Instruments();
  private readonly dial = new WindDial();
  private readonly trim: TrimPanel;
  private readonly touch: TouchDeck;
  private readonly overlayBar: OverlayBar;
  private readonly toasts: Toasts;
  private readonly settings: SettingsDialog;
  private readonly help: HelpDialog;
  private readonly polar: PolarChart;
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;
  private readonly view: HTMLElement;
  private readonly leftBody: HTMLElement;
  private readonly modeHost: HTMLElement;
  private readonly pip: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly pillText: TextSlot;
  private readonly navButtons = new Map<Sheet, HTMLButtonElement>();
  private readonly textGate = new RateGate(15);
  private readonly compactMq: MediaQueryList | null;
  private compact = false;
  private readonly cleanup: (() => void)[] = [];
  private input: InputController | null = null;
  private filter: ((k: ControlKey) => boolean) | null = null;
  private sheet: Sheet | null = null;
  private leftCollapsed = false;
  private rightCollapsed = false;
  private modePanel: HTMLElement | null = null;
  private eventLessons: Partial<Record<SimEventType, string>> = {};
  private readonly seenEvents = new Set<string>();
  private readonly lastToastAt = new Map<SimEventType, number>();
  private lastSimT = -Infinity;
  private pipRect: DOMRect | null = null;
  private pipDirty = true;
  private overlayTelltale = false;
  private readonly cost = { ema: 0, max: 0, frames: 0 };

  constructor(private readonly root: HTMLElement, private readonly app: AppApi) {
    root.classList.add('sx-root');
    this.lessonPanel = new LessonPanel();
    this.commands = this.makeCommands();
    const hooks: TrimHooks = {
      holdTiller: (v) => this.holdTiller(v),
      notify: (msg) => this.toasts.show({ msg, kind: 'info', ttl: 3, key: msg }),
      isLive: (k) => this.isLive(k),
    };
    this.trim = new TrimPanel(app, hooks);
    this.touch = new TouchDeck(app, hooks);
    this.toasts = new Toasts((id) => this.lessonPanel.lessonTitle(id), (id) => this.startLesson(id));
    this.polar = new PolarChart(() => this.togglePolar(false));
    this.overlayBar = new OverlayBar({
      setCamera: (c) => this.commands.setCamera(c),
      toggleOverlay: (k) => this.commands.toggleOverlay(k),
      togglePolar: () => this.togglePolar(),
    });
    this.settings = new SettingsDialog(root, {
      setWind: (p) => this.setWind(p),
      setHour: (hr) => this.setHour(hr),
      setTimeScale: (s) => this.setTimeScale(s),
      togglePause: () => this.commands.togglePause(),
      setSound: (on) => this.setSound(on),
      setQuality: (q) => this.setQuality(q),
      setTillerMode: (m) => this.syncState({ tillerMode: m }),
      resetProgress: () => this.lessonPanel.requestReset(),
      openHelp: () => this.help.show(),
      toggleFullscreen: () => this.toggleFullscreen(),
    });
    this.help = new HelpDialog(root);
    this.topBar = new TopBar(root, {
      setMode: (m) => this.setMode(m),
      togglePause: () => this.commands.togglePause(),
      setTimeScale: (s) => this.setTimeScale(s),
      setSound: (on) => this.setSound(on),
      setQuality: (q) => this.setQuality(q),
      setWind: (p) => this.setWind(p),
      setHour: (hr) => this.setHour(hr),
      toggleFullscreen: () => this.toggleFullscreen(),
      openHelp: () => this.help.show(),
      openSettings: () => this.settings.modal.show(),
    });

    // Left dock: lessons (or a mode panel in Sail lab).
    this.modeHost = h('div', { class: 'sx-mode-host', attrs: { hidden: true } });
    this.leftBody = h('div', 'sx-dock-body', [this.lessonPanel.el, this.modeHost]);
    this.left = this.dock('left', 'Lessons', 'book', this.leftBody, 'lesson');
    this.right = this.dock('right', 'Trim', 'sliders', h('div', 'sx-dock-body', [this.trim.el]), 'trim');
    this.view = h('aside', { class: 'sx-dock sx-dock-view sx-glass', attrs: { 'aria-label': 'View' } }, [
      this.sheetHead('View', 'view'),
      h('div', 'sx-dock-body', [this.overlayBar.el]),
    ]);

    this.dial.el.classList.add('sx-glass-round');
    this.instruments.dialSlot.append(this.dial.el);
    this.instruments.setPolar(null);

    const nav = h('nav', { class: 'sx-mnav sx-glass', attrs: { 'aria-label': 'Panels' } }, (['lesson', 'trim', 'view'] as const).map((s) => {
      const b = button(s === 'lesson' ? 'Lesson' : s === 'trim' ? 'Trim' : 'View', {
        icon: s === 'lesson' ? 'book' : s === 'trim' ? 'sliders' : 'layers',
        class: 'sx-mnav-btn',
        onClick: () => this.toggleSheet(s),
      });
      b.setAttribute('aria-expanded', 'false');
      this.navButtons.set(s, b);
      return b;
    }));

    this.pip = h('div', { class: 'sx-pip sx-pass', attrs: { hidden: true, 'aria-hidden': 'true' } }, [h('span', { class: 'sx-pip-label', text: 'Telltale cam' })]);
    const pillEl = h('span', 'sx-pill-text');
    this.pillText = new TextSlot(pillEl);
    this.pill = h('div', { class: 'sx-pill sx-pass', attrs: { hidden: true, role: 'status' } }, [pillEl]);
    this.lessonPanel.peek.classList.add('sx-peek-host');
    this.lessonPanel.onOpen = () => this.openSheet('lesson');
    this.lessonPanel.onRender = (m) => {
      if (m.kind !== 'idle' && this.leftCollapsed && !this.isCompact()) this.setLeftCollapsed(false);
    };

    this.topBar.el.classList.add('sx-pass');
    this.instruments.el.classList.add('sx-pass');
    this.touch.el.classList.add('sx-pass');
    this.toasts.el.classList.add('sx-pass');
    root.append(
      this.left, this.right, this.instruments.el, this.view, this.touch.el, nav, this.lessonPanel.peek,
      this.pip, this.pill, this.toasts.el, this.polar.el, this.topBar.el,
    );
    // Popovers, dialogs and the tooltip were appended by their constructors: keep them on top.
    for (const el of Array.from(root.querySelectorAll(':scope > .sx-pop, :scope > .sx-modal'))) root.append(el);
    this.cleanup.push(installGlossaryTips(root));

    this.compactMq = typeof matchMedia === 'function' ? matchMedia(COMPACT_QUERY) : null;
    this.compact = this.compactMq?.matches ?? false;
    const onCompact = () => {
      this.compact = this.compactMq?.matches ?? false;
      this.closeSheet();
      this.pipDirty = true;
      this.textGate.force();
    };
    this.compactMq?.addEventListener('change', onCompact);
    this.cleanup.push(() => this.compactMq?.removeEventListener('change', onCompact));
    const onResize = () => { this.pipDirty = true; };
    addEventListener('resize', onResize);
    this.cleanup.push(() => removeEventListener('resize', onResize));

    this.applyMode();
    this.syncAll();
  }

  // ---- public API -----------------------------------------------------------------------------------

  update(snap: SimSnapshot, dt: number): void {
    const t0 = performance.now();
    const text = this.textGate.tick(dt);
    const compact = this.isCompact();
    this.dial.update(snap, dt, text);
    this.instruments.update(snap, text);
    if (compact ? this.sheet === 'trim' : !this.rightCollapsed) this.trim.update(snap, text);
    if (compact) this.touch.update(snap, text);
    this.polar.update(snap, dt);
    if (text) {
      // Lesson steps change which controls are live; re-applying is a no-op when nothing changed.
      this.refreshLive();
      this.topBar.update(snap);
      const ov = this.app.overlays();
      this.overlayBar.sync(this.state.camera, ov, this.polar.visible);
      this.showPip(ov.telltaleCam === true);
    }
    this.handleEvents(snap);
    this.toasts.update(dt);
    const ms = performance.now() - t0;
    this.cost.frames++;
    this.cost.ema = this.cost.frames === 1 ? ms : this.cost.ema * 0.95 + ms * 0.05;
    this.cost.max = Math.max(this.cost.max * 0.999, ms);
  }

  /** Show a message (optionally linking a lesson; the link appears only if the lesson exists). */
  toast(msg: string, lessonId?: string, kind: ToastKind = 'info'): void {
    this.toasts.show({ msg, kind, lessonId: lessonId && this.lessonPanel.hasLesson(lessonId) ? lessonId : undefined });
  }

  /** Reflect state the App changed on its own (lesson set-up, keyboard handled elsewhere, governor …). */
  syncState(p: Partial<HudState>): void {
    const modeChanged = p.mode !== undefined && p.mode !== this.state.mode;
    Object.assign(this.state, p);
    if (p.wind) this.state.wind = { ...p.wind }; // never alias the App's settings object
    if (p.tillerMode && this.input) this.input.tillerMode = p.tillerMode;
    if (modeChanged) this.applyMode();
    this.syncAll();
  }

  get uiState(): Readonly<HudState> { return this.state; }

  /** Route keyboard UI commands through the HUD and let the on-screen tiller share the self-centring. */
  attachInput(input: InputController): void {
    this.input = input;
    input.setCommands(this.commands);
    input.setControlFilter(this.filter);
    input.tillerMode = this.state.tillerMode;
  }

  /** Lesson gating (usually `k => runner.isLive(k)`); applied to the panel, touch controls and keyboard. */
  setControlFilter(f: ((k: ControlKey) => boolean) | null): void {
    this.filter = f;
    this.input?.setControlFilter(f);
    this.refreshLive();
  }

  /** Re-read the control filter now (also done automatically at ~15 Hz). */
  refreshLive(): void {
    this.trim.refreshLive();
    this.touch.refreshLive();
  }

  setPolar(model: PolarModel | null): void {
    this.polar.setModel(model);
    this.instruments.setPolar(model);
  }

  /** Content for the left dock outside Lessons mode (e.g. the Sail-lab panel); null restores the lessons. */
  setModePanel(el: HTMLElement | null): void {
    this.modePanel = el;
    this.modeHost.replaceChildren(...(el ? [el] : []));
    this.applyMode();
  }

  /** Override which lesson a sim event's toast links to. */
  setEventLessons(map: Partial<Record<SimEventType, string>>): void {
    this.eventLessons = { ...this.eventLessons, ...map };
  }

  /** Where the App should draw the telltale-cam picture-in-picture (CSS px), or null when it is off. */
  telltaleCamRect(): { x: number; y: number; width: number; height: number } | null {
    if (!this.overlayTelltale) return null;
    if (this.pipDirty || !this.pipRect) {
      this.pipRect = this.pip.getBoundingClientRect();
      this.pipDirty = false;
    }
    const r = this.pipRect;
    return { x: r.left + 2, y: r.top + 2, width: r.width - 4, height: r.height - 4 };
  }

  /** Mean / peak cost of update() in ms (for the perf overlay). */
  stats(): { meanMs: number; maxMs: number } {
    return { meanMs: this.cost.ema, maxMs: this.cost.max };
  }

  openHelp(): void { this.help.show(); }
  openSettings(): void { this.settings.modal.show(); }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.input?.setCommands(null);
    this.root.replaceChildren();
    this.root.classList.remove('sx-root');
  }

  // ---- state changes initiated by the HUD ------------------------------------------------------------

  private makeCommands(): UiCommands {
    return {
      togglePause: () => {
        const paused = !this.state.paused; // decided first: the App may sync back from inside togglePause()
        this.app.togglePause();
        this.syncState({ paused });
      },
      stepTimeScale: (dir) => {
        const i = TIME_SCALES.indexOf(this.state.timeScale);
        const next = TIME_SCALES[Math.min(TIME_SCALES.length - 1, Math.max(0, (i < 0 ? TIME_SCALES.indexOf(1) : i) + dir))]!;
        this.setTimeScale(next);
      },
      setCamera: (c) => {
        this.app.setCamera(c);
        this.syncState({ camera: c });
      },
      cycleCamera: () => {
        const i = CAMERA_KEYS.indexOf(this.state.camera);
        this.commands.setCamera(CAMERA_KEYS[(i + 1) % CAMERA_KEYS.length]!);
      },
      toggleOverlay: (k) => {
        const on = !this.app.overlays()[k];
        this.app.setOverlay(k, on);
        this.overlayBar.sync(this.state.camera, this.app.overlays(), this.polar.visible);
        if (k === 'telltaleCam') this.showPip(on);
      },
      toggleHelp: () => {
        this.settings.modal.close();
        this.help.toggle();
      },
      escape: () => {
        if (Popover.closeAll()) return;
        if (this.help.open) { this.help.close(); return; }
        if (this.settings.modal.open) { this.settings.modal.close(); return; }
        if (this.sheet) { this.closeSheet(); return; }
        this.settings.modal.show();
      },
      notify: (msg) => this.toasts.show({ msg, kind: 'info', ttl: 3, key: msg }),
    };
  }

  private setMode(m: AppMode): void {
    this.app.setMode(m);
    this.syncState({ mode: m });
  }

  private setTimeScale(s: number): void {
    this.app.setTimeScale(s);
    this.syncState({ timeScale: s });
  }

  private setSound(on: boolean): void {
    this.app.setSound(on);
    this.syncState({ sound: on });
  }

  private setQuality(q: QualityTier | 'auto'): void {
    this.app.setQuality(q);
    this.syncState({ quality: q, qualityActual: q === 'auto' ? this.state.qualityActual : null });
  }

  private setHour(hr: number): void {
    this.app.setTimeOfDay(hr);
    this.state.hour = hr;
    this.topBar.sync(this.state);
  }

  private setWind(p: Partial<WindSettings>): void {
    this.app.setWind(p);
    if (this.state.wind) this.state.wind = { ...this.state.wind, ...p };
    this.topBar.sync(this.state);
  }

  private startLesson(id: string): void {
    this.app.startLesson(id);
    if (this.state.mode !== 'lessons') this.syncState({ mode: 'lessons' });
  }

  private togglePolar(on = !this.polar.visible): void {
    this.polar.setVisible(on);
    this.overlayBar.sync(this.state.camera, this.app.overlays(), on);
  }

  private toggleFullscreen(): void {
    if (typeof document === 'undefined' || !document.fullscreenEnabled) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  }

  private holdTiller(v: number | null): void {
    if (this.input) {
      this.input.holdTiller(v);
      return;
    }
    if (!this.isLive('tiller')) return;
    this.app.controls.tiller = v ?? (this.state.tillerMode === 'sticky' ? this.app.controls.tiller : 0);
  }

  private isLive(k: ControlKey): boolean {
    return this.filter === null || this.filter(k);
  }

  // ---- layout ---------------------------------------------------------------------------------------

  private isCompact(): boolean {
    return this.compact;
  }

  private dock(side: 'left' | 'right', title: string, ic: 'book' | 'sliders', body: HTMLElement, sheet: Sheet): HTMLElement {
    const tab = h('button', {
      class: 'sx-dock-tab',
      title: `Show or hide ${title.toLowerCase()}`,
      attrs: { type: 'button', 'aria-expanded': 'true', 'aria-label': `${title} panel` },
      on: { click: () => (side === 'left' ? this.setLeftCollapsed(!this.leftCollapsed) : this.setRightCollapsed(!this.rightCollapsed)) },
    }, [icon(ic, 16), h('span', { class: 'sx-dock-tab-label', text: title }), icon(side === 'left' ? 'chevronLeft' : 'chevronRight', 14)]);
    return h('aside', { class: `sx-dock sx-dock-${side} sx-glass`, attrs: { 'aria-label': title } }, [this.sheetHead(title, sheet), body, tab]);
  }

  private sheetHead(title: string, sheet: Sheet): HTMLElement {
    return h('div', 'sx-sheet-head', [
      h('span', 'sx-sheet-grip'),
      h('span', { class: 'sx-sheet-title', text: title }),
      button(`Close ${title.toLowerCase()}`, { icon: 'chevronDown', iconOnly: true, class: 'sx-btn--ghost sx-btn--sm', onClick: () => this.toggleSheet(sheet) }),
    ]);
  }

  private setLeftCollapsed(on: boolean): void {
    this.leftCollapsed = on;
    setClass(this.root, 'sx-left-collapsed', on);
    this.left.querySelector('.sx-dock-tab')?.setAttribute('aria-expanded', String(!on));
    this.pipDirty = true;
  }

  private setRightCollapsed(on: boolean): void {
    this.rightCollapsed = on;
    setClass(this.root, 'sx-right-collapsed', on);
    this.right.querySelector('.sx-dock-tab')?.setAttribute('aria-expanded', String(!on));
    this.pipDirty = true;
    this.textGate.force();
  }

  private toggleSheet(s: Sheet): void {
    if (this.sheet === s) this.closeSheet(); else this.openSheet(s);
  }

  private openSheet(s: Sheet): void {
    if (!this.isCompact()) {
      if (s === 'lesson') this.setLeftCollapsed(false);
      if (s === 'trim') this.setRightCollapsed(false);
      return;
    }
    this.sheet = s;
    for (const k of ['lesson', 'trim', 'view'] as const) {
      setClass(this.root, `sx-sheet-${k}`, k === s);
      this.navButtons.get(k)?.setAttribute('aria-expanded', String(k === s));
      setClass(this.navButtons.get(k)!, 'is-on', k === s);
    }
    this.textGate.force();
  }

  private closeSheet(): void {
    this.sheet = null;
    for (const k of ['lesson', 'trim', 'view'] as const) {
      setClass(this.root, `sx-sheet-${k}`, false);
      this.navButtons.get(k)?.setAttribute('aria-expanded', 'false');
      setClass(this.navButtons.get(k)!, 'is-on', false);
    }
  }

  private applyMode(): void {
    const m = this.state.mode;
    for (const k of ['lessons', 'free', 'lab'] as const) setClass(this.root, `sx-mode-${k}`, k === m);
    const showMode = m === 'lab' && this.modePanel !== null;
    this.modeHost.hidden = !showMode;
    this.lessonPanel.el.hidden = showMode;
    if (!this.isCompact()) this.setLeftCollapsed(m === 'free');
  }

  private syncAll(): void {
    this.topBar.sync(this.state);
    this.settings.sync(this.state);
    this.overlayBar.sync(this.state.camera, this.app.overlays(), this.polar.visible);
    setClass(this.root, 'sx-paused', this.state.paused);
    const slow = this.state.timeScale !== 1;
    const label = this.state.paused ? 'Paused — Space to resume' : slow ? `${this.state.timeScale}× ${this.state.timeScale < 1 ? 'slow motion' : 'speed'}` : '';
    this.pillText.set(label);
    this.pill.hidden = label === '';
  }

  private showPip(on: boolean): void {
    if (on === this.overlayTelltale) return;
    this.overlayTelltale = on;
    this.pip.hidden = !on;
    this.pipDirty = true;
  }

  // ---- sim events → toasts --------------------------------------------------------------------------

  private handleEvents(snap: SimSnapshot): void {
    if (snap.t < this.lastSimT) {
      this.seenEvents.clear();
      this.lastToastAt.clear();
    }
    this.lastSimT = snap.t;
    for (const e of snap.events) {
      const key = `${e.t}:${e.type}`;
      if (this.seenEvents.has(key)) continue;
      if (this.seenEvents.size > 64) this.seenEvents.clear();
      this.seenEvents.add(key);
      const spec = EVENT_TOASTS[e.type];
      if (!spec) continue;
      const last = this.lastToastAt.get(e.type);
      if (last !== undefined && e.t - last < spec.cooldown) continue;
      this.lastToastAt.set(e.type, e.t);
      const lessonId = this.eventLessons[e.type] ?? spec.lessonId;
      this.toasts.show({
        title: spec.title,
        msg: spec.msg,
        kind: spec.kind,
        lessonId: lessonId && this.lessonPanel.hasLesson(lessonId) ? lessonId : undefined,
        key: e.type,
      });
    }
  }
}
