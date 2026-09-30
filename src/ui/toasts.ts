// Event toasts (spec §3.2): accidental gybe, in irons, spinnaker collapse, luffing … each with a one-line
// "why" and a link to the lesson that teaches it. Rate-limited per event type; at most three on screen.
import type { SimEventType } from '../sim/types';
import { button, h, icon, textHtml, type IconName, notNull } from './dom';

export type ToastKind = 'warn' | 'info' | 'good';

export interface ToastSpec {
  title: string;
  /** One line; [[glossary]] markup allowed. */
  msg: string;
  kind: ToastKind;
  /** Lesson to link (shown only if the curriculum contains it). */
  lessonId?: string;
  /** Minimum seconds between two toasts of this event. */
  cooldown: number;
}

/**
 * Event → toast. Lesson ids follow the curriculum file names of Task 18 (`01-meet-the-boat.ts` → 'meet-the-boat');
 * the Hud hides a link whose lesson does not exist, and `Hud.setEventLessons` can remap them.
 */
export const EVENT_TOASTS: Partial<Record<SimEventType, ToastSpec>> = {
  crashGybe: { title: 'Accidental gybe!', msg: 'The wind got behind the mainsail and slammed the [[boom]] across. Steer less deep, or sheet in before you [[gybe]].', kind: 'warn', lessonId: 'gybing', cooldown: 6 },
  inIrons: { title: 'In irons', msg: 'Pointing into the wind the sails cannot fill. Back the jib and steer away until they draw.', kind: 'warn', lessonId: 'getting-out-of-irons', cooldown: 15 },
  spinCollapse: { title: 'Spinnaker collapsed', msg: 'Its [[luff]] folded in: trim the spinnaker sheet a little, or bear away.', kind: 'warn', lessonId: 'spinnaker-reaching', cooldown: 8 },
  roundUp: { title: 'Round-up', msg: 'Too much [[heel]]: the rudder lost its grip and the boat spun into the wind. Ease the main to depower.', kind: 'warn', lessonId: 'keel-and-balance', cooldown: 10 },
  luffing: { title: 'Luffing', msg: 'The sails are flapping — the wind meets them too head-on. [[trim|Trim]] in, or bear away.', kind: 'info', lessonId: 'jib-telltales', cooldown: 30 },
  backwinded: { title: 'Backwinded main', msg: 'The jib is over-trimmed and blows into the back of the main. Ease the jib a little.', kind: 'info', lessonId: 'main-and-jib', cooldown: 20 },
  tackComplete: { title: 'Tack complete', msg: '', kind: 'good', cooldown: 2 },
  gybeComplete: { title: 'Gybe complete', msg: '', kind: 'good', cooldown: 2 },
  spinRefill: { title: 'Spinnaker full again', msg: '', kind: 'good', cooldown: 5 },
};

const KIND_ICON: Record<ToastKind, IconName> = { warn: 'wind', info: 'bulb', good: 'check' };
const MAX_TOASTS = 3;

interface Live { el: HTMLElement; ttl: number; key: string }

export interface ToastOptions {
  title?: string;
  msg: string;
  kind?: ToastKind;
  lessonId?: string;
  /** Seconds on screen (default: 7 warn / 5 info / 2.5 good). */
  ttl?: number;
  /** Replaces a toast with the same key instead of stacking. */
  key?: string;
}

export class Toasts {
  readonly el: HTMLElement;
  private readonly live: Live[] = [];

  constructor(private readonly lessonTitle: (id: string) => string | null, private readonly openLesson: (id: string) => void) {
    this.el = h('div', { class: 'sx-toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
  }

  show(o: ToastOptions): void {
    const kind = o.kind ?? 'info';
    const key = o.key ?? `${o.title ?? ''}|${o.msg}`;
    const existing = this.live.findIndex((t) => t.key === key);
    if (existing >= 0) this.dismiss(existing);
    const title = o.lessonId ? this.lessonTitle(o.lessonId) : null;
    const el = h('div', `sx-toast is-${kind}`, [
      h('span', 'sx-toast-icon', [icon(KIND_ICON[kind], 18)]),
      h('div', 'sx-toast-body', [
        o.title ? h('div', { class: 'sx-toast-title', text: o.title }) : null,
        o.msg ? h('div', { class: 'sx-toast-msg', html: textHtml(o.msg) }) : null,
        title && o.lessonId ? button(`Lesson: ${title}`, { class: 'sx-btn--link', icon: 'book', onClick: () => { this.openLesson(o.lessonId!); this.clear(); } }) : null,
      ].filter(notNull)),
      button('Dismiss', { icon: 'close', iconOnly: true, class: 'sx-btn--ghost sx-btn--sm sx-toast-close', onClick: () => this.remove(el) }),
    ]);
    const ttl = o.ttl ?? (kind === 'warn' ? 7 : kind === 'good' ? 2.5 : 5);
    this.live.push({ el, ttl, key });
    this.el.append(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    while (this.live.length > MAX_TOASTS) this.dismiss(0);
  }

  /** Counts down lifetimes (real time). */
  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const t = this.live[i]!;
      t.ttl -= dt;
      if (t.ttl <= 0) this.dismiss(i);
    }
  }

  clear(): void {
    while (this.live.length) this.dismiss(0);
  }

  private remove(el: HTMLElement): void {
    const i = this.live.findIndex((t) => t.el === el);
    if (i >= 0) this.dismiss(i);
  }

  private dismiss(i: number): void {
    const [t] = this.live.splice(i, 1);
    if (!t) return;
    t.el.classList.remove('is-in');
    t.el.classList.add('is-out');
    setTimeout(() => t.el.remove(), 220);
  }
}
