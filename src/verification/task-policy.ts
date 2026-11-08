import { TASK_VERIFIABLE_LEVELS, type VerificationLevel } from './types.js';

/**
 * A6: one verification policy for every coding task, however it was created.
 *
 * v1 gave planned tasks independent QA (`REQUIREMENTS_SATISFIED` in verification_required) but `task:add` enqueued
 * manual tasks with no verification at all, so owner-requested corrections (S1-F1, D4) completed with no review.
 * Now a manual coding task gets the same independent review, needs enforceable acceptance criteria, and checks the
 * project's configured build/test commands. Waiving review is possible only explicitly, with a recorded reason.
 */
export interface ManualTaskPolicyInput {
  independentReview: boolean;
  criteria: string;
  noReview?: boolean;
  reason?: string;
  /** Explicit comma-separated task-level levels (overrides the defaults). */
  verify?: string;
  commands: { build?: string; test?: string };
}

export type ManualTaskPolicy =
  | { ok: true; verificationRequired: string[]; review: boolean; waived: string | null }
  | { ok: false; error: string };

export function manualTaskPolicy(i: ManualTaskPolicyInput): ManualTaskPolicy {
  if (i.noReview && !i.reason?.trim())
    return { ok: false, error: '--no-review needs --reason (the waiver is recorded in the audit log)' };
  const review = i.independentReview && !i.noReview;
  if (review && !i.criteria.trim())
    return {
      ok: false,
      error:
        'a coding task needs enforceable acceptance criteria (--criteria "..."); they are what the independent review checks',
    };
  let levels: string[];
  if (i.verify !== undefined) {
    levels = i.verify
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const bad = levels.filter((l) => !(TASK_VERIFIABLE_LEVELS as readonly string[]).includes(l));
    if (bad.length)
      return {
        ok: false,
        error: `--verify accepts ${TASK_VERIFIABLE_LEVELS.join(', ')} (got ${bad.join(', ')})`,
      };
  } else {
    levels = ['CHANGES_EXIST'];
    if (i.commands.build) levels.push('BUILD_PASSES' satisfies VerificationLevel);
    if (i.commands.test) levels.push('TESTS_PASS' satisfies VerificationLevel);
  }
  if (review) levels.push('REQUIREMENTS_SATISFIED');
  return {
    ok: true,
    verificationRequired: [...new Set(levels)],
    review,
    waived: i.noReview ? i.reason!.trim() : null,
  };
}
