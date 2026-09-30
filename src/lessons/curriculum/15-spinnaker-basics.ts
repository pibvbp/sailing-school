// Lesson 15 — Spinnaker: hoist and trim (spec §11.2): pole square to the apparent wind, ease to the curl.
// Task: 30 s full and curling at TWA 120–150° — played the way a trimmer does it: ease until the luff curls,
// trim a touch until it stops, again and again. The sim's curl appears over only ~0.03 of sheet travel.
import type { SimSnapshot } from '../../sim/types';
import type { Lesson, LessonCtx } from '../types';
import {
  absAwa, absTwa, autoTrim, downKey, fmt, frameDt, holdTwa, kiteOf, mem, peek, poleError, sailing, step, upKey, view, type Demo,
} from './helpers';

const POLE_TOLERANCE = 10;

/**
 * Playing the sheet on the edge: the luff curl averaged over CURL_WINDOW_S stays small but non-zero. Measured in
 * the sim: the crew's steady trim curls 0.01–0.16; a learner playing the sheet in fine steps (Shift) averages
 * 0.14–0.58; full-speed key presses average 0.63–0.87 — mostly deep curl, one step from a collapse.
 */
const CURL_WINDOW_S = 10;
const CURL_BAND: readonly [number, number] = [0.03, 0.6];

/** Mean curl over the last CURL_WINDOW_S of this step (call once per frame, from the check). */
function meanCurl(c: LessonCtx): number {
  const samples = mem<{ t: number; curl: number }[]>(c, 'curl', () => []);
  samples.push({ t: c.t, curl: kiteOf(c.snap).curl });
  while (samples.length > 1 && c.t - samples[0]!.t > CURL_WINDOW_S) samples.shift();
  const mean = samples.reduce((a, x) => a + x.curl, 0) / samples.length;
  mem(c, 'curlMean', () => ({ v: mean })).v = mean;
  return mean;
}

/** Full, with the sheet played on the edge of the curl. */
const onTheEdge = (c: LessonCtx): boolean => {
  const m = meanCurl(c);
  return kiteOf(c.snap).full && m >= CURL_BAND[0] && m <= CURL_BAND[1];
};

/** Pole angle the rule asks for (0…1 control units): square to the apparent wind. */
export const squarePole = (s: SimSnapshot): number => Math.min(1, Math.max(0, (absAwa(s) - 90) / 90));

/** The crew trims the kite as taught: pole square to the apparent wind, sheet eased until the luff curls. */
export function trimToCurl(): Demo {
  return (c: LessonCtx) => {
    const k = c.app.controls;
    const kite = kiteOf(c.snap);
    const dt = frameDt(c, 'curlDt');
    k.autoTrim.spinnaker = false;
    k.spinPole = squarePole(c.snap);
    if (!kite.up) return;
    if (kite.collapsed > 0.05) k.spinSheet = Math.min(1, k.spinSheet + 0.12 * dt);
    else if (kite.curl < 0.1) k.spinSheet = Math.max(0, k.spinSheet - 0.015 * dt);
    else if (kite.curl > 0.6) k.spinSheet = Math.min(1, k.spinSheet + 0.015 * dt);
  };
}

export const spinnakerBasics: Lesson = {
  id: 'spinnaker-basics',
  module: 'Spinnaker',
  title: 'Spinnaker: hoist and trim',
  summary: 'Hoist the big downwind sail, square the pole to the apparent wind and trim to the curl.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 10, twa: 135, controls: { autoTrim: autoTrim(true, true, true) } })),
  steps: [
    step({
      title: 'The spinnaker',
      body: `<p>The [[spinnaker]] is a big, light, balloon-shaped sail for sailing away from the wind — this one is 32 m², more than the main and jib together. It is symmetric: either edge can be the [[luff]].</p>
<p>Its windward corner is held out on the [[spinnaker-pole|spinnaker pole]], by a line called the [[guy]]; the leeward corner is trimmed with the spinnaker [[sheet]]. While it flies, the crew rolls the jib away so it does not steal the spinnaker's wind.</p>`,
      camera: 'chase',
      overlays: view(),
      controls: ['helm'],
    }),
    step({
      title: 'Hoist',
      body: `<p>Press <kbd>H</kbd> to [[hoist]] the spinnaker. It goes up from behind the jib in a few seconds, fills, and the boat surges forward. The crew handles the pole and sheet for now.</p>`,
      camera: 'chase',
      overlays: view(),
      controls: ['helm', 'spinHoist'],
      autoTrim: { main: true, jib: true, spinnaker: true },
      task: {
        label: 'Hoist the spinnaker and let it fill',
        holdSeconds: 1,
        check: (c) => kiteOf(c.snap).hoist >= 0.98 && kiteOf(c.snap).collapsed < 0.2,
      },
      hint: (c) => {
        const k = kiteOf(c.snap);
        if (!c.app.controls.spinHoist) return 'Press H to hoist.';
        return k.hoist < 0.98 ? `Hoisting… ${fmt(k.hoist * 100, 0)} %` : null;
      },
      showMe: (c) => {
        const k = c.app.controls;
        k.autoTrim.spinnaker = true;
        k.spinHoist = true;
      },
    }),
    step({
      title: 'Square the pole',
      body: `<p>You take over. The rule for the pole: keep it at right angles to the apparent wind — the amber arrow in this top view, or the needle on the wind dial. With the apparent wind 100° off the bow the pole points just 10° out from the forestay; on a dead run it is squared right back, across the boat.</p>
<p>The pole has been pulled too far aft, and the spinnaker has folded up. Move the pole forward with <kbd>J</kbd> (aft is <kbd>L</kbd>) until it is square to the apparent wind, and the sail fills again. Set the pole's height so that the spinnaker's two lower corners are level.</p>`,
      camera: 'top',
      overlays: view('windTriangle'),
      controls: ['helm', 'spinPole', 'spinPoleHeight', 'spinSheet'],
      autoTrim: { spinnaker: false },
      onEnter: (c) => { c.app.controls.spinPole = 0.6; },
      task: {
        label: `Pole within ${POLE_TOLERANCE}° of square to the apparent wind, spinnaker full, for 2 s`,
        holdSeconds: 2,
        check: (c) => kiteOf(c.snap).full && Math.abs(poleError(c.snap)) <= POLE_TOLERANCE,
      },
      hint: (c) => {
        const e = poleError(c.snap);
        if (Math.abs(e) <= POLE_TOLERANCE) {
          return kiteOf(c.snap).full ? null : 'Pole square — now trim the sheet in with I until the spinnaker fills.';
        }
        return e > 0
          ? `The pole is ${fmt(e, 0)}° too far aft — bring it forward with J.`
          : `The pole is ${fmt(-e, 0)}° too far forward — square it back with L.`;
      },
      showMe: (c) => {
        c.app.controls.spinHoist = true;
        return trimToCurl();
      },
    }),
    step({
      title: 'Trim to the curl',
      body: `<p>Now the sheet. The fast trim is the loosest one that still keeps the sail full, so you play it on an edge: ease the sheet (<kbd>K</kbd>) until the luff just starts to fold in — the [[luff-curl|curl]] — then trim (<kbd>I</kbd>) a touch until it stops, and keep going like that. Ease much further and the spinnaker collapses; trim too hard and it stalls, heels the boat and slows it down.</p>
<p>Play it for 30 seconds on a broad reach: a small curl on average (the curl read-out helps) and never a collapse. The curl comes and goes over a tiny movement of the sheet, so hold <kbd>Shift</kbd> for small adjustments.</p>`,
      camera: 'chase',
      overlays: view(),
      controls: ['helm', 'spinPole', 'spinPoleHeight', 'spinSheet'],
      autoTrim: { spinnaker: false },
      onEnter: (c) => {
        const k = c.app.controls;
        k.spinSheet = Math.min(1, k.spinSheet + 0.12);
      },
      task: {
        label: 'Spinnaker full, played on the edge of the curl (a small curl on average), at a true wind angle of 120–150°, for 30 s',
        holdSeconds: 30,
        check: (c) => {
          const a = absTwa(c.snap);
          const edge = onTheEdge(c); // samples the curl every frame
          return a >= 120 && a <= 150 && edge;
        },
      },
      hint: (c) => {
        const s = c.snap;
        const k = kiteOf(s);
        const a = absTwa(s);
        const mean = peek<{ v: number }>(c, 'curlMean')?.v ?? 0;
        if (!k.up) return 'The spinnaker is not up — press H to hoist it.';
        if (a < 120) return `Bear away to a broad reach with ${downKey(s)}.`;
        if (a > 150) return `Head up to a broad reach with ${upKey(s)}.`;
        if (k.collapsed > 0.05) return 'It collapsed: trim the sheet in quickly with I until it fills, then ease slowly again.';
        if (mean < CURL_BAND[0]) return 'No curl lately — ease the sheet slowly with K until the luff just starts to fold, then trim a touch.';
        if (mean > CURL_BAND[1]) return 'The luff is curling deeply most of the time, close to collapsing: trim a touch with I, and use Shift for smaller moves.';
        return null;
      },
      showMe: (c) => {
        c.app.controls.spinHoist = true;
        holdTwa(c, 135);
        return trimToCurl();
      },
    }),
    step({
      title: 'Why the curl',
      body: `<p>A curling luff means the spinnaker meets the wind at the smallest angle it can fly at. That is also where it pulls hardest for the least heel. Trimmed harder, the air stalls behind it: it looks full but drags and heels you. Eased further, it folds and collapses.</p>
<p>So a good trimmer plays the sheet on that edge: ease until the curl appears, trim a touch until it stops, and repeat — every gust, lull and course change moves the edge.</p>`,
      camera: 'chase',
      overlays: view(),
    }),
  ],
  quiz: [
    {
      q: 'Where should the spinnaker pole point?',
      options: ['Straight forward', 'At right angles to the apparent wind', 'At right angles to the true wind'],
      correct: 1,
      why: 'Square to the apparent wind holds the spinnaker’s windward edge out where the wind meets it.',
    },
    {
      q: 'How do you know the spinnaker sheet is trimmed right?',
      options: ['The sail is pulled in tight', 'The luff just starts to curl', 'The pole touches the forestay'],
      correct: 1,
      why: 'Ease until the [[luff-curl|curl]] appears, trim a touch until it stops, and keep playing it on that edge: the loosest trim that stays full.',
    },
  ],
};
