import type { Store } from '../queue/store.js';
import type { Task } from '../types/index.js';
import {
  TASK_VERIFIABLE_LEVELS,
  type EvidenceStatus,
  type VerificationLevel,
} from '../verification/types.js';
import type { WorkflowRepository } from '../workflows/repository.js';

/**
 * Evidence-based project progress.
 *
 * Principle: progress is derived ONLY from persisted verification evidence and queue state, never from what the model says.
 *   - `claimedPercent`  = weight of tasks the provider reported complete (an upper bound, shown for transparency).
 *   - `verifiedPercent` = weight of tasks whose REQUIRED independent checks all PASSED (the headline number).
 * A task that completes with no required verification is only ever "claimed". No ETA is produced: there is no basis for one.
 */

export const SIZE_WEIGHT: Record<string, number> = { S: 1, M: 2, L: 3 };

export type TaskVerificationState = 'VERIFIED' | 'CLAIMED' | 'FAILED_VERIFICATION' | 'NOT_DONE';
export type MilestoneState = 'NOT_STARTED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETE_UNVERIFIED' | 'VERIFIED';
export type RequirementState = 'NO_TASK' | 'NOT_STARTED' | 'IN_PROGRESS' | 'CLAIMED' | 'TASKS_VERIFIED';

export interface TaskProgress {
  taskId: string;
  planKey: string | null;
  title: string;
  milestoneKey: string | null;
  weight: number;
  status: Task['status'];
  verification: TaskVerificationState;
  requiredLevels: VerificationLevel[];
  levels: Partial<Record<VerificationLevel, EvidenceStatus>>;
  note: string | null;
  requirementIds: string[];
}

export interface MilestoneProgress {
  key: string;
  title: string;
  position: number;
  state: MilestoneState;
  tasks: number;
  verifiedPercent: number;
  claimedPercent: number;
}

export interface RequirementProgress {
  id: string;
  text: string;
  state: RequirementState;
  taskKeys: string[];
}

export interface Blocker {
  taskId: string;
  title: string;
  status: string;
  reason: string | null;
}

export interface ProjectProgress {
  projectId: string;
  lifecycle: string;
  verifiedPercent: number;
  claimedPercent: number;
  totals: {
    tasks: number;
    weight: number;
    verified: number;
    claimedOnly: number;
    failedVerification: number;
    notDone: number;
  };
  tasks: TaskProgress[];
  milestones: MilestoneProgress[];
  requirements: RequirementProgress[];
  blockers: Blocker[];
  spendUsdEstimate: number;
  executions: number;
  /** Stable hash of everything that matters; used to append snapshots only on change. */
  fingerprint: string;
}

const pct = (num: number, den: number): number => (den === 0 ? 0 : Math.round((num / den) * 1000) / 10);

const BLOCKING: Task['status'][] = ['BLOCKED', 'FAILED'];
const WAITING: Task['status'][] = [
  'WAITING_FOR_APPROVAL',
  'WAITING_FOR_AUTHENTICATION',
  'WAITING_FOR_CAPACITY',
];

export function computeProgress(store: Store, repo: WorkflowRepository, projectId: string): ProjectProgress {
  const project = store.getProject(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  const links = new Map(repo.listPlanTasks(projectId).map((l) => [l.taskId, l]));
  const coding = store
    .listTasks({ projectId })
    .filter((t) => t.kind === 'CODING' && t.status !== 'CANCELLED');

  const tasks: TaskProgress[] = coding.map((t) => {
    const link = links.get(t.id);
    const required = t.verificationRequired.filter((l): l is VerificationLevel =>
      (TASK_VERIFIABLE_LEVELS as readonly string[]).includes(l),
    );
    // latest evidence row per required level (append-only log: the most recent verdict wins)
    const levels: Partial<Record<VerificationLevel, EvidenceStatus>> = {};
    for (const e of store.listEvidence({ taskId: t.id })) {
      if (required.includes(e.level)) levels[e.level] = e.status;
    }
    let verification: TaskVerificationState = 'NOT_DONE';
    let note: string | null = null;
    if (t.status === 'COMPLETED') {
      if (required.length === 0) {
        verification = 'CLAIMED';
        note = 'no independent verification was required for this task';
      } else if (required.some((l) => levels[l] === 'FAILED')) {
        verification = 'FAILED_VERIFICATION';
        note = `failed: ${required.filter((l) => levels[l] === 'FAILED').join(', ')}`;
      } else if (required.every((l) => levels[l] === 'PASSED')) {
        verification = 'VERIFIED';
      } else {
        verification = 'CLAIMED';
        note = `not proven: ${required
          .filter((l) => levels[l] !== 'PASSED')
          .map((l) => `${l}=${levels[l] ?? 'MISSING'}`)
          .join(', ')}`;
      }
    } else if (required.some((l) => levels[l] === 'FAILED')) {
      note = `last verification failed: ${required.filter((l) => levels[l] === 'FAILED').join(', ')}`;
    }
    return {
      taskId: t.id,
      planKey: link?.planKey ?? null,
      title: t.title,
      milestoneKey: link?.milestoneKey ?? null,
      weight: SIZE_WEIGHT[link?.size ?? 'M'] ?? 1,
      status: t.status,
      verification,
      requiredLevels: required,
      levels,
      note,
      requirementIds: link?.requirementIds ?? [],
    };
  });

  const totalWeight = tasks.reduce((a, t) => a + t.weight, 0);
  const verifiedWeight = tasks.filter((t) => t.verification === 'VERIFIED').reduce((a, t) => a + t.weight, 0);
  const completedWeight = tasks.filter((t) => t.status === 'COMPLETED').reduce((a, t) => a + t.weight, 0);

  const milestones: MilestoneProgress[] = repo.listMilestones(projectId).map((m) => {
    const mt = tasks.filter((t) => t.milestoneKey === m.key);
    const w = mt.reduce((a, t) => a + t.weight, 0);
    const vw = mt.filter((t) => t.verification === 'VERIFIED').reduce((a, t) => a + t.weight, 0);
    const cw = mt.filter((t) => t.status === 'COMPLETED').reduce((a, t) => a + t.weight, 0);
    let state: MilestoneState = 'NOT_STARTED';
    if (mt.length > 0 && mt.every((t) => t.verification === 'VERIFIED')) state = 'VERIFIED';
    else if (mt.some((t) => BLOCKING.includes(t.status))) state = 'BLOCKED';
    else if (mt.length > 0 && mt.every((t) => t.status === 'COMPLETED')) state = 'COMPLETE_UNVERIFIED';
    else if (mt.some((t) => t.status !== 'QUEUED')) state = 'IN_PROGRESS';
    return {
      key: m.key,
      title: m.title,
      position: m.position,
      state,
      tasks: mt.length,
      verifiedPercent: pct(vw, w),
      claimedPercent: pct(cw, w),
    };
  });

  const requirements: RequirementProgress[] = repo.listRequirements(projectId).map((r) => {
    const covering = tasks.filter((t) => t.requirementIds.includes(r.id));
    let state: RequirementState = 'NO_TASK';
    if (covering.length > 0) {
      if (covering.every((t) => t.verification === 'VERIFIED')) state = 'TASKS_VERIFIED';
      else if (covering.every((t) => t.status === 'COMPLETED')) state = 'CLAIMED';
      else if (covering.some((t) => t.status !== 'QUEUED')) state = 'IN_PROGRESS';
      else state = 'NOT_STARTED';
    }
    return { id: r.id, text: r.text, state, taskKeys: covering.map((t) => t.planKey ?? t.taskId) };
  });

  const blockers: Blocker[] = coding
    .filter((t) => BLOCKING.includes(t.status) || WAITING.includes(t.status))
    .map((t) => ({ taskId: t.id, title: t.title, status: t.status, reason: t.lastErrorMessage }));

  const executions = coding.reduce((a, t) => a + store.listExecutions(t.id).length, 0);
  const progress: Omit<ProjectProgress, 'fingerprint'> = {
    projectId,
    lifecycle: project.lifecycle,
    verifiedPercent: pct(verifiedWeight, totalWeight),
    claimedPercent: pct(completedWeight, totalWeight),
    totals: {
      tasks: tasks.length,
      weight: totalWeight,
      verified: tasks.filter((t) => t.verification === 'VERIFIED').length,
      claimedOnly: tasks.filter((t) => t.verification === 'CLAIMED').length,
      failedVerification: tasks.filter((t) => t.verification === 'FAILED_VERIFICATION').length,
      notDone: tasks.filter((t) => t.verification === 'NOT_DONE').length,
    },
    tasks,
    milestones,
    requirements,
    blockers,
    spendUsdEstimate: store.projectSpend(projectId),
    executions,
  };
  return { ...progress, fingerprint: fingerprintOf(progress) };
}

function fingerprintOf(p: Omit<ProjectProgress, 'fingerprint'>): string {
  // Only fields that represent real change: not spend/time, which move on every execution.
  const material = JSON.stringify([
    p.lifecycle,
    p.verifiedPercent,
    p.claimedPercent,
    p.tasks.map((t) => [t.taskId, t.status, t.verification]),
    p.milestones.map((m) => [m.key, m.state]),
    p.requirements.map((r) => [r.id, r.state]),
  ]);
  let h = 5381;
  for (let i = 0; i < material.length; i++) h = ((h << 5) + h + material.charCodeAt(i)) | 0;
  return `${material.length}:${(h >>> 0).toString(16)}`;
}

/** One-line summary stored on the project record. */
export function summarize(p: ProjectProgress): string {
  return (
    `${p.verifiedPercent}% verified (${p.claimedPercent}% claimed); ${p.totals.verified}/${p.totals.tasks} tasks verified` +
    (p.blockers.length ? `; ${p.blockers.length} blocked/waiting` : '')
  );
}
