import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/database/connection.js';
import { Store } from '../../src/queue/store.js';
import { pidExists, processIdentity } from '../../src/workers/process-tree.js';
import { waitFor } from '../helpers/env.js';
import { removeTempDir } from '../helpers/fs.js';

/**
 * Stronger process-tree recovery test, independent of the Claude subscription. The mock provider spawns a REAL
 * long-running child process as its worker. The supervisor is SIGKILLed while that worker is alive; the restarted
 * supervisor must identify the orphan by its recorded OS identity, stop only it, and only then start a replacement
 * that resumes from the checkpoint.
 */
const ROOT = path.resolve(__dirname, '../..');
let home: string;
let env: NodeJS.ProcessEnv;
const procs: ChildProcess[] = [];
const strays: number[] = [];

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
const taskId = (out: string) => out.match(/tsk_[a-z0-9]+/)![0];
/** pids of every process whose image is claude(.exe) right now (e.g. the owner's interactive Claude Code). */
function claudePids(): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return [...out.matchAll(/^"claude\.exe","(\d+)"/gim)].map((m) => Number(m[1]));
    }
    return execFileSync('pgrep', ['-x', 'claude'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'elevariq-orphan-'));
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
    NODE_NO_WARNINGS: '1',
  };
  scenario(true);
});
function scenario(detached: boolean) {
  writeFileSync(
    env['MOCK_SCENARIO_FILE']!,
    JSON.stringify({
      tasks: {
        'orphan task': [
          {
            type: 'spawn_worker',
            detached,
            delayMs: 180_000,
            writes: [{ file: 'step1.txt', content: 'one\n' }],
          },
          { type: 'success', writes: [{ file: 'step2.txt', content: 'two\n' }] },
        ],
      },
    }),
  );
}
afterEach(async () => {
  const alive = procs.filter((p) => p.exitCode === null && p.signalCode === null);
  for (const p of alive) p.kill('SIGKILL');
  await Promise.all(alive.map(exited));
  procs.length = 0;
  for (const pid of strays.splice(0))
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  removeTempDir(home);
});

async function killSupervisorMidTask() {
  cli(['project:add', '--name', 'Orphan Demo']);
  const t = taskId(
    cli(['task:add', '--project', 'orphan-demo', '--title', 'orphan task', '--instructions', 'x']).stdout,
  );
  const store = new Store(openDatabase(path.join(home, 'agent.db')));
  const repo = store.listProjects()[0]!.repoPath;
  const a = startSupervisor();
  await waitFor(
    () => !!store.latestExecution(t)?.workerIdentity && existsSync(path.join(repo, '.mock-worker.beat')),
    30_000,
    100,
  );
  const exec = store.latestExecution(t)!;
  const workerPid = exec.workerPid!;
  strays.push(workerPid);
  a.kill('SIGKILL');
  await exited(a);
  await new Promise((r) => setTimeout(r, 1000));
  return { t, store, repo, exec, workerPid };
}

const lastBeat = (repo: string) =>
  Math.max(
    ...readFileSync(path.join(repo, '.mock-worker.beat'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => Number(l.split(' ')[1])),
  );

describe('E2E: orphaned worker process after supervisor SIGKILL', () => {
  it('stops exactly the recorded worker, then resumes the task from its checkpoint', async () => {
    // Long-lived claude processes only (e.g. the owner's interactive session): an installed agent's readiness probe
    // starts short-lived `claude auth status` processes that end on their own and must not be counted.
    // Counted: claude processes that were already running a minute before this test (probes live < 1-5 s, even
    // under the load of a parallel suite).
    const testStart = Date.now();
    const ids = await Promise.all(claudePids().map((p) => processIdentity(p)));
    const claudeBefore = ids
      .filter((i): i is NonNullable<typeof i> => !!i && i.startedAtMs < testStart - 60_000)
      .map((i) => i.pid);
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    strays.push(decoy.pid!);
    const { t, store, repo, exec, workerPid } = await killSupervisorMidTask();

    // The worker outlived its supervisor and is still working.
    expect(exec.workerIdentity).toMatchObject({ pid: workerPid, image: expect.stringMatching(/node/i) });
    expect(pidExists(workerPid)).toBe(true);
    expect(lastBeat(repo)).toBeGreaterThan(Date.now() - 2000);
    expect(store.getTask(t)!.status).toBe('RUNNING');

    const b = startSupervisor();
    await waitFor(() => store.getTask(t)!.status === 'COMPLETED', 60_000, 100);

    const execs = store.listExecutions(t);
    const stopped = store.listEvents({ type: 'recovery.orphan_worker_terminated', taskId: t });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.payload).toMatchObject({
      pid: workerPid,
      result: 'terminated',
      identityRecorded: true,
    });
    // Only the recorded worker was stopped.
    expect(pidExists(workerPid)).toBe(false);
    expect(pidExists(decoy.pid!)).toBe(true);
    for (const pid of claudeBefore) expect(pidExists(pid)).toBe(true);
    // The replacement started only after the old worker was handled, and the old worker did nothing afterwards.
    expect(execs.map((e) => e.outcome)).toEqual(['interrupted', 'completed']);
    expect(stopped[0]!.at).toBeLessThanOrEqual(execs[1]!.startedAt);
    expect(lastBeat(repo)).toBeLessThanOrEqual(execs[1]!.startedAt);
    // Resumed from the checkpoint and session; earlier work preserved and not redone.
    expect(execs[1]!.resumedFromSessionId).toBe(execs[0]!.providerSessionId);
    const cp = store.listCheckpoints(t);
    expect(cp.some((c) => c.executionId === execs[0]!.id)).toBe(true);
    expect(readFileSync(path.join(repo, 'step1.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(path.join(repo, 'step2.txt'), 'utf8')).toBe('two\n');
    const marks = readFileSync(path.join(repo, '.mock-executions.log'), 'utf8').trim().split('\n');
    expect(marks).toHaveLength(2);
    expect(marks[1]).toMatch(/\t2\tsuccess\tmock-session-/);

    expect(cli(['stop']).status).toBe(0);
    await exited(b);
  }, 120_000);

  it('leaves a process alone when the pid no longer has the recorded identity (pid reuse)', async () => {
    const { t, store, exec, workerPid } = await killSupervisorMidTask();
    // Simulate pid reuse: the live process at this pid is not the one recorded at spawn time.
    store.db.prepare('UPDATE executions SET worker_identity = ? WHERE id = ?').run(
      JSON.stringify({
        ...exec.workerIdentity!,
        startedAtMs: exec.workerIdentity!.startedAtMs - 3_600_000,
      }),
      exec.id,
    );

    const b = startSupervisor();
    await waitFor(
      () => store.listEvents({ type: 'recovery.orphan_pid_reused', taskId: t }).length === 1,
      60_000,
      100,
    );
    expect(store.listEvents({ type: 'recovery.orphan_worker_terminated', taskId: t })).toHaveLength(0);
    expect(pidExists(workerPid)).toBe(true); // not ours by identity: never touched
    expect(cli(['stop']).status).toBe(0);
    await exited(b);
  }, 120_000);

  it.runIf(process.platform === 'win32')(
    'Windows: a non-detached worker tree dies with its supervisor (libuv kill-on-close job object)',
    async () => {
      scenario(false);
      const { t, store, workerPid } = await killSupervisorMidTask();
      expect(pidExists(workerPid)).toBe(false);
      const b = startSupervisor();
      await waitFor(() => store.getTask(t)!.status === 'COMPLETED', 60_000, 100);
      expect(store.listEvents({ type: 'recovery.orphan_worker_terminated', taskId: t })).toHaveLength(0);
      expect(store.listExecutions(t).map((e) => e.outcome)).toEqual(['interrupted', 'completed']);
      expect(cli(['stop']).status).toBe(0);
      await exited(b);
    },
    120_000,
  );
});
