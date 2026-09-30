// Lesson 17 — Spinnaker gybe and douse (spec §11.2). Task: gybe with the spinnaker up, then douse before
// heading up.
import type { SimSnapshot } from '../../sim/types';
import type { Lesson, LessonCtx } from '../types';
import { absTwa, autoTrim, downKey, fmt, GybeWatch, holdTwa, kiteOf, latch, mem, sailing, speedKn, step, upKey, view } from './helpers';

interface GybeState { watch: GybeWatch; gybed: boolean; crashed: boolean }
const gybeState = (c: LessonCtx): GybeState => mem(c, 'gybe', () => ({ watch: new GybeWatch(), gybed: false, crashed: false }));

const settledUnderKite = (s: SimSnapshot): boolean => {
  const a = absTwa(s);
  return a >= 120 && a <= 165 && kiteOf(s).full;
};

const closeReachUnderJib = (s: SimSnapshot): boolean => {
  const a = absTwa(s);
  return a >= 50 && a <= 80 && s.sails.jib.furl <= 0.1 && speedKn(s) >= 3;
};

export const spinnakerGybeDouse: Lesson = {
  id: 'spinnaker-gybe-douse',
  module: 'Spinnaker',
  title: 'Spinnaker gybe and douse',
  summary: 'Gybe with the spinnaker flying, then take it down before you turn back toward the wind.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 10, twa: 140, spinnaker: true, controls: { autoTrim: autoTrim(true, true, true) } })),
  steps: [
    step({
      title: 'Gybing the spinnaker',
      body: `<p>In a spinnaker gybe the pole has to change sides with the wind. On a boat this size it goes end-for-end: as the stern passes through the wind, the crew unclips the pole from the mast and clips that end to the old sheet — which becomes the new [[guy]] — then frees the other end from the old guy and clips it onto the mast.</p>
<p>Meanwhile the helmsman turns slowly under the spinnaker so it keeps flying, the mainsail gybes across under control, and the trimmers swap sheet and guy. Press <kbd>G</kbd> and the crew does all of it with you.</p>`,
      camera: 'chase',
      overlays: view('track'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true, spinnaker: true },
    }),
    step({
      title: 'Gybe with the spinnaker up',
      body: `<p>Gybe onto the other broad reach with the spinnaker flying, and settle there with it full.</p>`,
      camera: 'chase',
      overlays: view('track', 'wheel'),
      controls: ['helm', 'manoeuvres', 'spinnaker'],
      autoTrim: { main: true, jib: true, spinnaker: true },
      task: {
        label: 'Gybe with the spinnaker up, then sail on with it full for 3 s',
        holdSeconds: 3,
        check: (c) => {
          const s = c.snap;
          const g = gybeState(c);
          const r = g.watch.update(s);
          if (r) {
            g.crashed = r.crashed;
            g.gybed = !r.crashed && kiteOf(s).hoist >= 0.9;
          }
          return g.gybed && settledUnderKite(s);
        },
      },
      hint: (c) => {
        const s = c.snap;
        const g = gybeState(c);
        if (s.maneuver === 'gybe') return null;
        if (g.crashed) return 'The boom crashed across — gybe again, with the main sheeted in first (or press G).';
        if (!kiteOf(s).up) return 'Keep the spinnaker up for this one: press H to hoist it again.';
        if (!g.gybed) return absTwa(s) < 130 ? `Bear away to a broad reach with ${downKey(s)}, then press G.` : 'Press G to gybe.';
        if (kiteOf(s).collapsed > 0.05) return 'Trim the spinnaker sheet in until it fills again.';
        return 'Settle on the new broad reach.';
      },
      showMe: (c) => {
        Object.assign(c.app.controls.autoTrim, { main: true, jib: true, spinnaker: true });
        c.app.controls.command = 'gybe';
      },
    }),
    step({
      title: 'Douse before you head up',
      body: `<p>A spinnaker is for sailing away from the wind. Head up to a close reach with it still up and it will overpower the boat — or collapse and flog. So you take it down first, while still sailing downwind: the [[douse]].</p>
<p>The crew unrolls the jib, so you keep driving, then gathers the spinnaker in behind the mainsail, where its wind shadow makes the sail easy to handle. Only then do you turn toward the wind.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
    }),
    step({
      title: 'Douse, then head up',
      body: `<p>Press <kbd>H</kbd> to douse while you are still on a broad reach. When the spinnaker is down and the jib is out, head up to a close reach (true wind angle 50–80°).</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm', 'spinHoist', 'jib', 'main'],
      autoTrim: { main: true, jib: true },
      task: {
        label: 'Douse on the broad reach, then sail a close reach under main and jib for 3 s',
        holdSeconds: 3,
        check: (c) => {
          const s = c.snap;
          const k = kiteOf(s);
          // Only a douse made while still sailing downwind counts.
          const doused = latch(c, 'doused', k.hoist <= 0.05 && absTwa(s) >= 100);
          if (!doused) return 0;
          return closeReachUnderJib(s) ? 1 : 0.5;
        },
      },
      hint: (c) => {
        const s = c.snap;
        const k = kiteOf(s);
        const doused = mem(c, 'doused', () => ({ on: false })).on;
        if (!doused) {
          if (k.hoist > 0.3 && absTwa(s) < 100) return `The spinnaker is still up — bear away again with ${downKey(s)} and douse it first (H).`;
          if (c.app.controls.spinHoist) return 'Press H to douse while you are still on a broad reach.';
          return `Dousing… ${fmt(k.hoist * 100, 0)} % still up.`;
        }
        if (s.sails.jib.furl > 0.1) return 'Unroll the jib (F) before you head up.';
        if (absTwa(s) > 80) return `Now head up to a close reach with ${upKey(s)}.`;
        if (absTwa(s) < 50) return `A little too high — bear away to a close reach with ${downKey(s)}.`;
        return null;
      },
      showMe: (c) => {
        const k = c.app.controls;
        Object.assign(k.autoTrim, { main: true, jib: true });
        k.spinHoist = false;
        return (cc) => {
          const kite = kiteOf(cc.snap);
          if (kite.hoist > 0.05) {
            if (absTwa(cc.snap) < 110) holdTwa(cc, 130);
            return;
          }
          holdTwa(cc, 65);
        };
      },
    }),
  ],
  quiz: [
    {
      q: 'In an end-for-end spinnaker gybe, the old sheet becomes…',
      options: ['the halyard', 'the new guy', 'the jib sheet'],
      correct: 1,
      why: 'The pole moves to the new windward side, so the line on that corner now works as the [[guy]].',
    },
    {
      q: 'When should you douse the spinnaker if you are going to sail upwind?',
      options: ['After heading up', 'Before heading up, while still sailing downwind', 'It does not matter'],
      correct: 1,
      why: 'Downwind it is blanketed by the main and easy to gather; heading up with it still set overpowers the boat.',
    },
  ],
};
