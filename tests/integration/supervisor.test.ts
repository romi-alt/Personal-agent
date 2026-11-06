import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { reconcileOrphans } from '../../src/recovery/reconcile.js';
import { TaskRunner } from '../../src/workers/runner.js';
import { drain, makeEnv, statuses, waitFor, type TestEnv } from '../helpers/env.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';

let env: TestEnv;
afterEach(() => env?.cleanup());
const add = (title: string, extra: Record<string, unknown> = {}) =>
  env.store.enqueueTask({
    projectId: env.project.id,
    title,
    instructions: `do ${title}`,
    maxRetries: 2,
    ...extra,
  }).task;

describe('mock execution through the supervisor', () => {
  it('claims, executes and completes a task with full state history, events, session and checkpoint', async () => {
    env = await makeEnv();
    const t = add('hello');
    await drain(env);
    const done = env.store.getTask(t.id)!;
    expect(done.status).toBe('COMPLETED');
    expect(statuses(env, t.id)).toEqual(['QUEUED', 'RUNNING', 'CHECKPOINTING', 'COMPLETED']);
    expect(done.completionEvidence).toMatch(/mock success/);
    // session id persistence
    expect(done.sessionId).toBe(`mock-session-${t.id}`);
    expect(env.store.latestExecution(t.id)).toMatchObject({
      outcome: 'completed',
      providerSessionId: `mock-session-${t.id}`,
    });
    // checkpoint persistence (git ref paired with session ref)
    const cp = env.store.latestCheckpoint(t.id)!;
    expect(cp.sessionRef).toBe(done.sessionId);
    expect(cp.repoRef).toMatch(/^agent\/test-project@[0-9a-f]{40}$/);
    expect(done.lastCheckpointId).toBe(cp.id);
    // artifacts exist in the isolated workspace
    expect(existsSync(path.join(env.project.repoPath, `${t.id}.done`))).toBe(true);
    // events captured
    const types = env.store.listEvents({ taskId: t.id }).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['task.enqueued', 'worker.launched', 'checkpoint.created', 'worker.terminated']),
    );
    // execution transcript separate from app logs
    expect(readFileSync(env.store.latestExecution(t.id)!.logRef!, 'utf8')).toContain('"kind":"result"');
  });

  it('runs tasks in priority order, sequentially with one worker', async () => {
    env = await makeEnv();
    const a = add('a');
    const b = add('b', { priority: 9 });
    await drain(env);
    const started = [a, b].map((t) => ({ id: t.id, at: env.store.latestExecution(t.id)!.startedAt }));
    expect(env.store.listExecutions(b.id)[0]!.id < env.store.listExecutions(a.id)[0]!.id).toBe(true);
    expect(started).toHaveLength(2);
  });

  it('failed execution: retries with backoff, then FAILS when retries are exhausted (no infinite loop)', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { bad: ['fatal'] } } } });
    const t = add('bad');
    await drain(env);
    let task = env.store.getTask(t.id)!;
    expect(task).toMatchObject({
      status: 'RETRY_SCHEDULED',
      attemptCount: 1,
      lastErrorClass: 'TASK_FAILURE',
    });
    expect(task.nextEligibleAt).toBe(env.clock.now() + 1000); // backoff base, jitter 0
    await drain(env); // not yet eligible
    expect(env.store.listExecutions(t.id)).toHaveLength(1);
    env.clock.advance(1001);
    await drain(env);
    env.clock.advance(60_000);
    await drain(env);
    task = env.store.getTask(t.id)!;
    expect(task.status).toBe('FAILED');
    expect(env.store.listExecutions(t.id)).toHaveLength(3); // initial + 2 retries
    expect(task.attemptCount).toBe(3);
  });

  it('process crash (thrown error) is classified as PROCESS_CRASH and retried', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { c: ['crash', 'success'] } } } });
    const t = add('c');
    await drain(env);
    expect(env.store.getTask(t.id)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      lastErrorClass: 'PROCESS_CRASH',
    });
    env.clock.advance(5000);
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
  });

  it('partial completion continues from checkpoint with the same session, then completes', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { p: ['partial', 'partial', 'success'] } } } });
    const t = add('p');
    await drain(env);
    const task = env.store.getTask(t.id)!;
    expect(task.status).toBe('COMPLETED');
    expect(task.continuationCount).toBe(2);
    expect(env.mock!.runs.map((r) => r.resumed)).toEqual([
      undefined,
      `mock-session-${t.id}`,
      `mock-session-${t.id}`,
    ]);
    expect(env.store.listCheckpoints(t.id)).toHaveLength(3);
  });
});

describe('capacity exhaustion and waiting', () => {
  it('rate limit: honours retry-after, blocks the whole provider, then resumes the same session', async () => {
    env = await makeEnv({
      mock: {
        scenario: {
          tasks: { r: [{ type: 'rate_limit', retryAfterMs: 30_000 }, 'success'], other: ['success'] },
        },
      },
    });
    const r = add('r');
    const other = add('other');
    await drain(env);
    expect(env.store.getTask(r.id)).toMatchObject({
      status: 'WAITING_FOR_CAPACITY',
      lastErrorClass: 'RATE_LIMIT',
      nextEligibleAt: env.clock.now() + 30_000,
    });
    // provider-wide block => the second task is NOT attempted while capacity is unavailable
    expect(env.store.getTask(other.id)!.status).toBe('QUEUED');
    expect(env.store.getProviderState('mock')).toMatchObject({
      status: 'RATE_LIMITED',
      blockedUntil: env.clock.now() + 30_000,
    });
    const callsBefore = env.mock!.runs.length;
    env.clock.advance(29_000);
    await drain(env);
    expect(env.mock!.runs.length).toBe(callsBefore); // idle: no provider calls while waiting
    env.clock.advance(1_500);
    await drain(env);
    expect(env.store.getTask(r.id)!.status).toBe('COMPLETED');
    expect(env.store.getTask(other.id)!.status).toBe('COMPLETED');
    expect(env.mock!.runs.find((x) => x.taskTitle === 'r' && x.attemptIndex === 2)!.resumed).toBe(
      `mock-session-${r.id}`,
    );
    expect(env.store.getProviderState('mock').status).toBe('OK');
  });

  it('quota exhaustion uses the provider-reported reset time and never polls before it', async () => {
    env = await makeEnv({
      mock: { scenario: { tasks: { q: [{ type: 'quota', resetsInMs: 3_600_000 }, 'success'] } } },
    });
    const t = add('q');
    await drain(env);
    const task = env.store.getTask(t.id)!;
    expect(task.status).toBe('WAITING_FOR_CAPACITY');
    const wait = task.nextEligibleAt! - env.clock.now();
    expect(wait).toBeGreaterThan(3_590_000); // ~reset (+margin); computed from Date.now() inside the mock
    expect(wait).toBeLessThan(3_620_000);
    expect(statuses(env, t.id)).toEqual(['QUEUED', 'RUNNING', 'CHECKPOINTING', 'WAITING_FOR_CAPACITY']);
    env.clock.advance(60_000);
    await drain(env);
    expect(env.mock!.runs).toHaveLength(1);
  });

  it('quota exhaustion without a reset time waits conservatively (no invented timestamp)', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { q: ['quota', 'success'] } } } });
    const t = add('q');
    await drain(env);
    const task = env.store.getTask(t.id)!;
    expect(task.nextEligibleAt! - env.clock.now()).toBe(env.config.backoff.quotaMinWaitMs);
  });

  it('consecutive rate limits back off exponentially', async () => {
    env = await makeEnv({
      mock: { scenario: { tasks: { r: ['rate_limit', 'rate_limit', 'rate_limit', 'success'] } } },
    });
    const t = add('r');
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await drain(env);
      waits.push(env.store.getTask(t.id)!.nextEligibleAt! - env.clock.now());
      env.clock.advance(waits[i]! + 1);
    }
    expect(waits).toEqual([1000, 2000, 4000]);
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
  });
});

describe('authentication, permissions and budget', () => {
  it('missing authentication parks tasks in WAITING_FOR_AUTHENTICATION without calling the provider, then proceeds when fixed', async () => {
    let ready = false;
    env = await makeEnv({
      mock: { authReady: () => ready, fingerprint: () => (ready ? 'fp-good' : 'fp-none') },
    });
    const t = add('needs-auth');
    const gate = (await env.supervisor.tick()).gate;
    expect(gate.open).toBe(false);
    expect(env.store.getTask(t.id)!.status).toBe('WAITING_FOR_AUTHENTICATION');
    expect(env.mock!.runs).toHaveLength(0);
    ready = true;
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
    expect(statuses(env, t.id)).toContain('WAITING_FOR_AUTHENTICATION');
  });

  it('runtime auth rejection waits for a CHANGED credential; it does not hammer with the same bad key', async () => {
    let fp = 'key-v1';
    env = await makeEnv({ mock: { scenario: { tasks: { a: ['auth', 'success'] } }, fingerprint: () => fp } });
    const t = add('a');
    await drain(env);
    expect(env.store.getTask(t.id)).toMatchObject({
      status: 'WAITING_FOR_AUTHENTICATION',
      lastErrorClass: 'AUTHENTICATION',
    });
    expect(env.store.getProviderState('mock').status).toBe('AUTH_REQUIRED');
    env.clock.advance(3_600_000);
    await drain(env);
    expect(env.mock!.runs).toHaveLength(1); // same credential => no retry
    fp = 'key-v2';
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
  });

  it('permission denial creates an approval request and waits; approval lets the task proceed with that action allowed', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { d: ['permission_denied', 'success'] } } } });
    const t = add('d');
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('WAITING_FOR_APPROVAL');
    const [apr] = env.store.listApprovals('PENDING');
    expect(apr).toMatchObject({ actionType: 'publish_release', taskId: t.id });
    await drain(env);
    expect(env.mock!.runs).toHaveLength(1); // not retried without approval
    env.store.decideApproval(apr!.id, 'APPROVED', 'owner');
    env.store.transition(t.id, 'READY', { reason: 'owner approved' });
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
  });

  it('budget exhaustion BLOCKS the task for owner decision (not retried, not failed)', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { b: ['budget'] } } } });
    const t = add('b');
    await drain(env);
    expect(env.store.getTask(t.id)).toMatchObject({ status: 'BLOCKED', lastErrorClass: 'BUDGET_EXHAUSTED' });
    env.clock.advance(1e7);
    await drain(env);
    expect(env.mock!.runs).toHaveLength(1);
  });

  it('daily budget gate stops new work once estimated spend reaches the limit', async () => {
    env = await makeEnv({
      env: { DAILY_BUDGET_USD: '1' },
      mock: { scenario: { tasks: { x: ['success'] } } },
    });
    const t = add('x');
    env.store.db
      .prepare(
        "INSERT INTO tasks(id,project_id,title,instructions,status,max_retries,dedupe_key,created_at,updated_at) VALUES ('old',?,'old','x','COMPLETED',1,'old',0,0)",
      )
      .run(env.project.id);
    env.store.db
      .prepare(
        "INSERT INTO executions(id,task_id,provider,started_at,heartbeat_at,cost_usd_estimate) VALUES ('e1','old','mock',?,?,1.5)",
      )
      .run(env.clock.now(), env.clock.now());
    const { gate } = await env.supervisor.tick();
    expect(gate.open).toBe(false);
    expect(gate.reason).toMatch(/daily budget/);
    expect(env.store.getTask(t.id)!.status).toBe('QUEUED');
  });

  it('invalid stored session: records the reason and continues in a NEW session built from persisted context', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { s: ['partial', 'invalid_session', 'success'] } } } });
    const t = add('s');
    await drain(env);
    const task = env.store.getTask(t.id)!;
    expect(task.status).toBe('COMPLETED');
    const events = env.store
      .listTransitions(t.id)
      .map((x) => x.reason)
      .join('|');
    expect(events).toMatch(/stored session could not be restored/);
    const runs = env.mock!.runs.filter((r) => r.taskTitle === 's');
    expect(runs[2]!.resumed).toBeUndefined(); // third run began a new session
  });
});

describe('cancel, pause and shutdown', () => {
  it('cancelling a running task interrupts the worker and keeps the CANCELLED state', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { h: ['hang'] } } } });
    const t = add('h');
    await env.supervisor.tick();
    await waitFor(() => env.store.getTask(t.id)!.status === 'RUNNING' && env.mock!.runs.length === 1);
    env.store.transition(t.id, 'CANCELLED', { reason: 'owner cancelled' });
    await waitFor(() => env.supervisor.activeWorkers === 0);
    expect(env.store.getTask(t.id)!.status).toBe('CANCELLED');
  });

  it('graceful shutdown aborts the running execution, checkpoints, releases the lease and the singleton lock', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { h: ['hang', 'success'] } } } });
    const t = add('h');
    const run = env.supervisor.start();
    await waitFor(() => env.mock!.runs.length === 1 && env.store.getTask(t.id)!.status === 'RUNNING');
    env.supervisor.requestStop('test');
    await run;
    const task = env.store.getTask(t.id)!;
    expect(task.status).toBe('READY'); // interrupted, will resume
    expect(task.assignedWorker).toBeNull();
    expect(task.leaseExpiresAt).toBeNull();
    expect(task.attemptCount).toBe(0); // shutdown does not burn a retry
    expect(env.store.latestCheckpoint(t.id)).not.toBeNull();
    expect(env.store.getSupervisorState()!.status).toBe('STOPPED');
    expect(statuses(env, t.id)).toEqual(['QUEUED', 'RUNNING', 'CHECKPOINTING', 'READY']);
  });

  it('stop requested through the database (CLI path) stops the loop', async () => {
    env = await makeEnv();
    const run = env.supervisor.start();
    await waitFor(() => env.store.getSupervisorState()?.status === 'IDLE');
    env.store.requestStop();
    await run;
    expect(env.store.getSupervisorState()!.status).toBe('STOPPED');
  });

  it('a second supervisor cannot start while one is live', async () => {
    env = await makeEnv();
    const run = env.supervisor.start();
    await waitFor(() => env.store.getSupervisorState()?.status === 'IDLE');
    const second = new Supervisor({
      config: env.config,
      store: env.store,
      provider: env.provider,
      registry: env.registry,
      log: env.log,
    });
    await expect(second.start()).rejects.toThrow(/Another supervisor/);
    env.supervisor.requestStop();
    await run;
  });
});

describe('restart recovery', () => {
  /** Simulates a hard crash: the task is left RUNNING with a lease, the supervisor row names a dead pid. */
  async function crashMidRun(title: string, withSession: boolean) {
    const t = add(title);
    const claimed = env.store.claimNext({
      workerId: 'dead-supervisor',
      leaseTtlMs: 60_000,
      maxConcurrent: 1,
      provider: 'mock',
      pid: 2_000_000_000,
    })!;
    if (withSession) env.store.recordSession(claimed.execution.id, t.id, `mock-session-${t.id}`);
    env.store.db
      .prepare(
        "INSERT INTO supervisor_state(id,instance_id,pid,host,started_at,heartbeat_at,status) VALUES (1,'dead',2000000000,?, ?, ?, 'RUNNING')",
      )
      .run(hostname(), env.clock.now(), env.clock.now());
    return { t, claimed };
  }

  it('interrupted task is reconciled on startup, resumed with its session, and not executed twice', async () => {
    env = await makeEnv();
    const { t } = await crashMidRun('interrupted', true);
    expect(env.store.getTask(t.id)!.status).toBe('RUNNING');
    const run = env.supervisor.start(); // dead pid => lock acquired; startup reconcile
    await waitFor(() => env.store.getTask(t.id)!.status === 'COMPLETED');
    env.supervisor.requestStop();
    await run;
    expect(statuses(env, t.id)).toEqual([
      'QUEUED',
      'RUNNING',
      'READY',
      'RUNNING',
      'CHECKPOINTING',
      'COMPLETED',
    ]);
    const execs = env.store.listExecutions(t.id);
    expect(execs.map((e) => e.outcome)).toEqual(['interrupted', 'completed']);
    expect(execs[1]!.resumedFromSessionId).toBe(`mock-session-${t.id}`);
    expect(env.store.listEvents({ type: 'recovery.task_reconciled' })).toHaveLength(1);
    expect(env.store.listCheckpoints(t.id).length).toBeGreaterThanOrEqual(2); // recovery checkpoint + completion
    expect(env.store.getTask(t.id)!.attemptCount).toBe(0);
  });

  it('a task that completed (success recorded in transcript) before the crash is NOT re-run', async () => {
    env = await makeEnv();
    const { t, claimed } = await crashMidRun('already-done', true);
    const { ExecutionLog } = await import('../../src/logging/logger.js');
    new ExecutionLog(env.config.logDir, claimed.execution.id, 1e6).append({
      kind: 'result',
      outcome: 'completed',
      summary: 'finished before crash',
    });
    env.store.db
      .prepare('UPDATE executions SET log_ref = ? WHERE id = ?')
      .run(path.join(env.config.logDir, 'executions', `${claimed.execution.id}.jsonl`), claimed.execution.id);
    const runner = new TaskRunner({
      config: env.config,
      store: env.store,
      provider: env.provider,
      registry: env.registry,
      log: env.log,
      workerId: 'x',
    });
    const acts = await reconcileOrphans({
      mode: 'startup',
      store: env.store,
      config: env.config,
      log: env.log,
      runner,
      registry: env.registry,
      providerName: 'mock',
    });
    expect(acts[0]!.action).toBe('completed_from_evidence');
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
    expect(env.store.getTask(t.id)!.completionEvidence).toMatch(/finished before crash/);
    await drain(env);
    expect(env.mock!.runs).toHaveLength(0);
  });

  it('crash between the two durable steps (CHECKPOINTING with recorded outcome) re-applies the outcome', async () => {
    env = await makeEnv();
    const { t, claimed } = await crashMidRun('half', true);
    env.store.endExecution(claimed.execution.id, { outcome: 'completed', summary: 'done' });
    env.store.transition(t.id, 'CHECKPOINTING', { reason: 'x', executionId: claimed.execution.id });
    const runner = new TaskRunner({
      config: env.config,
      store: env.store,
      provider: env.provider,
      registry: env.registry,
      log: env.log,
      workerId: 'x',
    });
    const acts = await reconcileOrphans({
      mode: 'startup',
      store: env.store,
      config: env.config,
      log: env.log,
      runner,
      registry: env.registry,
      providerName: 'mock',
    });
    expect(acts[0]!.action).toBe('reapplied_outcome');
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
  });

  it('sweep mode leaves tasks whose lease is still valid alone', async () => {
    env = await makeEnv();
    const t = add('live');
    env.store.claimNext({
      workerId: 'other',
      leaseTtlMs: 60_000,
      maxConcurrent: 1,
      provider: 'mock',
      pid: process.pid,
    });
    const runner = new TaskRunner({
      config: env.config,
      store: env.store,
      provider: env.provider,
      registry: env.registry,
      log: env.log,
      workerId: 'x',
    });
    const acts = await reconcileOrphans({
      mode: 'sweep',
      store: env.store,
      config: env.config,
      log: env.log,
      runner,
      registry: env.registry,
      providerName: 'mock',
    });
    expect(acts).toHaveLength(0);
    expect(env.store.getTask(t.id)!.status).toBe('RUNNING');
    env.clock.advance(61_000);
    expect(
      (
        await reconcileOrphans({
          mode: 'sweep',
          store: env.store,
          config: env.config,
          log: env.log,
          runner,
          registry: env.registry,
          providerName: 'mock',
        })
      ).length,
    ).toBe(1);
  });

  it('missing project directory after interruption BLOCKS the task instead of fabricating a workspace', async () => {
    env = await makeEnv();
    const { t } = await crashMidRun('lost-dir', false);
    const { rmSync } = await import('node:fs');
    rmSync(env.project.repoPath, { recursive: true, force: true });
    const runner = new TaskRunner({
      config: env.config,
      store: env.store,
      provider: env.provider,
      registry: env.registry,
      log: env.log,
      workerId: 'x',
    });
    const acts = await reconcileOrphans({
      mode: 'startup',
      store: env.store,
      config: env.config,
      log: env.log,
      runner,
      registry: env.registry,
      providerName: 'mock',
    });
    expect(acts[0]!.action).toBe('blocked_workspace_missing');
    expect(env.store.getTask(t.id)!.status).toBe('BLOCKED');
  });

  it('waiting state survives a supervisor restart (new Store/Supervisor on the same database)', async () => {
    env = await makeEnv({
      mock: { scenario: { tasks: { w: [{ type: 'rate_limit', retryAfterMs: 10_000 }, 'success'] } } },
    });
    const t = add('w');
    await drain(env);
    const { Store } = await import('../../src/queue/store.js');
    const fresh = new Store(env.store.db, env.clock);
    expect(fresh.getTask(t.id)).toMatchObject({ status: 'WAITING_FOR_CAPACITY' });
    expect(fresh.getProviderState('mock').blockedUntil).toBe(env.clock.now() + 10_000);
    env.clock.advance(10_500);
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
  });
});
