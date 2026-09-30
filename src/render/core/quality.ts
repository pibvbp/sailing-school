// Adaptive quality governor (spec §9.2): the median frame time over 2 s windows steps the tier down above
// 20 ms and up after 10 s continuously below 12 ms; the 12–20 ms dead band holds the tier.
//
// Design informed by ABYSSAL `core/Quality.js` (MIT, © 2026 Davi): decide on the median, not the mean,
// so one shader-compile hitch cannot cost a tier; close windows on wall time, not on a frame count that
// takes forever on a slow device; let the pipeline settle after every change before measuring again.
import { TIER_ORDER, tierSettings, type QualitySettings, type QualityTier } from './types';

export { TIER_ORDER, tierSettings };
export type { QualitySettings, QualityTier };

export const GOVERNOR = {
  /** Median window length. */
  windowMs: 2000,
  stepDownAboveMs: 20,
  stepUpBelowMs: 12,
  /** Continuous time below `stepUpBelowMs` before stepping up. */
  stepUpAfterMs: 10_000,
  /** Measurements ignored after start-up (shader compiles, first uploads). */
  warmupMs: 3000,
  /** Measurements ignored after every tier change (target reallocation, recompiles). */
  settleMs: 1000,
  /** A window needs at least this many frames even when its time is up. */
  minFrames: 5,
  /** A frame this long (hidden tab, debugger, GC storm) breaks the step-up streak. */
  hitchMs: 250,
  /** Samples are clamped to this before entering the median buffer. */
  maxFrameMs: 1000,
  /** A step-down this soon after a step-up means the higher tier did not fit: double the next wait. */
  failedStepUpWithinMs: 20_000,
  maxStepUpAfterMs: 80_000,
} as const;

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const n = values.length;
  const mid = n >> 1;
  return n % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

export class QualityGovernor {
  /** Current settings; replaced (never mutated) on every change. */
  settings: QualitySettings;

  private isLocked = false;
  private readonly frames: number[] = [];
  private windowStart = Number.NaN;
  private windowHadHitch = false;
  /** Timestamp of the latest frame at or above the step-up threshold. */
  private lastSlowFrameAt = -Infinity;
  private streakStart = Number.NaN;
  private settleUntil = -Infinity;
  /** Settle time to apply at the next sample (warm-up, unlock). */
  private pendingSettleMs: number = GOVERNOR.warmupMs;
  private lastStepUpAt = -Infinity;
  private stepUpAfterMs: number = GOVERNOR.stepUpAfterMs;

  constructor(start: QualityTier) {
    this.settings = tierSettings(start);
  }

  get locked(): boolean {
    return this.isLocked;
  }

  /**
   * Feed one frame. `frameMs` is the frame's duration, `nowMs` a monotonic timestamp.
   * Returns true when `settings` changed (the caller re-applies them).
   */
  sample(frameMs: number, nowMs: number): boolean {
    if (this.isLocked || !(frameMs >= 0) || !Number.isFinite(frameMs) || !Number.isFinite(nowMs)) return false;
    if (this.pendingSettleMs > 0) {
      this.settleUntil = nowMs + this.pendingSettleMs;
      this.pendingSettleMs = 0;
    }
    if (nowMs < this.settleUntil) return false;

    if (frameMs > GOVERNOR.hitchMs) {
      this.streakStart = Number.NaN;
      this.windowHadHitch = true;
    }
    if (frameMs >= GOVERNOR.stepUpBelowMs) this.lastSlowFrameAt = nowMs;
    if (Number.isNaN(this.windowStart)) this.windowStart = Math.max(nowMs - frameMs, this.settleUntil);
    this.frames.push(Math.min(frameMs, GOVERNOR.maxFrameMs));
    if (nowMs - this.windowStart < GOVERNOR.windowMs || this.frames.length < GOVERNOR.minFrames) return false;

    const windowMedian = median(this.frames);
    const windowStart = this.windowStart;
    const hitch = this.windowHadHitch;
    this.resetWindow();

    if (windowMedian > GOVERNOR.stepDownAboveMs) return this.step(-1, nowMs);
    if (windowMedian < GOVERNOR.stepUpBelowMs) {
      if (hitch) return false; // the streak restarts with the next clean window
      // A window that began slow and turned fast only counts from its last slow frame.
      if (Number.isNaN(this.streakStart)) this.streakStart = Math.max(windowStart, this.lastSlowFrameAt);
      return nowMs - this.streakStart >= this.stepUpAfterMs ? this.step(+1, nowMs) : false;
    }
    this.streakStart = Number.NaN; // dead band: hold the tier, restart the step-up streak
    return false;
  }

  /** Pin a tier (user override) and stop adapting; `null` resumes adapting from the current tier. */
  lock(tier: QualityTier | null): void {
    this.resetWindow();
    this.streakStart = Number.NaN;
    if (tier === null) {
      this.isLocked = false;
      this.stepUpAfterMs = GOVERNOR.stepUpAfterMs;
      this.pendingSettleMs = GOVERNOR.settleMs;
      return;
    }
    this.isLocked = true;
    if (tier !== this.settings.tier) this.settings = tierSettings(tier);
  }

  private step(direction: 1 | -1, nowMs: number): boolean {
    const index = TIER_ORDER.indexOf(this.settings.tier) + direction;
    const next = TIER_ORDER[index];
    if (next === undefined) {
      this.streakStart = Number.NaN;
      return false;
    }
    if (direction < 0 && nowMs - this.lastStepUpAt < GOVERNOR.failedStepUpWithinMs) {
      this.stepUpAfterMs = Math.min(this.stepUpAfterMs * 2, GOVERNOR.maxStepUpAfterMs);
    }
    if (direction > 0) this.lastStepUpAt = nowMs;
    this.settings = tierSettings(next);
    this.streakStart = Number.NaN;
    this.settleUntil = nowMs + GOVERNOR.settleMs;
    return true;
  }

  private resetWindow(): void {
    this.frames.length = 0;
    this.windowStart = Number.NaN;
    this.windowHadHitch = false;
  }
}
