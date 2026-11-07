import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildProjectContext, renderProjectContext } from '../../src/assignments/context.js';
import { findByExternalId, registerAssignment } from '../../src/assignments/register.js';
import { AssignmentValidationError, parseAssignment } from '../../src/assignments/schema.js';
import { Store } from '../../src/queue/store.js';
import { InvalidProjectTransitionError } from '../../src/projects/lifecycle.js';
import { WorkspaceViolationError } from '../../src/workspaces/paths.js';
import {
  acceptProject,
  AcceptanceRefusedError,
  deliveryReadiness,
  verifyProject,
} from '../../src/verification/service.js';
import { drain, makeEnv, type TestEnv } from '../helpers/env.js';
import { assignmentExample } from '../helpers/assignment.js';

let env: TestEnv;
afterEach(() => env?.cleanup());
const register = (over = {}) => registerAssignment(env.store, env.registry, 'mock', assignmentExample(over));

describe('assignment contract', () => {
  it('accepts a complete assignment and applies defaults', () => {
    const a = parseAssignment(assignmentExample());
    expect(a.workspace).toEqual({ type: 'managed' });
    expect(a.approvalPolicy).toEqual({
      preApproved: [],
      alsoRequire: [],
      deliveryRequiresOwnerApproval: true,
    });
    expect(a.priority).toBe(0);
    expect(a.source.system).toBe('manual');
  });
  it.each([
    ['missing objectives', { businessObjectives: [] }],
    ['no functional requirements', { functionalRequirements: [] }],
    [
      'duplicate requirement ids',
      {
        functionalRequirements: [
          { id: 'X', text: 'one one' },
          { id: 'X', text: 'two two' },
        ],
      },
    ],
    ['no acceptance criteria', { acceptanceCriteria: [] }],
    ['no deliverables', { expectedDeliverables: [] }],
    ['unknown field (strict)', { surprise: true }],
    ['production deploy cannot be pre-approved', { approvalPolicy: { preApproved: ['production_deploy'] } }],
    [
      'write access to integrations cannot be requested',
      { requiredIntegrations: [{ system: 'erp', access: 'write', purpose: 'sync status back' }] },
    ],
    ['negative budget', { budget: { maxUsdTotal: -1 } }],
  ])('rejects: %s', (_name, over) => {
    expect(() => parseAssignment(assignmentExample(over as never))).toThrow(AssignmentValidationError);
  });
  it('error message lists every problem with its path', () => {
    try {
      parseAssignment({ title: 'x' });
      expect.unreachable();
    } catch (e) {
      expect((e as AssignmentValidationError).issues.join('\n')).toMatch(/description/);
      expect((e as AssignmentValidationError).issues.join('\n')).toMatch(/functionalRequirements/);
    }
  });
});

describe('registering an assignment', () => {
  it('creates an isolated project, persists the full contract and seeds durable memory, creating NO tasks', async () => {
    env = await makeEnv();
    const r = await register({ priority: 7 });
    expect(r.created).toBe(true);
    expect(r.project).toMatchObject({ name: 'School Management ERP', priority: 7, lifecycle: 'REGISTERED' });
    expect(r.project.repoPath.startsWith(env.registry.root)).toBe(true);
    expect(env.store.listTasks({ projectId: r.project.id })).toHaveLength(0);
    const memory = env.store.listMemory(r.project.id).map((m) => m.section);
    expect(memory).toEqual(expect.arrayContaining(['assignment', 'requirements', 'important_decisions']));
    expect(env.store.getMemory(r.project.id, 'requirements')).toContain('[FR-1]');
  });

  it('context survives a restart (rebuilt from the database by a brand-new Store)', async () => {
    env = await makeEnv();
    const r = await register();
    env.store.enqueueTask({
      projectId: r.project.id,
      title: 'Build enrollment',
      instructions: 'x',
      maxRetries: 1,
    });
    const fresh = new Store(env.store.db); // simulates a new process
    const ctx = buildProjectContext(fresh, r.project.id);
    expect(ctx.assignment!.functionalRequirements.map((f) => f.id)).toEqual(['FR-1', 'FR-2']);
    expect(ctx.tasks.open.map((t) => t.title)).toEqual(['Build enrollment']);
    const text = renderProjectContext(ctx);
    expect(text).toContain('[FR-2] Attendance tracking');
    expect(text).toContain('Acceptance criteria');
    expect(renderProjectContext(ctx, 100).length).toBeLessThanOrEqual(100);
  });

  it('the project context is included in the worker prompt', async () => {
    env = await makeEnv();
    const r = await register();
    env.store.enqueueTask({ projectId: r.project.id, title: 'ctx', instructions: 'do', maxRetries: 1 });
    await drain(env);
    expect(env.mock!.runs[0]!.prompt).toContain('[FR-1] Student enrollment');
    expect(env.mock!.runs[0]!.prompt).toContain('lifecycle');
  });

  it('is idempotent per source system + external id (prevents duplicate sync)', async () => {
    env = await makeEnv();
    const a = await register({ source: { system: 'erp', externalId: 'ERP-PRJ-42' } });
    const b = await register({
      source: { system: 'erp', externalId: 'ERP-PRJ-42' },
      title: 'Same project renamed',
    });
    expect(b.created).toBe(false);
    expect(b.project.id).toBe(a.project.id);
    expect(findByExternalId(env.store, 'erp', 'ERP-PRJ-42')!.id).toBe(a.project.id);
    expect(env.store.listProjects().filter((p) => p.id !== env.project.id)).toHaveLength(1);
  });

  it('an existing workspace must be approved first, and a dirty one is refused', async () => {
    env = await makeEnv();
    const outside = path.join(env.dir, 'not-approved');
    mkdirSync(outside);
    await expect(register({ workspace: { type: 'existing', path: outside } })).rejects.toBeInstanceOf(
      WorkspaceViolationError,
    );
    env.registry.register(outside, 'approved', 'test');
    const ok = await register({ workspace: { type: 'existing', path: outside } });
    expect(ok.project.repoPath).toBe(outside.replace(/\/$/, ''));
  });
});

describe('project lifecycle is separate from task completion', () => {
  it('REGISTERED -> IN_DEVELOPMENT (task added) -> VERIFYING (all tasks done), never auto-delivered', async () => {
    env = await makeEnv();
    const { project } = await register();
    expect(project.lifecycle).toBe('REGISTERED');
    const t = env.store.enqueueTask({
      projectId: project.id,
      title: 'only task',
      instructions: 'x',
      maxRetries: 1,
    }).task;
    expect(env.store.getProject(project.id)!.lifecycle).toBe('IN_DEVELOPMENT');
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
    const p = env.store.getProject(project.id)!;
    expect(p.lifecycle).toBe('VERIFYING'); // NOT READY_FOR_DELIVERY / DELIVERED
    expect(deliveryReadiness(env.store, project.id).ready).toBe(false);
    expect(env.store.listProjectTransitions(project.id).map((x) => x.to)).toEqual([
      'IN_DEVELOPMENT',
      'VERIFYING',
    ]);
  });

  it('one provider success does not complete a project that still has open tasks', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { a: ['success'], b: ['fatal'] } } } });
    const { project } = await register();
    env.store.enqueueTask({ projectId: project.id, title: 'a', instructions: 'x', maxRetries: 0 });
    env.store.enqueueTask({ projectId: project.id, title: 'b', instructions: 'x', maxRetries: 0 });
    await drain(env);
    expect(env.store.getProject(project.id)!.lifecycle).toBe('IN_DEVELOPMENT');
  });

  it('adding work re-opens a project that was awaiting verification/approval', async () => {
    env = await makeEnv();
    const { project } = await register();
    env.store.enqueueTask({ projectId: project.id, title: 'one', instructions: 'x', maxRetries: 1 });
    await drain(env);
    expect(env.store.getProject(project.id)!.lifecycle).toBe('VERIFYING');
    env.store.enqueueTask({ projectId: project.id, title: 'correction', instructions: 'y', maxRetries: 1 });
    expect(env.store.getProject(project.id)!.lifecycle).toBe('IN_DEVELOPMENT');
  });

  it('illegal lifecycle jumps are rejected centrally', async () => {
    env = await makeEnv();
    const { project } = await register();
    expect(() => env.store.transitionProject(project.id, 'DELIVERED', 'skip everything')).toThrow(
      InvalidProjectTransitionError,
    );
    expect(() => env.store.transitionProject(project.id, 'READY_FOR_DELIVERY', 'skip')).toThrow(
      InvalidProjectTransitionError,
    );
  });

  it('paused/blocked/cancelled projects are not executed', async () => {
    env = await makeEnv();
    const { project } = await register();
    env.store.enqueueTask({ projectId: project.id, title: 'held', instructions: 'x', maxRetries: 1 });
    env.store.transitionProject(project.id, 'PAUSED', 'owner pause');
    await drain(env);
    expect(env.mock!.runs).toHaveLength(0);
    env.store.transitionProject(project.id, 'IN_DEVELOPMENT', 'resume');
    await drain(env);
    expect(env.mock!.runs).toHaveLength(1);
  });
});

describe('independent verification and owner acceptance', () => {
  const NODE_OK = 'node -e "process.exit(0)"';
  const NODE_FAIL = 'node -e "process.exit(1)"';

  async function finishedProject(verification = { buildCommand: NODE_OK, testCommand: NODE_OK }) {
    env = await makeEnv();
    const { project } = await register({ verification });
    env.store.enqueueTask({ projectId: project.id, title: 'work', instructions: 'x', maxRetries: 1 });
    await drain(env);
    return project;
  }
  const verify = (p: { id: string }) =>
    verifyProject(
      { store: env.store, timeoutMs: 30_000 },
      env.store.getProject(p.id)!,
      env.registry.assertApproved(env.store.getProject(p.id)!.repoPath),
    );

  it('records evidence per level; requirements/security are honestly NOT_EVALUATED, so the project is never "ready"', async () => {
    const project = await finishedProject();
    const r = await verify(project);
    const by = Object.fromEntries(r.evidence.map((e) => [e.level, e.status]));
    expect(by).toEqual({
      CLAIMED_COMPLETE: 'PASSED',
      CHANGES_EXIST: 'PASSED',
      BUILD_PASSES: 'PASSED',
      TESTS_PASS: 'PASSED',
      REQUIREMENTS_SATISFIED: 'NOT_EVALUATED', // no planned tasks with independent review in this test
      SECURITY_CHECKS_PASS: 'PASSED', // secret scan of a clean workspace
    });
    expect(r.readiness.ready).toBe(false);
    expect(r.readiness.blockers).toEqual(
      expect.arrayContaining(['REQUIREMENTS_SATISFIED: NOT_EVALUATED', 'OWNER_APPROVAL: MISSING']),
    );
    expect(env.store.getProject(project.id)!.lifecycle).toBe('AWAITING_OWNER_APPROVAL');
  });

  it('owner acceptance needs an explicit acknowledgement of unverified levels, and is recorded as evidence', async () => {
    const project = await finishedProject();
    await verify(project);
    expect(() => acceptProject(env.store, project.id, 'owner')).toThrow(AcceptanceRefusedError);
    expect(env.store.getProject(project.id)!.lifecycle).toBe('AWAITING_OWNER_APPROVAL');
    const r = acceptProject(env.store, project.id, 'owner', {
      acknowledgeUnverified: 'requirements reviewed manually',
    });
    expect(r.levels.OWNER_APPROVAL).toBe('PASSED');
    expect(r.ready).toBe(false); // still strict: requirements/security were never verified by the system
    expect(env.store.getProject(project.id)!.lifecycle).toBe('READY_FOR_DELIVERY');
    const approval = env.store.listEvidence({ projectId: project.id, level: 'OWNER_APPROVAL' })[0]!;
    expect(approval.evidence['acknowledgedUnverified']).toEqual(['REQUIREMENTS_SATISFIED']);
    expect(() => env.store.transitionProject(project.id, 'DELIVERED', 'owner delivered')).not.toThrow();
  });

  it('a failing build sends the project back to development and acceptance is refused', async () => {
    const project = await finishedProject({ buildCommand: NODE_FAIL, testCommand: NODE_OK });
    const r = await verify(project);
    expect(r.evidence.find((e) => e.level === 'BUILD_PASSES')!.status).toBe('FAILED');
    expect(env.store.getProject(project.id)!.lifecycle).toBe('IN_DEVELOPMENT');
    expect(() => acceptProject(env.store, project.id, 'owner', { acknowledgeUnverified: 'x' })).toThrow(
      /AWAITING_OWNER_APPROVAL/,
    );
  });

  it('missing build/test commands are NOT_CONFIGURED (unknown), not passes', async () => {
    const project = await finishedProject({} as never);
    const r = await verify(project);
    const by = Object.fromEntries(r.evidence.map((e) => [e.level, e.status]));
    expect(by['BUILD_PASSES']).toBe('NOT_CONFIGURED');
    expect(by['TESTS_PASS']).toBe('NOT_CONFIGURED');
    expect(r.readiness.ready).toBe(false);
  });

  it('a repository with nothing beyond the initial commit FAILS CHANGES_EXIST at project level', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { x: [{ type: 'success', noArtifact: true }] } } } });
    const { project } = await register();
    env.store.enqueueTask({ projectId: project.id, title: 'x', instructions: 'x', maxRetries: 1 });
    await drain(env);
    const r = await verify(project);
    expect(r.evidence.find((e) => e.level === 'CHANGES_EXIST')).toMatchObject({ status: 'FAILED' });
  });

  it('cannot accept a project that is not awaiting approval', async () => {
    env = await makeEnv();
    const { project } = await register();
    expect(() => acceptProject(env.store, project.id, 'owner', { acknowledgeUnverified: 'x' })).toThrow(
      AcceptanceRefusedError,
    );
  });
});

describe('project budget constraints', () => {
  it('maxExecutions stops further tasks of that project from being started', async () => {
    env = await makeEnv();
    const { project } = await register({ budget: { maxExecutions: 1 } });
    env.store.enqueueTask({ projectId: project.id, title: 'first', instructions: 'x', maxRetries: 1 });
    const second = env.store.enqueueTask({
      projectId: project.id,
      title: 'second',
      instructions: 'y',
      maxRetries: 1,
    }).task;
    await drain(env);
    expect(env.mock!.runs.map((r) => r.taskTitle)).toEqual(['first']);
    expect(env.store.getTask(second.id)!.status).toBe('QUEUED');
  });

  it('maxUsdTotal stops a project once estimated spend reaches the cap (other projects keep running)', async () => {
    env = await makeEnv({
      mock: {
        scenario: {
          tasks: { costly: [{ type: 'success', costUsd: 3 }], after: ['success'], other: ['success'] },
        },
      },
    });
    const { project } = await register({ budget: { maxUsdTotal: 2 } });
    env.store.enqueueTask({ projectId: project.id, title: 'costly', instructions: 'x', maxRetries: 1 });
    const after = env.store.enqueueTask({
      projectId: project.id,
      title: 'after',
      instructions: 'y',
      maxRetries: 1,
    }).task;
    const other = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'other',
      instructions: 'z',
      maxRetries: 1,
    }).task;
    await drain(env);
    expect(env.store.projectSpend(project.id)).toBe(3);
    expect(env.store.getTask(after.id)!.status).toBe('QUEUED'); // held by the project budget
    expect(env.store.getTask(other.id)!.status).toBe('COMPLETED');
  });

  it('assignment approval policy: pre-approved categories reach the provider; web access can be forced to need approval', async () => {
    env = await makeEnv();
    const { project } = await register({
      approvalPolicy: { preApproved: ['destructive_delete'], alsoRequire: ['web_access'] },
    });
    env.store.enqueueTask({ projectId: project.id, title: 'pol', instructions: 'x', maxRetries: 1 });
    let seen: { approved: string[]; also: string[] } | null = null;
    const original = env.mock!.run.bind(env.mock!);
    env.mock!.run = async (req) => {
      seen = { approved: req.approvedActionTypes, also: req.alsoRequireApproval };
      return original(req);
    };
    await drain(env);
    expect(seen).toEqual({ approved: ['destructive_delete'], also: ['web_access'] });
  });
});
