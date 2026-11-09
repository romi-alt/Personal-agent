import { afterEach, describe, expect, it } from 'vitest';
import { registerAssignment } from '../../src/assignments/register.js';
import { buildInbox } from '../../src/progress/inbox.js';
import { computeProgress } from '../../src/progress/model.js';
import { listSnapshots, recordSnapshotIfChanged } from '../../src/progress/snapshots.js';
import { acceptProject, verifyProject } from '../../src/verification/service.js';
import { assignmentExample } from '../helpers/assignment.js';
import { makeEnv, settle, type TestEnv } from '../helpers/env.js';
import { analysisJson, architectureJson, happyPlanning, planJson, reply } from '../helpers/plan-fixtures.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const NODE_OK = 'node -e "process.exit(0)"';
const NODE_FAIL = 'node -e "process.exit(1)"';

/** Run the real planning pipeline (mock provider, auto-approved) and then the planned coding tasks. */
async function planned(opts: {
  env?: Record<string, string>;
  scenario?: Record<string, unknown[]>;
  assignment?: Record<string, unknown>;
  run?: boolean;
}) {
  env = await makeEnv({
    env: { PLAN_APPROVAL: 'auto', ...opts.env },
    mock: { scenario: { tasks: { ...happyPlanning(), ...(opts.scenario ?? {}) } as never } },
  });
  const { project } = await registerAssignment(
    env.store,
    env.registry,
    'mock',
    assignmentExample(opts.assignment ?? {}),
  );
  env.workflows.startPlanning(project.id);
  if (opts.run !== false) await settle(env);
  return project;
}
const kinds = (projectId?: string) =>
  buildInbox(env.store, env.workflows.repo, { projectId }).map((i) => i.kind);
const progress = (projectId: string) => computeProgress(env.store, env.workflows.repo, projectId);
const byKey = (p: ReturnType<typeof progress>, key: string) => p.tasks.find((t) => t.planKey === key)!;

describe('progress is derived from evidence, never from model claims', () => {
  it('verified vs claimed: a completed task whose required checks did not all PASS is only "claimed"', async () => {
    const project = await planned({});
    const p = progress(project.id);
    // T1 (M, w2) and T3 (S, w1) required only CHANGES_EXIST -> VERIFIED. T2 (M, w2) also required TESTS_PASS, which has no command -> claimed only.
    expect(byKey(p, 'T1').verification).toBe('VERIFIED');
    expect(byKey(p, 'T3').verification).toBe('VERIFIED');
    expect(byKey(p, 'T2')).toMatchObject({ status: 'COMPLETED', verification: 'CLAIMED' });
    expect(byKey(p, 'T2').note).toMatch(/TESTS_PASS=NOT_CONFIGURED/);
    expect(p.claimedPercent).toBe(100);
    expect(p.verifiedPercent).toBe(60); // (2 + 1) / 5
    expect(p.claimedPercent).toBeGreaterThan(p.verifiedPercent);
    expect(p.totals).toMatchObject({ tasks: 3, weight: 5, verified: 2, claimedOnly: 1 });
  });

  it('configuring the test command and passing it makes the same project 100% verified', async () => {
    const project = await planned({ assignment: { verification: { testCommand: NODE_OK } } });
    const p = progress(project.id);
    expect(p).toMatchObject({ verifiedPercent: 100, claimedPercent: 100 });
    expect(p.milestones.map((m) => m.state)).toEqual(['VERIFIED', 'VERIFIED']);
    expect(p.requirements.map((r) => r.state)).toEqual([
      'TASKS_VERIFIED',
      'TASKS_VERIFIED',
      'TASKS_VERIFIED',
      'TASKS_VERIFIED',
    ]);
  });

  it('a failing check stops the task from completing, so neither number rises (and the failure is explained)', async () => {
    const project = await planned({ assignment: { verification: { testCommand: NODE_FAIL } } });
    const p = progress(project.id);
    expect(byKey(p, 'T2').status).toBe('RETRY_SCHEDULED');
    expect(byKey(p, 'T2').note).toMatch(/last verification failed: TESTS_PASS/);
    expect(p.verifiedPercent).toBe(40); // only T1
    expect(p.claimedPercent).toBe(40);
    expect(byKey(p, 'T3').status).toBe('QUEUED'); // depends on T2
  });

  it('provider "success" with no file changes does not raise progress at all', async () => {
    const project = await planned({
      scenario: { 'Scaffold project and auth': [{ type: 'success', noArtifact: true }] },
      env: { DEFAULT_MAX_RETRIES: '0' },
    });
    const p = progress(project.id);
    expect(byKey(p, 'T1').status).toBe('FAILED');
    expect(p.verifiedPercent).toBe(0);
    expect(p.claimedPercent).toBe(0);
  });

  it('a task with no required verification can only ever be "claimed", never verified', async () => {
    env = await makeEnv();
    env.store.enqueueTask({
      projectId: env.project.id,
      title: 'unchecked work',
      instructions: 'do it',
      maxRetries: 1,
    });
    await settle(env);
    const p = progress(env.project.id);
    expect(p.tasks[0]).toMatchObject({ status: 'COMPLETED', verification: 'CLAIMED' });
    expect(p.tasks[0]!.note).toMatch(/no independent verification/);
    expect(p).toMatchObject({ verifiedPercent: 0, claimedPercent: 100 });
  });

  it('the latest evidence wins (a later failure demotes a verified task; a later pass promotes it)', async () => {
    const project = await planned({ assignment: { verification: { testCommand: NODE_OK } } });
    const t1 = env.store
      .listTasks({ projectId: project.id })
      .find((t) => t.title === 'Scaffold project and auth')!;
    env.clock.advance(10);
    env.store.addEvidence({
      projectId: project.id,
      taskId: t1.id,
      level: 'CHANGES_EXIST',
      status: 'FAILED',
      summary: 'regression found on re-check',
    });
    expect(byKey(progress(project.id), 'T1').verification).toBe('FAILED_VERIFICATION');
    expect(progress(project.id).verifiedPercent).toBe(60);
    env.clock.advance(10);
    env.store.addEvidence({
      projectId: project.id,
      taskId: t1.id,
      level: 'CHANGES_EXIST',
      status: 'PASSED',
      summary: 'fixed',
    });
    expect(byKey(progress(project.id), 'T1').verification).toBe('VERIFIED');
    expect(progress(project.id).verifiedPercent).toBe(100);
  });

  it('reports blockers with reasons and never invents an ETA', async () => {
    const project = await planned({ scenario: { 'Scaffold project and auth': ['budget'] } });
    const p = progress(project.id);
    expect(p.blockers.map((b) => b.status)).toEqual(['BLOCKED']);
    expect(p.blockers[0]!.reason).toMatch(/budget/i);
    expect(JSON.stringify(p)).not.toMatch(/eta|estimatedCompletion|finishesAt/i);
    expect(p.milestones[0]!.state).toBe('BLOCKED');
  });

  it('milestone and requirement states follow the task evidence', async () => {
    const project = await planned({});
    const p = progress(project.id);
    expect(p.milestones.map((m) => [m.key, m.state])).toEqual([
      ['M1', 'VERIFIED'],
      ['M2', 'COMPLETE_UNVERIFIED'],
    ]);
    expect(Object.fromEntries(p.requirements.map((r) => [r.id, r.state]))).toEqual({
      'FR-1': 'CLAIMED',
      'FR-2': 'TASKS_VERIFIED',
      'NFR-1': 'TASKS_VERIFIED',
      'DR-1': 'CLAIMED',
    });
  });
});

describe('progress snapshots', () => {
  it('are recorded automatically by the supervisor, only when something changes, and never decrease in a clean run', async () => {
    const project = await planned({ assignment: { verification: { testCommand: NODE_OK } } });
    const snaps = listSnapshots(env.store, project.id);
    expect(snaps.length).toBeGreaterThan(1);
    const verified = snaps.map((s) => s.verifiedPercent);
    expect(verified).toEqual([...verified].sort((a, b) => a - b)); // monotonic
    expect(verified.at(-1)).toBe(100);
    expect(snaps.every((s) => s.claimedPercent >= s.verifiedPercent)).toBe(true);
    // a repeat with no change adds nothing
    const before = listSnapshots(env.store, project.id).length;
    expect(recordSnapshotIfChanged(env.store, env.workflows.repo, project.id).recorded).toBe(false);
    expect(listSnapshots(env.store, project.id)).toHaveLength(before);
  });

  it('refresh the project summary, current milestone and milestone statuses', async () => {
    const project = await planned({});
    const p = env.store.getProject(project.id)!;
    expect(p.progressSummary).toMatch(/60% verified \(100% claimed\); 2\/3 tasks verified/);
    expect(p.currentMilestone).toBe('M2: Core features');
    expect(env.workflows.repo.listMilestones(project.id).map((m) => m.status)).toEqual([
      'VERIFIED',
      'COMPLETE_UNVERIFIED',
    ]);
  });

  it('history is bounded', async () => {
    const project = await planned({});
    for (let i = 0; i < 600; i++) {
      env.store.db
        .prepare(
          "INSERT INTO progress_snapshots(id,project_id,at,verified_percent,claimed_percent,fingerprint,data) VALUES (?,?,?,?,?,?,'{}')",
        )
        .run(`pgs_filler${i}`, project.id, 1 + i, 1, 1, `f${i}`);
    }
    env.clock.advance(1000);
    env.store.addEvidence({
      projectId: project.id,
      // A CODING task (progress ignores planning tasks). The original `listTasks(...)[3]` assumed the stage-5 planning
      // pipeline's task count; the v2 line creates more planning tasks, so index 3 became a planning task.
      taskId: env.store.listTasks({ projectId: project.id }).find((t) => t.kind === 'CODING')!.id,
      level: 'CHANGES_EXIST',
      status: 'FAILED',
      summary: 'x',
    });
    recordSnapshotIfChanged(env.store, env.workflows.repo, project.id);
    expect(
      (
        env.store.db
          .prepare('SELECT COUNT(*) n FROM progress_snapshots WHERE project_id = ?')
          .get(project.id) as { n: number }
      ).n,
    ).toBeLessThanOrEqual(500);
  });
});

describe('milestone-aware dispatch', () => {
  // Plan whose M2 tasks do NOT depend on M1, so only milestone gating (not dependencies) orders them.
  const independent = reply(
    planJson((p) => {
      p.tasks[1]!.dependsOn = [];
      p.tasks[2]!.dependsOn = [];
      p.tasks[1]!.priority = 99; // a "more important" later-milestone task must still not jump the queue
    }),
  );

  it('strict (default): later-milestone work does not start while an earlier milestone is open, even with higher priority', async () => {
    const project = await planned({
      scenario: { 'Plan: decompose': [independent], 'Scaffold project and auth': ['fatal'] },
      env: { DEFAULT_MAX_RETRIES: '0' },
    });
    const titles = env.mock!.runs.filter((r) => !r.taskTitle.startsWith('Plan:')).map((r) => r.taskTitle);
    expect(titles).toEqual(['Scaffold project and auth']); // M1 failed -> M2 never started
    const p = progress(project.id);
    expect(byKey(p, 'T1').status).toBe('FAILED');
    expect(byKey(p, 'T2').status).toBe('QUEUED');
    expect(byKey(p, 'T3').status).toBe('QUEUED');
  });

  it('strict: tasks run in milestone order even when a later task has a far higher priority', async () => {
    await planned({ scenario: { 'Plan: decompose': [independent] } });
    const order = env.mock!.runs.filter((r) => !r.taskTitle.startsWith('Plan:')).map((r) => r.taskTitle);
    expect(order[0]).toBe('Scaffold project and auth');
    expect(order).toHaveLength(3);
  });

  it('off: only dependencies and priority order the work, so independent later-milestone tasks proceed', async () => {
    await planned({
      scenario: { 'Plan: decompose': [independent], 'Scaffold project and auth': ['fatal'] },
      env: { DEFAULT_MAX_RETRIES: '0' },
      assignment: { execution: { milestoneGating: 'off' } },
    });
    const titles = env.mock!.runs.filter((r) => !r.taskTitle.startsWith('Plan:')).map((r) => r.taskTitle);
    expect(titles).toEqual(
      expect.arrayContaining(['Scaffold project and auth', 'Enrollment module', 'Attendance module']),
    );
    expect(titles[0]).toBe('Enrollment module'); // priority 99 wins when gating is off
  });

  it('manually added tasks (no plan link) are never gated', async () => {
    env = await makeEnv();
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'manual',
      instructions: 'x',
      maxRetries: 1,
    }).task;
    expect(env.store.milestoneGateOpen(t.id, env.project.id)).toBe(true);
  });
});

describe('owner inbox', () => {
  it('is empty when nothing needs a human', async () => {
    env = await makeEnv();
    expect(buildInbox(env.store, env.workflows.repo)).toEqual([]);
  });

  it('plan approval appears with the resolving commands, and disappears once decided', async () => {
    const project = await planned({ env: { PLAN_APPROVAL: 'required' } });
    const [item] = buildInbox(env.store, env.workflows.repo, { projectId: project.id });
    expect(item).toMatchObject({
      kind: 'PLAN_APPROVAL',
      severity: 'medium',
      projectSlug: 'school-management-erp',
    });
    const id = env.store.listApprovals('PENDING')[0]!.id;
    expect(item!.actions).toEqual([`approve ${id}`, `deny ${id}`]);
    env.store.decideApproval(id, 'APPROVED', 'owner');
    expect(kinds()).not.toContain('PLAN_APPROVAL');
  });

  it('blocking clarification questions appear until answered', async () => {
    const project = await planned({
      scenario: {
        'Plan: analyze': [
          reply(analysisJson({ questions: [{ id: 'Q-1', text: 'Which gateway?', blocking: true }] })),
        ],
      },
    });
    const items = buildInbox(env.store, env.workflows.repo, { projectId: project.id });
    expect(items.map((i) => i.kind)).toEqual(['CLARIFICATION_QUESTION']);
    expect(items[0]!.detail).toBe('Which gateway?');
    expect(items[0]!.actions[0]).toMatch(/^workflow:answer wfr_\S+ --question Q-1/);
    const run = env.workflows.repo.listRuns({ projectId: project.id })[0]!;
    env.workflows.answerQuestion(run.id, 'Q-1', 'Stripe');
    expect(kinds(project.id)).not.toContain('CLARIFICATION_QUESTION');
  });

  it('a denied tool call becomes a permission approval item', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { w: ['permission_denied', 'success'] } as never } } });
    env.store.enqueueTask({ projectId: env.project.id, title: 'w', instructions: 'x', maxRetries: 1 });
    await settle(env);
    const [item] = buildInbox(env.store, env.workflows.repo);
    expect(item).toMatchObject({ kind: 'PERMISSION_APPROVAL', title: 'Approve action: publish_release' });
  });

  it('escalated and failed tasks are HIGH severity and sort before medium items', async () => {
    env = await makeEnv({
      env: { DEFAULT_MAX_RETRIES: '0' },
      mock: {
        scenario: {
          tasks: { blocked: ['budget'], failed: ['fatal'], approve: ['permission_denied'] } as never,
        },
      },
    });
    for (const title of ['approve', 'blocked', 'failed'])
      env.store.enqueueTask({ projectId: env.project.id, title, instructions: 'x', maxRetries: 0 });
    await settle(env);
    const items = buildInbox(env.store, env.workflows.repo);
    expect(items.map((i) => i.severity)).toEqual(['high', 'high', 'medium']);
    expect(items.map((i) => i.kind).sort()).toEqual([
      'PERMISSION_APPROVAL',
      'TASK_ESCALATION',
      'TASK_FAILED',
    ]);
    const blocked = items.find((i) => i.kind === 'TASK_ESCALATION')!;
    expect(blocked.actions).toEqual(expect.arrayContaining([expect.stringMatching(/^task:unblock tsk_/)]));
    // keys are stable per decision
    expect(new Set(items.map((i) => i.key)).size).toBe(3);
  });

  it('project verification and acceptance appear in order and clear when resolved', async () => {
    const project = await planned({
      assignment: { verification: { buildCommand: NODE_OK, testCommand: NODE_OK } },
    });
    expect(kinds(project.id)).toEqual(['PROJECT_VERIFICATION_NEEDED']);
    expect(buildInbox(env.store, env.workflows.repo)[0]!.severity).toBe('low');
    await verifyProject(
      { store: env.store, timeoutMs: 30_000 },
      env.store.getProject(project.id)!,
      env.registry.assertApproved(env.store.getProject(project.id)!.repoPath),
    );
    expect(kinds(project.id)).toEqual(['PROJECT_ACCEPTANCE']);
    acceptProject(env.store, project.id, 'owner', { acknowledgeUnverified: 'reviewed manually' });
    expect(kinds(project.id)).toEqual([]);
  });

  it('missing credentials surface as one high-priority item and clear when fixed', async () => {
    let ready = false;
    env = await makeEnv({ mock: { authReady: () => ready, fingerprint: () => (ready ? 'ok' : 'none') } });
    env.store.enqueueTask({
      projectId: env.project.id,
      title: 'needs-auth',
      instructions: 'x',
      maxRetries: 1,
    });
    await env.supervisor.tick();
    const [item] = buildInbox(env.store, env.workflows.repo);
    expect(item).toMatchObject({
      kind: 'CREDENTIALS_NEEDED',
      severity: 'high',
      actions: ['provider:status', 'doctor'],
    });
    ready = true;
    await settle(env);
    expect(kinds()).not.toContain('CREDENTIALS_NEEDED'); // (the now-finished project legitimately asks for verification)
  });

  it('a project that hit its budget shows a BUDGET_HELD item', async () => {
    env = await makeEnv({
      mock: { scenario: { tasks: { a: [{ type: 'success', costUsd: 5 }], b: ['success'] } as never } },
    });
    const { project } = await registerAssignment(
      env.store,
      env.registry,
      'mock',
      assignmentExample({ budget: { maxUsdTotal: 1 } }),
    );
    env.store.enqueueTask({ projectId: project.id, title: 'a', instructions: 'x', maxRetries: 1 });
    env.store.enqueueTask({ projectId: project.id, title: 'b', instructions: 'y', maxRetries: 1 });
    await settle(env);
    expect(kinds(project.id)).toEqual(['BUDGET_HELD']);
  });

  it('a failed planning workflow is surfaced once and cleared by a newer run', async () => {
    const bad = reply(planJson((p) => p.tasks.pop()));
    const project = await planned({
      env: { MAX_PLAN_REPAIRS: '0' },
      scenario: { 'Plan: decompose': [bad] },
    });
    expect(kinds(project.id)).toEqual(expect.arrayContaining(['WORKFLOW_FAILED', 'PROJECT_BLOCKED']));
    env.workflows.startPlanning(project.id);
    expect(kinds(project.id)).not.toContain('WORKFLOW_FAILED');
  });
});

describe('end to end: everything an owner needs is in `progress` and `inbox`', () => {
  it('walks a project from planning to accepted, with the inbox always naming the next human step', async () => {
    const project = await planned({
      env: { PLAN_APPROVAL: 'required' },
      assignment: { verification: { buildCommand: NODE_OK, testCommand: NODE_OK } },
    });
    expect(kinds(project.id)).toEqual(['PLAN_APPROVAL']);
    expect(progress(project.id)).toMatchObject({ verifiedPercent: 0, totals: { tasks: 0 } });
    env.store.decideApproval(env.store.listApprovals('PENDING')[0]!.id, 'APPROVED', 'owner');
    await settle(env);
    expect(progress(project.id).verifiedPercent).toBe(100);
    expect(kinds(project.id)).toEqual(['PROJECT_VERIFICATION_NEEDED']);
    // analysis keeps its own arrays untouched by the test helpers
    expect(analysisJson()).toBeTypeOf('string');
    expect(architectureJson()).toBeTypeOf('string');
  });
});
