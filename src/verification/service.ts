import { getAssignment } from '../assignments/register.js';
import type { Store } from '../queue/store.js';
import type { Project, Task } from '../types/index.js';
import { defaultVerifiers } from './verifiers.js';
import {
  type DeliveryReadiness,
  type EvidenceRecord,
  type EvidenceStatus,
  TASK_VERIFIABLE_LEVELS,
  VERIFICATION_LEVELS,
  type VerificationLevel,
  type Verifier,
} from './types.js';

export interface VerificationDeps {
  store: Store;
  timeoutMs: number;
  verifiers?: Partial<Record<VerificationLevel, Verifier>>;
}

const verifierFor = (deps: VerificationDeps, level: VerificationLevel): Verifier | undefined =>
  deps.verifiers?.[level] ?? (defaultVerifiers() as Partial<Record<VerificationLevel, Verifier>>)[level];

/**
 * Task-level gate run by the worker AFTER the provider claims success. Only FAILED evidence blocks completion;
 * NOT_CONFIGURED / NOT_EVALUATED are recorded as unknowns (they are never silently counted as passes).
 */
export async function verifyTask(
  deps: VerificationDeps,
  project: Project,
  task: Task,
  cwd: string,
): Promise<{ failed: EvidenceRecord[]; all: EvidenceRecord[] }> {
  const { store } = deps;
  const assignment = getAssignment(store, project.id);
  const required = task.verificationRequired.filter((l): l is VerificationLevel =>
    (TASK_VERIFIABLE_LEVELS as readonly string[]).includes(l),
  );
  const all: EvidenceRecord[] = [];
  for (const level of required) {
    const v = verifierFor(deps, level);
    if (!v) continue;
    const res = await v.verify({
      projectId: project.id,
      taskId: task.id,
      cwd,
      baseline: level === 'CHANGES_EXIST' ? (store.taskBaseline(task.id) ?? undefined) : undefined,
      commands: { build: assignment?.verification.buildCommand, test: assignment?.verification.testCommand },
      timeoutMs: deps.timeoutMs,
    });
    all.push(
      store.addEvidence({
        projectId: project.id,
        taskId: task.id,
        level,
        status: res.status,
        summary: res.summary,
        evidence: res.evidence,
      }),
    );
  }
  return { failed: all.filter((e) => e.status === 'FAILED'), all };
}

/** Latest status per level across the project (task-level and project-level evidence). */
export function latestLevels(
  store: Store,
  projectId: string,
): Record<VerificationLevel, EvidenceStatus | 'MISSING'> {
  const out = Object.fromEntries(VERIFICATION_LEVELS.map((l) => [l, 'MISSING'])) as Record<
    VerificationLevel,
    EvidenceStatus | 'MISSING'
  >;
  for (const e of store.listEvidence({ projectId })) {
    if (e.taskId === null) out[e.level] = e.status; // only project-level evidence counts; later rows overwrite earlier
  }
  return out;
}

export function deliveryReadiness(store: Store, projectId: string): DeliveryReadiness {
  const levels = latestLevels(store, projectId);
  const blockers: string[] = [];
  for (const l of VERIFICATION_LEVELS) {
    if (levels[l] !== 'PASSED') blockers.push(`${l}: ${levels[l]}`);
  }
  return { ready: blockers.length === 0, levels, blockers };
}

/**
 * Project-level verification run. Records evidence for every level it can evaluate, then moves the project
 * VERIFYING -> AWAITING_OWNER_APPROVAL (nothing FAILED) or back to IN_DEVELOPMENT (something FAILED).
 * It NEVER moves a project to READY_FOR_DELIVERY: that needs owner approval (acceptProject).
 */
export async function verifyProject(
  deps: VerificationDeps,
  project: Project,
  cwd: string,
): Promise<{ readiness: DeliveryReadiness; evidence: EvidenceRecord[] }> {
  const { store } = deps;
  const assignment = getAssignment(store, project.id);
  const evidence: EvidenceRecord[] = [];
  const tasks = store.listTasks({ projectId: project.id });
  const notDone = tasks.filter((t) => !['COMPLETED', 'CANCELLED'].includes(t.status));
  const claimedOk = tasks.some((t) => t.status === 'COMPLETED') && notDone.length === 0;
  evidence.push(
    store.addEvidence({
      projectId: project.id,
      level: 'CLAIMED_COMPLETE',
      status: claimedOk ? 'PASSED' : 'FAILED',
      summary: claimedOk
        ? `all ${tasks.filter((t) => t.status === 'COMPLETED').length} task(s) completed (provider claims)`
        : `${notDone.length} task(s) not complete or none completed`,
      evidence: { open: notDone.map((t) => ({ id: t.id, status: t.status })) },
    }),
  );
  for (const level of [
    'CHANGES_EXIST',
    'BUILD_PASSES',
    'TESTS_PASS',
    'REQUIREMENTS_SATISFIED',
    'SECURITY_CHECKS_PASS',
  ] as const) {
    const v = verifierFor(deps, level)!;
    const res = await v.verify({
      projectId: project.id,
      cwd,
      commands: { build: assignment?.verification.buildCommand, test: assignment?.verification.testCommand },
      timeoutMs: deps.timeoutMs,
    });
    evidence.push(
      store.addEvidence({
        projectId: project.id,
        level,
        status: res.status,
        summary: res.summary,
        evidence: res.evidence,
      }),
    );
  }
  const readiness = deliveryReadiness(store, project.id);
  const current = store.getProject(project.id)!;
  const anyFailed = evidence.some((e) => e.status === 'FAILED');
  if (current.lifecycle === 'VERIFYING') {
    if (anyFailed) {
      store.transitionProject(
        project.id,
        'IN_DEVELOPMENT',
        `verification failed: ${evidence
          .filter((e) => e.status === 'FAILED')
          .map((e) => e.level)
          .join(', ')}; correction work required`,
      );
    } else {
      store.transitionProject(
        project.id,
        'AWAITING_OWNER_APPROVAL',
        `verification run complete; unresolved: ${readiness.blockers.join(', ') || 'none'}`,
      );
    }
  }
  return { readiness, evidence };
}

export class AcceptanceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceRefusedError';
  }
}

/**
 * Owner acceptance. Refuses when anything FAILED. Unevaluated levels (e.g. requirements/security, which are not
 * implemented yet) require an explicit acknowledgement that is recorded as evidence.
 */
export function acceptProject(
  store: Store,
  projectId: string,
  owner: string,
  opts: { acknowledgeUnverified?: string } = {},
): DeliveryReadiness {
  const p = store.getProject(projectId);
  if (!p) throw new AcceptanceRefusedError(`unknown project ${projectId}`);
  if (p.lifecycle !== 'AWAITING_OWNER_APPROVAL') {
    throw new AcceptanceRefusedError(
      `project is ${p.lifecycle}; it must be AWAITING_OWNER_APPROVAL (run project:verify first)`,
    );
  }
  const levels = latestLevels(store, projectId);
  const failed = VERIFICATION_LEVELS.filter((l) => levels[l] === 'FAILED');
  if (failed.length)
    throw new AcceptanceRefusedError(`cannot accept: failed verification level(s): ${failed.join(', ')}`);
  const unresolved = VERIFICATION_LEVELS.filter((l) => l !== 'OWNER_APPROVAL' && levels[l] !== 'PASSED');
  if (unresolved.length && !opts.acknowledgeUnverified) {
    throw new AcceptanceRefusedError(
      `unverified level(s): ${unresolved.map((l) => `${l}=${levels[l]}`).join(', ')}. Re-run with an explicit acknowledgement to accept anyway.`,
    );
  }
  store.addEvidence({
    projectId,
    level: 'OWNER_APPROVAL',
    status: 'PASSED',
    summary: unresolved.length
      ? `accepted by ${owner} WITH acknowledged unverified levels`
      : `accepted by ${owner}`,
    evidence: { owner, acknowledgedUnverified: unresolved, note: opts.acknowledgeUnverified ?? null },
  });
  store.transitionProject(
    projectId,
    'READY_FOR_DELIVERY',
    `owner ${owner} accepted${unresolved.length ? ` (acknowledged unverified: ${unresolved.join(', ')})` : ''}`,
  );
  return deliveryReadiness(store, projectId);
}
