import type { Store } from '../queue/store.js';
import type { Approval, Task, TaskStatus } from '../types/index.js';

/**
 * Owner controls shared by the CLI and the command center, so both apply identical semantics and both leave an audit
 * trail (activity events carry the actor and channel).
 */
export type TaskAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'unblock';

const TASK_ACTIONS: Record<TaskAction, [TaskStatus, string]> = {
  pause: ['PAUSED', 'paused by owner'],
  resume: ['READY', 'resumed by owner'],
  cancel: ['CANCELLED', 'cancelled by owner'],
  retry: ['QUEUED', 'manual retry by owner'],
  unblock: ['READY', 'unblocked by owner'],
};

export interface Actor {
  by: string;
  channel: 'cli' | 'dashboard';
  /** Remote address for dashboard actions (audit). */
  address?: string;
}

const audit = (
  store: Store,
  type: string,
  actor: Actor,
  payload: Record<string, unknown>,
  ids: { projectId?: string | null; taskId?: string | null } = {},
) =>
  store.recordEvent({
    type,
    projectId: ids.projectId ?? null,
    taskId: ids.taskId ?? null,
    payload: { ...payload, by: actor.by, channel: actor.channel, address: actor.address ?? null },
  });

export function taskAction(store: Store, taskId: string, action: TaskAction, actor: Actor): Task {
  const t = store.getTask(taskId);
  if (!t) throw new Error(`unknown task ${taskId}`);
  const [to, reason] = TASK_ACTIONS[action];
  const patch =
    action === 'retry'
      ? { resetAttempts: true, nextEligibleAt: null, lastErrorClass: null, lastErrorMessage: null }
      : action === 'unblock'
        ? { nextEligibleAt: null, resetInterruptions: true, providerFailureStreak: 0 }
        : { nextEligibleAt: null };
  const r = store.transition(t.id, to, { reason: `${reason} (${actor.channel})`, patch });
  audit(
    store,
    'owner.task_action',
    actor,
    { action, from: t.status, to: r.status },
    { projectId: t.projectId, taskId: t.id },
  );
  return r;
}

export function setTaskPriority(store: Store, taskId: string, priority: number, actor: Actor): Task {
  const t = store.getTask(taskId);
  if (!t) throw new Error(`unknown task ${taskId}`);
  if (!Number.isInteger(priority) || priority < -10_000 || priority > 10_000)
    throw new Error('priority must be an integer between -10000 and 10000');
  store.db
    .prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?')
    .run(priority, store.clock.now(), taskId);
  audit(
    store,
    'owner.task_priority',
    actor,
    { from: t.priority, to: priority },
    { projectId: t.projectId, taskId },
  );
  return store.requireTask(taskId);
}

export function setProjectState(
  store: Store,
  projectId: string,
  state: 'ACTIVE' | 'PAUSED',
  actor: Actor,
): void {
  const p = store.getProject(projectId);
  if (!p) throw new Error(`unknown project ${projectId}`);
  store.updateProject(projectId, { status: state });
  audit(
    store,
    state === 'PAUSED' ? 'owner.project_paused' : 'owner.project_resumed',
    actor,
    { from: p.status, to: state },
    { projectId },
  );
}

export function setProjectPriority(store: Store, projectId: string, priority: number, actor: Actor): void {
  const p = store.getProject(projectId);
  if (!p) throw new Error(`unknown project ${projectId}`);
  if (!Number.isInteger(priority) || priority < -10_000 || priority > 10_000)
    throw new Error('priority must be an integer between -10000 and 10000');
  store.updateProject(projectId, { priority });
  audit(store, 'owner.project_priority', actor, { from: p.priority, to: priority }, { projectId });
}

/**
 * Decide an approval and apply its effect on a task waiting for it (same as `approve`/`deny` in the CLI).
 * Workflow/QA approvals are picked up by their engines on the next supervisor tick.
 */
export function decideApproval(
  store: Store,
  approvalId: string,
  decision: 'APPROVED' | 'DENIED',
  actor: Actor,
  note?: string,
): Approval {
  const a = store.decideApproval(approvalId, decision, actor.by);
  if (a.taskId) {
    const open = store.listApprovals('PENDING').filter((x) => x.taskId === a.taskId);
    const t = store.requireTask(a.taskId);
    if (t.status === 'WAITING_FOR_APPROVAL' && open.length === 0) {
      store.transition(t.id, decision === 'APPROVED' ? 'READY' : 'BLOCKED', {
        reason:
          decision === 'APPROVED' ? 'owner approved requested action(s)' : 'owner denied requested action',
        patch: { nextEligibleAt: null },
      });
    }
  }
  audit(
    store,
    'owner.approval_decided',
    actor,
    { approvalId, actionType: a.actionType, decision, note: note?.slice(0, 1000) ?? null },
    { projectId: a.projectId, taskId: a.taskId },
  );
  return a;
}
