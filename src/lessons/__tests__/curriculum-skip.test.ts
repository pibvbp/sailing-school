// Curriculum, skip path (spec §11, Task 18): a learner who pressed Next past the steps before a task still has
// to do it — idling for the step's idle window does not complete it — and "Show me" still completes it within
// its budget. Split from curriculum.test.ts so the two suites run in parallel.
import { describe, expect, it, vi } from 'vitest';
import { CURRICULUM } from '../curriculum';
import { PENDING_SIM_FIX, afterSkipping, idleWindow, showMeBudget } from './curriculum-harness';

/** Wall-clock allowance for a test that simulates up to `simSeconds`, with room for a loaded CI machine. */
const timeoutMs = (simSeconds: number): number => Math.max(60_000, 30_000 + 150 * simSeconds);

describe('curriculum: after skipping the steps before it, a task still needs the learner and Show me still works', () => {
  for (const lesson of CURRICULUM) {
    const pending = PENDING_SIM_FIX[lesson.id];
    lesson.steps.forEach((st, k) => {
      if (!st.task || k === 0) return;
      (pending ? it.skip : it)(`${lesson.id} step ${k + 1} "${st.title}"${pending ? ` (pending sim fix ${pending})` : ''}`, () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          afterSkipping(lesson, k);
          expect(errors.mock.calls.length, `${lesson.id} step ${k + 1}: errors`).toBe(0);
        } finally {
          errors.mockRestore();
        }
      }, timeoutMs(idleWindow(lesson, st) + showMeBudget(lesson, st)));
    });
  }
});
