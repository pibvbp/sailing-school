// Top bar (spec §3.2): app name, mode switcher, wind (speed, direction, gusts), time of day,
// pause and slow motion (0.25× … 2×), sound, quality, fullscreen, menu and help. Wind, time and
// quality open popovers; on phones everything but mode, wind and the menu moves into the menu.
import type { SimSnapshot, WindSettings } from '../sim/types';
import type { QualityTier } from '../render/core/types';
import type { AppMode } from '../lessons/types';
import { DEG } from '../shared/math';
import { TIME_SCALES } from './input';
import { button, compassName, fmtClock, fmtKn, h, icon, Popover, Segmented, setClass, TextSlot, Toggle } from './dom';
import { gustWord, QUALITY_ITEMS, TimeControls, WindControls } from './settings';
import type { HudState } from './Hud';

export interface TopBarHooks {
  setMode(m: AppMode): void;
  togglePause(): void;
  setTimeScale(s: number): void;
  setSound(on: boolean): void;
  setQuality(q: QualityTier | 'auto'): void;
  setWind(p: Partial<WindSettings>): void;
  setHour(h: number): void;
  toggleFullscreen(): void;
  openHelp(): void;
  openSettings(): void;
}

export class TopBar {
  readonly el: HTMLElement;
  private readonly mode: Segmented<AppMode>;
  private readonly windText: TextSlot;
  private readonly windSub: TextSlot;
  private readonly clock: TextSlot;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly speed: Segmented<string>;
  private readonly sound: Toggle;
  private readonly qualityText: TextSlot;
  private readonly fsBtn: HTMLButtonElement;
  private readonly windPop: Popover;
  private readonly windCtl: WindControls;
  private readonly timeCtl: TimeControls;
  private readonly qualityPop: Popover;
  private readonly qualitySeg: Segmented<QualityTier | 'auto'>;
  private state: HudState | null = null;
  private paused: boolean | null = null;

  constructor(host: HTMLElement, private readonly hooks: TopBarHooks) {
    this.mode = new Segmented<AppMode>('Mode', [
      { value: 'lessons', label: 'Lessons', short: 'Learn', title: 'Guided lessons' },
      { value: 'free', label: 'Free sail', short: 'Free', title: 'Sail anywhere, every control' },
      { value: 'lab', label: 'Sail lab', short: 'Lab', title: 'Wind tunnel on the water: the boat is towed' },
    ], (m) => hooks.setMode(m), 'sx-mode');

    // Wind chip + popover.
    const windMain = h('span', 'sx-chip-main');
    const windSub = h('span', 'sx-chip-sub');
    this.windText = new TextSlot(windMain);
    this.windSub = new TextSlot(windSub);
    const windBtn = h('button', { class: 'sx-chip', title: 'Wind settings', attrs: { type: 'button', 'aria-label': 'Wind settings' } }, [icon('wind', 16), windMain, windSub]);
    this.windCtl = new WindControls(hooks.setWind);
    this.windPop = new Popover(host, windBtn, h('div', 'sx-pop-body', [h('div', { class: 'sx-pop-title', text: 'Wind' }), this.windCtl.el]), 'Wind settings', 'center');
    windBtn.addEventListener('click', () => this.windPop.toggle());

    // Time chip + popover.
    const clock = h('span', 'sx-chip-main');
    this.clock = new TextSlot(clock);
    const timeBtn = h('button', { class: 'sx-chip is-time', title: 'Time of day', attrs: { type: 'button', 'aria-label': 'Time of day' } }, [icon('sun', 16), clock]);
    this.timeCtl = new TimeControls(hooks.setHour);
    const timePop = new Popover(host, timeBtn, h('div', 'sx-pop-body', [h('div', { class: 'sx-pop-title', text: 'Light' }), this.timeCtl.el]), 'Time of day', 'center');
    timeBtn.addEventListener('click', () => timePop.toggle());

    // Transport.
    this.pauseBtn = button('Pause', { icon: 'pause', iconOnly: true, class: 'sx-btn--icon', title: 'Pause (Space)', onClick: () => hooks.togglePause() });
    this.speed = new Segmented('Simulation speed', TIME_SCALES.map((s) => ({ value: String(s), label: s === 0.25 ? '¼×' : s === 0.5 ? '½×' : `${s}×`, title: `${s}× speed (, and . keys)` })), (v) => hooks.setTimeScale(Number(v)), 'sx-speed');

    // Right-hand icons.
    this.sound = new Toggle('Sound', (on) => hooks.setSound(on), { icon: 'sound', iconOnly: true, class: 'sx-btn--icon', title: 'Sound on/off' });
    const qualityMain = h('span', 'sx-chip-main');
    this.qualityText = new TextSlot(qualityMain);
    const qualityBtn = h('button', { class: 'sx-chip is-quality', title: 'Graphics quality', attrs: { type: 'button', 'aria-label': 'Graphics quality' } }, [qualityMain, icon('chevronDown', 14)]);
    this.qualitySeg = new Segmented('Graphics quality', QUALITY_ITEMS, (q) => { hooks.setQuality(q); this.qualityPop.close(); }, 'sx-seg--col');
    this.qualityPop = new Popover(host, qualityBtn, h('div', 'sx-pop-body', [h('div', { class: 'sx-pop-title', text: 'Graphics quality' }), this.qualitySeg.el]), 'Graphics quality', 'end');
    qualityBtn.addEventListener('click', () => this.qualityPop.toggle());
    this.fsBtn = button('Fullscreen', { icon: 'fullscreen', iconOnly: true, class: 'sx-btn--icon', title: 'Fullscreen', onClick: hooks.toggleFullscreen });
    if (typeof document !== 'undefined' && !document.fullscreenEnabled) this.fsBtn.hidden = true;
    document.addEventListener('fullscreenchange', () => {
      const on = document.fullscreenElement !== null;
      this.fsBtn.replaceChildren(icon(on ? 'exitFullscreen' : 'fullscreen'));
      this.fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    });

    this.el = h('header', { class: 'sx-top', attrs: { role: 'toolbar', 'aria-label': 'Sailing School' } }, [
      h('div', 'sx-top-group is-brand sx-glass', [
        h('span', 'sx-logo', [icon('logo', 22)]),
        h('span', { class: 'sx-brand', text: 'Sailing School' }),
        this.mode.el,
      ]),
      h('div', 'sx-top-group is-sim sx-glass', [windBtn, timeBtn, h('span', 'sx-sep'), this.pauseBtn, this.speed.el]),
      h('div', 'sx-top-group is-tools sx-glass', [
        this.sound.el,
        qualityBtn,
        this.fsBtn,
        button('Menu', { icon: 'gear', iconOnly: true, class: 'sx-btn--icon', title: 'Menu (Esc)', onClick: hooks.openSettings }),
        button('Help', { icon: 'help', iconOnly: true, class: 'sx-btn--icon', title: 'Keyboard & help (?)', onClick: hooks.openHelp }),
      ]),
      button('Menu', { icon: 'gear', iconOnly: true, class: 'sx-btn--icon sx-top-menu sx-glass', title: 'Menu', onClick: hooks.openSettings }),
    ]);
  }

  sync(st: HudState): void {
    this.state = st;
    this.mode.set(st.mode);
    if (st.paused !== this.paused) {
      this.paused = st.paused;
      this.pauseBtn.replaceChildren(icon(st.paused ? 'play' : 'pause'));
      this.pauseBtn.setAttribute('aria-label', st.paused ? 'Resume' : 'Pause');
      this.pauseBtn.title = st.paused ? 'Resume (Space)' : 'Pause (Space)';
      setClass(this.pauseBtn, 'is-on', st.paused);
    }
    this.speed.set(String(st.timeScale));
    this.sound.set(st.sound);
    this.sound.el.replaceChildren(icon(st.sound ? 'sound' : 'mute'));
    const q = QUALITY_ITEMS.find((i) => i.value === st.quality)?.label ?? 'Auto';
    this.qualityText.set(st.quality === 'auto' && st.qualityActual ? `Auto · ${st.qualityActual}` : q);
    this.qualitySeg.set(st.quality);
    this.clock.set(fmtClock(st.hour));
    this.timeCtl.sync(st.hour);
    this.windCtl.sync(st.wind);
    if (st.wind) this.setWindChip(st.wind.tws, st.wind.twd, st.wind.gustiness);
  }

  /** Before the App reports its wind settings, show the live wind. */
  update(snap: SimSnapshot): void {
    if (this.state?.wind) return;
    this.setWindChip(snap.wind.tws, snap.wind.twd, null);
  }

  private setWindChip(tws: number, twd: number, gust: number | null): void {
    const deg = ((Math.round(twd / DEG) % 360) + 360) % 360;
    this.windText.set(`${fmtKn(tws, 0)} kn`);
    this.windSub.set(`${compassName(deg)} ${deg}°${gust === null ? '' : ` · ${gustWord(gust)}`}`);
  }
}
