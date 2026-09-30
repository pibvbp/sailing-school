// Wall-clock budgets in tests. `pnpm test:perf` (PERF_STRICT=1, one test file at a time) checks the real
// budgets. The everyday suite runs files in parallel on a CPU shared with other workers, so it allows 3×:
// still enough to catch an order-of-magnitude regression without failing on machine load.
export const PERF_STRICT = process.env['PERF_STRICT'] === '1';

export const perfBudget = (budget: number): number => (PERF_STRICT ? budget : budget * 3);
