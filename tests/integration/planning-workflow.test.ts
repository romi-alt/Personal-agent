import { afterEach, describe, expect, it } from 'vitest';
import { registerAssignment } from '../../src/assignments/register.js';
import { Store } from '../../src/queue/store.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { WorkflowEngine } from '../../src/workflows/engine.js';
import { assignmentExample } from '../helpers/assignment.js';
import { makeEnv, settle, waitFor, type TestEnv } from '../helpers/env.js';
import { analysisJson, architectureJson, happyPlanning, planJson, reply } from '../helpers/plan-fixtures.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const AUTO = { PLAN_APPROVAL: 'auto' };
const setup = async (
  opts: Parameters<typeof makeEnv>[0] = {},
  scenario: Record<string, unknown[]> = happyPlanning(),
) => {
  env = await makeEnv({ ...opts, mock: { scenario: { tasks: scenario as never }, ...opts?.mock } });
  const { project } = await registerAssignment(env.store, env.registry, 'mock', assignmentExample());
  return project;
};
const planningTasks = (projectId: string) =>
  env.store.listTasks({ projectId }).filter((t) => t.kind === 'PLANNING');
const codingTasks = (projectId: string) =>
  env.store.listTasks({ projectId }).filter((t) => t.kind === 'CODING');

describe('planning workflow: analyse -> architect -> decompose -> tasks', () => {
  it('runs end to end: validated plan becomes ordered, linked coding tasks that the queue then executes; project is never auto-delivered', async () => {
    const project = await setup({ env: AUTO });
    const run = env.workflows.startPlanning(project.id);
    expect(env.store.getProject(project.id)!.lifecycle).toBe('ANALYZING');
    await settle(env);

    const done = env.workflows.repo.getRun(run.id)!;
    expect(done).toMatchObject({ status: 'COMPLETED' });
    expect(done.context.phase).toBe('done');

    // planning steps were read-only PLANNING tasks, executed by the ordinary queue
    const planning = planningTasks(project.id);
    expect(planning.map((t) => t.title)).toEqual([
      'Plan: analyze',
      'Plan: research',
      'Plan: architect',
      'Plan: decompose',
      'Plan: review',
    ]);
    expect(planning.every((t) => t.readOnly && t.status === 'COMPLETED')).toBe(true);
    expect(env.mock!.runs.filter((r) => r.taskTitle.startsWith('Plan:')).every((r) => r.readOnly)).toBe(true);
    expect(env.mock!.runs.filter((r) => !r.taskTitle.startsWith('Plan:')).every((r) => !r.readOnly)).toBe(
      true,
    );

    // requirements: assignment ones kept, derived one added by analysis
    expect(env.workflows.repo.listRequirements(project.id).map((r) => `${r.id}:${r.source}`)).toEqual([
      'FR-1:assignment',
      'FR-2:assignment',
      'NFR-1:assignment',
      'DR-1:analysis',
    ]);
    // memory sections written
    for (const section of ['requirements', 'architecture_decisions', 'technology_decisions', 'roadmap']) {
      expect(env.store.getMemory(project.id, section), section).toBeTruthy();
    }
    expect(env.store.getMemory(project.id, 'architecture_decisions')).toContain('Monolith first');

    // coding tasks: dependencies mapped to task ids, milestone-ordered priority, verification, plan links
    const coding = codingTasks(project.id);
    expect(coding.map((t) => t.title)).toEqual([
      'Scaffold project and auth',
      'Enrollment module',
      'Attendance module',
    ]);
    const [t1, t2, t3] = coding as [(typeof coding)[0], (typeof coding)[0], (typeof coding)[0]];
    expect(t2.dependsOn).toEqual([t1.id]);
    expect(t3.dependsOn).toEqual([t1.id, t2.id]);
    expect(t1.priority).toBeGreaterThan(t2.priority); // earlier milestone first
    expect(t2.verificationRequired).toEqual(['CHANGES_EXIST', 'TESTS_PASS']);
    expect(env.workflows.repo.listPlanTasks(project.id).map((p) => `${p.planKey}:${p.milestoneKey}`)).toEqual(
      ['T1:M1', 'T2:M2', 'T3:M2'],
    );
    expect(env.workflows.repo.listMilestones(project.id).map((m) => m.key)).toEqual(['M1', 'M2']);

    // the queue executed them in dependency order, each with independent verification evidence
    expect(coding.every((t) => env.store.getTask(t.id)!.status === 'COMPLETED')).toBe(true);
    expect(env.mock!.runs.filter((r) => !r.taskTitle.startsWith('Plan:')).map((r) => r.taskTitle)).toEqual([
      'Scaffold project and auth',
      'Enrollment module',
      'Attendance module',
    ]);
    for (const t of coding) {
      expect(env.store.listEvidence({ taskId: t.id, level: 'CHANGES_EXIST' })[0]).toMatchObject({
        status: 'PASSED',
      });
    }
    // all coding tasks done -> VERIFYING, never delivered; planning tasks did not trigger it earlier
    expect(env.store.getProject(project.id)!.lifecycle).toBe('VERIFYING');
    expect(env.store.listProjectTransitions(project.id).map((t) => t.to)).toEqual([
      'ANALYZING',
      'PLANNING',
      'IN_DEVELOPMENT',
      'VERIFYING',
    ]);
  });

  it('planning prompts carry the assignment, refined requirements and the previous steps outputs', async () => {
    const project = await setup({ env: AUTO });
    env.workflows.startPlanning(project.id);
    await settle(env);
    const prompts = Object.fromEntries(env.mock!.runs.map((r) => [r.taskTitle, r.prompt]));
    expect(prompts['Plan: analyze']).toContain('[FR-1] (must) Student enrollment');
    expect(prompts['Plan: analyze']).toContain('Reply schema (JSON object only)');
    expect(prompts['Plan: architect']).toContain('[DR-1]'); // refined requirement from analysis
    expect(prompts['Plan: architect']).toContain('Single school, single timezone'); // assumption carried forward
    expect(prompts['Plan: decompose']).toContain('Enrollment: students and guardians'); // architecture carried forward
    expect(prompts['Plan: decompose']).toContain('At most 60 tasks');
  });

  it('startPlanning is idempotent, requires an assignment, and is refused for a project already in development', async () => {
    const project = await setup({ env: AUTO });
    const a = env.workflows.startPlanning(project.id);
    expect(env.workflows.startPlanning(project.id).id).toBe(a.id);
    expect(() => env.workflows.startPlanning(env.project.id)).toThrow(/Register an assignment first/);
    await settle(env);
    expect(() => env.workflows.startPlanning(project.id)).toThrow(/planning can only start from/);
  });
});

describe('owner approval and clarification gates', () => {
  it('with PLAN_APPROVAL=required no coding task exists until the owner approves the plan', async () => {
    const project = await setup();
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)).toMatchObject({
      status: 'WAITING_FOR_OWNER',
      context: { phase: 'approval' },
    });
    expect(codingTasks(project.id)).toHaveLength(0);
    const approval = env.store.listApprovals('PENDING').find((a) => a.actionType === 'plan_approval')!;
    expect(approval.description).toMatch(/3 task\(s\), all 4 requirement\(s\) covered/);
    expect(env.store.getProject(project.id)!.lifecycle).toBe('PLANNING');

    env.store.decideApproval(approval.id, 'APPROVED', 'owner');
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)!.status).toBe('COMPLETED');
    expect(codingTasks(project.id)).toHaveLength(3);
    expect(env.store.getProject(project.id)!.lifecycle).toBe('VERIFYING');
  });

  it('a rejected plan creates nothing and the owner can start a fresh planning run', async () => {
    const project = await setup();
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    const approval = env.store.listApprovals('PENDING')[0]!;
    env.store.decideApproval(approval.id, 'DENIED', 'owner');
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)).toMatchObject({
      status: 'CANCELLED',
      error: 'plan rejected by the owner',
    });
    expect(codingTasks(project.id)).toHaveLength(0);
    expect(env.workflows.startPlanning(project.id).id).not.toBe(run.id);
  });

  it('blocking questions pause the workflow; answers flow into the architecture prompt; assumptions can be accepted instead', async () => {
    const project = await setup(
      { env: AUTO },
      {
        ...happyPlanning(),
        'Plan: analyze': [
          reply(
            analysisJson({
              questions: [
                { id: 'Q-1', text: 'Which payment gateway?', blocking: true },
                { id: 'Q-2', text: 'Nice to have: dark mode?', blocking: false },
              ],
            }),
          ),
        ],
      },
    );
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)).toMatchObject({
      status: 'WAITING_FOR_OWNER',
      context: { phase: 'clarify' },
    });
    expect(env.workflows.repo.latestStep(run.id, 'architect')).toBeNull(); // not started without the answer
    expect(env.store.getMemory(project.id, 'requirements')).toContain(
      '[Q-1] (blocking) Which payment gateway?',
    );

    expect(() => env.workflows.answerQuestion(run.id, 'Q-404', 'x')).toThrow(/Unknown question/);
    env.workflows.answerQuestion(run.id, 'Q-1', 'Stripe, test mode only');
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)!.status).toBe('COMPLETED');
    expect(env.mock!.runs.find((r) => r.taskTitle === 'Plan: architect')!.prompt).toContain(
      'Q-1: Stripe, test mode only',
    );
  });

  it('workflow:resume --assume continues without answers', async () => {
    const project = await setup(
      { env: AUTO },
      {
        ...happyPlanning(),
        'Plan: analyze': [
          reply(analysisJson({ questions: [{ id: 'Q-1', text: 'Which gateway?', blocking: true }] })),
        ],
      },
    );
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)!.status).toBe('WAITING_FOR_OWNER');
    env.workflows.resumeWithAssumptions(run.id);
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)!.status).toBe('COMPLETED');
  });
});

describe('invalid model output is repaired or escalated, never accepted', () => {
  it('feeds the validator errors back and succeeds on the repair round', async () => {
    const missingFr2 = planJson((p) => p.tasks.pop()); // FR-2 uncovered
    const project = await setup(
      { env: AUTO },
      {
        ...happyPlanning(),
        'Plan: decompose': [reply(missingFr2)],
        'Plan: decompose (repair 1)': [reply(planJson())],
      },
    );
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)).toMatchObject({
      status: 'COMPLETED',
      context: { repairs: { decompose: 1 } },
    });
    const repair = env.mock!.runs.find((r) => r.taskTitle === 'Plan: decompose (repair 1)')!;
    expect(repair.prompt).toContain('REPAIR REQUIRED');
    expect(repair.prompt).toContain('requirement "FR-2" is not implemented by any task');
    expect(
      env.workflows.repo
        .listSteps(run.id)
        .filter((s) => s.name === 'decompose')
        .map((s) => s.status),
    ).toEqual(['INVALID', 'COMPLETED']);
    expect(codingTasks(project.id)).toHaveLength(3);
  });

  it('a dependency cycle and prose-instead-of-JSON are both rejected', async () => {
    const cyclic = planJson((p) => (p.tasks[0]!.dependsOn = ['T3']));
    const project = await setup(
      { env: { ...AUTO, MAX_PLAN_REPAIRS: '3' } },
      {
        ...happyPlanning(),
        'Plan: decompose': [reply(cyclic)],
        'Plan: decompose (repair 1)': [reply('Sorry, here is a plan in words only.')],
        'Plan: decompose (repair 2)': [reply('```json\n' + planJson() + '\n```')],
      },
    );
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    const steps = env.workflows.repo.listSteps(run.id).filter((s) => s.name === 'decompose');
    expect(steps.map((s) => s.status)).toEqual(['INVALID', 'INVALID', 'COMPLETED']);
    expect(steps[0]!.error).toMatch(/cycle|later milestone/);
    expect(steps[1]!.error).toMatch(/invalid JSON|no JSON object/);
    expect(env.workflows.repo.getRun(run.id)!.status).toBe('COMPLETED'); // fenced JSON accepted
  });

  it('after MAX_PLAN_REPAIRS invalid replies the run FAILS, the project is BLOCKED for the owner, and no task is created', async () => {
    const bad = reply(planJson((p) => p.tasks.pop()));
    const project = await setup(
      { env: { ...AUTO, MAX_PLAN_REPAIRS: '1' } },
      { ...happyPlanning(), 'Plan: decompose': [bad], 'Plan: decompose (repair 1)': [bad] },
    );
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)).toMatchObject({ status: 'FAILED' });
    expect(env.workflows.repo.getRun(run.id)!.error).toMatch(/invalid output 2 times/);
    expect(codingTasks(project.id)).toHaveLength(0);
    expect(env.store.getProject(project.id)!.lifecycle).toBe('BLOCKED');
    expect(env.store.listEvents({ type: 'workflow.failed' })).toHaveLength(1);
    // owner can restart planning after fixing the cause
    expect(env.workflows.startPlanning(project.id).id).not.toBe(run.id);
  });

  it('an analysis that drops an assignment requirement or invents one is repaired', async () => {
    const dropped = reply(analysisJson({ requirements: [{ id: 'FR-1', text: 'only the first' }] }));
    const project = await setup(
      { env: AUTO },
      { ...happyPlanning(), 'Plan: analyze': [dropped], 'Plan: analyze (repair 1)': [reply(analysisJson())] },
    );
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    expect(env.mock!.runs.find((r) => r.taskTitle === 'Plan: analyze (repair 1)')!.prompt).toMatch(
      /assignment requirement "FR-2" is missing/,
    );
    expect(env.workflows.repo.getRun(run.id)!.status).toBe('COMPLETED');
  });

  it('a planning task that fails outright (retries exhausted) fails the run instead of looping', async () => {
    const project = await setup(
      { env: { ...AUTO, DEFAULT_MAX_RETRIES: '0' } },
      { ...happyPlanning(), 'Plan: architect': ['fatal'] },
    );
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)).toMatchObject({ status: 'FAILED' });
    expect(env.workflows.repo.getRun(run.id)!.error).toMatch(/"architect" FAILED/);
    expect(env.store.getProject(project.id)!.lifecycle).toBe('BLOCKED');
  });
});

describe('durability: crashes, waits and replays', () => {
  it('survives a supervisor restart mid-workflow without duplicating planning or coding tasks', async () => {
    const project = await setup({ env: AUTO });
    const run = env.workflows.startPlanning(project.id);
    // run only the first step, then "crash"
    await env.supervisor.tick();
    await waitFor(() => env.supervisor.activeWorkers === 0, 20_000); // not a fixed sleep: Windows is slower
    env.workflows.advanceAll();
    expect(env.workflows.repo.latestStep(run.id, 'analyze')!.status).toBe('COMPLETED');
    expect(env.workflows.repo.latestStep(run.id, 'architect')).toBeNull();

    // brand-new store, engine and supervisor on the same database file
    const store2 = new Store(env.store.db, env.clock, env.log);
    const engine2 = new WorkflowEngine(
      store2,
      { planApproval: 'auto', maxPlanTasks: 60, maxPlanRepairs: 2, defaultMaxRetries: 3 },
      env.log,
    );
    const sup2 = new Supervisor({
      config: env.config,
      store: store2,
      provider: env.provider,
      registry: env.registry,
      log: env.log,
      workflows: engine2,
    });
    const env2 = { ...env, store: store2, workflows: engine2, supervisor: sup2 } as TestEnv;
    await settle(env2);

    expect(engine2.repo.getRun(run.id)!.status).toBe('COMPLETED');
    expect(planningTasks(project.id)).toHaveLength(5);
    expect(codingTasks(project.id)).toHaveLength(3);
    // advancing again (replay) changes nothing
    expect(engine2.advanceAll()).toBe(0);
    expect(codingTasks(project.id)).toHaveLength(3);
  });

  it('a rate limit during a planning step waits in the queue; the workflow neither fails nor polls', async () => {
    const project = await setup(
      { env: AUTO },
      {
        ...happyPlanning(),
        'Plan: architect': [{ type: 'rate_limit', retryAfterMs: 30_000 }, reply(architectureJson())],
      },
    );
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    const arch = env.workflows.repo.latestStep(run.id, 'architect')!;
    expect(arch.status).toBe('DISPATCHED');
    expect(env.store.getTask(arch.taskId!)).toMatchObject({ status: 'WAITING_FOR_CAPACITY' });
    expect(env.workflows.repo.getRun(run.id)!.status).toBe('RUNNING');
    const calls = env.mock!.runs.length;
    env.clock.advance(20_000);
    await settle(env);
    expect(env.mock!.runs.length).toBe(calls); // still waiting: no provider calls
    env.clock.advance(11_000);
    await settle(env);
    expect(env.workflows.repo.getRun(run.id)!.status).toBe('COMPLETED');
  });

  it('materialising the same plan twice creates nothing new (idempotent keys)', async () => {
    const project = await setup({ env: AUTO });
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    const plan = JSON.parse(env.workflows.repo.completedOutput(run.id, 'decompose')!);
    const ids = codingTasks(project.id).map((t) => t.id);
    expect(env.workflows.materialize(env.workflows.repo.getRun(run.id)!, plan)).toBe(0);
    expect(codingTasks(project.id).map((t) => t.id)).toEqual(ids);
  });

  it('cancelling a run cancels its open planning task', async () => {
    const project = await setup({ env: AUTO });
    const run = env.workflows.startPlanning(project.id);
    env.workflows.advanceAll(); // dispatches the analyze task (not yet run)
    const task = planningTasks(project.id)[0]!;
    expect(task.status).toBe('QUEUED');
    env.workflows.cancel(run.id, 'owner changed their mind');
    expect(env.store.getTask(task.id)!.status).toBe('CANCELLED');
    expect(env.workflows.repo.getRun(run.id)).toMatchObject({
      status: 'CANCELLED',
      error: 'owner changed their mind',
    });
    await settle(env);
    expect(env.mock!.runs).toHaveLength(0);
  });

  it('a planning task needing approval for a denied tool simply waits (the workflow does not fail)', async () => {
    const project = await setup(
      { env: AUTO },
      { ...happyPlanning(), 'Plan: analyze': ['permission_denied', reply(analysisJson())] },
    );
    const run = env.workflows.startPlanning(project.id);
    await settle(env);
    expect(env.store.getTask(planningTasks(project.id)[0]!.id)!.status).toBe('WAITING_FOR_APPROVAL');
    expect(env.workflows.repo.getRun(run.id)!.status).toBe('RUNNING');
  });
});
