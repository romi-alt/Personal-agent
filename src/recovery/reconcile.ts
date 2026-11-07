import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { writeCheckpoint } from '../checkpoints/writer.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/logger.js';
import type { RunOutcome } from '../providers/types.js';
import { pidAlive, type Store } from '../queue/store.js';
import type { TaskRunner } from '../workers/runner.js';
import { stopOrphanWorker } from '../workers/process-tree.js';
import type { ExecutionRecord, Task } from '../types/index.js';
import { decide } from './decide.js';
import type { WorkspaceRegistry } from '../workspaces/registry.js';

export interface ReconcileAction {
  taskId: string;
  title: string;
  previousStatus: string;
  action:
    | 'escalated_repeated_interruption'
    | 'completed_from_evidence'
    | 'reapplied_outcome'
    | 'requeued_interrupted'
    | 'blocked_workspace_missing'
    | 'skipped_live_lease';
  detail: string;
}

export interface ReconcileOptions {
  /**
   * 'startup': the supervisor singleton lock proves no other supervisor is alive, so every task still
   * RUNNING/CHECKPOINTING is orphaned. 'sweep': only leases that have expired are reclaimed.
   */
  mode: 'startup' | 'sweep';
  store: Store;
  config: AppConfig;
  log: Logger;
  runner: TaskRunner;
  registry: WorkspaceRegistry;
  providerName: string;
  /** Executions currently running inside THIS process; the lease sweep must never reclaim these. */
  isLocallyActive?: (executionId: string) => boolean;
}

/** Last terminal `result` record in an execution transcript, if the process died after the provider returned. */
function readTranscriptResult(logRef: string | null): { outcome: string; summary?: string } | null {
  if (!logRef || !existsSync(logRef)) return null;
  try {
    const lines = readFileSync(logRef, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = JSON.parse(lines[i]!) as { kind?: string; outcome?: string; summary?: string };
      if (rec.kind === 'result' && rec.outcome) return { outcome: rec.outcome, summary: rec.summary };
    }
  } catch {
    /* corrupt/partial last line: treat as no evidence */
  }
  return null;
}

/** Reconcile leases/executions after an unclean stop. Idempotent. Never overwrites COMPLETED work. */
export async function reconcileOrphans(o: ReconcileOptions): Promise<ReconcileAction[]> {
  const { store, log } = o;
  const now = store.clock.now();
  const actions: ReconcileAction[] = [];

  for (const task of store.listActiveTasks()) {
    const live = task.leaseExpiresAt !== null && task.leaseExpiresAt > now;
    if (o.mode === 'sweep' && live) continue;
    const exec = store.latestExecution(task.id);
    // A worker in this very process that merely missed heartbeats (e.g. a long event-loop stall) is not orphaned.
    if (o.mode === 'sweep' && exec && o.isLocallyActive?.(exec.id)) {
      log.warn('recovery.lease_expired_but_worker_alive', { taskId: task.id, executionId: exec.id });
      continue;
    }
    const project = store.getProject(task.projectId)!;
    const staleWorkerAlive =
      !!exec?.pid && exec.host === hostname() && exec.pid !== process.pid && pidAlive(exec.pid);
    if (staleWorkerAlive) {
      log.warn('recovery.stale_process_alive', {
        taskId: task.id,
        pid: exec!.pid,
        note: 'previous worker pid still exists; lease reclaimed after expiry/startup lock',
      });
    }

    // A provider child process (native CLI worker) outlives a killed supervisor on Windows. Stop it before anything is
    // re-dispatched: a replacement execution must never run alongside the old session in the same workspace.
    if (exec?.workerPid && exec.host === hostname()) {
      const r = await stopOrphanWorker(exec.workerPid);
      store.setExecutionWorkerPid(exec.id, null);
      if (r === 'terminated') {
        log.warn('recovery.orphan_worker_terminated', { taskId: task.id, pid: exec.workerPid });
        store.recordEvent({
          type: 'recovery.orphan_worker_terminated',
          projectId: project.id,
          taskId: task.id,
          executionId: exec.id,
          severity: 'warn',
          payload: { pid: exec.workerPid },
        });
      }
    }

    // Case 1: the provider outcome was already persisted (crash between the two durable steps).
    if (task.status === 'CHECKPOINTING' && exec?.outcome) {
      actions.push(await reapply(o, task, exec));
      continue;
    }

    // Case 2: provider returned a terminal success (recorded in the transcript) but the queue was not updated.
    const transcript = readTranscriptResult(exec?.logRef ?? null);
    if (exec && transcript?.outcome === 'completed' && !exec.outcome) {
      store.db.transaction(() => {
        store.endExecution(exec.id, {
          outcome: 'completed',
          summary: transcript.summary ?? 'recovered from transcript',
        });
        if (task.status === 'RUNNING')
          store.transition(task.id, 'CHECKPOINTING', {
            reason: 'recovery: provider success found in transcript',
            executionId: exec.id,
          });
        store.transition(task.id, 'COMPLETED', {
          reason: 'recovery: provider reported success before interruption',
          executionId: exec.id,
          patch: {
            completionEvidence: `Recovered from execution transcript ${exec.logRef}: ${(transcript.summary ?? '').slice(0, 500)}`,
            lastErrorClass: null,
            lastErrorMessage: null,
            nextEligibleAt: null,
            resetInterruptions: true,
          },
        });
      })();
      const a: ReconcileAction = {
        taskId: task.id,
        title: task.title,
        previousStatus: task.status,
        action: 'completed_from_evidence',
        detail: `transcript ${exec.logRef}`,
      };
      store.recordEvent({
        type: 'recovery.task_reconciled',
        projectId: project.id,
        taskId: task.id,
        executionId: exec.id,
        payload: { ...a },
      });
      actions.push(a);
      continue;
    }

    // Case 3: genuinely interrupted. Preserve a recoverable checkpoint of the working tree + session reference.
    if (exec && !exec.outcome) {
      store.endExecution(exec.id, {
        outcome: 'interrupted',
        errorClass: 'INTERRUPTED',
        retryReason: 'supervisor/worker terminated before completing',
        summary: 'interrupted',
      });
    }
    const dirOk = existsSync(project.repoPath) && o.registry.isApproved(project.repoPath);
    const cp = dirOk
      ? await writeCheckpoint(store, {
          task,
          project,
          executionId: exec?.id ?? null,
          sessionRef: task.sessionId,
          completedSummary:
            store.latestValidCheckpoint(task.id).checkpoint?.completedSummary ??
            'No completed-work summary was recorded before interruption.',
          outstandingSummary:
            'Execution was interrupted by a crash or restart; inspect the working tree (git status/diff) and continue the unfinished work.',
          nextAction: 'resume the task, verifying existing artifacts first',
        })
      : null;
    if (!dirOk) {
      store.transition(task.id, 'READY', { reason: 'recovery: interrupted', executionId: exec?.id ?? null });
      store.transition(task.id, 'BLOCKED', {
        reason: `recovery: project directory ${project.repoPath} missing or not approved`,
        patch: { lastErrorMessage: 'workspace missing after interruption' },
      });
      const a: ReconcileAction = {
        taskId: task.id,
        title: task.title,
        previousStatus: task.status,
        action: 'blocked_workspace_missing',
        detail: project.repoPath,
      };
      store.recordEvent({
        type: 'recovery.task_reconciled',
        projectId: project.id,
        taskId: task.id,
        severity: 'error',
        payload: { ...a },
      });
      actions.push(a);
      continue;
    }
    // Poison-task guard: a task that keeps killing its worker is escalated, not retried forever.
    if (task.interruptionCount + 1 > o.config.maxInterruptions) {
      store.transition(task.id, 'READY', {
        reason: 'recovery: interrupted',
        executionId: exec?.id ?? null,
        patch: { incrementInterruption: true, lastCheckpointId: cp?.id },
      });
      store.transition(task.id, 'BLOCKED', {
        reason: `interrupted ${task.interruptionCount + 1} times in a row (limit ${o.config.maxInterruptions}); escalated to owner`,
        patch: { lastErrorClass: 'INTERRUPTED', lastErrorMessage: 'repeated crash/restart during execution' },
      });
      store.recordEvent({
        type: 'task.escalated',
        projectId: project.id,
        taskId: task.id,
        executionId: exec?.id ?? null,
        severity: 'error',
        payload: { reason: 'repeated interruptions', count: task.interruptionCount + 1 },
      });
      const esc: ReconcileAction = {
        taskId: task.id,
        title: task.title,
        previousStatus: task.status,
        action: 'escalated_repeated_interruption',
        detail: `${task.interruptionCount + 1} consecutive interruptions`,
      };
      store.recordEvent({
        type: 'recovery.task_reconciled',
        projectId: project.id,
        taskId: task.id,
        severity: 'error',
        payload: { ...esc },
      });
      actions.push(esc);
      continue;
    }
    store.transition(task.id, 'READY', {
      reason:
        o.mode === 'startup'
          ? 'recovery: supervisor restarted; resuming interrupted task'
          : 'recovery: lease expired; resuming interrupted task',
      executionId: exec?.id ?? null,
      patch: {
        nextEligibleAt: null,
        lastErrorClass: 'INTERRUPTED',
        lastErrorMessage: 'interrupted by crash/restart',
        lastCheckpointId: cp?.id,
        incrementInterruption: true,
      },
    });
    const a: ReconcileAction = {
      taskId: task.id,
      title: task.title,
      previousStatus: task.status,
      action: 'requeued_interrupted',
      detail: `checkpoint ${cp?.id}; session ${task.sessionId ?? 'none'} will be ${task.sessionId ? 'resumed (new session if invalid)' : 'rebuilt from persisted context'}`,
    };
    store.recordEvent({
      type: 'recovery.task_reconciled',
      projectId: project.id,
      taskId: task.id,
      executionId: exec?.id ?? null,
      severity: 'warn',
      payload: { ...a },
    });
    actions.push(a);
  }

  if (actions.length)
    store.recordEvent({ type: 'recovery.completed', payload: { mode: o.mode, count: actions.length } });
  return actions;
}

async function reapply(o: ReconcileOptions, task: Task, exec: ExecutionRecord): Promise<ReconcileAction> {
  const { store } = o;
  const project = store.getProject(task.projectId)!;
  const summary = exec.summary ?? '';
  const kind = exec.outcome === 'completed' ? 'completed' : exec.outcome === 'partial' ? 'partial' : 'failed';
  const failure =
    kind === 'failed'
      ? { errorClass: exec.errorClass ?? ('INTERRUPTED' as const), message: summary || 'recovered failure' }
      : undefined;
  const decision = decide({
    task,
    kind,
    failure,
    resumed: !!exec.resumedFromSessionId,
    providerState: store.getProviderState(o.providerName),
    now: store.clock.now(),
    config: o.config,
  });
  const outcome: RunOutcome =
    kind === 'completed'
      ? { kind, summary }
      : kind === 'partial'
        ? { kind, summary }
        : { kind: 'failed', failure: failure!, summary };
  o.runner.applyDecision(task.id, project.id, exec.id, o.providerName, outcome, decision, summary);
  const a: ReconcileAction = {
    taskId: task.id,
    title: task.title,
    previousStatus: task.status,
    action: 'reapplied_outcome',
    detail: `execution ${exec.id} outcome ${exec.outcome} -> ${decision.next}`,
  };
  store.recordEvent({
    type: 'recovery.task_reconciled',
    projectId: project.id,
    taskId: task.id,
    executionId: exec.id,
    payload: { ...a },
  });
  return a;
}
