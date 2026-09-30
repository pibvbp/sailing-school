// Left-hand lesson panel (spec §3.2, §11.1): lesson title, step text with hoverable glossary terms, the
// live task checklist with a progress bar, Hint / Show me / Back / Next, quizzes, the completion card
// and the curriculum navigator with completion ticks. `peek` is the compact card shown on phones.
// Implements the engine's LessonView: the LessonRunner drives it; user actions go back via bind().
import type {
  CatalogEntry, LessonActions, LessonInfo, LessonView, LessonViewModel, TaskStatus,
} from '../lessons/types';
import { button, glossaryHtml, h, icon, setClass, textHtml, TextSlot, notNull } from './dom';

export class LessonPanel implements LessonView {
  readonly el: HTMLElement;
  /** Compact progress card for phones (tap to open the lesson sheet). */
  readonly peek: HTMLButtonElement;
  /** Set by the Hud: the peek card was tapped. */
  onOpen: (() => void) | null = null;
  /** Set by the Hud: called after every render (e.g. to expand the dock when a lesson starts). */
  onRender: ((m: LessonViewModel) => void) | null = null;

  private actions: LessonActions | null = null;
  private model: LessonViewModel | null = null;
  private catalogOpen = false;
  private readonly content: HTMLElement;
  private readonly peekKicker: TextSlot;
  private readonly peekTitle: TextSlot;
  private readonly peekMeta: TextSlot;
  private readonly peekFill: HTMLElement;
  private task: { box: HTMLElement; fill: HTMLElement; meta: TextSlot; next: HTMLButtonElement; hold: number; nextLabel: TextSlot } | null = null;
  private hintBox: HTMLElement | null = null;
  private lastTask = { progress: -1, held: -1, done: false };

  constructor() {
    this.content = h('div', 'sx-lp-content');
    this.el = h('div', { class: 'sx-lp', attrs: { role: 'region', 'aria-label': 'Lesson' } }, [this.content]);
    const kicker = h('span', 'sx-peek-kicker');
    const title = h('span', 'sx-peek-title');
    const meta = h('span', 'sx-peek-meta');
    this.peekFill = h('span', 'sx-peek-fill');
    this.peekKicker = new TextSlot(kicker);
    this.peekTitle = new TextSlot(title);
    this.peekMeta = new TextSlot(meta);
    this.peek = h('button', {
      class: 'sx-peek sx-glass',
      attrs: { type: 'button', 'aria-label': 'Open the lesson', hidden: true },
      on: { click: () => this.onOpen?.() },
    }, [h('span', 'sx-peek-top', [kicker, meta]), title, h('span', 'sx-peek-bar', [this.peekFill])]);
  }

  bind(actions: LessonActions): void {
    this.actions = actions;
  }

  /** Whether the catalogue contains a lesson (used by toasts before linking to it). */
  hasLesson(id: string): boolean {
    return this.model?.catalog.some((c) => c.id === id) ?? false;
  }

  lessonTitle(id: string): string | null {
    return this.model?.catalog.find((c) => c.id === id)?.title ?? null;
  }

  get activeKind(): LessonViewModel['kind'] | null {
    return this.model?.kind ?? null;
  }

  /** Settings → "Reset lesson progress". */
  requestReset(): void {
    this.actions?.resetProgress();
  }

  render(m: LessonViewModel): void {
    this.model = m;
    this.task = null;
    this.hintBox = null;
    this.lastTask = { progress: -1, held: -1, done: false };
    const parts: HTMLElement[] =
      m.kind === 'idle' ? this.idle(m.catalog, m.resumeId)
        : m.kind === 'step' ? this.step(m)
          : m.kind === 'quiz' ? this.quiz(m)
            : this.complete(m);
    this.content.replaceChildren(...parts);
    this.content.scrollTop = 0;
    this.renderPeek(m);
    this.onRender?.(m);
  }

  setTask(st: TaskStatus): void {
    const t = this.task;
    if (!t) return;
    const held = st.held === null ? -1 : Math.round(st.held * 10) / 10;
    const p = Math.round(st.progress * 500) / 500;
    if (p === this.lastTask.progress && held === this.lastTask.held && st.done === this.lastTask.done) return;
    const doneChanged = st.done !== this.lastTask.done;
    this.lastTask = { progress: p, held, done: st.done };
    const scale = `scaleX(${p.toFixed(3)})`;
    t.fill.style.transform = scale;
    this.peekFill.style.transform = scale;
    const meta = st.done ? 'Done!' : st.held !== null && t.hold > 0 ? `${st.held.toFixed(1)} / ${t.hold} s` : `${Math.round(p * 100)}%`;
    t.meta.set(meta);
    this.peekMeta.set(meta);
    if (doneChanged) {
      setClass(t.box, 'is-done', st.done);
      setClass(this.peek, 'is-done', st.done);
      setClass(t.next, 'sx-btn--primary', st.done);
      if (st.done) t.nextLabel.set(this.nextLabel(false));
    }
  }

  setHint(text: string | null): void {
    const box = this.hintBox;
    if (!box) return;
    box.hidden = text === null;
    const body = box.querySelector('.sx-hint-text');
    // textHtml escapes the hint first, then turns [[glossary]] markup into terms.
    if (body) body.innerHTML = text === null ? '' : textHtml(text);
  }

  // ---- views ----------------------------------------------------------------------------------------

  private idle(catalog: CatalogEntry[], resumeId: string | null): HTMLElement[] {
    const done = catalog.filter((c) => c.done).length;
    const resume = resumeId ? catalog.find((c) => c.id === resumeId) : null;
    return [
      h('header', 'sx-lp-head', [
        h('div', { class: 'sx-kicker', text: `Curriculum · ${done} of ${catalog.length} complete` }),
        h('h2', { class: 'sx-lp-title', text: 'Learn to sail' }),
      ]),
      h('p', { class: 'sx-lp-lead', text: 'Each lesson sets up the wind, the boat and the view, then checks what you do in the live simulation. Hover underlined words for a definition.' }),
      resume ? button(`${done > 0 ? 'Continue' : 'Start'}: ${resume.title}`, { class: 'sx-btn--primary sx-btn--block', icon: 'chevronRight', iconAfter: true, onClick: () => this.actions?.select(resume.id) }) : null,
      this.catalogList(catalog),
    ].filter(notNull);
  }

  private step(m: Extract<LessonViewModel, { kind: 'step' }>): HTMLElement[] {
    const st = m.step;
    const next = h('button', { class: 'sx-btn sx-btn--next', attrs: { type: 'button' }, on: { click: () => this.actions?.next() } });
    const nextLabel = h('span');
    next.append(nextLabel, icon('chevronRight', 16));
    const nextSlot = new TextSlot(nextLabel);
    const parts: (HTMLElement | null)[] = [
      this.header(m.lesson, [this.dots(m.index, m.count)]),
      h('section', 'sx-lp-body', [
        h('h3', { class: 'sx-step-title', text: `${m.index + 1}. ${st.title}` }),
        h('div', { class: 'sx-prose', html: glossaryHtml(st.body) }),
      ]),
    ];
    if (st.taskLabel !== null) {
      const fill = h('span', 'sx-task-fill');
      const meta = h('span', 'sx-task-meta');
      const box = h('div', { class: `sx-task${st.completed ? ' was-done' : ''}`, attrs: { role: 'group', 'aria-label': 'Task' } }, [
        h('div', 'sx-task-row', [h('span', 'sx-task-check', [icon('check', 14)]), h('span', { class: 'sx-task-label', html: textHtml(st.taskLabel) })]),
        h('div', 'sx-task-bar', [fill]),
        h('div', 'sx-task-foot', [h('span', { class: 'sx-task-kicker', text: st.holdSeconds > 0 ? `Hold for ${st.holdSeconds} s` : 'Task' }), meta]),
      ]);
      this.task = { box, fill, meta: new TextSlot(meta), next, hold: st.holdSeconds, nextLabel: nextSlot };
      this.task.meta.set(st.holdSeconds > 0 ? `0.0 / ${st.holdSeconds} s` : '0%');
      parts.push(box);
    }
    this.hintBox = h('div', { class: 'sx-hint', attrs: { hidden: true, role: 'status', 'aria-live': 'polite' } }, [icon('bulb', 16), h('div', 'sx-hint-text')]);
    parts.push(this.hintBox);
    nextSlot.set(this.nextLabel(st.taskLabel !== null && !st.completed));
    if (st.taskLabel === null) next.classList.add('sx-btn--primary');
    const back = button('Previous step', { icon: 'chevronLeft', iconOnly: true, class: 'sx-btn--ghost sx-btn--sq', onClick: () => this.actions?.back() });
    back.disabled = m.index === 0;
    parts.push(h('footer', 'sx-lp-actions', [
      st.taskLabel !== null ? button('Hint', { icon: 'bulb', class: 'sx-btn--ghost', title: 'What should I do?', onClick: () => this.actions?.hint() }) : null,
      st.canShowMe ? button('Show me', { icon: 'eye', class: 'sx-btn--ghost', title: 'Let the crew demonstrate', onClick: () => this.actions?.showMe() }) : null,
      h('span', 'sx-grow'),
      back,
      next,
    ].filter(notNull)));
    parts.push(this.catalogDetails(m.catalog));
    return parts.filter(notNull);
  }

  private quiz(m: Extract<LessonViewModel, { kind: 'quiz' }>): HTMLElement[] {
    const a = m.answered;
    const options = m.question.options.map((o, i) => {
      const b = h('button', {
        class: 'sx-quiz-opt',
        attrs: { type: 'button', 'aria-pressed': String(a?.choice === i) },
        on: { click: () => this.actions?.answer(i) },
      }, [h('span', { class: 'sx-quiz-letter', text: String.fromCharCode(65 + i) }), h('span', { html: textHtml(o) })]);
      if (a) {
        b.disabled = true;
        if (i === a.correctIndex) b.classList.add('is-right');
        else if (i === a.choice) b.classList.add('is-wrong');
      }
      return b;
    });
    const last = m.index === m.count - 1;
    const next = button(last ? 'Finish' : 'Next question', { class: `sx-btn--next${a ? ' sx-btn--primary' : ''}`, icon: 'chevronRight', iconAfter: true, onClick: () => this.actions?.next() });
    next.disabled = a === null;
    return [
      this.header(m.lesson, [h('div', { class: 'sx-kicker is-accent', text: `Quick check · ${m.index + 1} of ${m.count}` })]),
      h('section', 'sx-lp-body', [
        h('p', { class: 'sx-quiz-q', html: textHtml(m.question.q) }),
        h('div', { class: 'sx-quiz-opts', attrs: { role: 'group', 'aria-label': 'Answers' } }, options),
        a ? h('div', { class: `sx-quiz-why ${a.correct ? 'is-right' : 'is-wrong'}`, attrs: { role: 'status' } }, [
          h('strong', { text: a.correct ? 'Right. ' : 'Not quite. ' }),
          h('span', { html: textHtml(a.why) }),
        ]) : null,
      ].filter(notNull)),
      h('footer', 'sx-lp-actions', [h('span', { class: 'sx-quiz-score', text: `Score ${m.score} / ${m.count}` }), h('span', 'sx-grow'), next]),
    ];
  }

  private complete(m: Extract<LessonViewModel, { kind: 'complete' }>): HTMLElement[] {
    const nextTitle = m.nextId ? m.catalog.find((c) => c.id === m.nextId)?.title : null;
    return [
      this.header(m.lesson, []),
      h('section', `sx-done${m.passed ? ' is-passed' : ''}`, [
        h('div', 'sx-done-badge', [icon(m.passed ? 'check' : 'book', 28)]),
        h('h3', { class: 'sx-done-title', text: m.passed ? 'Lesson complete' : 'Lesson finished' }),
        h('p', {
          class: 'sx-done-text',
          text: m.passed
            ? 'Nicely sailed — the tick is yours.'
            : `${m.skipped} task${m.skipped === 1 ? ' was' : 's were'} skipped. Replay the lesson to earn the tick.`,
        }),
        m.quiz ? h('p', { class: 'sx-done-quiz', text: `Quiz: ${m.quiz.correct} of ${m.quiz.total} right` }) : null,
      ].filter(notNull)),
      h('footer', 'sx-lp-actions', [
        button('Replay', { class: 'sx-btn--ghost', onClick: () => this.actions?.restart() }),
        h('span', 'sx-grow'),
        nextTitle ? button(`Next: ${nextTitle}`, { class: 'sx-btn--primary', icon: 'chevronRight', iconAfter: true, onClick: () => this.actions?.next() }) : null,
      ].filter(notNull)),
      this.catalogDetails(m.catalog, true),
    ];
  }

  // ---- pieces ---------------------------------------------------------------------------------------

  private header(l: LessonInfo, extra: HTMLElement[]): HTMLElement {
    return h('header', 'sx-lp-head', [
      h('div', { class: 'sx-kicker', text: `Lesson ${l.number} of ${l.count} · ${l.module}` }),
      h('h2', { class: 'sx-lp-title', text: l.title }),
      button('Leave lesson', { icon: 'close', iconOnly: true, class: 'sx-btn--ghost sx-btn--sm sx-lp-exit', onClick: () => this.actions?.exit() }),
      ...extra,
    ]);
  }

  private dots(index: number, count: number): HTMLElement {
    const dots: HTMLElement[] = [];
    for (let i = 0; i < count; i++) dots.push(h('span', `sx-dot${i < index ? ' is-past' : i === index ? ' is-now' : ''}`));
    return h('div', { class: 'sx-dots', attrs: { role: 'img', 'aria-label': `Step ${index + 1} of ${count}` } }, dots);
  }

  private nextLabel(skip: boolean): string {
    const m = this.model;
    if (m?.kind !== 'step') return 'Next';
    if (skip) return 'Skip';
    if (m.index < m.count - 1) return 'Next';
    return m.hasQuiz ? 'Quiz' : 'Finish';
  }

  private catalogDetails(catalog: CatalogEntry[], open = false): HTMLElement {
    const done = catalog.filter((c) => c.done).length;
    const d = h('details', 'sx-catalog', [
      h('summary', {}, [h('span', { text: 'All lessons' }), h('span', { class: 'sx-catalog-count', text: `${done}/${catalog.length}` })]),
      this.catalogList(catalog),
    ]);
    d.open = open || this.catalogOpen;
    d.addEventListener('toggle', () => { this.catalogOpen = d.open; });
    return d;
  }

  private catalogList(catalog: CatalogEntry[]): HTMLElement {
    const groups = new Map<string, CatalogEntry[]>();
    for (const c of catalog) {
      if (!groups.has(c.module)) groups.set(c.module, []);
      groups.get(c.module)!.push(c);
    }
    let n = 0;
    const blocks: HTMLElement[] = [];
    for (const [module, items] of groups) {
      blocks.push(h('div', { class: 'sx-cat-module', text: module }));
      blocks.push(h('ol', 'sx-cat-list', items.map((c) => {
        n++;
        return h('li', {}, [h('button', {
          class: `sx-cat-item${c.done ? ' is-done' : ''}${c.active ? ' is-active' : ''}`,
          title: c.summary,
          attrs: { type: 'button', 'aria-current': c.active ? 'true' : 'false' },
          on: { click: () => this.actions?.select(c.id) },
        }, [
          h('span', { class: 'sx-cat-tick', attrs: { 'aria-label': c.done ? 'complete' : 'not complete' } }, [c.done ? icon('check', 12) : h('span', { class: 'sx-cat-num', text: String(n) })]),
          h('span', { class: 'sx-cat-title', text: c.title }),
          c.quizBest ? h('span', { class: 'sx-cat-quiz', text: `${c.quizBest.correct}/${c.quizBest.total}` }) : null,
        ].filter(notNull))]);
      })));
    }
    return h('nav', { class: 'sx-cat', attrs: { 'aria-label': 'Lessons' } }, blocks);
  }

  private renderPeek(m: LessonViewModel): void {
    this.peek.hidden = m.kind === 'idle';
    setClass(this.peek, 'is-done', false);
    this.peekFill.style.transform = 'scaleX(0)';
    if (m.kind === 'step') {
      this.peekKicker.set(`${m.lesson.title} · ${m.index + 1}/${m.count}`);
      this.peekTitle.set(m.step.taskLabel ?? m.step.title);
      this.peekMeta.set(m.step.taskLabel ? '' : 'Read, then Next');
    } else if (m.kind === 'quiz') {
      this.peekKicker.set(`${m.lesson.title} · quiz`);
      this.peekTitle.set(`Question ${m.index + 1} of ${m.count}`);
      this.peekMeta.set('');
    } else if (m.kind === 'complete') {
      this.peekKicker.set(m.lesson.title);
      this.peekTitle.set(m.passed ? 'Lesson complete' : 'Lesson finished');
      this.peekMeta.set('');
      this.peekFill.style.transform = 'scaleX(1)';
    }
  }
}
