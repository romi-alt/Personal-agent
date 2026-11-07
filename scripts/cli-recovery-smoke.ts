/**
 * Live recovery test of the native CLI provider (acceptance test 6 against the real Claude Code CLI).
 * Uses the owner's subscription login, haiku by default, one small task.
 *
 *   npx tsx scripts/cli-recovery-smoke.ts
 *
 * Supervisor A starts the task; once the CLI worker is mid-task it is SIGKILLed (no cleanup runs). The orphaned
 * `claude` process is still alive at that point. Supervisor B must stop the orphan, resume the SAME session and
 * finish the task, without a duplicate concurrent session.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database/connection.js';
import { Store } from '../src/queue/store.js';
import { pidExists } from '../src/workers/process-tree.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const home = mkdtempSync(path.join(tmpdir(), 'elevariq-cli-recovery-'));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENT_HOME: home,
  AGENT_ENV_FILE: path.join(home, 'none.env'),
  EXECUTION_PROVIDER: 'claude-cli',
  CLAUDE_MODEL: process.env['CLAUDE_MODEL'] ?? 'haiku',
  LOG_TO_CONSOLE: 'false',
  POLL_INTERVAL_MS: '500',
  HEARTBEAT_INTERVAL_MS: '1000',
  LEASE_TTL_MS: '5000',
  NODE_NO_WARNINGS: '1',
};
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
const start = (): ChildProcess =>
  spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'start'], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(500);
  }
}
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });

const add = cli('project:add', '--name', 'CLI Recovery Demo');
if (add.status !== 0) throw new Error(add.stderr);
const task = cli(
  'task:add',
  '--project',
  'cli-recovery-demo',
  '--title',
  'Two-step note',
  '--instructions',
  'Step 1: create notes/step1.txt containing exactly: one. Step 2: run the shell command `sleep 25` (it is slow on purpose). ' +
    'Step 3: create notes/step2.txt containing exactly: two. Before doing anything, check which of these files already exist and skip completed steps. Reply DONE when finished.',
);
if (task.status !== 0) throw new Error(task.stderr);
const taskId = /tsk_[a-z0-9]+/.exec(task.stdout)![0];
const store = new Store(openDatabase(path.join(home, 'agent.db')));
const repo = store.listProjects()[0]!.repoPath;

let a: ChildProcess | undefined;
let b: ChildProcess | undefined;
try {
  a = start();
  await until(
    () => !!store.latestExecution(taskId)?.workerPid && existsSync(path.join(repo, 'notes', 'step1.txt')),
    180_000,
    'worker pid recorded and step 1 written',
  );
  const first = store.latestExecution(taskId)!;
  const orphanPid = first.workerPid!;
  const sessionId = store.getTask(taskId)!.sessionId;
  a.kill('SIGKILL');
  await sleep(1500);
  const orphanSurvived = pidExists(orphanPid);
  check('session id was persisted before the kill', !!sessionId, String(sessionId));

  b = start();
  // The invariant: no previous worker may still be running once the replacement execution exists.
  await until(() => store.listExecutions(taskId).length >= 2, 120_000, 'replacement execution started');
  const orphanAliveAtReplacement = pidExists(orphanPid);
  await until(
    () => store.getTask(taskId)!.status === 'COMPLETED' || store.getTask(taskId)!.status === 'BLOCKED',
    300_000,
    'task finished',
  );
  const t = store.getTask(taskId)!;
  const execs = store.listExecutions(taskId);
  const events = store.listEvents({ taskId }).map((e) => e.type);
  check(
    'no previous worker alive when the replacement started',
    !orphanAliveAtReplacement,
    orphanSurvived
      ? `orphan pid ${orphanPid} outlived the supervisor and was stopped by recovery (event: ${events.includes('recovery.orphan_worker_terminated')})`
      : `worker pid ${orphanPid} had already exited when checked 1.5 s after the supervisor was killed; nothing to stop`,
  );
  check(
    'task completed after restart',
    t.status === 'COMPLETED',
    `${t.status} ${t.lastErrorClass ?? ''} ${t.lastErrorMessage ?? ''}`,
  );
  check(
    'same provider session resumed',
    t.sessionId === sessionId,
    `${String(t.sessionId)} vs ${String(sessionId)}`,
  );
  check(
    'first execution recorded as interrupted',
    execs[0]?.outcome === 'interrupted',
    String(execs[0]?.outcome),
  );
  check('step 2 produced', existsSync(path.join(repo, 'notes', 'step2.txt')));
  check('exactly one replacement execution', execs.length === 2, `${execs.length} executions`);
} finally {
  for (const p of [a, b]) if (p && p.exitCode === null) p.kill('SIGKILL');
}
for (const c of checks)
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  -- ${c.detail}` : ''}`);
console.log(`agent home: ${home}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
