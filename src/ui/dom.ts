// Small DOM toolkit for the HUD: element builders, icons, number formatting, throttling, and the
// shared widgets (range slider, segmented control, toggle, popover, glossary tooltip).
// Import-safe in Node: nothing touches `document` until a function is called.
import { DEG } from '../shared/math';
import { compassDeg, toKn } from '../shared/units';
import { GLOSSARY_MARKUP, lookupTerm } from '../lessons/glossary';

// ---- element builders ------------------------------------------------------------------------

export const notNull = <T>(x: T): x is NonNullable<T> => x !== null && x !== undefined;

export type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean>;
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | string = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const p: Props = typeof props === 'string' ? { class: props } : props;
  if (p.class) el.className = p.class;
  if (p.text !== undefined) el.textContent = p.text;
  if (p.html !== undefined) el.innerHTML = p.html;
  if (p.title) el.title = p.title;
  if (p.attrs) for (const [k, v] of Object.entries(p.attrs)) el.setAttribute(k, String(v));
  if (p.on) {
    for (const [type, fn] of Object.entries(p.on)) el.addEventListener(type, fn as EventListener);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, children: Child[] = []): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ---- icons (24×24, stroked with currentColor) ---------------------------------------------------

const ICONS = {
  logo: 'M11 3.5v14H4.5z M13 6.5c3.8 2.6 5.8 6.4 6 11h-6z M3 19.5h18l-2.4 2.2H5.4z',
  play: 'M8 5.5v13l10-6.5z',
  pause: 'M7.5 5.5v13 M16.5 5.5v13',
  sound: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M15.5 9a4 4 0 0 1 0 6 M18.2 6.5a7.6 7.6 0 0 1 0 11',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M16 9.5l5 5 M21 9.5l-5 5',
  fullscreen: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
  exitFullscreen: 'M9 4v5H4 M20 9h-5V4 M15 20v-5h5 M4 15h5v5',
  gear: 'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 1 0 0-6.8z M12 2.8v2.6 M12 18.6v2.6 M2.8 12h2.6 M18.6 12h2.6 M5.5 5.5l1.9 1.9 M16.6 16.6l1.9 1.9 M5.5 18.5l1.9-1.9 M16.6 7.4l1.9-1.9',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 1 0 0 18z M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .8-1 1.5v.5 M12 16.8v.2',
  close: 'M6.5 6.5l11 11 M17.5 6.5l-11 11',
  chevronLeft: 'M14.5 5.5L8 12l6.5 6.5',
  chevronRight: 'M9.5 5.5L16 12l-6.5 6.5',
  chevronDown: 'M5.5 9.5L12 16l6.5-6.5',
  chevronUp: 'M5.5 14.5L12 8l6.5 6.5',
  wind: 'M3 8.5h10a3 3 0 1 0-3-3 M3 12.5h15a3 3 0 1 1-3 3 M3 16.5h7',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8z M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4',
  book: 'M4 5.5c2.7-1 5.4-1 8 .8 2.6-1.8 5.3-1.8 8-.8v13c-2.7-1-5.4-1-8 .8-2.6-1.8-5.3-1.8-8-.8z M12 6.3v13',
  sliders: 'M4 7h9 M17 7h3 M15 5v4 M4 17h3 M11 17h9 M9 15v4 M4 12h13 M20 12h0',
  layers: 'M12 4l9 4.5-9 4.5-9-4.5z M3 13l9 4.5 9-4.5 M3 17.2l9 4.5 9-4.5',
  bulb: 'M9 17.5h6 M10 20.5h4 M12 3.5a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-.6c0-.8.4-1.5 1-2A6 6 0 0 0 12 3.5z',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 1 0 0-5.6z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chart: 'M4 20V4 M4 20h16 M7 16c2-6 5-9 12-10',
  // overlays
  windTriangle: 'M4.5 19.5L12 5l7.5 14.5z M9.4 8.6L12 5l.9 4.3',
  forces: 'M5 19L18 6 M12.5 6H18v5.5 M5 19h8 M5 19v-8',
  wheel: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z M12 3v9l6.4-6.4 M12 12l-6.4-6.4',
  flow: 'M3 8c3-2.6 6 2.6 9 0s6-2.6 9 0 M3 13c3-2.6 6 2.6 9 0s6-2.6 9 0 M3 18c3-2.6 6 2.6 9 0s6-2.6 9 0',
  flowSlice: 'M12 4l9 4.5-9 4.5-9-4.5z M3 13.5l9 4.5 9-4.5',
  aoa: 'M7 20.5V3.5c5.5 3 9.5 9 10.5 17z M3 9.5l8 2.5',
  xray: 'M2.5 9.5h19 M7 9.5l2 4.5h6l2-4.5 M11 14v6.5h2V14 M4 6c1.3-1 2.7-1 4 0s2.7 1 4 0 2.7-1 4 0 2.7 1 4 0',
  labels: 'M3.5 12.5V4h8.5l9.5 9.5-8.5 8.5z M8 8.2h.1',
  laylines: 'M4.5 20.5L12 6l7.5 14.5 M13.5 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0',
  track: 'M4 20l1.4-2.6 M7.2 15.4l1.7-1.9 M10.8 12l1.5-2.2 M14 7.6l2-1.6 M18 4.8l2.3-.8',
  telltaleCam: 'M3 5h18v14H3z M12.5 11.5h6.5v5.5h-6.5z',
} as const;

export type IconName = keyof typeof ICONS;
const FILLED: ReadonlySet<IconName> = new Set<IconName>(['play']);

export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = s('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: FILLED.has(name) ? 'currentColor' : 'none',
    stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', class: 'sx-icon',
  });
  svg.append(s('path', { d: ICONS[name] }));
  return svg;
}

// ---- formatting (pure) -------------------------------------------------------------------------

/** 'P' (port), 'S' (starboard) or '' when the angle is within `dead` of zero. */
export function sideLetter(rad: number, dead = 0.5 * DEG): 'P' | 'S' | '' {
  return rad > dead ? 'S' : rad < -dead ? 'P' : '';
}

/** Unsigned whole degrees, e.g. 0.733 rad → "42°". */
export function fmtAngle(rad: number, digits = 0): string {
  return `${Math.abs(rad / DEG).toFixed(digits)}°`;
}

/** Signed wind angle for display: 42° S / 38° P (spec: + = from starboard). */
export function fmtSided(rad: number, digits = 0): string {
  const side = sideLetter(rad, digits > 0 ? 0.05 * DEG : 0.5 * DEG);
  return side ? `${fmtAngle(rad, digits)} ${side}` : fmtAngle(rad, digits);
}

/** Boom / jib-clew angle for display — spec §5: + = out to PORT (the opposite of wind angles). */
export function fmtSheetAngle(rad: number): string {
  return fmtSided(-rad);
}

export function fmtKn(ms: number, digits = 1): string {
  const kn = toKn(ms);
  return (Math.abs(kn) < 0.5 * 10 ** -digits ? 0 : kn).toFixed(digits);
}

/** Compass heading as three digits: 7° → "007°". */
export function fmtHeading(rad: number): string {
  return `${String(compassDeg(rad)).padStart(3, '0')}°`;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassName(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return POINTS[i]!;
}

/** Hours → "17:30". */
export function fmtClock(hours: number): string {
  const total = Math.round(hours * 60);
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

// ---- update helpers ----------------------------------------------------------------------------

/** Writes textContent only when the string changes (no layout reads). */
export class TextSlot {
  private last: string | null = null;
  constructor(readonly el: Element) {}
  set(text: string): void {
    if (text === this.last) return;
    this.last = text;
    this.el.textContent = text;
  }
}

/** Fires at most `hz` times per second of accumulated dt. */
export class RateGate {
  private acc = Infinity;
  private readonly period: number;
  constructor(hz: number) { this.period = 1 / hz; }
  tick(dt: number): boolean {
    this.acc += dt;
    if (this.acc < this.period) return false;
    this.acc = this.acc === Infinity ? 0 : this.acc % this.period;
    return true;
  }
  force(): void { this.acc = Infinity; }
}

/** Sets a class only when its state changes. */
export function setClass(el: Element, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/** Mouse clicks should not leave focus on a button/slider (Space would re-press it, arrows would move it). */
export function blurAfterMouse(el: HTMLElement): void {
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') requestAnimationFrame(() => el.blur());
  });
}

// ---- glossary markup -----------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Convert [[key]] / [[key|text]] into hoverable glossary terms. Input must be trusted HTML (lesson bodies are
 * authored in the repo) or already escaped (see textHtml) — never raw user input.
 */
export function glossaryHtml(html: string): string {
  return html.replace(GLOSSARY_MARKUP, (_m, key: string, shown?: string) => {
    const entry = lookupTerm(key);
    const label = shown?.trim() ?? (entry ? termText(key.trim(), entry) : key.trim());
    if (!entry) return label;
    return `<dfn class="sx-gloss" tabindex="0" data-term="${escapeHtml(entry.key)}">${label}</dfn>`;
  });
}

/** Text for [[key]] without "|text": a hyphenated key reads as its term ([[no-go-zone]] → "no-go zone"). */
function termText(written: string, entry: { key: string; term: string }): string {
  if (written !== entry.key || !written.includes('-')) return written;
  const term = entry.term.replace(/\s*\(.*\)\s*$/, '');
  return term === term.toUpperCase() ? term : term.charAt(0).toLowerCase() + term.slice(1);
}

/** Plain text (escaped) with glossary markup. */
export function textHtml(text: string): string {
  return glossaryHtml(escapeHtml(text));
}

/**
 * One shared definition card for every `.sx-gloss` term inside `root`: shown on hover, focus or tap; hidden on
 * pointer-out, blur, a tap elsewhere, Esc (via `hide`) and scrolling. A tap never closes the card it just opened
 * (touch browsers focus the term first, then deliver the click).
 */
export function installGlossaryTips(root: HTMLElement): { hide(): void; dispose(): void } {
  const tip = h('div', { class: 'sx-tip', attrs: { role: 'tooltip', id: 'sx-gloss-tip', hidden: true } }, [
    h('div', 'sx-tip-term'),
    h('div', 'sx-tip-def'),
  ]);
  root.append(tip);
  let current: HTMLElement | null = null;

  const show = (term: HTMLElement) => {
    const entry = lookupTerm(term.dataset['term'] ?? '');
    if (!entry) return;
    current?.removeAttribute('aria-describedby');
    current = term;
    term.setAttribute('aria-describedby', 'sx-gloss-tip');
    tip.firstElementChild!.textContent = entry.term;
    tip.lastElementChild!.textContent = entry.def;
    tip.hidden = false;
    const r = term.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), innerWidth - tw - 8);
    const above = r.top - th - 8;
    const y = above >= 8 ? above : Math.min(r.bottom + 8, innerHeight - th - 8);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  const hide = () => {
    current?.removeAttribute('aria-describedby');
    current = null;
    tip.hidden = true;
  };
  const termOf = (e: Event): HTMLElement | null => {
    const t = e.target as Element | null;
    return t && typeof t.closest === 'function' ? (t.closest('.sx-gloss') as HTMLElement | null) : null;
  };
  const over = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const t = termOf(e);
    if (t) show(t);
  };
  const out = (e: PointerEvent) => { if (e.pointerType === 'mouse' && termOf(e)) hide(); };
  const focusIn = (e: FocusEvent) => { const t = termOf(e); if (t) show(t); };
  const focusOut = (e: FocusEvent) => { if (termOf(e)) hide(); };
  const tap = (e: MouseEvent) => {
    const t = termOf(e);
    if (!t) { if (current) hide(); return; }
    if (current !== t) show(t);
  };
  const scrolled = () => { if (current) hide(); };
  root.addEventListener('pointerover', over);
  root.addEventListener('pointerout', out);
  root.addEventListener('focusin', focusIn);
  root.addEventListener('focusout', focusOut);
  root.addEventListener('click', tap);
  root.addEventListener('scroll', scrolled, true);
  addEventListener('resize', scrolled);
  return {
    hide: () => { if (current) hide(); },
    dispose: () => {
      root.removeEventListener('pointerover', over);
      root.removeEventListener('pointerout', out);
      root.removeEventListener('focusin', focusIn);
      root.removeEventListener('focusout', focusOut);
      root.removeEventListener('click', tap);
      root.removeEventListener('scroll', scrolled, true);
      removeEventListener('resize', scrolled);
      tip.remove();
    },
  };
}

// ---- widgets -------------------------------------------------------------------------------------

export function button(label: string, opts: { icon?: IconName; title?: string; class?: string; onClick: () => void; iconOnly?: boolean; iconAfter?: boolean }): HTMLButtonElement {
  const ic = opts.icon ? icon(opts.icon, opts.iconAfter ? 16 : 18) : null;
  const text = opts.iconOnly ? null : h('span', { text: label });
  const b = h('button', {
    class: `sx-btn ${opts.class ?? ''}`.trim(),
    title: opts.title ?? (opts.iconOnly ? label : ''),
    attrs: { type: 'button', ...(opts.iconOnly ? { 'aria-label': label } : {}) },
    on: { click: () => opts.onClick() },
  }, opts.iconAfter ? [text, ic] : [ic, text]);
  blurAfterMouse(b);
  return b;
}

export interface SliderOptions {
  label: string;
  /** Glossary key: the label becomes a hoverable definition. */
  term?: string;
  min: number;
  max: number;
  step?: number;
  /** Fill from the centre (for −1…+1 controls). */
  bipolar?: boolean;
  /** Captions under the ends of the track, e.g. ['eased', 'trimmed']. */
  ends?: [string, string];
  format?: (v: number) => string;
  /** Screen-reader value text. */
  ariaText?: (v: number) => string;
  vertical?: boolean;
  onInput(v: number): void;
  onGrab?(): void;
  onRelease?(): void;
}

const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** Native range input (accessible, touch-friendly) with a label, a live value and a filled track. */
export class Slider {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly value: TextSlot | null;
  private dragging = false;
  private last = NaN;
  private enabled = true;

  constructor(private readonly o: SliderOptions) {
    const id = `sx-s-${Math.random().toString(36).slice(2, 9)}`;
    this.input = h('input', {
      class: `sx-range${o.bipolar ? ' is-bipolar' : ''}${o.vertical ? ' is-vertical' : ''}`,
      attrs: { type: 'range', id, min: o.min, max: o.max, step: o.step ?? 0.01, 'aria-label': o.label },
    });
    const valueEl = o.format ? h('span', 'sx-slider-value') : null;
    this.value = valueEl ? new TextSlot(valueEl) : null;
    // A plain span (not <label for>): clicking it must not focus the range and steal the arrow keys.
    const label = h('span', { class: 'sx-slider-label' }, [
      o.term ? h('span', { class: 'sx-gloss', text: o.label, attrs: { 'data-term': o.term, tabindex: '-1' } }) : o.label,
    ]);
    this.el = h('div', `sx-slider${o.vertical ? ' is-vertical' : ''}`, [
      h('div', 'sx-slider-head', [label, valueEl]),
      this.input,
      o.ends ? h('div', 'sx-slider-ends', [h('span', { text: o.ends[0] }), h('span', { text: o.ends[1] })]) : null,
    ]);
    const release = () => {
      if (!this.dragging) return;
      this.dragging = false;
      o.onRelease?.();
    };
    this.input.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      o.onGrab?.();
      const up = () => {
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
        release();
        if (e.pointerType === 'mouse') this.input.blur();
      };
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
    });
    this.input.addEventListener('keydown', (e) => {
      // Only value keys count as grabbing the control (Tab must not take a sail off auto-trim).
      if (!SLIDER_KEYS.has(e.key) || this.dragging || !this.enabled) return;
      this.dragging = true;
      o.onGrab?.();
    });
    this.input.addEventListener('keyup', release);
    this.input.addEventListener('blur', release);
    this.input.addEventListener('input', () => {
      const v = Number(this.input.value);
      this.paint(v);
      o.onInput(v);
    });
  }

  /** Reflect an external value (skipped while the learner is dragging). */
  set(v: number): void {
    if (this.dragging) return;
    const step = this.o.step ?? 0.01;
    if (Math.abs(v - this.last) < step * 0.5) return;
    this.input.value = String(v);
    this.paint(v);
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.input.disabled = !on;
    setClass(this.el, 'is-locked', !on);
  }

  setAuto(on: boolean): void {
    setClass(this.el, 'is-auto', on);
  }

  private paint(v: number): void {
    this.last = v;
    const { min, max, bipolar } = this.o;
    const p = ((v - min) / (max - min)) * 100;
    const lo = bipolar ? Math.min(50, p) : 0;
    const hi = bipolar ? Math.max(50, p) : p;
    this.input.style.setProperty('--lo', `${lo.toFixed(1)}%`);
    this.input.style.setProperty('--hi', `${hi.toFixed(1)}%`);
    const text = this.o.format?.(v);
    if (text !== undefined) this.value?.set(text);
    const aria = this.o.ariaText?.(v) ?? text;
    if (aria !== undefined) this.input.setAttribute('aria-valuetext', aria);
  }
}

export interface SegItem<T extends string> { value: T; label: string; title?: string; icon?: IconName; /** Label on phones. */ short?: string }

/** A row of mutually exclusive buttons (radio-group semantics). */
export class Segmented<T extends string> {
  readonly el: HTMLElement;
  private readonly buttons = new Map<T, HTMLButtonElement>();
  private current: T | null = null;
  private enabled = true;

  constructor(label: string, items: SegItem<T>[], onPick: (v: T) => void, cls = '') {
    this.el = h('div', { class: `sx-seg ${cls}`.trim(), attrs: { role: 'radiogroup', 'aria-label': label } });
    // Radio-group keyboard model: one tab stop, arrows move (and pick), Home/End jump.
    this.el.addEventListener('keydown', (e) => {
      const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      const list = [...this.buttons.entries()].filter(([, b]) => !b.disabled);
      if (!list.length) return;
      e.preventDefault();
      const at = list.findIndex(([, b]) => b === document.activeElement);
      const i = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1
        : (Math.max(0, at) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      const [value, b] = list[i]!;
      b.focus();
      onPick(value);
    });
    for (const it of items) {
      const b = h('button', {
        class: 'sx-seg-btn',
        title: it.title ?? '',
        attrs: { type: 'button', role: 'radio', 'aria-checked': 'false' },
        on: { click: () => onPick(it.value) },
      }, [
        it.icon ? icon(it.icon, 16) : null,
        h('span', { class: it.short ? 'sx-long' : '', text: it.label }),
        it.short ? h('span', { class: 'sx-short', text: it.short, attrs: { 'aria-hidden': 'true' } }) : null,
      ]);
      if (it.short) b.setAttribute('aria-label', it.label);
      blurAfterMouse(b);
      this.buttons.set(it.value, b);
      this.el.append(b);
    }
  }

  set(v: T | null): void {
    if (v === this.current) return;
    this.current = v;
    const any = v !== null && this.buttons.has(v);
    let first = true;
    for (const [k, b] of this.buttons) {
      b.setAttribute('aria-checked', String(k === v));
      b.tabIndex = (any ? k === v : first) ? 0 : -1;
      first = false;
    }
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const b of this.buttons.values()) b.disabled = !on;
  }
}

/** A pressed / not pressed button. */
export class Toggle {
  readonly el: HTMLButtonElement;
  private on = false;

  constructor(label: string, onChange: (on: boolean) => void, opts: { icon?: IconName; title?: string; class?: string; iconOnly?: boolean } = {}) {
    this.el = h('button', {
      class: `sx-toggle ${opts.class ?? ''}`.trim(),
      title: opts.title ?? '',
      attrs: { type: 'button', 'aria-pressed': 'false', ...(opts.iconOnly ? { 'aria-label': label } : {}) },
      on: { click: () => onChange(!this.on) },
    }, [opts.icon ? icon(opts.icon) : null, opts.iconOnly ? null : h('span', { class: 'sx-toggle-label', text: label })]);
    blurAfterMouse(this.el);
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.el.setAttribute('aria-pressed', String(on));
  }

  setEnabled(on: boolean): void {
    setDisabled(this.el, !on);
  }
}

/** Sets `disabled` only when it changes. */
export function setDisabled(el: HTMLButtonElement | HTMLInputElement, disabled: boolean): void {
  if (el.disabled !== disabled) el.disabled = disabled;
}

/** Floating glass card anchored to a button; one open at a time; closes on outside press or Esc. */
export class Popover {
  private static openOne: Popover | null = null;
  readonly el: HTMLElement;
  private isOpen = false;
  private readonly onDoc = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!this.el.contains(t) && !this.anchor.contains(t)) this.close();
  };
  private readonly onResize = () => this.place();

  constructor(private readonly host: HTMLElement, private readonly anchor: HTMLElement, content: HTMLElement, label: string, private readonly align: 'start' | 'center' | 'end' = 'center') {
    this.el = h('div', { class: 'sx-pop sx-glass', attrs: { role: 'dialog', 'aria-label': label, hidden: true } }, [content]);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
        this.anchor.focus();
      }
    });
    anchor.setAttribute('aria-haspopup', 'dialog');
    anchor.setAttribute('aria-expanded', 'false');
    host.append(this.el);
  }

  get open(): boolean { return this.isOpen; }

  toggle(): void {
    if (this.isOpen) this.close(); else this.show();
  }

  show(): void {
    if (this.isOpen) return;
    Popover.openOne?.close();
    Popover.openOne = this;
    this.isOpen = true;
    this.el.hidden = false;
    this.anchor.setAttribute('aria-expanded', 'true');
    this.place();
    document.addEventListener('pointerdown', this.onDoc, true);
    addEventListener('resize', this.onResize);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (Popover.openOne === this) Popover.openOne = null;
    this.el.hidden = true;
    this.anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onDoc, true);
    removeEventListener('resize', this.onResize);
  }

  static closeAll(): boolean {
    const p = Popover.openOne;
    p?.close();
    return p !== null;
  }

  private place(): void {
    const r = this.anchor.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const hgt = this.el.offsetHeight;
    let x = this.align === 'start' ? r.left : this.align === 'end' ? r.right - w : r.left + r.width / 2 - w / 2;
    x = Math.min(Math.max(8, x), innerWidth - w - 8);
    let y = r.bottom + 8;
    if (y + hgt > innerHeight - 8) y = Math.max(8, r.top - hgt - 8);
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}

/** Centered dialog with a dimmed backdrop; Esc / backdrop / close button dismiss it; focus returns afterwards. */
export class Modal {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  private readonly card: HTMLElement;
  private shown = false;
  private returnFocus: HTMLElement | null = null;
  /** Called after the dialog opens and before focus is restored on close (the Hud suspends keys and sets inert). */
  onToggle: ((open: boolean) => void) | null = null;

  constructor(host: HTMLElement, title: string, cls = '') {
    const titleId = `sx-m-${Math.random().toString(36).slice(2, 9)}`;
    this.body = h('div', 'sx-modal-body');
    this.card = h('div', {
      class: `sx-modal-card sx-glass ${cls}`.trim(),
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    }, [
      h('header', 'sx-modal-head', [
        h('h2', { class: 'sx-modal-title', text: title, attrs: { id: titleId } }),
        button('Close', { icon: 'close', iconOnly: true, class: 'sx-btn--ghost sx-btn--sm', onClick: () => this.close() }),
      ]),
      this.body,
    ]);
    this.el = h('div', { class: 'sx-modal', attrs: { hidden: true } }, [this.card]);
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!Popover.closeAll()) this.close();
    });
    host.append(this.el);
  }

  get open(): boolean { return this.shown; }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.el.hidden = false;
    this.onToggle?.(true);
    requestAnimationFrame(() => this.el.classList.add('is-in'));
    this.card.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.shown) return;
    this.shown = false;
    this.el.classList.remove('is-in');
    this.el.hidden = true;
    this.onToggle?.(false);
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  toggle(): void {
    if (this.shown) this.close(); else this.show();
  }
}

/** Leading + trailing throttle: at most one call per `ms`, and the last value always lands. */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  return (...args: A) => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
      return;
    }
    pending = args;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      last = performance.now();
      if (pending) fn(...pending);
      pending = null;
    }, ms - (now - last));
  };
}

/** Like throttle, for partial-update calls: partials that arrive inside the window are merged, none is lost. */
export function throttleMerge<T extends object>(fn: (p: T) => void, ms: number): (p: T) => void {
  let pending: T | null = null;
  const flush = throttle(() => {
    const p = pending;
    pending = null;
    if (p) fn(p);
  }, ms);
  return (p: T) => {
    pending = pending ? { ...pending, ...p } : { ...p };
    flush();
  };
}
