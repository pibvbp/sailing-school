// Lesson 9 — Main and jib together (spec §11.2): upwash and downwash, backwinding, and why the "venturi" story
// is wrong. Task: cause and fix a backwinded main.
//
// The whole lesson looks straight down on the flow slice — the one picture that shows both sails' sections and the
// air between them. The trim steps add the angle-of-attack colours, which paint the sections blue / green / red.
import type { SimSnapshot } from '../../sim/types';
import type { Lesson, LessonCtx } from '../types';
import { fmt, frameDt, holdTwa, mainLuffBubble, ramp, sailing, step, together, trimOf, view } from './helpers';

/** The top view from this height (m) fills the picture with the rig rather than the sea round it (where the app can zoom). */
const CLOSE_UP_M = 38;
const closeUp = (c: LessonCtx): void => c.app.setCameraDistance?.(CLOSE_UP_M);

/** Backwinded, as the sim's detector defines it: the main's luff lifting while its leech still draws. */
const backwinded = (s: SimSnapshot): boolean => {
  const b = mainLuffBubble(s);
  return s.sails.jib.set && b.bubble >= 0.45 && b.leechFull;
};

export const mainAndJib: Lesson = {
  id: 'main-and-jib',
  module: 'Trim and balance',
  title: 'Main and jib together',
  summary: 'How the two sails help each other, what backwinding is — and why the slot is not a venturi.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 12, twa: 45 })),
  steps: [
    step({
      title: 'Two sails, one flow',
      body: `<p>The two sails sit close together and change each other's airflow. A lifting sail bends the air before it arrives — [[upwash]] — and turns it as it leaves — [[downwash]].</p>
<p>You are looking straight down on a slice of the air through the rig. The two bold white curves are the jib (ahead) and the mainsail where the slice cuts them; the fine lines are streamlines. Watch them curve toward the main's lee side well ahead of the mast: that is the upwash.</p>
<p>The jib sits in the main's upwash, so it meets the wind from further aft than the boat's own apparent wind — it is lifted. The boat can therefore point higher before the jib's luff starts to lift.</p>`,
      camera: 'top',
      overlays: view('flowSlice'),
      onEnter: closeUp,
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    step({
      title: 'The main pays for it',
      body: `<p>The main sits in the jib's downwash: the air leaving the jib's [[leech]] reaches the main from further forward. So the main must be sheeted closer to the centreline than the jib, and the front of the main is the first part of it to luff.</p>
<p>What the [[slot]] does <em>not</em> do is act as a nozzle that speeds the air up and sucks the main along. That "venturi" story is wrong: measurements show the air near the main's lee side just behind the mast actually slows down when a jib is set. In the slice the strongest suction (blue) sits on the lee side of the jib's luff, not in the slot. The sails help each other through the way each one bends the other's flow.</p>`,
      camera: 'top',
      overlays: view('flowSlice'),
      onEnter: closeUp,
      controls: ['helm'],
    }),
    step({
      title: 'Cause backwinding',
      body: `<p>Over-trim the jib (<kbd>↑</kbd>) and ease the main a little (<kbd>S</kbd>). The jib's downwash grows until the air hits the back of the main's luff: the front of the main bulges and flaps while its leech still draws. That is [[backwinding]].</p>
<p>The two sections now show how each sail is working, in the groove meter's colours: green in the groove, blue where it luffs, red where it stalls. Watch the mainsail's section turn blue.</p>`,
      camera: 'top',
      overlays: view('flowSlice', 'aoa'),
      onEnter: closeUp,
      controls: ['mainSheet', 'jibSheet'],
      autoTrim: { main: false, jib: false },
      task: {
        label: 'Make the jib backwind the main (the main’s luff lifting while its leech draws)',
        holdSeconds: 1,
        check: (c) => backwinded(c.snap),
      },
      hint: (c) => {
        const s = c.snap;
        const b = mainLuffBubble(s);
        if (backwinded(s)) return null;
        if (c.app.controls.jibSheet < 0.95) return 'Trim the jib all the way in with ↑.';
        if (!b.leechFull) return 'The whole main is flapping now — trim it in a little with W so its leech draws again.';
        return `Now ease the main slowly with S until its front starts to lift (luff bubble ${fmt(b.bubble * 100, 0)} %).`;
      },
      showMe: (c) => {
        const k = c.app.controls;
        k.autoTrim.main = false;
        k.autoTrim.jib = false;
        holdTwa(c, 45);
        // Jib hard in; then ease the main slowly until its luff lifts (trim back if the whole sail flogs).
        return together(ramp({ jibSheet: 1 }), (cc) => {
          const dt = frameDt(cc, 'demoDt');
          if (backwinded(cc.snap)) return;
          const kk = cc.app.controls;
          const rate = mainLuffBubble(cc.snap).leechFull ? -0.03 : 0.03;
          kk.mainSheet = Math.min(1, Math.max(0.3, kk.mainSheet + rate * dt));
        });
      },
    }),
    step({
      title: 'Fix it',
      body: `<p>The jib is pulled in hard and the main is eased, so the main's luff is lifting. Fix it the way a crew does: ease the jib a touch (<kbd>↓</kbd>) until its telltales stream, then trim the main (<kbd>W</kbd>) until its luff is full and the sail is in the groove — both sections green. Trim the jib first, then set the main to match it.</p>`,
      camera: 'top',
      overlays: view('flowSlice', 'aoa'),
      controls: ['mainSheet', 'jibSheet', 'autoTrim'],
      // Start from the broken trim, whether or not the step before was done.
      onEnter: (c) => {
        closeUp(c);
        const k = c.app.controls;
        Object.assign(k.autoTrim, { main: false, jib: false });
        k.jibSheet = 1;
        k.mainSheet = Math.min(k.mainSheet, 0.6);
      },
      task: {
        label: 'Main luff full and both sails in the groove, for 4 s',
        holdSeconds: 4,
        check: (c) => {
          const s = c.snap;
          const m = trimOf(s.sails.main), j = trimOf(s.sails.jib);
          return mainLuffBubble(s).bubble <= 0.1 && m.luffing <= 0.1 && m.stall <= 0.35 && j.luffing <= 0.35 && j.stall <= 0.35;
        },
      },
      hint: (c) => {
        const s = c.snap;
        const m = trimOf(s.sails.main), j = trimOf(s.sails.jib);
        if (j.stall > 0.35) return 'The jib is stalled — ease it a touch with ↓.';
        if (mainLuffBubble(s).bubble > 0.1 || m.luffing > 0.1) return 'The main’s luff is still lifting — trim it in with W.';
        if (m.stall > 0.35) return 'Now the main is stalled — ease it a touch with S.';
        return null;
      },
      showMe: (c) => { Object.assign(c.app.controls.autoTrim, { main: true, jib: true }); },
    }),
  ],
  quiz: [
    {
      q: 'Why can the jib point higher than it could on its own?',
      options: ['It sits in the main’s upwash', 'The slot speeds the air up', 'The jib is smaller'],
      correct: 0,
      why: 'The main’s [[upwash]] turns the flow at the jib so it meets the wind from further aft.',
    },
    {
      q: 'The front of the main bulges and flaps while the jib is pulled in tight. What is happening?',
      options: ['The main is stalled', 'The jib’s downwash is backwinding the main', 'The boat is in irons'],
      correct: 1,
      why: 'The jib turns the air so it hits the back of the main’s [[luff]] — ease the jib or trim the main.',
    },
    {
      q: 'Does the slot work like a venturi nozzle that speeds the air up to suck the main along?',
      options: ['Yes', 'No'],
      correct: 1,
      why: 'Near the main’s luff the air in the slot actually slows down; the sails help each other through upwash and downwash.',
    },
  ],
};
