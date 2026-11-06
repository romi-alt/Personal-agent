import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/database/connection.js';
import { Store } from '../../src/queue/store.js';

/** Every advertised CLI command is executed for real against a throwaway AGENT_HOME. */
const ROOT = path.resolve(__dirname, '../..');
let home: string;
let env: NodeJS.ProcessEnv;
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
const ok = (...args: string[]) => {
  const r = run(...args);
  expect(r.status, `${args.join(' ')} => ${r.stderr}`).toBe(0);
  return r.stdout;
};
const store = () => new Store(openDatabase(path.join(home, 'agent.db')));

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'elevariq-cli-'));
  env = {
    ...process.env,
    AGENT_HOME: home,
    AGENT_ENV_FILE: path.join(home, 'none.env'),
    LOG_TO_CONSOLE: 'false',
    EXECUTION_PROVIDER: 'mock',
    NODE_NO_WARNINGS: '1',
  };
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('CLI commands', () => {
  let taskId = '';
  it('help, doctor, integrations', () => {
    expect(ok('--help')).toContain('task:add');
    const doctor = ok('doctor');
    expect(doctor).toMatch(/node\s+OK/);
    expect(doctor).toMatch(/database\s+OK/);
    expect(doctor).toMatch(/provider auth\s+OK/);
    const integ = ok('integrations');
    expect(integ).toMatch(/erp\s+ok\s+mock/);
    expect(integ).toMatch(/crm\s+ok\s+mock/);
  });
  it('project:add, projects, workspaces, workspace:approve', () => {
    expect(ok('project:add', '--name', 'CLI Demo', '--priority', '2')).toContain('cli-demo');
    expect(ok('projects')).toMatch(/cli-demo\s+CLI Demo\s+ACTIVE\s+2/);
    const extra = path.join(home, 'extra');
    mkdirSync(extra);
    expect(ok('workspace:approve', extra)).toContain('approved workspace');
    expect(ok('workspaces')).toContain('extra');
  });
  it('task:add (flags, .json file, .md file) and duplicate protection', () => {
    const out = ok(
      'task:add',
      '--project',
      'cli-demo',
      '--title',
      'First',
      '--instructions',
      'do it',
      '--criteria',
      'works',
      '--priority',
      '3',
    );
    taskId = out.match(/tsk_[a-z0-9]+/)![0];
    expect(ok('task:add', '--project', 'cli-demo', '--title', 'First', '--instructions', 'do it')).toContain(
      'duplicate ignored',
    );
    expect(ok('task:add', '--project', 'cli-demo', '--file', 'examples/task-example.json')).toContain(
      'queued task',
    );
    expect(ok('task:add', '--project', 'cli-demo', '--file', 'examples/task-example.md')).toContain(
      'Add attendance tracking',
    );
    expect(ok('tasks', '--project', 'cli-demo')).toMatch(/First\s+QUEUED\s+3/);
    expect(ok('tasks', '--status', 'queued')).toContain('First');
    expect(run('tasks', '--status', 'nonsense').status).toBe(1);
  });
  it('task:pause / resume / cancel / show', () => {
    expect(ok('task:pause', taskId)).toContain('PAUSED');
    expect(ok('task:resume', taskId)).toContain('READY');
    const shown = ok('task:show', taskId);
    expect(shown).toMatch(/Transitions:[\s\S]*PAUSED[\s\S]*READY/);
    expect(JSON.parse(ok('task:show', taskId, '--json')).task.id).toBe(taskId);
    expect(ok('task:cancel', taskId)).toContain('CANCELLED');
    const bad = run('task:resume', taskId); // illegal from terminal state
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/Invalid task transition/);
    expect(bad.stderr).not.toMatch(/at async/); // friendly one-line error, no stack
  });
  it('task:retry / task:unblock operate on FAILED / BLOCKED tasks', () => {
    const s = store();
    const p = s.getProject('cli-demo')!;
    const failed = s.enqueueTask({
      projectId: p.id,
      title: 'will fail',
      instructions: 'x',
      maxRetries: 1,
    }).task;
    s.transition(failed.id, 'READY', { reason: 'x' });
    s.transition(failed.id, 'BLOCKED', { reason: 'test' });
    expect(ok('task:unblock', failed.id)).toContain('READY');
    s.transition(failed.id, 'BLOCKED', { reason: 'again' });
    s.transition(failed.id, 'QUEUED', { reason: 'x' });
    s.db.prepare("UPDATE tasks SET status='FAILED', attempt_count=4 WHERE id=?").run(failed.id);
    expect(ok('task:retry', failed.id)).toContain('QUEUED');
    expect(s.getTask(failed.id)!.attemptCount).toBe(0);
  });
  it('approvals / approve / deny move the task accordingly', () => {
    const s = store();
    const p = s.getProject('cli-demo')!;
    const t1 = s.enqueueTask({
      projectId: p.id,
      title: 'needs approval',
      instructions: 'x',
      maxRetries: 1,
    }).task;
    s.transition(t1.id, 'ANALYZING', { reason: 'x' });
    s.transition(t1.id, 'WAITING_FOR_APPROVAL', { reason: 'x' });
    const a1 = s.createApproval({
      projectId: p.id,
      taskId: t1.id,
      actionType: 'publish_release',
      description: 'npm publish',
    });
    expect(ok('approvals')).toMatch(/publish_release\s+PENDING/);
    expect(ok('approve', a1.id, '--by', 'owner')).toContain('APPROVED');
    expect(s.getTask(t1.id)!.status).toBe('READY');
    const t2 = s.enqueueTask({ projectId: p.id, title: 'denied', instructions: 'x', maxRetries: 1 }).task;
    s.transition(t2.id, 'ANALYZING', { reason: 'x' });
    s.transition(t2.id, 'WAITING_FOR_APPROVAL', { reason: 'x' });
    const a2 = s.createApproval({
      projectId: p.id,
      taskId: t2.id,
      actionType: 'production_deploy',
      description: 'deploy',
    });
    expect(ok('deny', a2.id)).toContain('DENIED');
    expect(s.getTask(t2.id)!.status).toBe('BLOCKED');
    expect(run('approve', 'apr_missing').status).toBe(1);
  });
  it('memory:set / memory:get, logs, status, health, recovery', () => {
    expect(ok('memory:set', 'cli-demo', 'roadmap', 'ship', 'phase', 'one')).toContain('saved roadmap');
    expect(ok('memory:get', 'cli-demo', 'roadmap')).toContain('ship phase one');
    expect(run('memory:set', 'cli-demo', 'bogus', 'x').status).toBe(1);
    expect(ok('logs', '--task', taskId)).toMatch(/task\.transition/);
    expect(ok('logs', '--project', 'cli-demo', '--limit', '3')).toContain('task.');
    expect(ok('logs', '--app', '--limit', '2')).toBeTypeOf('string');
    expect(ok('status')).toMatch(/Supervisor\s+: NEVER_STARTED/);
    expect(JSON.parse(ok('status', '--json')).authentication.ready).toBe(true);
    expect(run('health').status).toBe(1); // no live supervisor
    expect(ok('recovery')).toMatch(/Provider state: OK/);
  });
  it('recovery --run reconciles an orphaned task when no supervisor is alive', () => {
    const s = store();
    const p = s.getProject('cli-demo')!;
    const t = s.enqueueTask({
      projectId: p.id,
      title: 'orphan',
      instructions: 'x',
      maxRetries: 1,
      priority: 99,
    }).task;
    s.claimNext({
      workerId: 'dead',
      leaseTtlMs: 60_000,
      maxConcurrent: 1,
      provider: 'mock',
      pid: 2_000_000_000,
    });
    expect(s.getTask(t.id)!.status).toBe('RUNNING');
    expect(ok('recovery', '--run')).toMatch(/requeued_interrupted/);
    expect(s.getTask(t.id)!.status).toBe('READY');
    expect(hostname()).toBeTruthy();
  });
  it('unknown command and bad config fail with clear exit codes', () => {
    expect(run('bogus').status).toBe(1);
    const bad = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'status'], {
      cwd: ROOT,
      env: { ...env, MAX_CONCURRENT_WORKERS: '0' },
      encoding: 'utf8',
    });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/MAX_CONCURRENT_WORKERS/);
  });
});
