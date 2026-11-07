import type { AppConfig } from '../config/index.js';
import { computeBackoffMs } from '../scheduler/backoff.js';
import type { ProviderFailure } from '../providers/types.js';
import type { ErrorClass, ProviderState, Task, TaskStatus } from '../types/index.js';

export type OutcomeKind = 'completed' | 'partial' | 'failed';

export interface ProviderStateChange {
  status: ProviderState['status'];
  blockedUntil: number | null;
  reason: string | null;
  errorClass: ErrorClass | null;
  consecutiveFailures: number;
}

export interface Decision {
  next: TaskStatus;
  nextEligibleAt: number | null;
  errorClass: ErrorClass | null;
  errorMessage: string | null;
  consumesAttempt: boolean;
  countsContinuation: boolean;
  clearSession: boolean;
  /** Present when the outcome says something about provider-wide availability. */
  provider: ProviderStateChange;
  /** Provider-level failure streak to store on the task (0 resets it). */
  providerFailureStreak: number;
  /** True when the task made progress/finished, so the interruption counter resets. */
  resetInterruptions: boolean;
  /** True when a repeated-failure limit was hit and the task was BLOCKED for owner review. */
  escalated: boolean;
  reason: string;
  /** Short human text stored as the execution's retry reason. */
  retryReason: string | null;
}

export interface DecideInput {
  task: Task;
  kind: OutcomeKind;
  failure?: ProviderFailure;
  /** True when the execution attempted to resume a stored session. */
  resumed: boolean;
  providerState: ProviderState;
  now: number;
  config: Pick<AppConfig, 'backoff' | 'maxContinuations' | 'maxProviderFailureStreak'>;
  rng?: () => number;
}

const OK = (): ProviderStateChange => ({
  status: 'OK',
  blockedUntil: null,
  reason: null,
  errorClass: null,
  consecutiveFailures: 0,
});

/**
 * Central, pure failure-policy: each condition is handled distinctly and none is
 * silently treated as a rate limit. Server-provided guidance (retry-after / reset time) is honoured
 * exactly; when absent we use conservative exponential backoff with jitter and a hard cap. We never
 * invent a quota-reset time.
 */
export function decide(input: DecideInput): Decision {
  const { task, now, config, providerState } = input;
  const rng = input.rng ?? Math.random;
  const base: Decision = {
    next: 'READY',
    nextEligibleAt: null,
    errorClass: null,
    errorMessage: null,
    consumesAttempt: false,
    countsContinuation: false,
    clearSession: false,
    provider: OK(),
    providerFailureStreak: 0,
    resetInterruptions: false,
    escalated: false,
    reason: '',
    retryReason: null,
  };

  if (input.kind === 'completed')
    return { ...base, next: 'COMPLETED', resetInterruptions: true, reason: 'provider reported success' };

  if (input.kind === 'partial') {
    if (task.continuationCount + 1 > config.maxContinuations) {
      return {
        ...base,
        next: 'BLOCKED',
        errorClass: 'TASK_FAILURE',
        errorMessage: `continuation limit (${config.maxContinuations}) reached without completion`,
        reason: 'continuation limit reached; owner review required',
        countsContinuation: true,
      };
    }
    return {
      ...base,
      next: 'READY',
      countsContinuation: true,
      reason: 'partial progress checkpointed; continuing',
      retryReason: 'continue after partial completion',
    };
  }

  const f = input.failure ?? { errorClass: 'TASK_FAILURE' as const, message: 'unknown failure' };
  const failures = providerState.consecutiveFailures + 1;
  const withErr = { errorClass: f.errorClass, errorMessage: f.message };
  const streak = input.task.providerFailureStreak + 1;
  const escalate = (label: string): Decision => ({
    ...base,
    ...withErr,
    next: 'BLOCKED',
    escalated: true,
    providerFailureStreak: streak,
    provider: {
      status: 'OUTAGE',
      blockedUntil: null,
      reason: f.message,
      errorClass: f.errorClass,
      consecutiveFailures: failures,
    },
    reason: `${label} repeated ${streak} times in a row (limit ${config.maxProviderFailureStreak}); escalated to owner instead of retrying forever`,
    retryReason: null,
  });

  switch (f.errorClass) {
    case 'RATE_LIMIT': {
      if (streak > config.maxProviderFailureStreak) return escalate('rate limiting');
      const wait = f.retryAfterMs ?? computeBackoffMs(failures, config.backoff, rng);
      const until = now + wait;
      return {
        ...base,
        ...withErr,
        next: 'WAITING_FOR_CAPACITY',
        nextEligibleAt: until,
        providerFailureStreak: streak,
        provider: {
          status: 'RATE_LIMITED',
          blockedUntil: until,
          reason: f.message,
          errorClass: 'RATE_LIMIT',
          consecutiveFailures: failures,
        },
        reason:
          f.retryAfterMs !== undefined
            ? `rate limited; honouring retry-after ${wait}ms`
            : `rate limited; backoff ${wait}ms (no server guidance)`,
        retryReason: 'rate limit',
      };
    }
    case 'QUOTA_EXHAUSTED': {
      let until: number;
      let how: string;
      if (f.resetsAtMs !== undefined) {
        until = Math.max(now, f.resetsAtMs) + config.backoff.resetMarginMs;
        how = `provider-reported reset at ${new Date(f.resetsAtMs).toISOString()}`;
      } else {
        const cap = Math.max(config.backoff.maxMs, config.backoff.quotaMinWaitMs);
        const wait = Math.min(
          cap,
          Math.max(config.backoff.quotaMinWaitMs, computeBackoffMs(failures, config.backoff, rng)),
        );
        until = now + wait;
        how = `no reset time provided; conservative wait ${wait}ms`;
      }
      return {
        ...base,
        ...withErr,
        next: 'WAITING_FOR_CAPACITY',
        nextEligibleAt: until,
        provider: {
          status: 'QUOTA_EXHAUSTED',
          blockedUntil: until,
          reason: f.message,
          errorClass: 'QUOTA_EXHAUSTED',
          consecutiveFailures: failures,
        },
        reason: `usage quota exhausted; ${how}`,
        retryReason: 'usage quota exhausted',
      };
    }
    case 'AUTHENTICATION':
      return {
        ...base,
        ...withErr,
        next: 'WAITING_FOR_AUTHENTICATION',
        nextEligibleAt: null,
        provider: {
          status: 'AUTH_REQUIRED',
          blockedUntil: null,
          reason: f.message,
          errorClass: 'AUTHENTICATION',
          consecutiveFailures: providerState.consecutiveFailures,
        },
        reason: 'authentication unavailable; waiting for credentials',
        retryReason: 'authentication',
      };
    case 'NETWORK':
    case 'PROVIDER_OUTAGE': {
      if (streak > config.maxProviderFailureStreak)
        return escalate(f.errorClass === 'NETWORK' ? 'network failure' : 'provider outage');
      const wait = f.retryAfterMs ?? computeBackoffMs(failures, config.backoff, rng);
      const until = now + wait;
      return {
        ...base,
        ...withErr,
        next: 'RETRY_SCHEDULED',
        nextEligibleAt: until,
        providerFailureStreak: streak,
        provider: {
          status: 'OUTAGE',
          blockedUntil: until,
          reason: f.message,
          errorClass: f.errorClass,
          consecutiveFailures: failures,
        },
        reason: `${f.errorClass === 'NETWORK' ? 'network interruption' : 'provider outage'}; retry in ${wait}ms (does not consume a retry)`,
        retryReason: f.errorClass === 'NETWORK' ? 'network interruption' : 'provider outage',
      };
    }
    case 'INVALID_SESSION':
      if (input.resumed) {
        return {
          ...base,
          ...withErr,
          next: 'READY',
          clearSession: true,
          reason: 'stored session could not be restored; starting a new session from persisted context',
          retryReason: 'invalid session reference',
        };
      }
      return retryOrFail(input, base, withErr, rng, 'session error on a fresh session');
    case 'PERMISSION_DENIED':
      return {
        ...base,
        ...withErr,
        next: 'WAITING_FOR_APPROVAL',
        reason: 'tool call denied; owner approval required',
        retryReason: 'permission denied',
      };
    case 'BUDGET_EXHAUSTED':
      return {
        ...base,
        ...withErr,
        next: 'BLOCKED',
        reason: 'spending budget exhausted; owner must raise the budget or accept the outcome',
        retryReason: 'budget exhausted',
      };
    case 'INTERRUPTED':
      return {
        ...base,
        ...withErr,
        next: 'READY',
        reason: 'execution interrupted (shutdown/recovery); will resume',
        retryReason: 'interrupted',
      };
    case 'TIMEOUT':
    case 'PROCESS_CRASH':
    case 'TASK_FAILURE':
      return retryOrFail(input, base, withErr, rng, f.errorClass.toLowerCase().replace('_', ' '));
  }
}

function retryOrFail(
  input: DecideInput,
  base: Decision,
  withErr: Pick<Decision, 'errorClass' | 'errorMessage'>,
  rng: () => number,
  label: string,
): Decision {
  const { task, config, now } = input;
  const attempts = task.attemptCount + 1;
  if (attempts > task.maxRetries) {
    return {
      ...base,
      ...withErr,
      next: 'FAILED',
      consumesAttempt: true,
      reason: `${label}; retries exhausted (${task.maxRetries})`,
      retryReason: null,
    };
  }
  const wait = computeBackoffMs(attempts, config.backoff, rng);
  return {
    ...base,
    ...withErr,
    next: 'RETRY_SCHEDULED',
    nextEligibleAt: now + wait,
    consumesAttempt: true,
    // A failing session may be poisoned; start fresh after the first retry for plain task failures.
    clearSession: withErr.errorClass === 'TASK_FAILURE' && attempts >= 2,
    reason: `${label}; retry ${attempts}/${task.maxRetries} in ${wait}ms`,
    retryReason: label,
  };
}
