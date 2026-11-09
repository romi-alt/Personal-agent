/**
 * Suspend-aware elapsed time (A11).
 *
 * Wall-clock budgets (`now() - startedAt`) charge host sleep/hibernation to whatever was running: a worker that did
 * 11 minutes of work, slept 3 hours and woke was killed as TIMEOUT on the first tick after wake (D4, exe_mw85pdo9…).
 * Timers do not fire while the host is suspended, so a suspension shows up as one tick that arrives far later than
 * the tick interval. This meter samples on every tick and books the excess of any such gap as suspended time, which
 * active-time budgets then exclude.
 *
 * Deterministic and injectable (`now`), so sleep/wake is testable without sleeping a machine. Backward clock jumps
 * (NTP corrections) are ignored rather than producing negative time.
 */
export interface SuspendGap {
  /** Wall time the host was considered suspended (gap minus one tick interval). */
  suspendedMs: number;
  /** When the late tick arrived. */
  at: number;
}

export class ActiveTimeMeter {
  private last: number;
  private suspendedTotal = 0;

  constructor(
    private readonly now: () => number,
    private readonly tickMs: number,
    private readonly thresholdMs: number,
  ) {
    this.last = now();
  }

  /** Call once per tick. Returns the detected suspension, if this tick arrived after one. */
  sample(): SuspendGap | undefined {
    const t = this.now();
    const gap = t - this.last;
    this.last = t;
    if (gap <= 0) return undefined;
    if (gap > this.tickMs + this.thresholdMs) {
      const suspendedMs = gap - this.tickMs;
      this.suspendedTotal += suspendedMs;
      return { suspendedMs, at: t };
    }
    return undefined;
  }

  /** Cumulative suspended time; take a snapshot when a budget starts. */
  suspendedMs(): number {
    return this.suspendedTotal;
  }

  /** Active (non-suspended) time elapsed since `startedAt`, given the suspended-time snapshot taken at that moment. */
  activeSince(startedAt: number, suspendedAtStart: number): number {
    return Math.max(0, this.now() - startedAt - (this.suspendedTotal - suspendedAtStart));
  }
}
