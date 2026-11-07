import { existsSync } from 'node:fs';
import { getAssignment } from '../assignments/register.js';
import { buildProjectContext, renderProjectContext } from '../assignments/context.js';
import type { AppConfig } from '../config/index.js';
import { ExecutionLog } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';
import { PLANNING_APPEND, SYSTEM_APPEND, buildPrompt, loadMemory } from '../memory/context.js';
import type { ExecutionProvider, PermissionDenial, ProviderFailure, RunOutcome } from '../providers/types.js';
import { StaleLeaseError, type Store } from '../queue/store.js';
import { decide, type Decision, type OutcomeKind } from '../recovery/decide.js';
import type { ExecutionRecord, Task } from '../types/index.js';
import { verifyTask } from '../verification/service.js';
import { commitExists, gitState, treeFingerprint } from '../workspaces/git.js';
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

/**
 * Executes one claimed task end-to-end: run provider, heartbeat, verify, checkpoint, apply the recovery decision.
 *
 * Every durable write is fenced by the execution id (tasks.lease_execution_id): a worker whose lease was
 * reclaimed can never overwrite the state written by a newer execution, and a duplicated completion is a no-op.
 */
export class TaskRunner {
  constructor(private readonly d: RunnerDeps) {}

  async execute(claimed: { task: Task; execution: ExecutionRecord }, shutdown: AbortSignal): Promise<void> {
    const { store, config, log, provider, workerId } = this.d;
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

    // The heartbeat covers the provider run AND post-run verification (which can take minutes).
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

    try {
      await this.executeInner(task, execution, project.id, abort, () => leaseLost, execLog);
    } finally {
      clearInterval(hb);
      shutdown.removeEventListener('abort', onShutdown);
    }
  }

  private async executeInner(
    task: Task,
    execution: ExecutionRecord,
    projectId: string,
    abort: AbortController,
    isLeaseLost: () => boolean,
    execLog: ExecutionLog,
  ): Promise<void> {
    const { store, config, log, provider, registry } = this.d;
    const project = store.getProject(projectId)!;
    const xlog = log.child({ taskId: task.id, executionId: execution.id, projectId });

    // Workspace isolation: the project directory must be approved and still exist.
    let cwd: string;
    try {
      cwd = registry.assertApproved(project.repoPath);
      if (!existsSync(cwd)) throw new Error(`project directory ${cwd} no longer exists`);
    } catch (err) {
      await this.finish(
        task,
        execution,
        { kind: 'failed', failure: { errorClass: 'TASK_FAILURE', message: (err as Error).message } },
        true,
        execLog,
        abort.signal,
      );
      return;
    }

    // Baseline for CHANGES_EXIST + the state we are resuming from.
    const fp = await treeFingerprint(cwd);
    store.recordExecutionStart(execution.id, fp);
    const git = await gitState(cwd);

    // Checkpoint integrity: never trust a damaged or dangling checkpoint.
    const integrityNotes: string[] = [];
    const { checkpoint, skippedCorrupt } = store.latestValidCheckpoint(task.id);
    if (skippedCorrupt.length)
      integrityNotes.push(
        `${skippedCorrupt.length} corrupted checkpoint(s) were ignored (${skippedCorrupt.join(', ')}); state was reconstructed from the working tree`,
      );
    if (checkpoint?.repoRef) {
      const sha = checkpoint.repoRef.split('@')[1];
      if (sha && git.isRepo && !(await commitExists(cwd, sha))) {
        integrityNotes.push(
          `checkpoint commit ${sha.slice(0, 8)} no longer exists in the repository (history rewritten?); trust only the current working tree`,
        );
        store.recordEvent({
          type: 'checkpoint.repo_ref_missing',
          projectId,
          taskId: task.id,
          severity: 'warn',
          payload: { checkpointId: checkpoint.id, sha },
        });
      }
    }
    const mode = task.sessionId ? 'resume' : checkpoint ? 'recovery' : 'fresh';
    const lastFailure = store
      .listExecutions(task.id)
      .filter((e) => e.id !== execution.id)
      .at(-1);
    const assignment = getAssignment(store, projectId);
    const prompt = buildPrompt({
      task,
      project,
      checkpoint,
      git,
      memory: loadMemory(store, projectId),
      mode,
      sessionLossReason: mode === 'recovery' ? (lastFailure?.retryReason ?? 'no stored session') : null,
      projectContext: assignment ? renderProjectContext(buildProjectContext(store, projectId)) : undefined,
      integrityNotes,
    });
    const approvedActionTypes = [
      ...new Set([
        ...store
          .listApprovals('APPROVED')
          .filter((a) => a.taskId === task.id)
          .map((a) => a.actionType),
        ...(assignment?.approvalPolicy.preApproved ?? []),
      ]),
    ];
    const perExec = [
      config.maxBudgetUsdPerExecution > 0 ? config.maxBudgetUsdPerExecution : undefined,
      assignment?.budget.maxUsdPerExecution,
    ].filter((x): x is number => x !== undefined);
    const attemptIndex = store.listExecutions(task.id).length; // includes this execution => 1-based

    // Hard ceiling on one execution. Suspended while the provider reports an official capacity wait (the worker is
    // alive and waiting for a usage reset, which can take hours); re-armed with a fresh budget when the wait ends.
    let hardTimer: NodeJS.Timeout | undefined = setTimeout(
      () => abort.abort(),
      config.workerTimeoutMs + 10_000,
    );
    const suspendHardTimer = () => {
      if (hardTimer) clearTimeout(hardTimer);
      hardTimer = undefined;
    };
    const rearmHardTimer = () => {
      suspendHardTimer();
      hardTimer = setTimeout(() => abort.abort(), config.workerTimeoutMs + 10_000);
    };
    execLog.append({ kind: 'start', mode, attemptIndex, resumeSessionId: task.sessionId, integrityNotes });
    let lastActivityWrite = 0;
    let outcome: RunOutcome;
    try {
      outcome = await provider.run({
        executionId: execution.id,
        taskId: task.id,
        taskTitle: task.title,
        prompt,
        systemAppend: task.readOnly ? PLANNING_APPEND : SYSTEM_APPEND,
        readOnly: task.readOnly,
        cwd,
        resumeSessionId: task.sessionId ?? undefined,
        approvedActionTypes,
        alsoRequireApproval: assignment?.approvalPolicy.alsoRequire ?? [],
        attemptIndex,
        limits: {
          maxTurns: config.maxTurnsPerExecution,
          maxBudgetUsd: perExec.length ? Math.min(...perExec) : undefined,
          timeoutMs: config.workerTimeoutMs,
        },
        signal: abort.signal,
        onSession: (id) => {
          store.recordSession(execution.id, task.id, id);
          execLog.append({ kind: 'session', sessionId: id });
        },
        onProcess: (pid) => store.setExecutionWorkerPid(execution.id, pid),
        onEvent: (ev) => {
          execLog.append({ kind: ev.type, ...ev.data });
          const t = store.clock.now();
          if (t - lastActivityWrite > 5_000) {
            lastActivityWrite = t;
            store.touchExecutionActivity(execution.id);
          }
          if (ev.type === 'capacity_wait') {
            const waiting = ev.data['waiting'] === true;
            if (waiting) suspendHardTimer();
            else rearmHardTimer();
            store.setExecutionCapacityWait(
              execution.id,
              waiting
                ? {
                    since: store.clock.now(),
                    reason: String(ev.data['reason'] ?? 'usage limit'),
                    resetsAt: typeof ev.data['resetsAtMs'] === 'number' ? ev.data['resetsAtMs'] : null,
                    recheckAt: typeof ev.data['recheckAtMs'] === 'number' ? ev.data['recheckAtMs'] : null,
                  }
                : null,
            );
            store.recordEvent({
              type: waiting ? 'provider.capacity_wait_started' : 'provider.capacity_wait_ended',
              projectId,
              taskId: task.id,
              executionId: execution.id,
              severity: waiting ? 'warn' : 'info',
              payload: ev.data,
            });
            return;
          }
          if (ev.type === 'permission_denied' || ev.type === 'rate_limit' || ev.type === 'retry') {
            store.recordEvent({
              type: `provider.${ev.type}`,
              projectId,
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
      suspendHardTimer();
      store.setExecutionCapacityWait(execution.id, null);
    }

    if (isLeaseLost() && outcome.kind === 'failed' && outcome.failure.errorClass === 'INTERRUPTED') {
      xlog.warn('worker.lease_lost', { note: 'task was cancelled or reclaimed; discarding result' });
      store.recordEvent({
        type: 'worker.terminated',
        projectId,
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

    // "Claude says it is done" is a claim. Run required independent checks before accepting it.
    if (outcome.kind === 'completed') {
      store.addEvidence({
        projectId,
        taskId: task.id,
        level: 'CLAIMED_COMPLETE',
        status: 'PASSED',
        summary: 'provider reported success (a claim, not proof)',
        evidence: {
          summary: outcome.summary.slice(0, 1000),
          sessionId: outcome.sessionId ?? null,
          deniedToolCalls: (outcome.denials ?? []).map((d) => ({ tool: d.tool, reason: d.reason })),
        },
      });
      if (outcome.denials?.length) {
        // Success claimed although some actions were refused: the work may be incomplete. Flag it, do not hide it.
        store.recordEvent({
          type: 'task.completed_with_denials',
          projectId,
          taskId: task.id,
          executionId: execution.id,
          severity: 'warn',
          payload: { denied: outcome.denials.map((d) => `${d.tool}: ${d.reason}`).slice(0, 10) },
        });
      }
      const { failed } = await verifyTask(
        { store, timeoutMs: config.verifyCommandTimeoutMs },
        project,
        task,
        cwd,
      );
      if (failed.length) {
        outcome = {
          kind: 'failed',
          sessionId: outcome.sessionId,
          usage: outcome.usage,
          summary: outcome.summary,
          failure: {
            errorClass: 'TASK_FAILURE',
            message: `verification failed after the provider reported success: ${failed.map((f) => `${f.level} (${f.summary})`).join('; ')}`,
          },
        };
        execLog.append({ kind: 'verification_failed', levels: failed.map((f) => f.level) });
      }
    }
    await this.finish(task, execution, outcome, false, execLog, abort.signal);
  }

  private async finish(
    task: Task,
    execution: ExecutionRecord,
    outcome: RunOutcome,
    workspaceProblem: boolean,
    execLog: ExecutionLog,
    signal: AbortSignal,
  ): Promise<void> {
    void signal;
    const { store, config, log, provider } = this.d;
    const project = store.getProject(task.projectId)!;
    const current = store.requireTask(task.id);
    // Fencing: only the execution that owns the lease may finish. Duplicate/late completions are ignored.
    if (current.leaseExecutionId !== execution.id || current.status !== 'RUNNING') {
      log.warn('worker.finish_skipped', {
        taskId: task.id,
        executionId: execution.id,
        status: current.status,
        note: 'lease no longer held or already finished (duplicate/late completion ignored)',
      });
      store.recordEvent({
        type: 'worker.duplicate_completion_ignored',
        projectId: project.id,
        taskId: task.id,
        executionId: execution.id,
        severity: 'warn',
        payload: { status: current.status },
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
    const testResults = 'testResults' in outcome ? (outcome.testResults ?? null) : null;

    const git = await gitState(project.repoPath);
    try {
      store.db
        .transaction(() => {
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
            fenceExecutionId: execution.id,
          });
          store.addCheckpoint({
            projectId: project.id,
            taskId: task.id,
            executionId: execution.id,
            sessionRef: sessionId,
            repoRef: git.head ? `${git.branch ?? 'detached'}@${git.head}` : null,
            gitDirty: git.isRepo ? git.dirty : null,
            completedSummary: summary,
            outstandingSummary:
              outstanding + (git.dirty ? `\nUncommitted changes: ${git.changes.length}` : ''),
            testResults,
            nextAction,
          });
        })
        .immediate();
    } catch (err) {
      if (err instanceof StaleLeaseError) {
        log.warn('worker.finish_stale', { taskId: task.id, executionId: execution.id });
        return;
      }
      throw err;
    }
    execLog.append({ kind: 'checkpoint_written' });
    this.applyDecision(task.id, project.id, execution.id, provider.name, outcome, decision, summary);
  }

  /**
   * Second durable step: CHECKPOINTING -> final state. Idempotent: if the task already left CHECKPOINTING
   * (duplicate completion event, or reconciliation got there first) this is a recorded no-op.
   */
  applyDecision(
    taskId: string,
    projectId: string,
    executionId: string,
    providerName: string,
    outcome: RunOutcome,
    decision: Decision,
    summary: string,
  ): boolean {
    const { store, log, config } = this.d;
    const applied = store.db
      .transaction(() => {
        const cur = store.requireTask(taskId);
        if (cur.status !== 'CHECKPOINTING' || cur.leaseExecutionId !== executionId) {
          store.recordEvent({
            type: 'worker.duplicate_completion_ignored',
            projectId,
            taskId,
            executionId,
            severity: 'warn',
            payload: { status: cur.status, phase: 'apply' },
          });
          return false;
        }
        const evidence =
          decision.next === 'COMPLETED'
            ? `${summary.slice(0, 1500)} [execution ${executionId}${'testResults' in outcome && outcome.testResults ? `; tests: ${outcome.testResults}` : ''}; verification: ${
                store
                  .listEvidence({ taskId })
                  .map((e) => `${e.level}=${e.status}`)
                  .join(', ') || 'none required'
              }]`
            : undefined;
        store.transition(taskId, decision.next, {
          reason: decision.reason,
          executionId,
          expectedFrom: 'CHECKPOINTING',
          fenceExecutionId: executionId,
          patch: {
            nextEligibleAt: decision.nextEligibleAt,
            lastErrorClass: decision.errorClass,
            lastErrorMessage: decision.errorMessage,
            incrementAttempt: decision.consumesAttempt,
            incrementContinuation: decision.countsContinuation,
            resetInterruptions: decision.resetInterruptions,
            providerFailureStreak: decision.providerFailureStreak,
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
            types.set('unspecified', {
              tool: 'unknown',
              reason: decision.errorMessage ?? 'permission denied',
            });
          for (const [type, d] of types)
            store.createApproval({
              projectId,
              taskId,
              actionType: type,
              description: d.reason,
              payload: { tool: d.tool, input: d.input },
            });
        }
        if (decision.escalated) {
          store.recordEvent({
            type: 'task.escalated',
            projectId,
            taskId,
            executionId,
            severity: 'error',
            payload: { reason: decision.reason, errorClass: decision.errorClass },
          });
        }
        if (decision.next === 'COMPLETED' && outcome.kind === 'completed') {
          store.saveTaskOutput(taskId, executionId, outcome.summary);
        }
        if (decision.next === 'COMPLETED')
          store.updateProject(projectId, {
            progressSummary: `Last completed: ${store.requireTask(taskId).title}`,
          });
        return true;
      })
      .immediate();
    void config;
    if (!applied) return false;
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
    return true;
  }
}
