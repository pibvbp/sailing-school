// Lesson 18 — Sailing smart (spec §11.2): VMG and polars, laylines, gusts and lulls, lifts and headers.
// Task: reach the windward mark in shifty, gusty wind within the target time.
//
// AppApi has no way to place a mark, so the "mark" is a windward finish line through RACE_MARK, square to the
// mean wind, RACE_DISTANCE metres upwind of the race start (the scenario origin). The App can draw a windward
// mark at RACE_MARK for a visible target; a race that runs out of time restarts from the same start.
import type { SimSnapshot } from '../../sim/types';
import type { Lesson, LessonCtx } from '../types';
import {
  absTwa, angleDiff, autoTrim, bestBeat, downKey, fmt, fromDeg, holdTwa, mem, peek, POLARS, sailing, speedKn, step, tackOf,
  toDeg, twsKn, upKey, view, vmgKn,
} from './helpers';
import { optimalVmg } from '../../sim/polarTable';

const TWS = 12;
/** Mean wind direction for the whole lesson (deg). */
export const TWD = 200;
/** Distance from the race start to the windward finish line (m) and the time allowed (s). */
export const RACE_DISTANCE = 150;
export const RACE_TIME = 100;
/** A shift this big against your tack is a header worth tacking on (deg). */
const HEADER = 5;

/** The wind's shift from its mean direction (deg, + = veered / clockwise). */
const shiftDeg = (s: SimSnapshot): number => angleDiff(toDeg(s.wind.twd), TWD);
/** Positive when the current shift lifts you, negative when it heads you. */
const liftDeg = (s: SimSnapshot): number => shiftDeg(s) * tackOf(s);

/** The windward mark (sim world east, north; m): the race starts at the origin. */
export const RACE_MARK = { e: RACE_DISTANCE * Math.sin(fromDeg(TWD)), n: RACE_DISTANCE * Math.cos(fromDeg(TWD)) } as const;

const RACE_SCENARIO = sailing({
  twsKn: TWS, twdDeg: TWD, twa: 42, gustiness: 0.6, shiftDeg: 10, shiftPeriod: 90, seed: 21,
  controls: { autoTrim: autoTrim(true, true, false) },
});

interface Race { t0: number; attempts: number }
const race = (c: LessonCtx): Race => mem(c, 'race', () => ({ t0: c.t, attempts: 1 }));

/** Metres made good toward the mean wind from the start line (the origin). */
function madeGood(s: SimSnapshot): number {
  const up = fromDeg(TWD);
  return s.boat.pos.x * Math.sin(up) + s.boat.pos.y * Math.cos(up);
}

export const sailingSmart: Lesson = {
  id: 'sailing-smart',
  module: 'Tactics',
  title: 'Sailing smart',
  summary: 'VMG and polars, gusts and lulls, lifts and headers — then race to a windward mark.',
  setup: (c) => c.app.scenario(sailing({ twsKn: TWS, twdDeg: TWD, twa: 55 })),
  steps: [
    step({
      title: 'Velocity made good',
      body: () => `<p>You cannot sail straight to a mark upwind, so boat speed alone is not the point. What counts is how fast you get <em>upwind</em>: your [[vmg|VMG]], velocity made good, shown on the instrument strip.</p>
<p>Point too high ([[pinching]]) and the boat slows down; sail too low and you go fast, but more across the wind than up it. In between is the angle with the best VMG. The boat's [[polar]] — its speed at every wind angle, measured in this simulator — says that in ${TWS} knots it is about ${fmt(bestBeat(TWS).twa, 0)}° off the true wind, at ${fmt(bestBeat(TWS).speed)} kn.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    step({
      title: 'Find the best VMG',
      body: () => `<p>You are sailing a little low. Head up slowly (<kbd>→</kbd> on this tack) and watch the VMG. It rises, peaks, then falls again as the boat slows down. Find the top: at least 93 % of the polar's best, about ${fmt(bestBeat(TWS).vmg)} kn, for 8 seconds.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
      task: {
        label: 'Sail upwind at 93 % of the best VMG or better, for 8 s',
        holdSeconds: 8,
        check: (c) => absTwa(c.snap) <= 55 && vmgKn(c.snap) >= 0.93 * bestBeat(twsKn(c.snap)).vmg,
      },
      hint: (c) => {
        const s = c.snap;
        const best = bestBeat(twsKn(s));
        const now = `VMG ${fmt(vmgKn(s))} kn of a possible ${fmt(best.vmg)} kn.`;
        if (absTwa(s) > best.twa + 3) return `${now} Head up a little with ${upKey(s)} (best angle about ${fmt(best.twa, 0)}°).`;
        if (absTwa(s) < best.twa - 3) return `${now} You are pinching — bear away a touch with ${downKey(s)}.`;
        return `${now} Right angle; give the boat time to reach full speed.`;
      },
      showMe: (c) => holdTwa(c, bestBeat(twsKn(c.snap)).twa),
    }),
    step({
      title: 'Downwind too',
      body: () => {
        const here = optimalVmg(POLARS, TWS, false).twa;
        const light = optimalVmg(POLARS, 6, false).twa;
        return here < 165
          ? `<p>The same idea works downwind. In ${TWS} knots the polar says the best downwind VMG comes at about ${fmt(here, 0)}° off the wind — not dead downwind. The broad reach is so much faster that gybing from one broad reach to the other beats running straight at the mark.</p>`
          : `<p>The same idea works downwind. In ${TWS} knots the polar puts the best downwind VMG close to dead downwind, at about ${fmt(here, 0)}°. In light air it moves up — about ${fmt(light, 0)}° in 6 knots — and gybing from one broad reach to the other beats running straight at the mark.</p>`;
      },
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
    }),
    step({
      title: 'Gusts, lulls and shifts',
      body: `<p>Real wind is never steady. [[gust|Gusts]] come as darker patches on the water; in a gust the apparent wind moves aft and strengthens, so you can point a little higher — or [[depower]] if you are heeling too much. In a [[lull]], bear away a little to keep your speed up.</p>
<p>The wind also swings from side to side. A [[lift-shift|lift]] lets you point closer to the mark; a [[header]] forces you away from it — and whatever heads you on one tack lifts you on the other. So tack on the headers. Keep away from the [[layline|laylines]] until you are close to the mark: out there you can no longer use the shifts.</p>`,
      camera: 'top',
      overlays: view('wheel', 'laylines'),
      controls: ['helm'],
    }),
    step({
      title: 'Race to the windward mark',
      body: `<p>The wind is now gusty and shifting. The windward mark is ${RACE_DISTANCE} m straight upwind of your start — cross that line within ${RACE_TIME} seconds. Sail at your best VMG angle, ride the gusts, and tack (<kbd>T</kbd>) when a header knocks you off course. The clock starts now.</p>`,
      camera: 'chase',
      overlays: view('wheel', 'laylines', 'track'),
      controls: ['helm', 'manoeuvres', 'main', 'jib', 'crew'],
      onEnter: (c) => c.app.scenario(RACE_SCENARIO),
      task: {
        label: `Gain ${RACE_DISTANCE} m to windward within ${RACE_TIME} s`,
        check: (c) => {
          const r = race(c);
          const d = madeGood(c.snap);
          if (d >= RACE_DISTANCE) return 1;
          if (c.t - r.t0 > RACE_TIME) {
            // Out of time: back to the start line for another go.
            c.app.scenario(RACE_SCENARIO);
            r.t0 = c.t;
            r.attempts++;
            return 0;
          }
          return Math.max(0, d / RACE_DISTANCE);
        },
      },
      hint: (c) => {
        const s = c.snap;
        const r = peek<Race>(c, 'race');
        if (!r) return null;
        const left = Math.max(0, RACE_TIME - (c.t - r.t0));
        const togo = Math.max(0, RACE_DISTANCE - madeGood(s));
        const status = `${fmt(togo, 0)} m to go, ${fmt(left, 0)} s left${r.attempts > 1 ? ` (attempt ${r.attempts})` : ''}.`;
        if (s.maneuver === 'tack') return status;
        const best = bestBeat(twsKn(s));
        if (absTwa(s) > 60) return `${status} Head up to close-hauled with ${upKey(s)}.`;
        if (liftDeg(s) < -HEADER) return `${status} You are headed by ${fmt(-liftDeg(s), 0)}° — tack now (T): the other tack is lifted.`;
        if (absTwa(s) > best.twa + 5) return `${status} You are sailing low; head up toward ${fmt(best.twa, 0)}°.`;
        if (speedKn(s) < 0.8 * best.speed) return `${status} Build speed: bear away a touch with ${downKey(s)}.`;
        return status;
      },
      showMe: (c) => {
        Object.assign(c.app.controls.autoTrim, { main: true, jib: true });
        let sinceTack = 99;
        let last = c.t;
        return (cc) => {
          const s = cc.snap;
          sinceTack += Math.max(0, cc.t - last);
          last = cc.t;
          if (s.maneuver !== null) return;
          holdTwa(cc, bestBeat(twsKn(s)).twa);
          if (liftDeg(s) < -HEADER && sinceTack > 15 && speedKn(s) > 3) {
            cc.app.controls.command = 'tack';
            sinceTack = 0;
          }
        };
      },
    }),
  ],
  quiz: [
    {
      q: 'Upwind, what does VMG tell you?',
      options: ['Your speed through the water', 'How fast you are getting toward the wind', 'The wind speed'],
      correct: 1,
      why: 'Velocity made good is the part of your speed that takes you upwind (or downwind).',
    },
    {
      q: 'On starboard tack you are headed by 10°. What about port tack?',
      options: ['It is headed too', 'It is lifted by 10° — time to tack', 'Nothing changes'],
      correct: 1,
      why: 'A shift that heads one tack lifts the other.',
    },
    {
      q: 'A gust hits you while sailing upwind. The apparent wind…',
      options: ['moves aft and strengthens, so you can point a little higher', 'moves forward, so you must bear away', 'does not change'],
      correct: 0,
      why: 'More true wind for the same boat speed swings the apparent wind aft — a small lift, and more heel.',
    },
  ],
};
