import type { ExecutionRecord } from '../types/index.js';

/**
 * A12: bounded capacity waiting. A task may legitimately wait a long time for subscription capacity (a weekly limit
 * can be days away), so nothing is killed early; but an unbounded silent wait must reach the owner.
 *
 * The capacity streak is the run of most-recent executions that ended waiting for capacity (QUOTA_EXHAUSTED /
 * RATE_LIMIT) without any other outcome in between. Its start is the first such execution's start time.
 */
const CAPACITY_CLASSES = new Set(['QUOTA_EXHAUSTED', 'RATE_LIMIT']);

export function capacityStreakSince(executions: readonly ExecutionRecord[]): number | null {
  let since: number | null = null;
  for (let i = executions.length - 1; i >= 0; i--) {
    const e = executions[i]!;
    if (e.endedAt === null && i === executions.length - 1) continue; // the running execution itself
    if (!e.errorClass || !CAPACITY_CLASSES.has(e.errorClass)) break;
    since = e.startedAt;
  }
  return since;
}

export interface CapacityEscalation {
  since: number;
  waitedMs: number;
}

/** Returns the escalation to raise, or null (disabled, below the threshold, or not a capacity streak). */
export function capacityEscalation(
  executions: readonly ExecutionRecord[],
  now: number,
  escalateAfterMs: number,
): CapacityEscalation | null {
  if (escalateAfterMs <= 0) return null;
  const since = capacityStreakSince(executions);
  if (since === null) return null;
  const waitedMs = now - since;
  return waitedMs > escalateAfterMs ? { since, waitedMs } : null;
}
