// Lesson 4 — Apparent wind (spec §11.2): the wind triangle; the apparent wind moves forward as you speed
// up, is stronger upwind and weaker downwind.
import type { Lesson } from '../types';
import { absAwa, absTwa, autoTrim, awsKn, downKey, fmt, holdTwa, sailing, speedKn, step, trimOf, twsKn, upKey, view } from './helpers';

export const apparentWind: Lesson = {
  id: 'apparent-wind',
  module: 'How sails work',
  title: 'Apparent wind',
  summary: 'The wind you feel is the true wind plus the wind of your own motion — and it changes with every speed and course.',
  setup: (c) => c.app.scenario(sailing({
    twsKn: 10, twa: 90, speedKn: 0,
    controls: { mainSheet: 0, jibSheet: 0, autoTrim: autoTrim(false, false, false) },
  })),
  steps: [
    step({
      title: 'Standing still',
      body: `<p>The boat is lying almost still with her sails let right out. The blue arrow is the [[true-wind|true wind]]: 10 knots from the beam. The amber arrow is the [[apparent-wind|apparent wind]] — the wind you feel on board. Standing still, the two would be the same; drifting slowly, they very nearly are.</p>
<p>Once you move you also feel the wind of your own motion, like the breeze on your face when you cycle on a calm day. This [[boat-wind|boat wind]] (grey arrow) blows from straight ahead and is as strong as your speed. The apparent wind is the true wind and the boat wind added together, head to tail — the wind triangle.</p>`,
      camera: 'top',
      overlays: view('windTriangle'),
      controls: [],
    }),
    step({
      title: 'Speed up',
      body: `<p>Trim the sails and go. Switch the crew's <strong>Auto</strong> trim on for the main and the jib in the trim panel, or pull the sheets in yourself: <kbd>W</kbd> for the mainsheet, <kbd>↑</kbd> for the jib sheet. The autopilot holds the beam reach.</p>
<p>As the boat speeds up, the grey arrow grows and the amber arrow swings forward and gets stronger — although the true wind has not changed at all.</p>`,
      camera: 'top',
      overlays: view('windTriangle'),
      controls: ['main', 'jib'],
      task: {
        label: 'Reach 4.5 kn on the beam reach, with the apparent wind at least 20° ahead of the true wind',
        holdSeconds: 2,
        check: (c) => {
          const s = c.snap;
          const a = absTwa(s);
          return a >= 75 && a <= 105 && speedKn(s) >= 4.5 && a - absAwa(s) >= 20;
        },
      },
      hint: (c) => {
        const s = c.snap;
        const k = c.app.controls;
        if (speedKn(s) >= 4.5) return null;
        const mainOut = !k.autoTrim.main && (k.mainSheet < 0.25 || trimOf(s.sails.main).luffing > 0.35);
        const jibOut = !k.autoTrim.jib && k.jibSheet < 0.05;
        if (mainOut || jibOut) return 'The sails are still let out — pull them in with W and ↑, or switch the crew’s Auto trim on.';
        return `${fmt(speedKn(s))} kn and accelerating. Watch the apparent wind angle (AWA) drop below the true one (TWA).`;
      },
      showMe: (c) => {
        Object.assign(c.app.controls.autoTrim, { main: true, jib: true });
        holdTwa(c, 90);
      },
    }),
    step({
      title: 'Stronger upwind',
      body: `<p>Now turn toward the wind until you are close-hauled (<kbd>→</kbd> on this tack). Your boat wind now blows against the true wind at a steep angle, so the two add up: the apparent wind gets <strong>stronger</strong> and comes from further ahead.</p>
<p>Compare the apparent wind speed (AWS) with the true wind speed (TWS) on the instruments — sailing upwind always feels windier than it really is.</p>`,
      camera: 'top',
      overlays: view('windTriangle'),
      controls: ['helm', 'main', 'jib'],
      task: {
        label: 'Close-hauled, with the apparent wind at least 30 % stronger than the true wind, for 3 s',
        holdSeconds: 3,
        check: (c) => {
          const s = c.snap;
          return absTwa(s) <= 55 && speedKn(s) >= 3 && awsKn(s) >= 1.3 * twsKn(s);
        },
      },
      hint: (c) => {
        const s = c.snap;
        if (absTwa(s) > 55) return `Turn toward the wind with ${upKey(s)} until the true wind angle is about 45°.`;
        if (speedKn(s) < 3) return 'Let the boat build speed — the boat wind is what makes the apparent wind stronger.';
        return `AWS ${fmt(awsKn(s))} kn against TWS ${fmt(twsKn(s))} kn.`;
      },
      showMe: (c) => {
        Object.assign(c.app.controls.autoTrim, { main: true, jib: true });
        holdTwa(c, 45);
      },
    }),
    step({
      title: 'Weaker downwind',
      body: `<p>Now bear away until the wind comes from behind (<kbd>←</kbd> on this tack). You are running away from the wind, so your boat wind cancels part of it: the apparent wind drops. On deck it feels warm and calm, although the true wind is still blowing 10 knots.</p>
<p>That is why a breeze that feels gentle on a run can feel like a gale when you turn back upwind.</p>`,
      camera: 'top',
      overlays: view('windTriangle'),
      controls: ['helm', 'main', 'jib'],
      task: {
        label: 'Broad reach or run, with the apparent wind at most 75 % of the true wind, for 3 s',
        holdSeconds: 3,
        check: (c) => {
          const s = c.snap;
          return absTwa(s) >= 140 && awsKn(s) <= 0.75 * twsKn(s);
        },
      },
      hint: (c) => {
        const s = c.snap;
        if (absTwa(s) < 140) return `Turn away from the wind with ${downKey(s)} until the true wind angle is about 150°.`;
        return `AWS ${fmt(awsKn(s))} kn against TWS ${fmt(twsKn(s))} kn — wait for the boat to settle at speed.`;
      },
      showMe: (c) => {
        Object.assign(c.app.controls.autoTrim, { main: true, jib: true });
        holdTwa(c, 150);
      },
    }),
    step({
      title: 'Why it matters',
      body: `<p>The sails, the [[telltale|telltales]] and the windex all feel the apparent wind, never the true wind, so every trim you make is set to it. Change your speed or your course and the apparent wind changes with it.</p>
<p>The faster a boat sails, the further forward its apparent wind swings — that is why fast boats seem to sail with the wind in their faces even when reaching.</p>`,
      camera: 'chase',
      overlays: view('windTriangle'),
    }),
  ],
  quiz: [
    {
      q: 'You speed up on a beam reach. What does the apparent wind do?',
      options: ['Moves forward and gets stronger', 'Moves aft and gets weaker', 'Nothing — only the true wind matters'],
      correct: 0,
      why: 'Your own motion adds a headwind; added to the true wind it swings the apparent wind forward and strengthens it.',
    },
    {
      q: 'Close-hauled, the apparent wind is…',
      options: ['weaker than the true wind', 'stronger than the true wind', 'the same as the true wind'],
      correct: 1,
      why: 'Sailing toward the wind, the boat wind and the true wind add up.',
    },
    {
      q: 'Which wind do the sails and telltales respond to?',
      options: ['The true wind', 'The apparent wind'],
      correct: 1,
      why: 'Everything on a moving boat feels the [[apparent-wind|apparent wind]].',
    },
  ],
};
