// Fixed-step simulation clock (spec §4): the physics always advances in exact 1/120 s steps; rendering
// interpolates between the last two states with `alpha`. A long pause (hidden tab, debugger) never
// explodes the simulation — at most `maxSteps` run per frame and the rest of the backlog is dropped.
export class FixedStepLoop {
  private acc = 0;

  constructor(
    private readonly step: (dt: number) => void,
    readonly dt = 1 / 120,
    readonly maxSteps = 12,
  ) {}

  /** Advance by real elapsed seconds scaled by `timeScale`; returns steps run and the interpolation factor. */
  advance(realDt: number, timeScale: number): { steps: number; alpha: number } {
    this.acc += Math.max(0, realDt) * Math.max(0, timeScale);
    let steps = 0;
    while (this.acc >= this.dt && steps < this.maxSteps) {
      this.step(this.dt);
      this.acc -= this.dt;
      steps++;
    }
    if (this.acc >= this.dt) this.acc = this.acc % this.dt; // drop the backlog instead of spiralling
    return { steps, alpha: this.acc / this.dt };
  }

  reset(): void {
    this.acc = 0;
  }
}
