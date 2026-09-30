// Laylines and course line (spec §8, lesson 18 "Sailing smart"). From every windward mark two lines run back
// downwind at the best upwind VMG angle from the polars (plus the leeway the boat is making), one per tack — sail on
// either and you fetch the mark without another tack. Leeward marks get the gybing laylines at the best downwind
// angle. A dashed course-over-ground line ahead of the boat shows when you will cross one.
import * as THREE from 'three';
import type { MarkSpec } from '../../lessons/types';
import polars from '../../sim/data/polars.json';
import { optimalVmg, type PolarTable } from '../../sim/polarTable';
import type { SimSnapshot } from '../../sim/types';
import { DEG, KN } from '../../shared/math';
import type { Label, LabelLayer } from './labels';
import type { LineBatch } from './lines';
import { COLORS, linearColor } from './palette';

export type Mark = MarkSpec;

const TABLE = polars as unknown as PolarTable;
const COURSE_LEN = 160;
const LAYLINE_MIN = 250;
/** Leeway assumed before the boat has shown its own upwind leeway (rad). */
const DEFAULT_LEEWAY = 3.5 * DEG;

const LAYLINE_STYLE = { width: 2.4, alpha: 0.9, dash: 7, duty: 0.7, glow: 2 };
const COURSE_STYLE = { width: 2, alpha: 0.85, dash: 3, duty: 0.55, glow: 1.5 };
const cStbd = linearColor(COLORS.starboard);
const cPort = linearColor(COLORS.port);
const cCourse = linearColor(COLORS.white);

/**
 * Bearings (rad, compass) along which the two laylines extend FROM a mark, starboard tack first: the reverse of the
 * course over ground sailed toward it at the given true wind angle. On starboard tack (wind from starboard) the heading
 * is twd − TWA and leeway sets the track a further `leeway` away from the wind.
 */
export function laylineBearings(twd: number, twa: number, leeway: number): [number, number] {
  const a = twa + leeway;
  return [twd - a + Math.PI, twd + a + Math.PI];
}

export class Laylines {
  private marks: Mark[] = [];
  private twd = NaN;
  private leeway = DEFAULT_LEEWAY;
  private vmgTws = -1;
  private beat = 40 * DEG;
  private run = 150 * DEG;
  private readonly buf = new Float32Array(3 * 12);
  private readonly alphas = new Float32Array(12);
  private readonly labels: Label[] = [];
  private readonly courseLabel: Label;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly lines: LineBatch, private readonly layer: LabelLayer) {
    this.courseLabel = layer.create({ color: COLORS.white, priority: 3 });
  }

  setMarks(marks: readonly Mark[]): void {
    this.marks = marks.map((m) => ({ ...m }));
    while (this.labels.length < 2 * this.marks.length) this.labels.push(this.layer.create({ priority: 4 }));
  }

  update(dt: number, s: SimSnapshot, boatWorld: THREE.Vector3): void {
    // Smooth the wind direction (gust-to-gust noise) and learn the boat's upwind leeway.
    const twd = s.wind.twd;
    this.twd = Number.isNaN(this.twd) ? twd : this.twd + Math.atan2(Math.sin(twd - this.twd), Math.cos(twd - this.twd)) * Math.min(1, dt / 4);
    if (Math.abs(s.wind.twa) < 60 * DEG && s.boat.speed > 1) {
      this.leeway += (Math.abs(s.boat.leeway) - this.leeway) * Math.min(1, dt / 8);
    }
    // Best VMG angles from the polars, looked up again only when the wind speed has changed noticeably.
    const twsKn = s.wind.tws / KN;
    if (Math.abs(twsKn - this.vmgTws) > 0.05) {
      this.vmgTws = twsKn;
      this.beat = optimalVmg(TABLE, twsKn, true).twa * DEG;
      this.run = optimalVmg(TABLE, twsKn, false).twa * DEG;
    }
    const beat = this.beat, run = this.run;
    let li = 0;
    // Only the leg being sailed: windward-mark laylines on a beat, leeward-mark (gybing) laylines downwind.
    const beating = Math.abs(s.wind.twa) < 90 * DEG;
    for (const m of this.marks) {
      if (m.kind === 'start' || (m.kind === 'windward') !== beating) continue;
      const upwind = m.kind === 'windward';
      const twa = upwind ? beat : run;
      const lw = upwind ? this.leeway : 0;
      const bearings = laylineBearings(this.twd, twa, lw);
      const len = Math.max(LAYLINE_MIN, 1.4 * Math.hypot(boatWorld.x - m.e, boatWorld.z + m.n));
      for (let k = 0; k < 2; k++) {
        const bearing = bearings[k]!;
        this.segment(m.e, m.n, bearing, len);
        this.lines.add(this.buf, 12, k === 0 ? cStbd : cPort, LAYLINE_STYLE, undefined, this.alphas);
        const label = this.labels[li++];
        if (label) {
          this.tmp.set(m.e + Math.sin(bearing) * 45, 0.2, -(m.n + Math.cos(bearing) * 45));
          label.color(k === 0 ? COLORS.starboard : COLORS.port)
            .text(k === 0 ? 'Starboard layline' : 'Port layline', `${Math.round((twa + lw) / DEG)}° TWA`).at(this.tmp);
        }
      }
    }
    for (; li < this.labels.length; li++) this.labels[li]!.hide();

    // Course over ground, dashed ahead of the boat.
    const cog = s.boat.speed > 0.3 ? s.boat.cog : s.boat.heading;
    this.segment(s.boat.pos.x, s.boat.pos.y, cog, COURSE_LEN, 0.5);
    this.lines.add(this.buf, 12, cCourse, COURSE_STYLE, undefined, this.alphas);
    this.tmp.set(s.boat.pos.x + Math.sin(cog) * 30, 0.2, -(s.boat.pos.y + Math.cos(cog) * 30));
    this.courseLabel.text('Course', `${Math.round(((cog / DEG) % 360 + 360) % 360)}°`).at(this.tmp, 0, -14);
  }

  hide(): void {
    for (const l of this.labels) l.hide();
    this.courseLabel.hide();
  }

  /** 12 points from (e, n) along `bearing` for `len` m, fading out toward the far end (starting after `skip` m). */
  private segment(e: number, n: number, bearing: number, len: number, skip = 0): void {
    const se = Math.sin(bearing), sn = Math.cos(bearing);
    for (let i = 0; i < 12; i++) {
      const d = skip + (len - skip) * (i / 11);
      this.buf[3 * i] = e + se * d;
      this.buf[3 * i + 1] = 0.06;
      this.buf[3 * i + 2] = -(n + sn * d);
      this.alphas[i] = Math.min(1, 1.25 * (1 - i / 11)) * (i === 0 && skip > 0 ? 0 : 1);
    }
  }
}
