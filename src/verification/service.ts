import { getAssignment } from '../assignments/register.js';
import type { ProjectAssignment } from '../assignments/schema.js';
import { ensureDerivedCommands } from '../assignments/verification-config.js';
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
  /** project:verify derives missing commands from package.json (default true). */
  deriveCommands?: boolean;
}

const verifierFor = (deps: VerificationDeps, level: VerificationLevel): Verifier | undefined =>
  deps.verifiers?.[level] ?? (defaultVerifiers() as Partial<Record<VerificationLevel, Verifier>>)[level];

const commandsOf = (a: ProjectAssignment | null) => ({
  build: a?.verification.buildCommand,
  test: a?.verification.testCommand,
  browserTest: a?.verification.browserTestCommand,
});

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
      commands: commandsOf(assignment),
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
  // A5: a project whose assignment configures no command gets them derived from package.json (audited, persisted),
  // so the run records real execution evidence instead of NOT_CONFIGURED. Owner-set commands are never overridden.
  if (deps.deriveCommands !== false) ensureDerivedCommands(store, project.id, cwd, 'project:verify');
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
    const res =
      level === 'REQUIREMENTS_SATISFIED' && !deps.verifiers?.REQUIREMENTS_SATISFIED
        ? requirementCoverage(store, project.id)
        : await v.verify({
            projectId: project.id,
            cwd,
            commands: commandsOf(assignment),
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

/**
 * Project-level REQUIREMENTS_SATISFIED: every planned requirement must be implemented by at least one task whose
 * latest independent review (task-level REQUIREMENTS_SATISFIED evidence, src/engineering/qa.ts) PASSED.
 * Without independent reviews the answer is NOT_EVALUATED - never an implicit pass.
 */
export function requirementCoverage(
  store: Store,
  projectId: string,
): { status: EvidenceStatus; summary: string; evidence: Record<string, unknown> } {
  const reqs = store.db.prepare('SELECT req_id FROM requirements WHERE project_id = ?').all(projectId) as {
    req_id: string;
  }[];
  const links = store.db
    .prepare(
      `SELECT p.task_id, p.requirement_ids, t.status, t.verification_required FROM plan_tasks p JOIN tasks t ON t.id = p.task_id WHERE t.project_id = ?`,
    )
    .all(projectId) as {
    task_id: string;
    requirement_ids: string;
    status: string;
    verification_required: string;
  }[];
  if (!reqs.length || !links.some((l) => l.verification_required.includes('REQUIREMENTS_SATISFIED')))
    return {
      status: 'NOT_EVALUATED',
      summary: 'no planned tasks with independent review: requirement coverage cannot be evaluated',
      evidence: { requirements: reqs.length },
    };
  const latest = (taskId: string) =>
    store.listEvidence({ taskId, level: 'REQUIREMENTS_SATISFIED' }).at(-1)?.status;
  const reviewed = new Set(
    links.filter((l) => l.status === 'COMPLETED' && latest(l.task_id) === 'PASSED').map((l) => l.task_id),
  );
  const byReq: Record<string, string[]> = {};
  for (const r of reqs)
    byReq[r.req_id] = links
      .filter(
        (l) => (JSON.parse(l.requirement_ids) as string[]).includes(r.req_id) && reviewed.has(l.task_id),
      )
      .map((l) => l.task_id);
  const missing = Object.entries(byReq)
    .filter(([, t]) => t.length === 0)
    .map(([id]) => id);
  return missing.length
    ? {
        status: 'FAILED',
        summary: `${missing.length} of ${reqs.length} requirement(s) without an independently verified implementation: ${missing.join(', ')}`,
        evidence: { byRequirement: byReq, missing },
      }
    : {
        status: 'PASSED',
        summary: `all ${reqs.length} requirement(s) implemented by independently reviewed tasks`,
        evidence: { byRequirement: byReq },
      };
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
