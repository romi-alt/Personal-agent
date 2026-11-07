import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/database/connection.js';
import { Store } from '../../src/queue/store.js';
import { waitFor } from '../helpers/env.js';
import { removeTempDir } from '../helpers/fs.js';

/**
 * End-to-end: REAL supervisor processes (spawned via the CLI), a REAL SQLite file, REAL SIGKILL.
 * Only the provider is the deterministic mock, so no paid API traffic is generated.
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
const openStore = () => new Store(openDatabase(path.join(home, 'agent.db')));
const taskId = (out: string) => out.match(/tsk_[a-z0-9]+/)![0];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'elevariq-e2e-'));
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
    RESET_MARGIN_MS: '100',
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

describe('E2E: three tasks, capacity exhaustion, supervisor killed and restarted', () => {
  it('resumes the partially-completed task after restart and completes all three exactly once', async () => {
    writeFileSync(
      env['MOCK_SCENARIO_FILE']!,
      JSON.stringify({
        tasks: {
          'Task 1: scaffold': ['success'],
          'Task 2: attendance module': [
            { type: 'partial', writes: [{ file: 'attendance/part1.txt', content: 'half done\n' }] },
            { type: 'quota', resetsInMs: 6000 },
            'success',
          ],
          'Task 3: reports': ['success'],
        },
      }),
    );
    expect(cli(['project:add', '--name', 'Disposable Demo']).status).toBe(0);
    const t1 = taskId(
      cli([
        'task:add',
        '--project',
        'disposable-demo',
        '--title',
        'Task 1: scaffold',
        '--instructions',
        'scaffold',
      ]).stdout,
    );
    const t2 = taskId(
      cli([
        'task:add',
        '--project',
        'disposable-demo',
        '--title',
        'Task 2: attendance module',
        '--instructions',
        'attendance',
        '--depends',
        t1,
      ]).stdout,
    );
    const t3 = taskId(
      cli([
        'task:add',
        '--project',
        'disposable-demo',
        '--title',
        'Task 3: reports',
        '--instructions',
        'reports',
        '--depends',
        t2,
      ]).stdout,
    );

    // ---- supervisor A: task 1 completes, task 2 partial then provider capacity exhausted
    const a = startSupervisor();
    const store = openStore();
    await waitFor(() => store.getTask(t2)!.status === 'WAITING_FOR_CAPACITY', 20_000, 100);
    expect(store.getTask(t1)!.status).toBe('COMPLETED');
    const waitUntil = store.getTask(t2)!.nextEligibleAt!;
    expect(waitUntil).toBeGreaterThan(Date.now());

    // ---- terminate the supervisor abruptly (SIGKILL: no cleanup code runs)
    a.kill('SIGKILL');
    await exited(a);

    // state survived the kill
    expect(store.getTask(t2)).toMatchObject({
      status: 'WAITING_FOR_CAPACITY',
      lastErrorClass: 'QUOTA_EXHAUSTED',
      continuationCount: 1,
    });
    const sessionBefore = store.getTask(t2)!.sessionId;
    expect(sessionBefore).toMatch(/^mock-session-/);
    expect(store.listCheckpoints(t2).length).toBe(2);
    expect(store.getTask(t3)!.status).toBe('QUEUED');
    expect(store.getProviderState('mock')).toMatchObject({ status: 'QUOTA_EXHAUSTED' });

    // ---- supervisor B restarts while the provider is still exhausted: must stay idle (no wasted requests)
    const b = startSupervisor();
    await waitFor(
      () => store.getSupervisorState()?.pid === b.pid && store.getSupervisorState()?.status === 'IDLE',
      15_000,
      100,
    );
    await new Promise((r) => setTimeout(r, 1500));
    if (Date.now() < waitUntil - 500) expect(store.listExecutions(t2)).toHaveLength(2);
    expect(cli(['health']).status).toBe(0);

    // ---- provider capacity returns (reset time passes): remaining work completes
    await waitFor(() => ['COMPLETED'].includes(store.getTask(t3)!.status), 30_000, 100);

    for (const id of [t1, t2, t3]) expect(store.getTask(id)!.status).toBe('COMPLETED');
    // every task completed exactly once
    for (const id of [t1, t2, t3])
      expect(store.listExecutions(id).filter((e) => e.outcome === 'completed')).toHaveLength(1);
    // task 2 resumed its saved session
    const t2execs = store.listExecutions(t2);
    expect(t2execs.map((e) => e.outcome)).toEqual(['partial', 'failed', 'completed']);
    expect(t2execs[2]!.resumedFromSessionId).toBe(sessionBefore);
    // exact persisted transition history for the interrupted task
    expect(store.listTransitions(t2).map((t) => t.to)).toEqual([
      'QUEUED',
      'RUNNING',
      'CHECKPOINTING',
      'READY',
      'RUNNING',
      'CHECKPOINTING',
      'WAITING_FOR_CAPACITY',
      'RUNNING',
      'CHECKPOINTING',
      'COMPLETED',
    ]);
    // no work duplicated: workspace marker log has unique (task, attempt) pairs and attempt numbering is contiguous
    const project = store.listProjects()[0]!;
    const marks = readFileSync(path.join(project.repoPath, '.mock-executions.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split('\t'));
    expect(new Set(marks.map((m) => `${m[0]}#${m[1]}`)).size).toBe(marks.length);
    expect(marks.filter((m) => m[0] === 'Task 1: scaffold')).toHaveLength(1);
    expect(marks.filter((m) => m[0] === 'Task 3: reports')).toHaveLength(1);
    expect(readFileSync(path.join(project.repoPath, 'attendance/part1.txt'), 'utf8')).toBe('half done\n'); // earlier artifacts preserved

    // ---- CLI reports and graceful stop
    const status = JSON.parse(cli(['status', '--json']).stdout) as {
      supervisor: { live: boolean };
      queue: { byStatus: Record<string, number> };
    };
    expect(status.supervisor.live).toBe(true);
    expect(status.queue.byStatus['COMPLETED']).toBe(3);
    const stop = cli(['stop']);
    expect(stop.status).toBe(0);
    expect(await exited(b)).toBe(0);
    expect(store.getSupervisorState()!.status).toBe('STOPPED');
    expect(store.listEvents({ type: 'supervisor.stopped' }).at(-1)!.payload['graceful']).toBe(true);
  }, 90_000);

  it('recovers a task whose supervisor was SIGKILLed mid-execution and resumes its session', async () => {
    writeFileSync(
      env['MOCK_SCENARIO_FILE']!,
      JSON.stringify({ tasks: { 'long task': ['hang', 'success'] } }),
    );
    cli(['project:add', '--name', 'Crash Demo']);
    const t = taskId(
      cli(['task:add', '--project', 'crash-demo', '--title', 'long task', '--instructions', 'x']).stdout,
    );
    const store = openStore();

    const a = startSupervisor();
    await waitFor(() => store.getTask(t)!.status === 'RUNNING' && !!store.getTask(t)!.sessionId, 20_000, 100);
    a.kill('SIGKILL');
    await exited(a);
    expect(store.getTask(t)!.status).toBe('RUNNING'); // orphaned: the DB cannot know the process died

    const b = startSupervisor();
    await waitFor(() => store.getTask(t)!.status === 'COMPLETED', 30_000, 100);
    const execs = store.listExecutions(t);
    expect(execs.map((e) => e.outcome)).toEqual(['interrupted', 'completed']);
    expect(execs[1]!.resumedFromSessionId).toBe(execs[0]!.providerSessionId);
    expect(store.listEvents({ type: 'recovery.task_reconciled', taskId: t })).toHaveLength(1);
    expect(store.getTask(t)!.attemptCount).toBe(0);
    expect(cli(['stop']).status).toBe(0);
    await exited(b);
  }, 60_000);

  it('refuses to start a second live supervisor', async () => {
    cli(['project:add', '--name', 'Singleton']);
    const store = openStore();
    const a = startSupervisor();
    await waitFor(() => store.getSupervisorState()?.status === 'IDLE', 20_000, 100);
    const second = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'start'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(second.status).toBe(3);
    expect(second.stderr).toMatch(/Another supervisor/);
    expect(cli(['stop']).status).toBe(0);
    await exited(a);
  }, 60_000);
});
