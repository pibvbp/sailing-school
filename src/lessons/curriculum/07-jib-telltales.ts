// Lesson 7 — Jib and telltales (spec §11.2): the groove; ease till the windward telltale lifts, trim till it
// streams; then steer to the telltales upwind.
import type { Lesson } from '../types';
import { absTwa, downKey, holdTwa, jibTelltales, manualHelm, ramp, sailing, speedKn, step, upKey, view } from './helpers';

export const jibTelltalesLesson: Lesson = {
  id: 'jib-telltales',
  module: 'Trim and balance',
  title: 'Jib and telltales',
  summary: 'Read the jib’s telltales, trim it into the groove, then steer by them upwind.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 10, twa: 60, controls: { jibSheet: 0.6 } })),
  steps: [
    step({
      title: 'Telltales',
      body: `<p>[[telltale|Telltales]] are short ribbons on both sides of the jib, just behind its [[luff]]. They show how the air flows over each side. Streaming straight back means smooth flow: the sail is working.</p>
<p>The <strong>windward</strong> ribbon (on the side the wind hits) lifts and twirls when the angle of attack is too small — the sail is about to luff. The <strong>leeward</strong> ribbon droops or spins when the angle is too big — the flow on the lee side is stalling. The small window shows the telltales close up.</p>`,
      camera: 'helm',
      overlays: view('telltaleCam'),
      controls: ['helm'],
      autoTrim: { main: true, jib: false },
    }),
    step({
      title: 'Ease until the windward telltales lift',
      body: `<p>You trim the jib with its [[sheet]]. Ease it with <kbd>↓</kbd>: the sail swings out, the angle of attack falls, and the windward telltales start to lift. Keep easing and the whole luff will flap.</p>`,
      camera: 'helm',
      overlays: view('telltaleCam'),
      controls: ['jibSheet'],
      autoTrim: { main: true, jib: false },
      task: {
        label: 'Ease the jib until a windward telltale lifts',
        holdSeconds: 1,
        check: (c) => {
          const t = jibTelltales(c.snap);
          return t.lifting + t.fluttering >= 1;
        },
      },
      hint: (c) => {
        const t = jibTelltales(c.snap);
        if (t.lifting + t.fluttering >= 1) return null;
        return t.stalled > 0 ? 'The leeward telltales are stalled — the jib is over-trimmed. Ease it well out with ↓.' : 'Keep easing with ↓ — the telltales are still streaming.';
      },
      showMe: (c) => {
        c.app.controls.autoTrim.jib = false;
        return ramp({ jibSheet: 0.2 });
      },
    }),
    step({
      title: 'Trim until they stream',
      body: `<p>The jib is eased too far: its windward telltales lift. Now trim with <kbd>↑</kbd> until they stop lifting and every ribbon streams straight back. The jib is in the [[groove]]: the flow is smooth on both sides. Hold <kbd>Shift</kbd> for fine trim.</p>`,
      camera: 'helm',
      overlays: view('telltaleCam'),
      controls: ['jibSheet'],
      autoTrim: { main: true, jib: false },
      // Start eased, whether or not the step before was done.
      onEnter: (c) => { c.app.controls.jibSheet = Math.min(c.app.controls.jibSheet, 0.2); },
      task: {
        label: 'Trim until all the jib telltales stream, for 3 s',
        holdSeconds: 3,
        check: (c) => {
          const t = jibTelltales(c.snap);
          return t.total > 0 && t.streaming === t.total;
        },
      },
      hint: (c) => {
        const t = jibTelltales(c.snap);
        if (t.total > 0 && t.streaming === t.total) return null;
        if (t.stalled > 0) return 'A leeward telltale is stalling — you have trimmed too far. Ease a touch with ↓.';
        return 'The windward telltales are still lifting — trim in with ↑.';
      },
      showMe: (c) => { c.app.controls.autoTrim.jib = true; },
    }),
    step({
      title: 'Over-trim: the leeward telltales stall',
      body: `<p>See the other edge of the groove: pull the jib in too far with <kbd>↑</kbd>. The angle of attack grows until the air breaks away from the lee side, and the leeward telltales stop streaming. The sail still looks full — only the telltales tell you it is stalled and slow.</p>`,
      camera: 'helm',
      overlays: view('telltaleCam'),
      controls: ['jibSheet'],
      autoTrim: { main: true, jib: false },
      task: {
        label: 'Over-trim the jib until two leeward telltales stall',
        holdSeconds: 1,
        check: (c) => jibTelltales(c.snap).stalled >= 2,
      },
      hint: (c) => (jibTelltales(c.snap).stalled >= 2 ? null : 'Keep trimming in with ↑ until the leeward ribbons droop or spin.'),
      showMe: (c) => {
        c.app.controls.autoTrim.jib = false;
        return ramp({ jibSheet: 1 });
      },
    }),
    step({
      title: 'Steer by the telltales',
      body: `<p>Upwind, sailors set the jib for close-hauled and then <em>steer</em> by its telltales. The sheet is now pulled in for close-hauled, and you have the helm.</p>
<p>Windward telltale lifting: you are [[pinching]] — too close to the wind, so [[bearing-away|bear away]]. Leeward telltale stalling: you are sailing too low — [[heading-up|head up]]. Keep every ribbon streaming for 15 seconds.</p>`,
      camera: 'helm',
      overlays: view('telltaleCam', 'wheel'),
      controls: ['helm'],
      autoTrim: { main: true, jib: false },
      onEnter: (c) => {
        c.app.controls.jibSheet = 0.95;
        manualHelm(c);
      },
      task: {
        label: 'Upwind with every jib telltale streaming, for 15 s',
        holdSeconds: 15,
        check: (c) => {
          const s = c.snap;
          const t = jibTelltales(s);
          return absTwa(s) <= 55 && speedKn(s) >= 3 && t.total > 0 && t.streaming === t.total;
        },
      },
      hint: (c) => {
        const s = c.snap;
        const t = jibTelltales(s);
        if (absTwa(s) > 55) return `You are well below close-hauled. Head up with ${upKey(s)} until the leeward telltales stream.`;
        if (t.lifting + t.fluttering > 0) return `Windward telltale lifting: you are pinching. Bear away a little with ${downKey(s)}.`;
        if (t.stalled > 0) return `Leeward telltale stalling: you are sailing too low. Head up a little with ${upKey(s)}.`;
        if (speedKn(s) < 3) return 'Let the boat build speed before pointing higher.';
        return null;
      },
      showMe: (c) => holdTwa(c, 42),
    }),
  ],
  quiz: [
    {
      q: 'Upwind, the windward jib telltale lifts. What do you do?',
      options: ['Head up', 'Bear away (or trim in)', 'Ease the sheet'],
      correct: 1,
      why: 'A lifting windward telltale means too small an angle of attack: bear away, or trim the jib in.',
    },
    {
      q: 'The leeward telltale stalls. The jib is…',
      options: ['too eased, or you are steering too high', 'over-trimmed, or you are steering too low', 'perfectly trimmed'],
      correct: 1,
      why: 'Too big an angle of attack separates the flow on the lee side — ease, or head up.',
    },
  ],
};
