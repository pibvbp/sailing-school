// Lesson 3 — Points of sail (spec §11.2): the wheel overlay; close-hauled, beam reach, broad reach and run
// with the crew trimming — and a comparison of the speeds the learner actually reached.
import type { Lesson, LessonCtx, Step } from '../types';
import { absTwa, downKey, fmt, holdTwa, mem, sailing, speedKn, step, TimeWindow, upKey, view } from './helpers';

type Point = 'closeHauled' | 'beam' | 'broad' | 'run';
type Speeds = Partial<Record<Point, number>>;

/** Hold each point this long; its speed is the mean over the last SETTLED_S, once the boat has settled. */
const HOLD_S = 12;
const SETTLED_S = 6;

/** Settled speeds (kn) of this run of the lesson, kept in ctx.data and shown in the last step. */
const speeds = (data: Readonly<Record<string, unknown>>): Speeds => (data['speeds'] as Speeds | undefined) ?? {};

interface PointDef { key: Point; name: string; action: string; lo: number; hi: number; show: number; body: string }

function pointStep(p: PointDef): Step {
  const inRange = (c: LessonCtx) => {
    const a = absTwa(c.snap);
    return a >= p.lo && a <= p.hi;
  };
  return step({
    title: p.name,
    body: p.body,
    camera: 'top',
    overlays: view('wheel'),
    controls: ['helm'],
    autoTrim: { main: true, jib: true },
    task: {
      label: `${p.action} (true wind angle ${p.lo}–${p.hi}°) for ${HOLD_S} s`,
      holdSeconds: HOLD_S,
      check: (c) => {
        const settled = mem(c, 'speed', () => new TimeWindow(SETTLED_S));
        if (!inRange(c) || speedKn(c.snap) < 2) { settled.clear(); return false; }
        settled.add(c.t, speedKn(c.snap));
        c.data['speeds'] = { ...speeds(c.data), [p.key]: settled.mean() };
        return true;
      },
    },
    hint: (c) => {
      const s = c.snap;
      const a = absTwa(s);
      if (a > p.hi) return `True wind angle ${fmt(a, 0)}°: turn toward the wind with ${upKey(s)} until it reads ${p.lo}–${p.hi}°.`;
      if (a < p.lo) return `True wind angle ${fmt(a, 0)}°: turn away from the wind with ${downKey(s)} until it reads ${p.lo}–${p.hi}°.`;
      if (speedKn(s) < 2) return 'Right angle — give the boat a moment to pick up speed.';
      return null;
    },
    showMe: (c) => holdTwa(c, p.show),
  });
}

export const pointsOfSail: Lesson = {
  id: 'points-of-sail',
  module: 'First steps',
  title: 'Points of sail',
  summary: 'Close-hauled, reaching and running: the names for your angle to the wind, and how fast each one is.',
  // A close reach: none of the four points the learner is asked to sail.
  setup: (c) => c.app.scenario(sailing({ twsKn: 10, twa: 65 })),
  steps: [
    step({
      title: 'Your angle to the wind',
      body: `<p>Your angle to the true wind has a name. From the edge of the no-go zone outward: [[close-hauled]] (about 40–50° off the wind), [[close-reach|close reach]], [[beam-reach|beam reach]] (90°, wind straight across the boat), [[broad-reach|broad reach]], and the [[run]], with the wind from behind. Together they are the [[points-of-sail]]; the wheel on the water marks each sector.</p>
<p>For this lesson the autopilot holds your angle to the wind (<strong>Hold TWA</strong> in the trim panel) — right now a close reach, 65° off it. <kbd>←</kbd> and <kbd>→</kbd> still turn the bow; the autopilot then keeps the new angle. The crew trims the sails, so you can watch the speed on the instrument strip.</p>`,
      camera: 'top',
      overlays: view('wheel'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    pointStep({
      key: 'closeHauled', name: 'Close-hauled', action: 'Sail close-hauled', lo: 38, hi: 52, show: 45,
      body: `<p>Turn toward the wind until you are [[close-hauled]]: as close to the wind as the sails still drive, 40–50° off it. On this tack the wind is on the starboard side, so turn with <kbd>→</kbd>.</p>
<p>The crew pulls both sails in tight, and the boat leans over — it [[heel|heels]].</p>`,
    }),
    pointStep({
      key: 'beam', name: 'Beam reach', action: 'Sail a beam reach', lo: 80, hi: 100, show: 90,
      body: `<p>Now turn away from the wind to a [[beam-reach|beam reach]]: the wind blowing straight across the boat, 90° to it. The crew eases the sails out as you turn.</p>`,
    }),
    pointStep({
      key: 'broad', name: 'Broad reach', action: 'Sail a broad reach', lo: 120, hi: 150, show: 135,
      body: `<p>Keep turning away to a [[broad-reach|broad reach]], with the wind coming over the back corner of the boat. The sails go further out; the boom is now well over the side.</p>`,
    }),
    pointStep({
      key: 'run', name: 'Run', action: 'Run with the wind from behind', lo: 160, hi: 180, show: 170,
      body: `<p>Finally bear away until the wind comes from behind — a [[run]]. The mainsail is right out, and the jib hangs limp in its wind shadow.</p>
<p>Stop short of dead downwind: if the wind gets behind the mainsail on the side where the boom is, the boom swings across the boat — an accidental [[gybe]] (lesson 13).</p>`,
    }),
    step({
      title: 'Compare the speeds',
      body: (data) => `<p>Your settled speeds in 10 knots of wind: close-hauled <strong>${fmt(speeds(data).closeHauled ?? NaN)} kn</strong>, beam reach <strong>${fmt(speeds(data).beam ?? NaN)} kn</strong>, broad reach <strong>${fmt(speeds(data).broad ?? NaN)} kn</strong>, run <strong>${fmt(speeds(data).run ?? NaN)} kn</strong>.</p>
<p>The reach is usually fastest: the sails' force points mostly forward and the wind you feel is still strong. Close-hauled, much of that force pushes the boat sideways instead. On a run you sail away from your own wind, so it feels light, and the sails can only be pushed along, not pull like a wing.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
    }),
  ],
  quiz: [
    {
      q: 'Which point of sail is usually the fastest for a boat like this?',
      options: ['Close-hauled', 'Beam reach', 'Dead run'],
      correct: 1,
      why: 'On a reach the sails’ force points mostly forward while the apparent wind is still strong.',
    },
    {
      q: 'Close-hauled, the sails are…',
      options: ['pulled in tight', 'let right out', 'rolled away'],
      correct: 0,
      why: 'Sailing close to the wind, the sails are sheeted in near the centreline.',
    },
    {
      q: 'On a run the wind comes from…',
      options: ['ahead', 'the side', 'behind'],
      correct: 2,
      why: 'Running means sailing with the wind from astern — the sails are let right out.',
    },
  ],
};
