export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  /** Fractional jitter, e.g. 0.2 => +/-20%. */
  jitter: number;
}

/**
 * Conservative exponential backoff with jitter, hard-capped at maxMs.
 * `failures` is the number of consecutive failures so far (>= 1).
 */
export function computeBackoffMs(
  failures: number,
  policy: BackoffPolicy,
  rng: () => number = Math.random,
): number {
  const n = Math.max(1, failures);
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(n - 1, 30));
  const jitterFactor = 1 + policy.jitter * (rng() * 2 - 1);
  return Math.min(policy.maxMs, Math.max(0, Math.round(exp * jitterFactor)));
}
