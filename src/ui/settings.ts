// Settings menu (Esc) plus the wind / time-of-day control groups that the top bar also shows in its
// popovers. Slider changes reach the App throttled (wind re-seeds the sea state, time re-bakes the sky).
import type { WindSettings } from '../sim/types';
import type { QualityTier } from '../render/core/types';
import { DEG } from '../shared/math';
import { fromDeg, fromKn, toKn } from '../shared/units';
import { TIME_SCALES } from './input';
import { button, compassName, fmtClock, h, Modal, Segmented, Slider, throttle, throttleMerge, Toggle } from './dom';
import type { HudState } from './Hud';

export const GUST_WORDS = ['steady', 'light gusts', 'moderate gusts', 'gusty', 'squally'] as const;
export function gustWord(g: number): string {
  return GUST_WORDS[Math.min(GUST_WORDS.length - 1, Math.round(g * (GUST_WORDS.length - 1)))]!;
}

const THROTTLE_MS = 120;

export class WindControls {
  readonly el: HTMLElement;
  private readonly tws: Slider;
  private readonly dir: Slider;
  private readonly gust: Slider;
  private readonly shift: Slider;
  private readonly period: Slider;

  constructor(setWind: (p: Partial<WindSettings>) => void) {
    // One throttle for five sliders: partials are merged so a {tws} change is never dropped by a {twd} one.
    const send = throttleMerge(setWind, THROTTLE_MS);
    this.tws = new Slider({ label: 'Wind speed', term: 'true-wind', min: 4, max: 25, step: 0.5, format: (v) => `${v.toFixed(v % 1 ? 1 : 0)} kn`, onInput: (v) => send({ tws: fromKn(v) }) });
    this.dir = new Slider({ label: 'From', min: 0, max: 355, step: 5, format: (v) => `${Math.round(v)}° ${compassName(v)}`, onInput: (v) => send({ twd: fromDeg(v) }) });
    this.gust = new Slider({ label: 'Gusts', term: 'gust', min: 0, max: 1, step: 0.05, format: gustWord, onInput: (v) => send({ gustiness: v }) });
    this.shift = new Slider({ label: 'Wind shifts', term: 'header', min: 0, max: 15, step: 1, format: (v) => (v < 0.5 ? 'off' : `±${Math.round(v)}°`), onInput: (v) => send({ shiftAmplitude: fromDeg(v) }) });
    this.period = new Slider({ label: 'Shift period', min: 60, max: 300, step: 10, format: (v) => `${Math.round(v)} s`, onInput: (v) => send({ shiftPeriod: v }) });
    this.el = h('div', 'sx-group', [this.tws.el, this.dir.el, this.gust.el, this.shift.el, this.period.el]);
  }

  sync(w: WindSettings | null): void {
    if (!w) return;
    this.tws.set(Math.round(toKn(w.tws) * 2) / 2);
    this.dir.set(((Math.round(w.twd / DEG / 5) * 5) % 360 + 360) % 360);
    this.gust.set(w.gustiness);
    this.shift.set(Math.round(w.shiftAmplitude / DEG));
    this.period.set(w.shiftPeriod);
  }
}

export class TimeControls {
  readonly el: HTMLElement;
  private readonly hour: Slider;

  constructor(setHour: (h: number) => void) {
    const send = throttle(setHour, THROTTLE_MS);
    this.hour = new Slider({ label: 'Time of day', min: 5, max: 21, step: 0.25, format: fmtClock, onInput: send });
    const preset = (label: string, hr: number) => button(label, { class: 'sx-btn--chip', onClick: () => { this.hour.set(hr); setHour(hr); } });
    this.el = h('div', 'sx-group', [
      this.hour.el,
      h('div', 'sx-row sx-row--wrap', [preset('Morning', 8), preset('Midday', 13), preset('Afternoon', 17), preset('Golden hour', 18.75)]),
    ]);
  }

  sync(hour: number): void {
    this.hour.set(hour);
  }
}

export const QUALITY_ITEMS: { value: QualityTier | 'auto'; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Adapts to keep the frame rate smooth' },
  { value: 'ultra', label: 'Ultra', title: 'Full resolution, reflections, 4K shadows' },
  { value: 'high', label: 'High', title: 'The default' },
  { value: 'medium', label: 'Med', title: 'Lighter ocean and shadows' },
  { value: 'low', label: 'Low', title: 'For older or battery-saving devices' },
];

export interface SettingsHooks {
  setWind(p: Partial<WindSettings>): void;
  setHour(h: number): void;
  setTimeScale(s: number): void;
  togglePause(): void;
  setSound(on: boolean): void;
  setQuality(q: QualityTier | 'auto'): void;
  setTillerMode(m: 'spring' | 'sticky'): void;
  resetProgress(): void;
  openHelp(): void;
  toggleFullscreen(): void;
}

export class SettingsDialog {
  readonly modal: Modal;
  private readonly wind: WindControls;
  private readonly time: TimeControls;
  private readonly speed: Segmented<string>;
  private readonly pause: Toggle;
  private readonly sound: Toggle;
  private readonly quality: Segmented<QualityTier | 'auto'>;
  private readonly tiller: Segmented<'spring' | 'sticky'>;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: HTMLElement, hooks: SettingsHooks) {
    this.modal = new Modal(host, 'Menu', 'sx-settings');
    this.wind = new WindControls(hooks.setWind);
    this.time = new TimeControls(hooks.setHour);
    this.speed = new Segmented('Simulation speed', TIME_SCALES.map((s) => ({ value: String(s), label: `${s}×` })), (v) => hooks.setTimeScale(Number(v)), 'sx-seg--fill');
    this.pause = new Toggle('Pause', () => hooks.togglePause(), { icon: 'pause', title: 'Pause (Space)' });
    this.sound = new Toggle('Sound', (on) => hooks.setSound(on), { icon: 'sound' });
    this.quality = new Segmented('Graphics quality', QUALITY_ITEMS, (q) => hooks.setQuality(q), 'sx-seg--fill');
    this.tiller = new Segmented('Tiller behaviour', [
      { value: 'spring', label: 'Self-centring', title: 'Hold to turn, release to centre (default)' },
      { value: 'sticky', label: 'Stays put', title: 'The tiller stays where you leave it' },
    ], (m) => hooks.setTillerMode(m), 'sx-seg--fill');
    const reset = button('Reset lesson progress', {
      class: 'sx-btn--ghost sx-btn--danger',
      onClick: () => {
        if (this.confirmTimer === null) {
          reset.querySelector('span')!.textContent = 'Click again to erase all ticks';
          this.confirmTimer = setTimeout(() => {
            this.confirmTimer = null;
            reset.querySelector('span')!.textContent = 'Reset lesson progress';
          }, 3000);
          return;
        }
        clearTimeout(this.confirmTimer);
        this.confirmTimer = null;
        reset.querySelector('span')!.textContent = 'Progress erased';
        hooks.resetProgress();
      },
    });
    const group = (title: string, ...children: HTMLElement[]) => h('section', 'sx-set', [h('h3', { class: 'sx-set-title', text: title }), ...children]);
    this.modal.body.append(
      h('div', 'sx-set-grid', [
        group('Wind', this.wind.el),
        h('div', 'sx-set-col', [
          group('Light', this.time.el),
          group('Simulation', this.speed.el, h('div', 'sx-row sx-row--2', [this.pause.el, this.sound.el])),
          group('Graphics', this.quality.el, button('Fullscreen', { icon: 'fullscreen', class: 'sx-btn--ghost', onClick: hooks.toggleFullscreen })),
          group('Controls', this.tiller.el, h('div', 'sx-row sx-row--2', [
            button('Keyboard & help', { icon: 'help', class: 'sx-btn--ghost', onClick: () => { this.modal.close(); hooks.openHelp(); } }),
            reset,
          ])),
        ]),
      ]),
    );
  }

  sync(st: HudState): void {
    this.wind.sync(st.wind);
    this.time.sync(st.hour);
    this.speed.set(String(st.timeScale));
    this.pause.set(st.paused);
    this.sound.set(st.sound);
    this.quality.set(st.quality);
    this.tiller.set(st.tillerMode);
  }
}
