import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/logger.js';
import { pruneExecutionLogs } from '../logging/logger.js';
import type { ExecutionProvider } from '../providers/types.js';
import type { Store } from '../queue/store.js';
import { reconcileOrphans, type ReconcileAction } from '../recovery/reconcile.js';
import { TaskRunner } from '../workers/runner.js';
import type { WorkspaceRegistry } from '../workspaces/registry.js';
import type { ExecutionRecord, Task } from '../types/index.js';

export interface SupervisorDeps {
  config: AppConfig;
  store: Store;
  provider: ExecutionProvider;
  registry: WorkspaceRegistry;
  log: Logger;
  instanceId?: string;
  rng?: () => number;
}

export interface GateResult {
  open: boolean;
  reason: string;
}

/**
 * Long-running, independent process loop. It owns scheduling, leases, heartbeats, recovery and shutdown,
 * and makes NO provider calls while idle: its only periodic work is local SQLite polling (bounded by
 * POLL_INTERVAL_MS) and a local, network-free credential preflight when authentication is the blocker.
 */
export class Supervisor {
  readonly instanceId: string;
  private stopping = false;
  private stopReason = '';
  private wakeResolve: (() => void) | null = null;
  private readonly shutdownCtl = new AbortController();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly runner: TaskRunner;
  private lastGate = '';
  private lastRetentionRun = 0;
  private done: Promise<void> | null = null;

  constructor(private readonly d: SupervisorDeps) {
    this.instanceId = d.instanceId ?? `sup_${randomBytes(4).toString('hex')}`;
    this.runner = new TaskRunner({
      config: d.config,
      store: d.store,
      provider: d.provider,
      registry: d.registry,
      log: d.log,
      workerId: this.instanceId,
      rng: d.rng,
    });
  }

  get activeWorkers(): number {
    return this.workers.size;
  }

  /** In-process, event-driven wake-up (e.g. after enqueue). Cross-process changes are seen by bounded polling. */
  wake(): void {
    this.wakeResolve?.();
  }

  requestStop(reason = 'stop requested'): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stopReason = reason;
    this.d.log.info('supervisor.stop_requested', { reason, instanceId: this.instanceId });
    this.wake();
  }

  /** Acquire the singleton lock, reconcile after any unclean stop, then run until stopped. */
  async start(): Promise<void> {
    const { store, config, log } = this.d;
    const { previous } = store.acquireSupervisorLock(this.instanceId, config.leaseTtlMs);
    store.recordEvent({
      type: 'supervisor.started',
      payload: {
        instanceId: this.instanceId,
        pid: process.pid,
        provider: this.d.provider.name,
        previousStatus: previous?.status ?? null,
        previousInstance: previous?.instanceId ?? null,
      },
    });
    log.info('supervisor.started', { instanceId: this.instanceId, pid: process.pid });
    pruneExecutionLogs(config.logDir, config.logRetentionDays);

    const actions = await this.reconcile('startup');
    if (actions.length) log.warn('supervisor.recovered_tasks', { count: actions.length });

    this.done = this.loop();
    await this.done;
  }

  private async reconcile(mode: 'startup' | 'sweep'): Promise<ReconcileAction[]> {
    return reconcileOrphans({
      mode,
      store: this.d.store,
      config: this.d.config,
      log: this.d.log,
      runner: this.runner,
      registry: this.d.registry,
      providerName: this.d.provider.name,
      isLocallyActive: (id) => this.workers.has(id),
    });
  }

  /** Decide whether new work may be claimed now. Purely local; never calls the provider. */
  async gate(): Promise<GateResult> {
    const { store, config, provider } = this.d;
    const now = store.clock.now();
    let ps = store.getProviderState(provider.name);

    const pre = await provider.preflight();
    const fp = pre.fingerprint ?? null;
    if (!pre.ready) {
      const reason = `preflight: ${pre.missing.join('; ')}`;
      if (ps.status !== 'AUTH_REQUIRED' || ps.reason !== reason) {
        store.setProviderState({
          ...ps,
          status: 'AUTH_REQUIRED',
          blockedUntil: null,
          reason,
          errorClass: 'AUTHENTICATION',
          credentialFingerprint: fp,
        });
        store.recordEvent({ type: 'auth.not_ready', severity: 'warn', payload: { missing: pre.missing } });
      }
      this.parkForAuthentication();
      return { open: false, reason: `authentication not ready: ${pre.missing.join('; ')}` };
    }
    if (ps.status === 'AUTH_REQUIRED') {
      const preflightKind = ps.reason?.startsWith('preflight:') ?? false;
      // A runtime auth rejection is only cleared when the credential itself changed (no probing request is made).
      if (!preflightKind && fp !== null && fp === ps.credentialFingerprint) {
        return {
          open: false,
          reason: 'authentication was rejected for the current credential; update the credential to retry',
        };
      }
      store.setProviderState({
        ...ps,
        status: 'OK',
        blockedUntil: null,
        reason: null,
        errorClass: null,
        consecutiveFailures: 0,
        credentialFingerprint: fp,
      });
      store.recordEvent({ type: 'auth.ready', payload: { detail: pre.detail } });
      ps = store.getProviderState(provider.name);
    } else if (ps.credentialFingerprint !== fp) {
      store.setProviderState({ ...ps, credentialFingerprint: fp });
      ps = store.getProviderState(provider.name);
    }
    if (ps.blockedUntil && ps.blockedUntil > now) {
      return {
        open: false,
        reason: `provider ${ps.status} until ${new Date(ps.blockedUntil).toISOString()}: ${ps.reason ?? ''}`,
      };
    }
    if (config.dailyBudgetUsd > 0) {
      const spent = store.estimatedSpendSince(now - 86_400_000);
      if (spent >= config.dailyBudgetUsd) {
        return {
          open: false,
          reason: `daily budget reached (estimated $${spent.toFixed(2)} >= $${config.dailyBudgetUsd})`,
        };
      }
    }
    return { open: true, reason: 'open' };
  }

  /** When credentials are missing, make the dependent state durable: pending tasks wait for authentication. */
  private parkForAuthentication(): void {
    const { store } = this.d;
    for (const t of store.listTasks({
      statuses: ['QUEUED', 'READY', 'RETRY_SCHEDULED', 'WAITING_FOR_CAPACITY'],
    })) {
      store.transition(t.id, 'WAITING_FOR_AUTHENTICATION', {
        reason: 'authentication preflight failed',
        patch: { lastErrorClass: 'AUTHENTICATION', lastErrorMessage: 'provider credentials not ready' },
      });
    }
  }

  /** One scheduling pass. Exposed for deterministic tests. */
  async tick(): Promise<{ claimed: number; gate: GateResult }> {
    const { store, config, log, provider } = this.d;
    store.sweepDependencyBlocks();
    const gate = await this.gate();
    if (gate.reason !== this.lastGate) {
      this.lastGate = gate.reason;
      log.info('supervisor.gate', { open: gate.open, reason: gate.reason });
    }
    if (!gate.open || this.stopping) return { claimed: 0, gate };

    let claimed = 0;
    while (this.workers.size < config.maxConcurrentWorkers && !this.stopping) {
      const c = store.claimNext({
        workerId: this.instanceId,
        leaseTtlMs: config.leaseTtlMs,
        maxConcurrent: config.maxConcurrentWorkers,
        provider: provider.name,
        pid: process.pid,
        logRef: (id) => path.join(config.logDir, 'executions', `${id}.jsonl`),
      });
      if (!c) break;
      claimed++;
      this.launch(c);
    }
    return { claimed, gate };
  }

  private launch(c: { task: Task; execution: ExecutionRecord }): void {
    const p = this.runner
      .execute(c, this.shutdownCtl.signal)
      .catch((err) => {
        // Last-resort guard: a bug must not wedge the task in RUNNING until lease expiry without a trace.
        this.d.log.error('worker.unhandled_error', {
          taskId: c.task.id,
          executionId: c.execution.id,
          error: err,
        });
        this.d.store.recordEvent({
          type: 'worker.crashed',
          taskId: c.task.id,
          executionId: c.execution.id,
          severity: 'error',
          payload: { error: String(err) },
        });
      })
      .finally(() => {
        this.workers.delete(c.execution.id);
        this.wake();
      });
    this.workers.set(c.execution.id, p);
  }

  private async loop(): Promise<void> {
    const { store, config, log } = this.d;
    let lastSweep = 0;
    try {
      for (;;) {
        const current = [...this.workers.keys()][0] ? (store.listActiveTasks()[0]?.id ?? null) : null;
        const hb = store.heartbeatSupervisor(
          this.instanceId,
          this.stopping ? 'STOPPING' : this.workers.size ? 'RUNNING' : 'IDLE',
          current,
        );
        if (hb.stopRequested) this.requestStop('stop requested via CLI');
        if (this.stopping) break;

        const now = store.clock.now();
        if (now - lastSweep > config.leaseTtlMs) {
          lastSweep = now;
          await this.reconcile('sweep');
        }
        if (now - this.lastRetentionRun > 6 * 3_600_000) {
          this.lastRetentionRun = now;
          pruneExecutionLogs(config.logDir, config.logRetentionDays);
          try {
            const m = store.runMaintenance(config.eventRetentionDays);
            if (m.eventsDeleted) log.info('maintenance.events_pruned', { deleted: m.eventsDeleted });
          } catch (err) {
            log.warn('maintenance.error', { error: err });
          }
        }
        try {
          await this.tick();
        } catch (err) {
          log.error('supervisor.tick_error', { error: err });
          store.heartbeatSupervisor(this.instanceId, 'ERROR', null, String(err));
        }
        const nextWake = store.nextWakeAt();
        const sleepMs = Math.max(
          25,
          Math.min(config.pollIntervalMs, nextWake ? nextWake - store.clock.now() : config.pollIntervalMs),
        );
        await this.sleep(sleepMs);
      }
    } finally {
      await this.shutdown();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => ((this.wakeResolve = null), resolve()), ms);
      this.wakeResolve = () => (clearTimeout(t), (this.wakeResolve = null), resolve());
    });
  }

  /** Graceful stop: stop claiming, ask running work to stop, persist state, release leases and the singleton lock. */
  private async shutdown(): Promise<void> {
    const { store, config, log } = this.d;
    log.info('supervisor.shutting_down', { reason: this.stopReason, activeWorkers: this.workers.size });
    store.heartbeatSupervisor(this.instanceId, 'STOPPING', null);
    this.shutdownCtl.abort();
    const pending = Promise.allSettled([...this.workers.values()]);
    const timeout = new Promise<'timeout'>((r) =>
      setTimeout(() => r('timeout'), config.shutdownGraceMs).unref(),
    );
    const res = await Promise.race([pending.then(() => 'done' as const), timeout]);
    if (res === 'timeout') {
      log.warn('supervisor.shutdown_grace_exceeded', {
        remaining: this.workers.size,
        note: 'leases will expire; startup recovery will reconcile these tasks',
      });
    }
    store.releaseSupervisor(this.instanceId);
    store.recordEvent({
      type: 'supervisor.stopped',
      payload: { instanceId: this.instanceId, reason: this.stopReason, graceful: res === 'done' },
    });
    log.info('supervisor.stopped', { instanceId: this.instanceId, graceful: res === 'done' });
  }

  /** Resolves when the loop has fully stopped (tests). */
  async stopped(): Promise<void> {
    await this.done;
  }
}
