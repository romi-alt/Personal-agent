import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from '../../src/scheduler/backoff.js';
import { decide, type DecideInput } from '../../src/recovery/decide.js';
import type { ProviderFailure } from '../../src/providers/types.js';
import type { ProviderState, Task } from '../../src/types/index.js';

const cfg = {
  backoff: { baseMs: 1000, maxMs: 60_000, jitter: 0, quotaMinWaitMs: 600_000, resetMarginMs: 5000 },
  maxContinuations: 3,
};
const now = 1_000_000;
const task = (o: Partial<Task> = {}): Task => ({
  id: 't',
  projectId: 'p',
  title: 't',
  instructions: '',
  acceptanceCriteria: '',
  dependsOn: [],
  priority: 0,
  status: 'CHECKPOINTING',
  attemptCount: 0,
  maxRetries: 2,
  continuationCount: 0,
  scheduledStart: null,
  nextEligibleAt: null,
  lastErrorClass: null,
  lastErrorMessage: null,
  lastCheckpointId: null,
  assignedWorker: null,
  leaseExpiresAt: null,
  completionEvidence: null,
  sessionId: null,
  dedupeKey: 'k',
  createdAt: 0,
  updatedAt: 0,
  completedAt: null,
  ...o,
});
const ps = (o: Partial<ProviderState> = {}): ProviderState => ({
  provider: 'x',
  status: 'OK',
  blockedUntil: null,
  reason: null,
  errorClass: null,
  consecutiveFailures: 0,
  credentialFingerprint: null,
  updatedAt: 0,
  ...o,
});
const fail = (f: ProviderFailure, o: Partial<DecideInput> = {}) =>
  decide({
    task: task(),
    kind: 'failed',
    failure: f,
    resumed: false,
    providerState: ps(),
    now,
    config: cfg,
    rng: () => 0.5,
    ...o,
  });

describe('backoff', () => {
  it('grows exponentially, is capped, and applies bounded jitter', () => {
    const p = { baseMs: 1000, maxMs: 10_000, jitter: 0.2 };
    expect(computeBackoffMs(1, { ...p, jitter: 0 })).toBe(1000);
    expect(computeBackoffMs(3, { ...p, jitter: 0 })).toBe(4000);
    expect(computeBackoffMs(50, { ...p, jitter: 0 })).toBe(10_000);
    expect(computeBackoffMs(1, p, () => 0)).toBe(800);
    expect(computeBackoffMs(1, p, () => 1)).toBe(1200);
    expect(computeBackoffMs(50, p, () => 1)).toBeLessThanOrEqual(10_000);
  });
});

describe('failure classification policy (each condition handled distinctly)', () => {
  it('rate limit honours server retry-after exactly', () => {
    const d = fail({ errorClass: 'RATE_LIMIT', message: 'x', retryAfterMs: 7000 });
    expect(d).toMatchObject({
      next: 'WAITING_FOR_CAPACITY',
      nextEligibleAt: now + 7000,
      consumesAttempt: false,
    });
    expect(d.provider).toMatchObject({ status: 'RATE_LIMITED', blockedUntil: now + 7000 });
  });
  it('rate limit without guidance uses exponential backoff keyed on consecutive failures', () => {
    expect(fail({ errorClass: 'RATE_LIMIT', message: 'x' }).nextEligibleAt).toBe(now + 1000);
    expect(
      fail({ errorClass: 'RATE_LIMIT', message: 'x' }, { providerState: ps({ consecutiveFailures: 3 }) })
        .nextEligibleAt,
    ).toBe(now + 8000);
  });
  it('quota exhaustion uses the provider reset time (+margin) and never invents one', () => {
    expect(
      fail({ errorClass: 'QUOTA_EXHAUSTED', message: 'x', resetsAtMs: now + 3_600_000 }).nextEligibleAt,
    ).toBe(now + 3_600_000 + 5000);
    const noReset = fail({ errorClass: 'QUOTA_EXHAUSTED', message: 'x' });
    expect(noReset.nextEligibleAt).toBe(now + 600_000); // conservative minimum wait, not a fabricated reset
    expect(noReset.reason).toMatch(/no reset time provided/);
  });
  it('a reset time in the past never schedules into the past', () => {
    expect(fail({ errorClass: 'QUOTA_EXHAUSTED', message: 'x', resetsAtMs: now - 5000 }).nextEligibleAt).toBe(
      now + 5000,
    );
  });
  it('authentication failure waits for credentials and does not consume retries', () => {
    const d = fail({ errorClass: 'AUTHENTICATION', message: 'bad key' });
    expect(d).toMatchObject({
      next: 'WAITING_FOR_AUTHENTICATION',
      nextEligibleAt: null,
      consumesAttempt: false,
    });
    expect(d.provider.status).toBe('AUTH_REQUIRED');
  });
  it('network/outage retries do not consume the retry budget', () => {
    for (const c of ['NETWORK', 'PROVIDER_OUTAGE'] as const) {
      const d = fail({ errorClass: c, message: 'x' });
      expect(d).toMatchObject({ next: 'RETRY_SCHEDULED', consumesAttempt: false });
      expect(d.nextEligibleAt).toBeGreaterThan(now);
    }
  });
  it('crash / timeout / task failure consume attempts, then FAIL when exhausted', () => {
    for (const c of ['PROCESS_CRASH', 'TIMEOUT', 'TASK_FAILURE'] as const) {
      expect(fail({ errorClass: c, message: 'x' })).toMatchObject({
        next: 'RETRY_SCHEDULED',
        consumesAttempt: true,
      });
      expect(fail({ errorClass: c, message: 'x' }, { task: task({ attemptCount: 2 }) })).toMatchObject({
        next: 'FAILED',
      });
    }
  });
  it('invalid session starts a new session once; on a fresh session it counts as a failure', () => {
    const resumed = fail({ errorClass: 'INVALID_SESSION', message: 'x' }, { resumed: true });
    expect(resumed).toMatchObject({ next: 'READY', clearSession: true, consumesAttempt: false });
    expect(fail({ errorClass: 'INVALID_SESSION', message: 'x' }, { resumed: false }).consumesAttempt).toBe(
      true,
    );
  });
  it('permission denial waits for approval; budget exhaustion blocks; shutdown interrupt just resumes', () => {
    expect(fail({ errorClass: 'PERMISSION_DENIED', message: 'x' }).next).toBe('WAITING_FOR_APPROVAL');
    expect(fail({ errorClass: 'BUDGET_EXHAUSTED', message: 'x' }).next).toBe('BLOCKED');
    expect(fail({ errorClass: 'INTERRUPTED', message: 'x' })).toMatchObject({
      next: 'READY',
      consumesAttempt: false,
    });
  });
  it('success completes and clears provider block; partial continues until the continuation limit', () => {
    const ok = decide({
      task: task(),
      kind: 'completed',
      resumed: false,
      providerState: ps({ consecutiveFailures: 4 }),
      now,
      config: cfg,
    });
    expect(ok).toMatchObject({ next: 'COMPLETED' });
    expect(ok.provider.consecutiveFailures).toBe(0);
    const p = (n: number) =>
      decide({
        task: task({ continuationCount: n }),
        kind: 'partial',
        resumed: false,
        providerState: ps(),
        now,
        config: cfg,
      });
    expect(p(0)).toMatchObject({ next: 'READY', countsContinuation: true });
    expect(p(3).next).toBe('BLOCKED');
  });
});
