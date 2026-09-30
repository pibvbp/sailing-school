// Track trail (spec §8): where the boat has been over the ground, drawn on the water and fading with age. It records
// all the time (cheap) so switching it on shows the recent history; a jump (new scenario) starts a fresh track.
// Tacks and gybes read as corners; the colour shifts toward the tack's side colour (port red / starboard green).
import * as THREE from 'three';
import type { SimSnapshot } from '../../sim/types';
import type { LineBatch } from './lines';
import { COLORS } from './palette';

const RECORD_DT = 0.5;
const MAX_POINTS = 720; // 6 minutes
const JUMP = 60;

export class TrackTrail {
  private readonly e = new Float64Array(MAX_POINTS);
  private readonly n = new Float64Array(MAX_POINTS);
  private readonly t = new Float64Array(MAX_POINTS);
  private readonly side = new Int8Array(MAX_POINTS);
  private start = 0;
  private count = 0;
  private lastT = -Infinity;
  private dirty = true;
  private readonly buf = new Float32Array(3 * (MAX_POINTS + 1));
  private readonly alphas = new Float32Array(MAX_POINTS + 1);
  private readonly color = new THREE.Color();
  private readonly white = new THREE.Color(COLORS.white);
  private readonly port = new THREE.Color(COLORS.port);
  private readonly stbd = new THREE.Color(COLORS.starboard);

  /** Record the boat's position (call every frame, overlay on or off). */
  record(s: SimSnapshot): void {
    const e = s.boat.pos.x, n = s.boat.pos.y;
    if (s.t < this.lastT) this.clear(); // the simulation was reset
    if (this.count > 0) {
      const last = (this.start + this.count - 1) % MAX_POINTS;
      if (Math.hypot(e - this.e[last]!, n - this.n[last]!) > JUMP) this.clear();
    }
    if (s.t - this.lastT < RECORD_DT && this.count > 0) return;
    this.lastT = s.t;
    const i = (this.start + this.count) % MAX_POINTS;
    if (this.count === MAX_POINTS) this.start = (this.start + 1) % MAX_POINTS; else this.count++;
    this.e[i] = e;
    this.n[i] = n;
    this.t[i] = s.t;
    this.side[i] = s.wind.twa >= 0 ? 1 : -1;
    this.dirty = true;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
    this.lastT = -Infinity;
    this.dirty = true;
  }

  /** Rebuild the line when new points arrived; the live end always joins the boat. */
  draw(lines: LineBatch, s: SimSnapshot): void {
    if (this.count < 1) { lines.begin(); lines.end(); return; }
    if (!this.dirty) return;
    this.dirty = false;
    lines.begin();
    const now = s.t;
    // Draw in runs of constant tack so each run takes its side's tint.
    let runStart = 0;
    for (let k = 1; k <= this.count; k++) {
      const endOfRun = k === this.count || this.side[(this.start + k) % MAX_POINTS] !== this.side[(this.start + runStart) % MAX_POINTS];
      if (!endOfRun) continue;
      let m = 0;
      // Include the first point of the next run so runs join without a gap.
      const last = Math.min(k, this.count - 1);
      for (let j = runStart; j <= last; j++) {
        const i = (this.start + j) % MAX_POINTS;
        this.buf[3 * m] = this.e[i]!;
        this.buf[3 * m + 1] = 0.05;
        this.buf[3 * m + 2] = -this.n[i]!;
        const age = now - this.t[i]!;
        this.alphas[m] = 0.85 * Math.max(0, 1 - age / (MAX_POINTS * RECORD_DT));
        m++;
      }
      const sd = this.side[(this.start + runStart) % MAX_POINTS]!;
      this.color.copy(this.white).lerp(sd > 0 ? this.stbd : this.port, 0.35);
      if (m >= 2) lines.add(this.buf, m, this.color, TRACK_STYLE, undefined, this.alphas);
      runStart = k;
    }
    lines.end();
  }
}

const TRACK_STYLE = { width: 3, alpha: 1, glow: 2 };
