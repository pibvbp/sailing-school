// Detects teaching-relevant situations and turns them into debounced events (spec §7.7).
import type { SimEvent, SimEventType } from './types';
import { DEG } from '../shared/math';

export interface EventInputs {
  t: number;
  dt: number;
  twa: number;
  speed: number;
  heel: number;
  yawRate: number;
  rudder: number;
  crashRate: number;
  spinEvents: readonly ('spinCollapse' | 'spinRefill')[];
  mainLuffing: number;
  jibLuffing: number;
  jibSet: boolean;
  mainLuffBubble: number;
  mainLeechFull: boolean;
}

export class EventDetector {
  private queue: SimEvent[] = [];
  private ironsT = 0;
  private ironsArmed = true;
  private luffT = 0;
  private lastFired = new Map<SimEventType, number>();

  emit(type: SimEventType, t: number, data?: Record<string, number>): void {
    this.queue.push(data ? { type, t, data } : { type, t });
    this.lastFired.set(type, t);
  }

  private debounced(type: SimEventType, t: number, gap: number): boolean {
    const last = this.lastFired.get(type);
    return last === undefined || t - last >= gap;
  }

  update(s: EventInputs): void {
    // One gybe, one event (the swing and the slam of the same gybe arrive a moment apart).
    if (s.crashRate > 0 && this.debounced('crashGybe', s.t, 3)) this.emit('crashGybe', s.t, { rate: s.crashRate });
    for (const e of s.spinEvents) this.emit(e, s.t);

    // In irons: pointing into the no-go zone with no way on.
    if (Math.abs(s.twa) < 30 * DEG && s.speed < 0.26) {
      this.ironsT += s.dt;
      if (this.ironsT > 3 && this.ironsArmed) { this.emit('inIrons', s.t); this.ironsArmed = false; }
    } else {
      this.ironsT = 0;
      if (Math.abs(s.twa) > 45 * DEG && s.speed > 0.8) this.ironsArmed = true;
    }

    // Round-up: heavily heeled, the bow swinging toward the wind (> 8°/s) although the rudder is not steering it
    // there (< 5° of rudder toward the wind) — whether the helm is fighting it or the tiller is centred.
    const windSide = Math.sign(s.twa) || 1;
    const towardWind = s.yawRate * windSide > 8 * DEG;
    const rudderToWind = s.rudder * windSide;
    if (Math.abs(s.heel) > 25 * DEG && towardWind && rudderToWind < 5 * DEG && this.debounced('roundUp', s.t, 6)) {
      this.emit('roundUp', s.t);
    }

    // Sails luffing while the boat is supposed to be sailing (not head to wind).
    const luffing = Math.max(s.mainLuffing, s.jibSet ? s.jibLuffing : 0);
    this.luffT = luffing > 0.7 && Math.abs(s.twa) > 40 * DEG ? this.luffT + s.dt : 0;
    if (this.luffT > 2 && this.debounced('luffing', s.t, 12)) this.emit('luffing', s.t);

    if (s.jibSet && Math.abs(s.twa) > 30 * DEG && s.mainLuffBubble > 0.45 && s.mainLeechFull && this.debounced('backwinded', s.t, 12)) {
      this.emit('backwinded', s.t);
    }
  }

  drain(): SimEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}
