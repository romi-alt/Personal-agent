import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { getAssignment } from '../assignments/register.js';
import type { App } from '../core/app.js';
import { projectRoadmap } from '../planning/roadmap-service.js';
import { buildStatus, type StatusReport } from '../supervisor/status.js';
import { TASK_STATUSES } from '../types/index.js';
import { deliveryReadiness } from '../verification/service.js';

const execFileP = promisify(execFile);

/**
 * Command-center read models. Everything shown in the dashboard comes from these functions, and these functions only
 * read the database / repository: no metric is computed from anything but recorded state.
 */
let statusCache: { at: number; value: StatusReport } | null = null;
/** Provider preflight runs `claude auth status` (a process spawn): cache it briefly. */
export async function systemStatus(app: App, maxAgeMs = 15_000): Promise<StatusReport> {
  if (statusCache && Date.now() - statusCache.at < maxAgeMs) return statusCache.value;
  const value = await buildStatus(app.store, app.provider, app.config.leaseTtlMs);
  statusCache = { at: Date.now(), value };
  return value;
}
export function invalidateStatus(): void {
  statusCache = null;
}

function taskCounts(app: App, projectId?: string): Record<string, number> {
  const rows = app.store.db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM tasks ${projectId ? 'WHERE project_id = ?' : ''} GROUP BY status`,
    )
    .all(...(projectId ? [projectId] : [])) as { status: string; n: number }[];
  const out: Record<string, number> = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function overview(app: App) {
  const { store, workflows } = app;
  const status = await systemStatus(app);
  const projects = store.listProjects().map((p) => {
    const roadmap = projectRoadmap(store, workflows.repo, p.id);
    const counts = taskCounts(app, p.id);
    const next = roadmap.milestones.find(
      (m) => (roadmap.progress.milestones.find((g) => g.key === m.key)?.ratio ?? 0) < 1,
    );
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      lifecycle: p.lifecycle,
      status: p.status,
      priority: p.priority,
      lastActivityAt: p.lastActivityAt,
      planned: roadmap.tasks.length > 0,
      progress: roadmap.progress.overall,
      counts,
      nextMilestone: next
        ? {
            key: next.key,
            title: next.title,
            progress: roadmap.progress.milestones.find((g) => g.key === next.key) ?? null,
          }
        : null,
    };
  });
  const totals = taskCounts(app);
  const pendingApprovals = store.listApprovals('PENDING');
  return {
    generatedAt: Date.now(),
    system: status,
    totals: {
      activeProjects: projects.filter(
        (p) => !['DELIVERED', 'CANCELLED', 'READY_FOR_DELIVERY'].includes(p.lifecycle),
      ).length,
      completedProjects: projects.filter((p) => ['DELIVERED', 'READY_FOR_DELIVERY'].includes(p.lifecycle))
        .length,
      queued: (totals['QUEUED'] ?? 0) + (totals['READY'] ?? 0) + (totals['RETRY_SCHEDULED'] ?? 0),
      running: (totals['RUNNING'] ?? 0) + (totals['CHECKPOINTING'] ?? 0),
      waitingForCapacity: totals['WAITING_FOR_CAPACITY'] ?? 0,
      waitingForApproval: totals['WAITING_FOR_APPROVAL'] ?? 0,
      waitingForAuthentication: totals['WAITING_FOR_AUTHENTICATION'] ?? 0,
      blocked: totals['BLOCKED'] ?? 0,
      failed: totals['FAILED'] ?? 0,
      completed: totals['COMPLETED'] ?? 0,
      pendingApprovals: pendingApprovals.length,
    },
    byStatus: totals,
    projects,
    upcomingMilestones: projects
      .filter((p) => p.nextMilestone)
      .map((p) => ({ projectId: p.id, project: p.name, ...p.nextMilestone! })),
    recentActivity: store.listEvents({ limit: 40 }).reverse(),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  if (!existsSync(cwd)) return '';
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

export async function projectDetail(app: App, projectId: string) {
  const { store, workflows, qa } = app;
  const p = store.getProject(projectId);
  if (!p) return null;
  const tasks = store.listTasks({ projectId });
  const executions = tasks
    .flatMap((t) => store.listExecutions(t.id).map((e) => ({ ...e, taskTitle: t.title })))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 100);
  const checkpoints = tasks
    .map((t) => {
      const c = store.latestValidCheckpoint(t.id).checkpoint;
      return c
        ? {
            taskId: t.id,
            taskTitle: t.title,
            id: c.id,
            createdAt: c.createdAt,
            repoRef: c.repoRef,
            completed: c.completedSummary,
            outstanding: c.outstandingSummary,
            next: c.nextAction,
          }
        : null;
    })
    .filter(Boolean);
  const evidence = store.listEvidence({ projectId });
  const runs = workflows.repo.listRuns({ projectId });
  const lastRun = runs.at(-1);
  const reviews = lastRun ? workflows.repo.listReviews(lastRun.id) : [];
  const qaRows = qa.rows().filter((r) => tasks.some((t) => t.id === r.taskId));
  const [gitStatus, gitLog] = await Promise.all([
    git(p.repoPath, ['status', '--porcelain', '--untracked-files=all']),
    git(p.repoPath, ['log', '--oneline', '-n', '30']),
  ]);
  const outstanding = [
    ...tasks
      .filter((t) => ['BLOCKED', 'FAILED', 'WAITING_FOR_APPROVAL'].includes(t.status))
      .map((t) => ({
        kind: 'task',
        severity: t.status === 'FAILED' ? 'high' : 'medium',
        text: `${t.title}: ${t.status}${t.lastErrorMessage ? ` - ${t.lastErrorMessage}` : ''}`,
        taskId: t.id,
      })),
    ...evidence
      .filter((e) => e.status === 'FAILED')
      .slice(-20)
      .map((e) => ({
        kind: 'evidence',
        severity: 'high',
        text: `${e.level} FAILED: ${e.summary}`,
        taskId: e.taskId,
      })),
    ...qaRows
      .filter((r) => ['ESCALATED', 'OWNER_REJECTED'].includes(r.status))
      .map((r) => ({
        kind: 'qa',
        severity: 'high',
        text: `QA ${r.status} for ${store.getTask(r.taskId)?.title ?? r.taskId} (round ${r.round})`,
        taskId: r.taskId,
      })),
    ...(reviews.length
      ? reviews
          .filter((r) => r.round === Math.max(...reviews.map((x) => x.round)))
          .flatMap((r) =>
            r.issues
              .filter((i) => i.severity !== 'low')
              .map((i) => ({
                kind: 'plan_review',
                severity: i.severity,
                text: `${i.category}: ${i.description}`,
                taskId: null,
              })),
          )
      : []),
  ];
  return {
    project: p,
    assignment: getAssignment(store, projectId),
    documents: workflows.repo.listDocuments(projectId).map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      bytes: d.bytes,
      createdAt: d.createdAt,
      preview: d.kind === 'repo_profile' ? null : d.content.slice(0, 4000),
    })),
    requirements: workflows.repo.listRequirements(projectId),
    research: workflows.repo.listFindings(projectId),
    architecture: workflows.repo.latestSpec(projectId),
    adrs: workflows.repo.listAdrs(projectId),
    roadmap: projectRoadmap(store, workflows.repo, projectId),
    tasks,
    executions,
    checkpoints,
    git: {
      status: gitStatus.trim().split('\n').filter(Boolean),
      log: gitLog.trim().split('\n').filter(Boolean),
    },
    evidence,
    qa: qaRows.map((r) => ({
      ...r,
      taskTitle: store.getTask(r.taskId)?.title ?? '',
      result: qa.result(r.taskId, r.round),
    })),
    approvals: store.listApprovals().filter((a) => a.projectId === projectId),
    workflows: runs.map((r) => ({
      id: r.id,
      status: r.status,
      phase: r.context.phase,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      questions: r.context.questions,
    })),
    reviews,
    readiness: deliveryReadiness(store, projectId),
    lifecycle: store.listProjectTransitions(projectId),
    outstanding,
    activity: store.listEvents({ projectId, limit: 100 }).reverse(),
  };
}

/** Last lines of an execution transcript (already redacted when written). */
export function executionLog(app: App, executionId: string, maxLines = 300): { lines: unknown[] } | null {
  const row = app.store.db.prepare('SELECT log_ref FROM executions WHERE id = ?').get(executionId) as
    { log_ref: string | null } | undefined;
  if (!row?.log_ref || !existsSync(row.log_ref)) return row ? { lines: [] } : null;
  const lines = readFileSync(row.log_ref, 'utf8').trim().split('\n').slice(-maxLines);
  return {
    lines: lines.map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return { raw: l.slice(0, 2000) };
      }
    }),
  };
}

export function taskDetail(app: App, taskId: string) {
  const t = app.store.getTask(taskId);
  if (!t) return null;
  return {
    task: t,
    transitions: app.store.listTransitions(taskId),
    executions: app.store.listExecutions(taskId),
    checkpoints: app.store.listCheckpoints(taskId),
    evidence: app.store.listEvidence({ taskId }),
    output: app.store.getTaskOutput(taskId)?.slice(0, 20_000) ?? null,
    events: app.store.listEvents({ taskId, limit: 100 }).reverse(),
  };
}
