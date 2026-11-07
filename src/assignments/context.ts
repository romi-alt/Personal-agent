import { getAssignment } from './register.js';
import type { ProjectAssignment } from './schema.js';
import type { Store } from '../queue/store.js';
import type { Project, Task } from '../types/index.js';

/** Structured project context rebuilt entirely from the database, so it survives restarts and model-context limits. */
export interface ProjectContext {
  project: Pick<
    Project,
    'id' | 'name' | 'slug' | 'lifecycle' | 'status' | 'repoPath' | 'currentMilestone' | 'progressSummary'
  >;
  assignment: ProjectAssignment | null;
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    completed: string[];
    open: { id: string; title: string; status: string }[];
  };
  spendUsdEstimate: number;
  latestCheckpoint: { taskId: string; completed: string; outstanding: string; nextAction: string } | null;
  memory: { section: string; content: string }[];
}

export function buildProjectContext(store: Store, projectId: string): ProjectContext {
  const p = store.getProject(projectId);
  if (!p) throw new Error(`Unknown project ${projectId}`);
  const tasks: Task[] = store.listTasks({ projectId });
  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const cp = tasks
    .map((t) => store.latestCheckpoint(t.id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return {
    project: {
      id: p.id,
      name: p.name,
      slug: p.slug,
      lifecycle: p.lifecycle,
      status: p.status,
      repoPath: p.repoPath,
      currentMilestone: p.currentMilestone,
      progressSummary: p.progressSummary,
    },
    assignment: getAssignment(store, projectId),
    tasks: {
      total: tasks.length,
      byStatus,
      completed: tasks.filter((t) => t.status === 'COMPLETED').map((t) => t.title),
      open: tasks
        .filter((t) => !['COMPLETED', 'CANCELLED'].includes(t.status))
        .map((t) => ({ id: t.id, title: t.title, status: t.status })),
    },
    spendUsdEstimate: store.projectSpend(projectId),
    latestCheckpoint: cp
      ? {
          taskId: cp.taskId,
          completed: cp.completedSummary,
          outstanding: cp.outstandingSummary,
          nextAction: cp.nextAction,
        }
      : null,
    memory: store.listMemory(projectId).map((m) => ({ section: m.section, content: m.content })),
  };
}

/** Compact, bounded text form for prompts (the model sees the contract, not the whole database). */
export function renderProjectContext(ctx: ProjectContext, maxChars = 4000): string {
  const a = ctx.assignment;
  const lines: string[] = [`# Project context: ${ctx.project.name} (lifecycle ${ctx.project.lifecycle})`];
  if (a) {
    lines.push(`Objectives: ${a.businessObjectives.join('; ')}`);
    lines.push(
      'Functional requirements: ' + a.functionalRequirements.map((r) => `[${r.id}] ${r.text}`).join(' | '),
    );
    if (a.nonFunctionalRequirements.length)
      lines.push(
        'Non-functional: ' + a.nonFunctionalRequirements.map((r) => `[${r.id}] ${r.text}`).join(' | '),
      );
    if (a.technicalConstraints.length) lines.push('Constraints: ' + a.technicalConstraints.join('; '));
    lines.push('Deliverables: ' + a.expectedDeliverables.join('; '));
    lines.push('Acceptance criteria: ' + a.acceptanceCriteria.map((c) => `[${c.id}] ${c.text}`).join(' | '));
  }
  lines.push(
    `Tasks: ${ctx.tasks.total} total; completed: ${ctx.tasks.completed.join(', ') || 'none'}; open: ${ctx.tasks.open.map((t) => `${t.title} (${t.status})`).join(', ') || 'none'}`,
  );
  const text = lines.join('\n');
  const suffix = '\n…[context truncated]';
  return text.length > maxChars ? text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix : text;
}
