import { existsSync } from 'node:fs';
import type { AppConfig } from '../config/index.js';
import { ExecutionLog } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';
import { SYSTEM_APPEND, buildPrompt, loadMemory } from '../memory/context.js';
import type { ExecutionProvider, PermissionDenial, ProviderFailure, RunOutcome } from '../providers/types.js';
import type { Store } from '../queue/store.js';
import { decide, type Decision, type OutcomeKind } from '../recovery/decide.js';
import type { ExecutionRecord, Task } from '../types/index.js';
import { gitState } from '../workspaces/git.js';
import type { WorkspaceRegistry } from '../workspaces/registry.js';

export interface RunnerDeps {
  config: AppConfig;
  store: Store;
  provider: ExecutionProvider;
  registry: WorkspaceRegistry;
  log: Logger;
  workerId: string;
  rng?: () => number;
}

const toFailure = (err: unknown): ProviderFailure => ({
  errorClass: 'PROCESS_CRASH',
  message: err instanceof Error ? err.message : String(err),
});

/** Executes one claimed task end-to-end: run provider, heartbeat, checkpoint, apply the recovery decision. */
export class TaskRunner {
  constructor(private readonly d: RunnerDeps) {}

  async execute(claimed: { task: Task; execution: ExecutionRecord }, shutdown: AbortSignal): Promise<void> {
    const { store, config, log, provider, registry, workerId } = this.d;
    const { task, execution } = claimed;
    const project = store.getProject(task.projectId)!;
    const xlog = log.child({ taskId: task.id, executionId: execution.id, projectId: project.id });
    const execLog = new ExecutionLog(config.logDir, execution.id, 5 * 1024 * 1024);

    store.recordEvent({
      type: 'worker.launched',
      projectId: project.id,
      taskId: task.id,
      executionId: execution.id,
      payload: { provider: provider.name, resumeSession: task.sessionId },
    });

    // Workspace isolation: the project directory must be approved and still exist.
    let cwd: string;
    try {
      cwd = registry.assertApproved(project.repoPath);
      if (!existsSync(cwd)) throw new Error(`project directory ${cwd} no longer exists`);
    } catch (err) {
      await this.finish(
        task,
        execution,
        project.repoPath,
        { kind: 'failed', failure: { errorClass: 'TASK_FAILURE', message: (err as Error).message } },
        true,
        execLog,
      );
      return;
    }

    const git = await gitState(cwd);
    const checkpoint = store.latestCheckpoint(task.id);
    const mode = task.sessionId ? 'resume' : checkpoint ? 'recovery' : 'fresh';
    const lastFailure = store
      .listExecutions(task.id)
      .filter((e) => e.id !== execution.id)
      .at(-1);
    const prompt = buildPrompt({
      task,
      project,
      checkpoint,
      git,
      memory: loadMemory(store, project.id),
      mode,
      sessionLossReason: mode === 'recovery' ? (lastFailure?.retryReason ?? 'no stored session') : null,
    });
    const approvedActionTypes = store
      .listApprovals('APPROVED')
      .filter((a) => a.taskId === task.id)
      .map((a) => a.actionType);
    const attemptIndex = store.listExecutions(task.id).length; // includes this execution => 1-based

    const abort = new AbortController();
    let leaseLost = false;
    const onShutdown = () => abort.abort();
    if (shutdown.aborted) abort.abort();
    else shutdown.addEventListener('abort', onShutdown, { once: true });
    const hb = setInterval(() => {
      try {
        if (!store.heartbeat(execution.id, task.id, workerId, config.leaseTtlMs)) {
          leaseLost = true;
          abort.abort();
        }
      } catch (err) {
        xlog.error('heartbeat.error', { error: err });
      }
    }, config.heartbeatIntervalMs);
    // Defence in depth: hard stop if a provider ignores its own timeout.
    const hardTimer = setTimeout(() => abort.abort(), config.workerTimeoutMs + 10_000);

    execLog.append({ kind: 'start', mode, attemptIndex, resumeSessionId: task.sessionId });
    let outcome: RunOutcome;
    try {
      outcome = await provider.run({
        executionId: execution.id,
        taskId: task.id,
        taskTitle: task.title,
        prompt,
        systemAppend: SYSTEM_APPEND,
        cwd,
        resumeSessionId: task.sessionId ?? undefined,
        approvedActionTypes,
        attemptIndex,
        limits: {
          maxTurns: config.maxTurnsPerExecution,
          maxBudgetUsd: config.maxBudgetUsdPerExecution > 0 ? config.maxBudgetUsdPerExecution : undefined,
          timeoutMs: config.workerTimeoutMs,
        },
        signal: abort.signal,
        onSession: (id) => {
          store.recordSession(execution.id, task.id, id);
          execLog.append({ kind: 'session', sessionId: id });
        },
        onEvent: (ev) => {
          execLog.append({ kind: ev.type, ...ev.data });
          if (ev.type === 'permission_denied' || ev.type === 'rate_limit' || ev.type === 'retry') {
            store.recordEvent({
              type: `provider.${ev.type}`,
              projectId: project.id,
              taskId: task.id,
              executionId: execution.id,
              severity: ev.type === 'retry' ? 'info' : 'warn',
              payload: ev.data,
            });
          }
        },
      });
    } catch (err) {
      outcome = { kind: 'failed', failure: toFailure(err) };
    } finally {
      clearInterval(hb);
      clearTimeout(hardTimer);
      shutdown.removeEventListener('abort', onShutdown);
    }

    if (leaseLost && outcome.kind === 'failed' && outcome.failure.errorClass === 'INTERRUPTED') {
      xlog.warn('worker.lease_lost', { note: 'task was cancelled or reclaimed; discarding result' });
      store.recordEvent({
        type: 'worker.terminated',
        projectId: project.id,
        taskId: task.id,
        executionId: execution.id,
        severity: 'warn',
        payload: { reason: 'lease lost' },
      });
      return;
    }
    // Persist the terminal provider result in the execution transcript BEFORE touching the queue,
    // so a crash in between can be reconciled from evidence.
    execLog.append({
      kind: 'result',
      outcome: outcome.kind,
      errorClass: outcome.kind === 'failed' ? outcome.failure.errorClass : null,
      summary: 'summary' in outcome ? outcome.summary : undefined,
    });
    await this.finish(task, execution, cwd, outcome, false, execLog);
  }

  private async finish(
    task: Task,
    execution: ExecutionRecord,
    cwd: string,
    outcome: RunOutcome,
    workspaceProblem: boolean,
    execLog: ExecutionLog,
  ): Promise<void> {
    const { store, config, log, provider, workerId } = this.d;
    void cwd;
    const project = store.getProject(task.projectId)!;
    const current = store.requireTask(task.id);
    if (current.assignedWorker !== workerId || current.status !== 'RUNNING') {
      log.warn('worker.finish_skipped', {
        taskId: task.id,
        status: current.status,
        note: 'lease no longer held',
      });
      return;
    }

    const kind: OutcomeKind = outcome.kind;
    const failure = outcome.kind === 'failed' ? outcome.failure : undefined;
    const resumed = !!execution.resumedFromSessionId;
    const decision: Decision = decide({
      task: current,
      kind,
      failure,
      resumed,
      providerState: store.getProviderState(provider.name),
      now: store.clock.now(),
      config,
      rng: this.d.rng,
    });
    // A workspace problem (missing/unapproved directory) cannot fix itself: owner must intervene.
    if (workspaceProblem) {
      decision.next = 'BLOCKED';
      decision.reason = failure?.message ?? 'workspace problem';
      decision.consumesAttempt = false;
      decision.nextEligibleAt = null;
    }

    const sessionId =
      ('sessionId' in outcome ? outcome.sessionId : undefined) ??
      store.getExecution(execution.id)?.providerSessionId ??
      current.sessionId ??
      null;
    const usage = ('usage' in outcome ? outcome.usage : undefined) ?? null;
    const summary = outcome.kind === 'failed' ? (outcome.summary ?? failure!.message) : outcome.summary;
    const outstanding =
      outcome.kind === 'partial'
        ? (outcome.outstanding ?? 'remaining work')
        : outcome.kind === 'failed'
          ? `Execution did not finish: ${failure!.errorClass}: ${failure!.message}`
          : 'none reported';
    const nextAction =
      outcome.kind === 'completed'
        ? 'none (task complete)'
        : outcome.kind === 'partial' && outcome.nextAction
          ? outcome.nextAction
          : `resume: ${decision.reason}`;

    // Gather working-tree state outside the DB transaction (async), then commit atomically.
    const checkpointInput = {
      task: current,
      project,
      executionId: execution.id,
      sessionRef: sessionId,
      completedSummary: summary,
      outstandingSummary: outstanding,
      nextAction,
      testResults: 'testResults' in outcome ? (outcome.testResults ?? null) : null,
    };
    const git = await gitState(project.repoPath);
    store.db.transaction(() => {
      store.endExecution(execution.id, {
        outcome: outcome.kind,
        errorClass: decision.errorClass,
        retryReason: decision.retryReason,
        usage: usage ? ({ ...usage } as Record<string, unknown>) : null,
        costUsdEstimate: usage?.costUsdEstimate ?? null,
        costUsdBilled: usage?.costUsdBilled ?? null,
        summary: summary.slice(0, 4000),
      });
      store.transition(task.id, 'CHECKPOINTING', {
        reason: `execution ${outcome.kind}`,
        executionId: execution.id,
        expectedFrom: 'RUNNING',
      });
      store.addCheckpoint({
        projectId: project.id,
        taskId: task.id,
        executionId: execution.id,
        sessionRef: sessionId,
        repoRef: git.head ? `${git.branch ?? 'detached'}@${git.head}` : null,
        gitDirty: git.isRepo ? git.dirty : null,
        completedSummary: checkpointInput.completedSummary,
        outstandingSummary:
          checkpointInput.outstandingSummary +
          (git.dirty ? `\nUncommitted changes: ${git.changes.length}` : ''),
        testResults: checkpointInput.testResults,
        nextAction,
      });
    })();
    execLog.append({ kind: 'checkpoint_written' });

    this.applyDecision(task.id, project.id, execution.id, provider.name, outcome, decision, summary);
  }

  /** Second durable step: CHECKPOINTING -> final state. Reconcile can redo this if a crash lands between the two. */
  applyDecision(
    taskId: string,
    projectId: string,
    executionId: string,
    providerName: string,
    outcome: RunOutcome,
    decision: Decision,
    summary: string,
  ): void {
    const { store, log } = this.d;
    store.db.transaction(() => {
      const evidence =
        decision.next === 'COMPLETED'
          ? `${summary.slice(0, 1500)} [execution ${executionId}${'testResults' in outcome && outcome.testResults ? `; tests: ${outcome.testResults}` : ''}]`
          : undefined;
      store.transition(taskId, decision.next, {
        reason: decision.reason,
        executionId,
        expectedFrom: 'CHECKPOINTING',
        patch: {
          nextEligibleAt: decision.nextEligibleAt,
          lastErrorClass: decision.errorClass,
          lastErrorMessage: decision.errorMessage,
          incrementAttempt: decision.consumesAttempt,
          incrementContinuation: decision.countsContinuation,
          ...(decision.clearSession ? { sessionId: null } : {}),
          ...(evidence ? { completionEvidence: evidence } : {}),
        },
      });
      const prev = store.getProviderState(providerName);
      store.setProviderState({
        provider: providerName,
        status: decision.provider.status,
        blockedUntil: decision.provider.blockedUntil,
        reason: decision.provider.reason,
        errorClass: decision.provider.errorClass,
        consecutiveFailures: decision.provider.consecutiveFailures,
        credentialFingerprint: prev.credentialFingerprint,
      });
      if (decision.next === 'WAITING_FOR_APPROVAL') {
        const denials: PermissionDenial[] = outcome.kind === 'failed' ? (outcome.denials ?? []) : [];
        const types = new Map<string, PermissionDenial>();
        for (const d of denials) types.set(d.approvalType ?? `tool:${d.tool}`, d);
        if (types.size === 0)
          types.set('unspecified', { tool: 'unknown', reason: decision.errorMessage ?? 'permission denied' });
        for (const [type, d] of types) {
          store.createApproval({
            projectId,
            taskId,
            actionType: type,
            description: d.reason,
            payload: { tool: d.tool, input: d.input },
          });
        }
      }
      if (decision.next === 'COMPLETED')
        store.updateProject(projectId, {
          progressSummary: `Last completed: ${store.requireTask(taskId).title}`,
        });
    })();
    if (decision.retryReason && decision.nextEligibleAt) {
      store.recordEvent({
        type: 'retry.scheduled',
        projectId,
        taskId,
        executionId,
        payload: {
          reason: decision.retryReason,
          nextEligibleAt: decision.nextEligibleAt,
          errorClass: decision.errorClass,
        },
      });
    }
    log.info('worker.terminated', { taskId, executionId, outcome: outcome.kind, next: decision.next });
    store.recordEvent({
      type: 'worker.terminated',
      projectId,
      taskId,
      executionId,
      payload: { outcome: outcome.kind, next: decision.next, errorClass: decision.errorClass },
    });
  }
}
