// Adaptive quality governor (spec §9.2): the median frame time over 2 s windows steps the tier down above
// 20 ms and up after 10 s continuously below 12 ms; the 12–20 ms band holds the tier.
//
// Two signals, because vsync hides headroom: on a 60 Hz display every rAF interval is ≥ 16.7 ms, so the
// interval alone can never show "below 12 ms".
//   step down — the rAF interval: dropped frames are what the viewer sees.
//   step up   — the measured frame cost (`FrameCost`, from `FrameTimer`: GPU time where the timer query works,
//               else CPU busy time) when the caller passes it; otherwise the interval (the pre-2026-09-30
//               rule, which only steps up on displays faster than ≈ 83 Hz). A step-up also needs a clean
//               cadence: at most 10 % of the window's frames over 20 ms.
// No oscillation: a step-up that has to be undone within 20 s records how much more the higher tier cost; that
// tier is retried only when its predicted cost fits (a lighter scene), never on a timer. When the failed step
// was decided on CPU time alone (no GPU timing), the GPU cost is unknown and the tier is barred for the session.
//
// Design informed by ABYSSAL `core/Quality.js` (MIT, © 2026 Davi): decide on the median, not the mean,
// so one shader-compile hitch cannot cost a tier; close windows on wall time, not on a frame count that
// takes forever on a slow device; let the pipeline settle after every change before measuring again.
import { TIER_ORDER, tierSettings, type QualitySettings, type QualityTier } from './types';

export { TIER_ORDER, tierSettings };
export type { QualitySettings, QualityTier };

/** What one frame's work cost, as measured by `FrameTimer`. */
export interface FrameCost {
  /** Milliseconds; NaN while unknown. */
  ms: number;
  /** True when `ms` includes GPU time (timer query); false when it is CPU busy time only. */
  gpu: boolean;
}

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
  /** A step-down this soon after a step-up means the higher tier did not fit. */
  failedStepUpWithinMs: 20_000,
  /** A tier that failed before is retried only if its predicted cost is below this. */
  predictedFitMs: 15,
  /** Each failure doubles the step-up wait (up to this) … */
  maxStepUpAfterMs: 300_000,
  /** … and it halves back after this long without a step-down. */
  backoffDecayMs: 300_000,
} as const;

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const n = values.length;
  const mid = n >> 1;
  return n % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

/** 90th percentile of an already sorted array. */
const p90 = (sorted: number[]): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;

type Basis = 'gpu' | 'interval' | 'cpu';

export class QualityGovernor {
  /** Current settings; replaced (never mutated) on every change. */
  settings: QualitySettings;

  private isLocked = false;
  private readonly frames: number[] = [];
  private readonly costs: number[] = [];
  private cpuOnlyCosts = 0;
  private windowStart = Number.NaN;
  private windowHadHitch = false;
  /** Timestamp of the latest frame that showed no headroom (at/above the threshold, or not fitting a failed tier). */
  private lastSlowFrameAt = -Infinity;
  private streakStart = Number.NaN;
  private settleUntil = -Infinity;
  /** Settle time to apply at the next sample (warm-up, unlock). */
  private pendingSettleMs: number = GOVERNOR.warmupMs;
  private stepUpAfterMs: number = GOVERNOR.stepUpAfterMs;
  private lastStepDownAt = Number.NaN;
  private lastStepUp: { at: number; toIndex: number; cost: number; basis: Basis } | null = null;
  /** Measured cost ratio (higher tier / tier below) of tiers whose step-up failed. */
  private readonly failRatio = new Map<number, number>();
  /** Highest tier index a step-up may reach (lowered when a CPU-only step-up fails). */
  private ceiling: number = TIER_ORDER.length - 1;

  constructor(start: QualityTier) {
    this.settings = tierSettings(start);
  }

  get locked(): boolean {
    return this.isLocked;
  }

  /**
   * Feed one frame. `frameMs` is the rAF interval (raw, unclamped), `nowMs` a monotonic timestamp and `cost`
   * the frame's measured work (optional; see the file header). Returns true when `settings` changed.
   */
  sample(frameMs: number, nowMs: number, cost?: FrameCost | null): boolean {
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
    const measured = cost && cost.ms >= 0 && Number.isFinite(cost.ms) ? cost : null;
    const signal = measured ? measured.ms : frameMs;
    if (signal >= GOVERNOR.stepUpBelowMs || !this.nextTierFits(signal)) this.lastSlowFrameAt = nowMs;
    if (Number.isNaN(this.windowStart)) this.windowStart = Math.max(nowMs - frameMs, this.settleUntil);
    this.frames.push(Math.min(frameMs, GOVERNOR.maxFrameMs));
    if (measured) {
      this.costs.push(Math.min(measured.ms, GOVERNOR.maxFrameMs));
      if (!measured.gpu) this.cpuOnlyCosts++;
    }
    if (nowMs - this.windowStart < GOVERNOR.windowMs || this.frames.length < GOVERNOR.minFrames) return false;

    const interval = median(this.frames); // sorts `frames`
    const cadence = p90(this.frames);
    const useCost = this.costs.length * 2 >= this.frames.length;
    const decision = useCost ? median(this.costs) : interval;
    const basis: Basis = !useCost ? 'interval' : this.cpuOnlyCosts > 0 ? 'cpu' : 'gpu';
    const windowStart = this.windowStart;
    const hitch = this.windowHadHitch;
    this.resetWindow();
    this.decayBackoff(nowMs);

    if (interval > GOVERNOR.stepDownAboveMs) return this.stepDown(nowMs, useCost ? decision : interval);
    // A tier that failed before counts only windows where it is predicted to fit, so a retry needs a full
    // (backed-off) streak of them and a scene flickering between cheap and expensive views cannot bounce it.
    if (decision < GOVERNOR.stepUpBelowMs && cadence <= GOVERNOR.stepDownAboveMs && this.nextTierFits(decision)) {
      if (hitch) return false; // the streak restarts with the next clean window
      // A window that began slow and turned fast only counts from its last slow frame.
      if (Number.isNaN(this.streakStart)) this.streakStart = Math.max(windowStart, this.lastSlowFrameAt);
      return nowMs - this.streakStart >= this.stepUpAfterMs ? this.stepUp(nowMs, decision, basis) : false;
    }
    this.streakStart = Number.NaN; // dead band: hold the tier, restart the step-up streak
    return false;
  }

  /** Pin a tier (user override) and stop adapting; `null` resumes adapting from the current tier, afresh. */
  lock(tier: QualityTier | null): void {
    this.resetWindow();
    this.streakStart = Number.NaN;
    this.lastStepUp = null;
    if (tier === null) {
      this.isLocked = false;
      this.stepUpAfterMs = GOVERNOR.stepUpAfterMs;
      this.failRatio.clear();
      this.ceiling = TIER_ORDER.length - 1;
      this.pendingSettleMs = GOVERNOR.settleMs;
      return;
    }
    this.isLocked = true;
    if (tier !== this.settings.tier) this.settings = tierSettings(tier);
  }

  /** False when the next tier failed before and would not fit at this cost. */
  private nextTierFits(cost: number): boolean {
    const ratio = this.failRatio.get(TIER_ORDER.indexOf(this.settings.tier) + 1);
    return ratio === undefined || cost * ratio < GOVERNOR.predictedFitMs;
  }

  private stepUp(nowMs: number, cost: number, basis: Basis): boolean {
    const next = TIER_ORDER.indexOf(this.settings.tier) + 1;
    if (next >= TIER_ORDER.length || next > this.ceiling) {
      this.streakStart = Number.NaN;
      return false;
    }
    this.lastStepUp = { at: nowMs, toIndex: next, cost, basis };
    return this.apply(next, nowMs);
  }

  private stepDown(nowMs: number, failingCost: number): boolean {
    const index = TIER_ORDER.indexOf(this.settings.tier);
    if (index <= 0) return false;
    const up = this.lastStepUp;
    if (up && up.toIndex === index && nowMs - up.at < GOVERNOR.failedStepUpWithinMs) {
      // The tier we just moved into did not fit.
      if (up.basis === 'cpu') {
        this.ceiling = index - 1; // CPU time could not see the GPU cost: do not probe this tier again
      } else {
        this.failRatio.set(index, Math.max(1.1, failingCost / Math.max(up.cost, 1e-3)));
        this.stepUpAfterMs = Math.min(this.stepUpAfterMs * 2, GOVERNOR.maxStepUpAfterMs);
      }
    }
    this.lastStepUp = null;
    this.lastStepDownAt = nowMs;
    return this.apply(index - 1, nowMs);
  }

  private apply(index: number, nowMs: number): boolean {
    this.settings = tierSettings(TIER_ORDER[index]!);
    this.streakStart = Number.NaN;
    this.settleUntil = nowMs + GOVERNOR.settleMs;
    return true;
  }

  /** Halve a doubled step-up wait after a long stable stretch (review M-6). */
  private decayBackoff(nowMs: number): void {
    if (this.stepUpAfterMs <= GOVERNOR.stepUpAfterMs || Number.isNaN(this.lastStepDownAt)) return;
    if (nowMs - this.lastStepDownAt < GOVERNOR.backoffDecayMs) return;
    this.stepUpAfterMs = Math.max(GOVERNOR.stepUpAfterMs, this.stepUpAfterMs / 2);
    this.lastStepDownAt = nowMs;
  }

  private resetWindow(): void {
    this.frames.length = 0;
    this.costs.length = 0;
    this.cpuOnlyCosts = 0;
    this.windowStart = Number.NaN;
    this.windowHadHitch = false;
  }
}
