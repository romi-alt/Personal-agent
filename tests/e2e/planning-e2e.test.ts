import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/database/connection.js';
import { Store } from '../../src/queue/store.js';
import { WorkflowRepository } from '../../src/workflows/repository.js';
import { assignmentExample } from '../helpers/assignment.js';
import { waitFor } from '../helpers/env.js';
import { removeTempDir } from '../helpers/fs.js';
import { analysisJson, architectureJson, planJson, reply } from '../helpers/plan-fixtures.js';

/**
 * Phase 2 end to end with REAL processes and a real database file: assignment -> plan -> tasks -> execution -> VERIFYING,
 * with the supervisor SIGKILLed in the middle of a planning step. Only the provider is the deterministic mock.
 */
const ROOT = path.resolve(__dirname, '../..');
let home: string;
let env: NodeJS.ProcessEnv;
const procs: ChildProcess[] = [];

const cli = (args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
const ok = (...args: string[]) => {
  const r = cli(args);
  expect(r.status, `${args.join(' ')}: ${r.stderr}`).toBe(0);
  return r.stdout;
};
const startSupervisor = (): ChildProcess => {
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'start'], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
  });
  procs.push(p);
  return p;
};
const exited = (p: ChildProcess) =>
  new Promise<number | null>((r) => (p.exitCode !== null ? r(p.exitCode) : p.once('exit', (c) => r(c))));

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'elevariq-plan-e2e-'));
  env = {
    ...process.env,
    AGENT_HOME: home,
    AGENT_ENV_FILE: path.join(home, 'no.env'),
    LOG_TO_CONSOLE: 'false',
    EXECUTION_PROVIDER: 'mock',
    MOCK_SCENARIO_FILE: path.join(home, 'scenario.json'),
    POLL_INTERVAL_MS: '100',
    HEARTBEAT_INTERVAL_MS: '200',
    LEASE_TTL_MS: '1500',
    SHUTDOWN_GRACE_MS: '3000',
    BACKOFF_BASE_MS: '500',
    PLAN_APPROVAL: 'required',
    NODE_NO_WARNINGS: '1',
  };
});
afterEach(async () => {
  const alive = procs.filter((p) => p.exitCode === null && p.signalCode === null);
  for (const p of alive) p.kill('SIGKILL');
  await Promise.all(alive.map(exited));
  procs.length = 0;
  removeTempDir(home);
});

describe('E2E: assignment -> planned tasks -> executed -> VERIFYING, across a SIGKILL during planning', () => {
  it('resumes the interrupted planning step, waits for plan approval, then builds and executes the plan exactly once', async () => {
    writeFileSync(
      env['MOCK_SCENARIO_FILE']!,
      JSON.stringify({
        tasks: {
          'Plan: analyze': [reply(analysisJson())],
          'Plan: architect': ['hang', reply(architectureJson())], // first attempt hangs: we kill the supervisor there
          'Plan: decompose': [reply(planJson())],
        },
      }),
    );
    const assignmentFile = path.join(home, 'assignment.json');
    writeFileSync(assignmentFile, JSON.stringify(assignmentExample()));
    expect(ok('assignment:add', '--file', assignmentFile)).toMatch(/registered project/);
    ok('plan:start', 'school-management-erp');

    const store = new Store(openDatabase(path.join(home, 'agent.db')));
    const wf = new WorkflowRepository(store);
    const project = store.listProjects()[0]!;
    const run = wf.listRuns({ projectId: project.id })[0]!;

    // ---- supervisor A: analysis completes, architecture hangs mid-execution -> SIGKILL
    const a = startSupervisor();
    await waitFor(
      () => {
        const step = wf.latestStep(run.id, 'architect');
        const task = step?.taskId ? store.getTask(step.taskId) : null;
        return task?.status === 'RUNNING' && !!task.sessionId;
      },
      30_000,
      100,
    );
    expect(wf.latestStep(run.id, 'analyze')!.status).toBe('COMPLETED');
    a.kill('SIGKILL');
    await exited(a);
    expect(wf.getRun(run.id)!.status).toBe('RUNNING'); // workflow state survived the kill

    // ---- supervisor B: reconciles the orphaned planning task, resumes, reaches the approval gate
    const b = startSupervisor();
    await waitFor(() => wf.getRun(run.id)!.status === 'WAITING_FOR_OWNER', 40_000, 100);
    expect(wf.getRun(run.id)!.context.phase).toBe('approval');
    const archTask = store.getTask(wf.latestStep(run.id, 'architect')!.taskId!)!;
    expect(store.listExecutions(archTask.id).map((e) => e.outcome)).toEqual(['interrupted', 'completed']);
    expect(store.listTasks({ projectId: project.id }).filter((t) => t.kind === 'CODING')).toHaveLength(0); // nothing built before approval

    const show = ok('workflow:show', run.id);
    expect(show).toMatch(/Waiting for plan approval/);
    const approvalId = store.listApprovals('PENDING').find((x) => x.actionType === 'plan_approval')!.id;
    expect(ok('approve', approvalId)).toContain('APPROVED');

    // ---- the plan is materialised and executed by the ordinary queue
    await waitFor(() => store.getProject(project.id)!.lifecycle === 'VERIFYING', 60_000, 100);
    const tasks = store.listTasks({ projectId: project.id });
    const coding = tasks.filter((t) => t.kind === 'CODING');
    const planning = tasks.filter((t) => t.kind === 'PLANNING');
    expect(planning).toHaveLength(3);
    expect(coding.map((t) => t.title)).toEqual([
      'Scaffold project and auth',
      'Enrollment module',
      'Attendance module',
    ]);
    for (const t of [...planning, ...coding]) {
      expect(t.status).toBe('COMPLETED');
      expect(store.listExecutions(t.id).filter((e) => e.outcome === 'completed')).toHaveLength(1); // exactly once
    }
    expect(wf.getRun(run.id)!.status).toBe('COMPLETED');
    expect(store.listProjectTransitions(project.id).map((t) => t.to)).toEqual([
      'ANALYZING',
      'PLANNING',
      'IN_DEVELOPMENT',
      'VERIFYING',
    ]);
    expect(store.getProject(project.id)!.lifecycle).not.toBe('DELIVERED');

    // ---- CLI views
    const planShow = ok('plan:show', 'school-management-erp');
    expect(planShow).toMatch(/FR-1\s+must\s+assignment\s+T2/);
    expect(planShow).toMatch(/DR-1\s+could\s+analysis\s+T2/);
    expect(planShow).toMatch(/Latest plan: valid; uncovered requirements: none/);
    expect(ok('workflow:list')).toMatch(/plan_project\s+COMPLETED/);

    expect(ok('stop')).toBeTypeOf('string');
    expect(await exited(b)).toBe(0);
  }, 150_000);
});
