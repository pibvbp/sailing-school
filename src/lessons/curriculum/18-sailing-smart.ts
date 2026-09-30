// Lesson 18 — Sailing smart (spec §11.2): VMG and polars, laylines, gusts and lulls, lifts and headers.
// Task: reach the windward mark in shifty, gusty wind within the target time.
//
// The race: a windward mark MARK_DISTANCE m dead upwind of the start, in gusty wind that swings ±10° over
// about 90 s. The autopilot may hold the angle to the wind; the learner's job is to choose when to tack — on the
// headers, and on the layline. One long tack sails past a mark dead upwind, so doing nothing never finishes.
// Measured on this course (six wind seeds, 2026-09-30 physics): tacking on 5° headers and on the layline
// finishes in 238–255 s (faster in 5 of the 6), one tack on the layline only in 243–250 s, tacking on headers
// with no eye on the laylines often never gets there; the target time is 313 s.
import { fromDeg, fromKn, toDeg } from '../../shared/units';
import type { SimSnapshot } from '../../sim/types';
import type { Lesson, LessonCtx, MarkSpec } from '../types';
import {
  absTwa, angleDiff, autoTrim, bestBeat, bestRun, downKey, fmt, holdHeading, holdTwa, mem, peek, sailing, speedKn, step,
  tackOf, twsKn, upKey, view, vmgKn, type Demo,
} from './helpers';

const TWS = 12;
/** Mean wind direction for the whole lesson (deg). */
export const TWD = 200;
/** The windward mark: this far dead upwind of the start (m); "reached" within REACHED_M. */
export const MARK_DISTANCE = 500;
export const REACHED_M = 25;
/**
 * Time allowed (s): 1.35 × the time it takes at the polar's best upwind VMG — room for a few tacks and the odd
 * wrong call, not for ignoring the shifts or sailing past the laylines.
 */
export const TARGET_TIME = Math.ceil((1.35 * MARK_DISTANCE) / fromKn(bestBeat(TWS).vmg));
/** A shift this big against your tack is a header worth tacking on (deg). */
const HEADER = 5;
/** Tack a little past the layline: leeway and the tack itself cost a few degrees. */
const LAYLINE_MARGIN = 4;

const MARK: MarkSpec = {
  id: 'windward', kind: 'windward',
  e: MARK_DISTANCE * Math.sin(fromDeg(TWD)), n: MARK_DISTANCE * Math.cos(fromDeg(TWD)),
};

/** The start: the scenario origin, close-hauled on starboard tack, autopilot on, crew trimming. */
const RACE_START = sailing({
  twsKn: TWS, twdDeg: TWD, twa: Math.round(bestBeat(TWS).twa), gustiness: 0.5, shiftDeg: 10, shiftPeriod: 90, seed: 31,
  controls: { autoTrim: autoTrim(true, true, false) },
});

// ---- race geometry ---------------------------------------------------------------------------------------

/** The wind's shift from its mean direction (deg, + = veered / clockwise). */
const shiftDeg = (s: SimSnapshot): number => angleDiff(toDeg(s.wind.twd), TWD);
/** Positive when the current shift lifts you, negative when it heads you. */
const liftDeg = (s: SimSnapshot): number => shiftDeg(s) * tackOf(s);

interface ToMark { dist: number; bearing: number; /** The mark's direction relative to straight upwind now (deg, + = right). */ rel: number }

function toMark(s: SimSnapshot): ToMark {
  const de = MARK.e - s.boat.pos.x, dn = MARK.n - s.boat.pos.y;
  const bearing = ((toDeg(Math.atan2(de, dn)) % 360) + 360) % 360;
  return { dist: Math.hypot(de, dn), bearing, rel: angleDiff(bearing, toDeg(s.wind.twd)) };
}

/** Can the boat fetch the mark on its current tack? (Starboard tack points left of the wind, port tack right.) */
const fetches = (s: SimSnapshot, beat: number): boolean => {
  const { rel } = toMark(s);
  return tackOf(s) > 0 ? rel <= -(beat - 1) : rel >= beat - 1;
};

/** Is the boat beyond the layline for the other tack — could it fetch the mark after tacking? */
const pastLayline = (s: SimSnapshot, beat: number): boolean => {
  const { rel } = toMark(s);
  return tackOf(s) > 0 ? rel >= beat + LAYLINE_MARGIN : rel <= -(beat + LAYLINE_MARGIN);
};

interface Race { t0: number; attempts: number }

function startRace(c: LessonCtx): void {
  c.app.scenario(RACE_START);
  c.app.setMarks([MARK]);
}

/** The crew's race: the angle from the polar, tack on headers and on the layline, then straight for the mark. */
function raceDemo(): Demo {
  let sinceTack = 99;
  let last = -1;
  return (c) => {
    const s = c.snap;
    sinceTack += last < 0 ? 0 : Math.max(0, c.t - last);
    last = c.t;
    if (s.maneuver === 'tack') { sinceTack = 0; return; }
    const beat = bestBeat(twsKn(s)).twa;
    if (fetches(s, beat)) {
      // On the layline: point straight at the mark while it is outside the no-go zone.
      const m = toMark(s);
      if (Math.abs(m.rel) >= beat - 2) holdHeading(c, m.bearing);
      else holdTwa(c, beat);
      return;
    }
    holdTwa(c, beat);
    if (sinceTack > 15 && speedKn(s) > 3 && (pastLayline(s, beat) || liftDeg(s) < -HEADER)) c.app.controls.command = 'tack';
  };
}

// ---- the lesson ------------------------------------------------------------------------------------------

export const sailingSmart: Lesson = {
  id: 'sailing-smart',
  module: 'Tactics',
  title: 'Sailing smart',
  summary: 'VMG and polars, gusts and lulls, lifts and headers, laylines — then a race to a windward mark.',
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
        const here = bestRun(TWS).twa;
        const light = bestRun(6).twa;
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
<p>The wind also swings from side to side. A [[lift-shift|lift]] lets you point closer to the mark; a [[header]] forces you away from it — and whatever heads you on one tack lifts you on the other. So tack on the headers. The [[layline|laylines]] are the two lines from the mark on which you can just fetch it: tack onto one too early and you must tack again; go past it and every metre beyond is wasted. Keep away from them until you are close to the mark — out there you can no longer use the shifts. You will see them drawn from the mark in the race.</p>`,
      camera: 'top',
      overlays: view('wheel'),
      controls: ['helm'],
    }),
    step({
      title: 'Race to the windward mark',
      body: `<p>The race: the orange windward mark is ${MARK_DISTANCE} m dead upwind of the start, and the wind is gusty and shifting. Reach it — within ${REACHED_M} m — in ${TARGET_TIME} seconds. The clock starts now.</p>
<p>The autopilot holds your angle to the wind; your job is to decide when to tack (<kbd>T</kbd>). A mark dead upwind can't be reached on one tack. Each tack costs a few boat lengths, so tack on the big headers — 5° or more — not on every flicker, and tack for the mark when you reach the layline (the overlay shows them). If time runs out, you go back to the start for another try.</p>`,
      camera: 'chase',
      overlays: view('wheel', 'laylines', 'track'),
      controls: ['helm', 'manoeuvres', 'main', 'jib', 'crew'],
      onEnter: startRace,
      tick: (c) => {
        const r = mem<Race>(c, 'race', () => ({ t0: c.t, attempts: 1 }));
        if (c.t - r.t0 > TARGET_TIME) {
          startRace(c); // out of time: back to the start for another go
          r.t0 = c.t;
          r.attempts++;
        }
      },
      task: {
        label: `Reach the windward mark (within ${REACHED_M} m) in ${TARGET_TIME} s`,
        check: (c) => {
          const d = toMark(c.snap).dist;
          return d <= REACHED_M ? 1 : Math.max(0, 1 - d / MARK_DISTANCE);
        },
      },
      hint: (c) => {
        const s = c.snap;
        const r = peek<Race>(c, 'race');
        if (!r) return null;
        const m = toMark(s);
        const left = Math.max(0, TARGET_TIME - (c.t - r.t0));
        const status = `${fmt(m.dist, 0)} m to the mark, ${fmt(left, 0)} s left${r.attempts > 1 ? ` (attempt ${r.attempts})` : ''}.`;
        if (s.maneuver === 'tack') return status;
        const beat = bestBeat(twsKn(s)).twa;
        if (fetches(s, beat)) return `${status} You can fetch the mark on this tack — sail straight for it.`;
        if (absTwa(s) > 70) return `${status} Head up to close-hauled with ${upKey(s)}.`;
        if (pastLayline(s, beat)) return `${status} You are past the layline: tack now (T) and sail for the mark.`;
        if (liftDeg(s) < -HEADER) return `${status} You are headed by ${fmt(-liftDeg(s), 0)}° — tack (T): the other tack is lifted.`;
        if (absTwa(s) > beat + 5) return `${status} You are sailing low; head up toward ${fmt(beat, 0)}°.`;
        return status;
      },
      showMe: (c) => {
        Object.assign(c.app.controls.autoTrim, { main: true, jib: true });
        return raceDemo();
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
      q: 'You tack onto the layline far from the mark, and the wind heads you. What now?',
      options: ['Nothing — you are on the layline', 'You can no longer fetch the mark and must tack again', 'Bear away to the mark'],
      correct: 1,
      why: 'Out on the layline a header puts the mark out of reach and a lift makes you overstand — that is why you stay off the laylines until you are close.',
    },
    {
      q: 'A gust hits you while sailing upwind. The apparent wind…',
      options: ['moves aft and strengthens, so you can point a little higher', 'moves forward, so you must bear away', 'does not change'],
      correct: 0,
      why: 'More true wind for the same boat speed swings the apparent wind aft — a small lift, and more heel.',
    },
  ],
};
