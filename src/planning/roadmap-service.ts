import type { Store } from '../queue/store.js';
import { qaEvidenceKind } from '../verification/types.js';
import type { WorkflowRepository } from '../workflows/repository.js';
import { criticalPath, isDelivered, progress, type ProgressTask } from './roadmap.js';

/** Roadmap view of a project assembled from the database: milestones, epics, tasks, critical path, verified progress. */
export function projectRoadmap(store: Store, repo: WorkflowRepository, projectId: string) {
  const links = repo.listPlanTasks(projectId);
  const epicByTask = new Map(
    (
      store.db.prepare('SELECT task_id, epic_key FROM plan_tasks').all() as {
        task_id: string;
        epic_key: string | null;
      }[]
    ).map((r) => [r.task_id, r.epic_key]),
  );
  const keyByTask = new Map(links.map((l) => [l.taskId, l.planKey]));
  const tasks = links.map((l) => {
    const t = store.requireTask(l.taskId);
    const evidence = store.listEvidence({ taskId: l.taskId });
    // "Verified progress" counts only independent verification; owner overrides (legacy PASSED+ownerOverride or v2
    // OWNER_ACCEPTED) are acceptance, not verification.
    const passed = [
      ...new Set(evidence.filter((e) => qaEvidenceKind(e) === 'verified').map((e) => e.level as string)),
    ];
    return {
      taskId: l.taskId,
      key: l.planKey,
      title: l.title,
      milestone: l.milestoneKey,
      epic: epicByTask.get(l.taskId) ?? null,
      size: l.size,
      status: t.status,
      dependsOn: t.dependsOn.map((d) => keyByTask.get(d)).filter((k): k is string => !!k),
      required: t.verificationRequired,
      passed,
      requirementIds: l.requirementIds,
    };
  });
  const pt: ProgressTask[] = tasks.map((t) => ({
    key: t.key,
    milestone: t.milestone,
    epic: t.epic,
    size: t.size,
    status: t.status,
    required: t.required,
    passed: t.passed,
  }));
  // Critical path over the REMAINING work (delivered tasks no longer bound the schedule).
  const remaining = tasks.filter((t) => !isDelivered(pt.find((p) => p.key === t.key)!));
  const remainingKeys = new Set(remaining.map((t) => t.key));
  return {
    milestones: repo.listMilestones(projectId),
    epics: repo.listEpics(projectId),
    tasks: tasks.map((t) => ({ ...t, delivered: !remainingKeys.has(t.key) })),
    criticalPath: criticalPath(
      remaining.map((t) => ({
        key: t.key,
        size: t.size,
        dependsOn: t.dependsOn.filter((d) => remainingKeys.has(d)),
      })),
    ),
    progress: progress(pt),
  };
}
