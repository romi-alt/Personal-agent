import type { Store } from '../queue/store.js';
import type { WorkflowRepository } from '../workflows/repository.js';

/**
 * The owner inbox: everything that is waiting for a HUMAN decision or intervention, in one place, derived from
 * durable state (nothing is stored separately, so it can never go stale or diverge from reality).
 * Each item names the exact command(s) that resolve it.
 */
export type InboxSeverity = 'high' | 'medium' | 'low';
export type InboxKind =
  | 'PERMISSION_APPROVAL'
  | 'PLAN_APPROVAL'
  | 'CLARIFICATION_QUESTION'
  | 'TASK_ESCALATION'
  | 'TASK_FAILED'
  | 'PROJECT_ACCEPTANCE'
  | 'PROJECT_VERIFICATION_NEEDED'
  | 'PROJECT_BLOCKED'
  | 'WORKFLOW_FAILED'
  | 'CREDENTIALS_NEEDED'
  | 'BUDGET_HELD';

export interface InboxItem {
  /** Stable identifier (kind + subject): the same pending decision always has the same key. */
  key: string;
  kind: InboxKind;
  severity: InboxSeverity;
  projectId: string | null;
  projectSlug: string | null;
  taskId: string | null;
  title: string;
  detail: string;
  since: number;
  /** Commands that resolve the item. */
  actions: string[];
}

const SEVERITY_ORDER: Record<InboxSeverity, number> = { high: 0, medium: 1, low: 2 };

export function buildInbox(
  store: Store,
  repo: WorkflowRepository,
  filter: { projectId?: string } = {},
): InboxItem[] {
  const items: InboxItem[] = [];
  const slug = (id: string | null) => (id ? (store.getProject(id)?.slug ?? null) : null);
  const inScope = (projectId: string | null) => !filter.projectId || projectId === filter.projectId;

  // Pending approvals (permission-gated actions and plan approvals)
  for (const a of store.listApprovals('PENDING')) {
    if (!inScope(a.projectId)) continue;
    const isPlan = a.actionType === 'plan_approval';
    items.push({
      key: `approval:${a.id}`,
      kind: isPlan ? 'PLAN_APPROVAL' : 'PERMISSION_APPROVAL',
      severity: 'medium',
      projectId: a.projectId,
      projectSlug: slug(a.projectId),
      taskId: a.taskId,
      title: isPlan ? 'Approve the execution plan' : `Approve action: ${a.actionType}`,
      detail: a.description,
      since: a.requestedAt,
      actions: [`approve ${a.id}`, `deny ${a.id}`],
    });
  }

  // Workflow runs waiting on the owner or failed
  for (const run of repo.listRuns()) {
    if (!inScope(run.projectId)) continue;
    if (run.status === 'WAITING_FOR_OWNER' && run.context.phase === 'clarify') {
      for (const q of run.context.questions.filter((x) => x.blocking && !run.context.answers[x.id])) {
        items.push({
          key: `question:${run.id}:${q.id}`,
          kind: 'CLARIFICATION_QUESTION',
          severity: 'medium',
          projectId: run.projectId,
          projectSlug: slug(run.projectId),
          taskId: null,
          title: `Question blocks planning: ${q.id}`,
          detail: q.text,
          since: run.updatedAt,
          actions: [
            `workflow:answer ${run.id} --question ${q.id} --text "<answer>"`,
            `workflow:resume ${run.id} --assume`,
          ],
        });
      }
    }
    if (run.status === 'FAILED') {
      const project = store.getProject(run.projectId);
      // Only surface a failure that has not been superseded by a newer run
      const newer = repo.listRuns({ projectId: run.projectId }).at(-1)?.id !== run.id; // listRuns is in creation order
      if (!newer && project) {
        items.push({
          key: `workflow-failed:${run.id}`,
          kind: 'WORKFLOW_FAILED',
          severity: 'high',
          projectId: run.projectId,
          projectSlug: project.slug,
          taskId: null,
          title: 'Planning workflow failed',
          detail: run.error ?? 'unknown error',
          since: run.updatedAt,
          actions: [`workflow:show ${run.id}`, `plan:start ${project.slug}`],
        });
      }
    }
  }

  // Tasks needing intervention
  for (const t of store.listTasks({ statuses: ['BLOCKED', 'FAILED'] })) {
    if (!inScope(t.projectId)) continue;
    const planning = t.kind === 'PLANNING';
    if (planning && repo.listRuns({ projectId: t.projectId }).every((r) => r.status !== 'RUNNING')) continue; // run already ended
    items.push({
      key: `task:${t.id}`,
      kind: t.status === 'BLOCKED' ? 'TASK_ESCALATION' : 'TASK_FAILED',
      severity: 'high',
      projectId: t.projectId,
      projectSlug: slug(t.projectId),
      taskId: t.id,
      title: `${t.status === 'BLOCKED' ? 'Blocked' : 'Failed'}: ${t.title}`,
      detail: `${t.lastErrorClass ?? 'no class'}: ${t.lastErrorMessage ?? 'no detail'}`,
      since: t.updatedAt,
      actions:
        t.status === 'BLOCKED'
          ? [`task:show ${t.id}`, `task:unblock ${t.id}`, `task:cancel ${t.id}`]
          : [`task:show ${t.id}`, `task:retry ${t.id}`, `task:cancel ${t.id}`],
    });
  }

  // Project-level decisions
  for (const p of store.listProjects()) {
    if (!inScope(p.id)) continue;
    if (p.lifecycle === 'AWAITING_OWNER_APPROVAL') {
      items.push({
        key: `accept:${p.id}`,
        kind: 'PROJECT_ACCEPTANCE',
        severity: 'medium',
        projectId: p.id,
        projectSlug: p.slug,
        taskId: null,
        title: `Accept or reject project: ${p.name}`,
        detail:
          'Independent verification was run; the owner decides (unverified levels need an explicit acknowledgement).',
        since: p.updatedAt,
        actions: [`project:status ${p.slug}`, `project:accept ${p.slug} [--acknowledge-unverified "why"]`],
      });
    } else if (p.lifecycle === 'VERIFYING') {
      items.push({
        key: `verify:${p.id}`,
        kind: 'PROJECT_VERIFICATION_NEEDED',
        severity: 'low',
        projectId: p.id,
        projectSlug: p.slug,
        taskId: null,
        title: `All tasks finished - verification needed: ${p.name}`,
        detail: 'Every task is terminal. Run independent verification before the project can be accepted.',
        since: p.updatedAt,
        actions: [`project:verify ${p.slug}`],
      });
    } else if (p.lifecycle === 'BLOCKED') {
      items.push({
        key: `blocked:${p.id}`,
        kind: 'PROJECT_BLOCKED',
        severity: 'high',
        projectId: p.id,
        projectSlug: p.slug,
        taskId: null,
        title: `Project blocked: ${p.name}`,
        detail: store.listProjectTransitions(p.id).at(-1)?.reason ?? 'blocked',
        since: p.updatedAt,
        actions: [`project:status ${p.slug}`, `plan:start ${p.slug}`],
      });
    }
    if (
      store.projectOverBudget(p.id) &&
      store.listTasks({ projectId: p.id, statuses: ['QUEUED', 'READY', 'RETRY_SCHEDULED'] }).length > 0
    ) {
      items.push({
        key: `budget:${p.id}`,
        kind: 'BUDGET_HELD',
        severity: 'medium',
        projectId: p.id,
        projectSlug: p.slug,
        taskId: null,
        title: `Budget reached; work is on hold: ${p.name}`,
        detail: `Estimated spend $${store.projectSpend(p.id).toFixed(2)} reached the assignment's limit. Raise the budget in the assignment or accept the current state.`,
        since: p.updatedAt,
        actions: [`assignment:show ${p.slug}`, `project:status ${p.slug}`],
      });
    }
  }

  // Provider needs credentials (global)
  if (!filter.projectId) {
    const waiting = store.listTasks({ statuses: ['WAITING_FOR_AUTHENTICATION'] });
    if (waiting.length > 0) {
      items.push({
        key: 'credentials',
        kind: 'CREDENTIALS_NEEDED',
        severity: 'high',
        projectId: null,
        projectSlug: null,
        taskId: null,
        title: `Credentials needed: ${waiting.length} task(s) waiting for authentication`,
        detail:
          'Provider authentication is not ready (missing/rejected key, or paid-API authorisation or budget not configured).',
        since: Math.min(...waiting.map((t) => t.updatedAt)),
        actions: ['provider:status', 'doctor'],
      });
    }
  }

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.since - b.since);
}
