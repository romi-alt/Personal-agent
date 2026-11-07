import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/database/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { reconcileOrphans } from '../../src/recovery/reconcile.js';
import { StaleLeaseError, Store } from '../../src/queue/store.js';
import { TaskRunner } from '../../src/workers/runner.js';
import { decide } from '../../src/recovery/decide.js';
import { drain, makeEnv, statuses, waitFor, type TestEnv } from '../helpers/env.js';

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
const runner = () =>
  new TaskRunner({
    config: env.config,
    store: env.store,
    provider: env.provider,
    registry: env.registry,
    log: env.log,
    workerId: 'test-runner',
  });
const reconcile = (mode: 'startup' | 'sweep', isLocallyActive?: (id: string) => boolean) =>
  reconcileOrphans({
    mode,
    store: env.store,
    config: env.config,
    log: env.log,
    runner: runner(),
    registry: env.registry,
    providerName: env.provider.name,
    isLocallyActive,
  });
const orphan = (title: string, session = true) => {
  const t = add(title);
  const claimed = env.store.claimNext({
    workerId: 'dead',
    leaseTtlMs: 60_000,
    maxConcurrent: 1,
    provider: 'mock',
    pid: 2_000_000_000,
  })!;
  if (session) env.store.recordSession(claimed.execution.id, t.id, `mock-session-${t.id}`);
  return { t, claimed };
};

describe('execution fencing (stale workers cannot corrupt newer state)', () => {
  it('a worker whose lease was reclaimed cannot heartbeat, transition or apply a decision', async () => {
    env = await makeEnv();
    const { t, claimed: a } = orphan('fenced');
    env.clock.advance(61_000);
    expect((await reconcile('sweep')).map((x) => x.action)).toEqual(['requeued_interrupted']);
    const b = env.store.claimNext({
      workerId: 'new',
      leaseTtlMs: 60_000,
      maxConcurrent: 1,
      provider: 'mock',
      pid: process.pid,
    })!;
    expect(b.execution.id).not.toBe(a.execution.id);

    expect(env.store.heartbeat(a.execution.id, t.id, 'dead', 60_000)).toBe(false);
    expect(() =>
      env.store.transition(t.id, 'CHECKPOINTING', { reason: 'late', fenceExecutionId: a.execution.id }),
    ).toThrow(StaleLeaseError);
    expect(env.store.getTask(t.id)).toMatchObject({ status: 'RUNNING', leaseExecutionId: b.execution.id });

    // a late "completion" from the old execution is ignored and recorded
    const dec = decide({
      task: env.store.getTask(t.id)!,
      kind: 'completed',
      resumed: false,
      providerState: env.store.getProviderState('mock'),
      now: env.clock.now(),
      config: env.config,
    });
    expect(
      runner().applyDecision(
        t.id,
        env.project.id,
        a.execution.id,
        'mock',
        { kind: 'completed', summary: 'late' },
        dec,
        'late',
      ),
    ).toBe(false);
    expect(env.store.getTask(t.id)!.status).toBe('RUNNING');
    expect(env.store.listEvents({ type: 'worker.duplicate_completion_ignored' })).toHaveLength(1);
  });

  it('a duplicated completion event for an already-completed task is a no-op', async () => {
    env = await makeEnv();
    const t = add('dup');
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
    const before = env.store.listTransitions(t.id).length;
    const exec = env.store.latestExecution(t.id)!;
    const dec = decide({
      task: env.store.getTask(t.id)!,
      kind: 'completed',
      resumed: false,
      providerState: env.store.getProviderState('mock'),
      now: env.clock.now(),
      config: env.config,
    });
    expect(
      runner().applyDecision(
        t.id,
        env.project.id,
        exec.id,
        'mock',
        { kind: 'completed', summary: 'again' },
        dec,
        'again',
      ),
    ).toBe(false);
    expect(env.store.listTransitions(t.id)).toHaveLength(before);
    expect(env.store.getTask(t.id)!.completionEvidence).not.toContain('again');
  });

  it('the supervisor sweep never reclaims a task whose worker is alive in this process', async () => {
    env = await makeEnv();
    const { t } = orphan('alive');
    env.clock.advance(61_000); // lease expired (e.g. event-loop stall) ...
    const execId = env.store.latestExecution(t.id)!.id;
    expect(await reconcile('sweep', (id) => id === execId)).toHaveLength(0); // ... but the worker is local and alive
    expect(env.store.getTask(t.id)!.status).toBe('RUNNING');
  });
});

describe('escalation instead of infinite retry loops', () => {
  it('a task that keeps killing its worker is BLOCKED after MAX_INTERRUPTIONS', async () => {
    env = await makeEnv({ env: { MAX_INTERRUPTIONS: '2' } });
    const t = add('poison');
    const crashOnce = async () => {
      env.store.claimNext({
        workerId: 'dead',
        leaseTtlMs: 60_000,
        maxConcurrent: 1,
        provider: 'mock',
        pid: 2_000_000_000,
      });
      return reconcile('startup');
    };
    expect((await crashOnce())[0]!.action).toBe('requeued_interrupted'); // 1
    expect((await crashOnce())[0]!.action).toBe('requeued_interrupted'); // 2
    expect((await crashOnce())[0]!.action).toBe('escalated_repeated_interruption'); // 3 > limit
    expect(env.store.getTask(t.id)).toMatchObject({ status: 'BLOCKED', lastErrorClass: 'INTERRUPTED' });
    expect(env.store.listEvents({ type: 'task.escalated' })).toHaveLength(1);
    await drain(env);
    expect(env.store.listExecutions(t.id)).toHaveLength(3); // no further attempts
  });

  it('repeated network failures escalate after MAX_PROVIDER_FAILURE_STREAK; success resets the streak', async () => {
    env = await makeEnv({
      env: { MAX_PROVIDER_FAILURE_STREAK: '2' },
      mock: { scenario: { tasks: { n: ['network', 'network', 'network', 'success'] } } },
    });
    const t = add('n');
    for (let i = 0; i < 3; i++) {
      await drain(env);
      env.clock.advance(3_600_000);
    }
    const task = env.store.getTask(t.id)!;
    expect(task).toMatchObject({ status: 'BLOCKED', providerFailureStreak: 3 });
    expect(env.store.listEvents({ type: 'task.escalated' })).toHaveLength(1);
    env.store.transition(t.id, 'READY', {
      reason: 'owner unblock',
      patch: { providerFailureStreak: 0, resetInterruptions: true },
    });
    await drain(env);
    expect(env.store.getTask(t.id)).toMatchObject({ status: 'COMPLETED', providerFailureStreak: 0 });
  });
});

describe('checkpoint integrity', () => {
  it('detects a tampered checkpoint, skips it, and falls back to the previous valid one', async () => {
    env = await makeEnv();
    const t = add('cp');
    const base = {
      projectId: env.project.id,
      taskId: t.id,
      executionId: null,
      sessionRef: 's',
      repoRef: null,
      gitDirty: false,
      testResults: null,
      outstandingSummary: 'o',
      nextAction: 'n',
    };
    const good = env.store.addCheckpoint({ ...base, completedSummary: 'good' });
    env.clock.advance(10);
    const bad = env.store.addCheckpoint({ ...base, completedSummary: 'newer' });
    env.store.db.prepare('UPDATE checkpoints SET completed_summary = ? WHERE id = ?').run('TAMPERED', bad.id);
    const r = env.store.latestValidCheckpoint(t.id);
    expect(r.checkpoint!.id).toBe(good.id);
    expect(r.skippedCorrupt).toEqual([bad.id]);
    expect(env.store.listEvents({ type: 'checkpoint.corrupt' })).toHaveLength(1);
  });

  it('with every checkpoint corrupt the worker still runs, rebuilding context from the working tree, and says so in the prompt', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { c: ['partial', 'success'] } } } });
    const t = add('c');
    await env.supervisor.tick(); // attempt 1 only (partial)
    await waitFor(() => env.supervisor.activeWorkers === 0);
    // corrupt the first checkpoint before the continuation runs
    env.store.db.prepare("UPDATE checkpoints SET next_action = 'garbage' WHERE task_id = ?").run(t.id);
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
    const second = env.mock!.runs.find((r) => r.attemptIndex === 2)!;
    expect(second.prompt).toMatch(/corrupted checkpoint/);
  });

  it('a checkpoint that references a commit that no longer exists is flagged, not trusted', async () => {
    env = await makeEnv();
    const t = add('dangling');
    env.store.addCheckpoint({
      projectId: env.project.id,
      taskId: t.id,
      executionId: null,
      sessionRef: null,
      repoRef: 'agent/test-project@' + 'deadbeef'.repeat(5),
      gitDirty: false,
      completedSummary: 'x',
      outstandingSummary: 'y',
      testResults: null,
      nextAction: 'z',
    });
    await drain(env);
    expect(env.store.listEvents({ type: 'checkpoint.repo_ref_missing' })).toHaveLength(1);
    expect(env.mock!.runs[0]!.prompt).toMatch(/no longer exists in the repository/);
  });
});

describe('incomplete tool execution', () => {
  it('a crash after a partial file write leaves a dirty-tree checkpoint, and the retry prompt warns about partial files', async () => {
    env = await makeEnv({
      mock: {
        scenario: {
          tasks: {
            w: [{ type: 'crash', writes: [{ file: 'half-written.txt', content: 'incompl' }] }, 'success'],
          },
        },
      },
    });
    const t = add('w');
    await drain(env);
    const cp = env.store.latestCheckpoint(t.id)!;
    expect(cp.gitDirty).toBe(true);
    expect(cp.outstandingSummary).toMatch(/Uncommitted changes/);
    expect(existsSync(path.join(env.project.repoPath, 'half-written.txt'))).toBe(true);
    env.clock.advance(5000);
    await drain(env);
    const retry = env.mock!.runs.find((r) => r.attemptIndex === 2)!;
    expect(retry.prompt).toMatch(/half-written\.txt/); // the changed file is listed in the working-tree state
    expect(retry.prompt).toMatch(/partially written/);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
  });

  it('a hard crash mid-execution yields a recovery checkpoint from the CURRENT working tree', async () => {
    env = await makeEnv();
    const { t } = orphan('mid-tool');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(env.project.repoPath, 'partial-edit.ts'), 'export const x = ');
    const [act] = await reconcile('startup');
    expect(act!.action).toBe('requeued_interrupted');
    const cp = env.store.latestCheckpoint(t.id)!;
    expect(cp.gitDirty).toBe(true);
    expect(cp.outstandingSummary).toContain('partial-edit.ts');
  });
});

describe('verification gating (a claim is not proof)', () => {
  it('a task required to change files FAILS when the provider claims success but nothing changed', async () => {
    env = await makeEnv({
      mock: { scenario: { tasks: { v: [{ type: 'success', noArtifact: true }, 'success'] } } },
    });
    const t = add('v', { verificationRequired: ['CHANGES_EXIST'] });
    await drain(env);
    expect(env.store.getTask(t.id)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      lastErrorClass: 'TASK_FAILURE',
      attemptCount: 1,
    });
    expect(env.store.getTask(t.id)!.lastErrorMessage).toMatch(
      /verification failed after the provider reported success.*CHANGES_EXIST/,
    );
    const levels = env.store.listEvidence({ taskId: t.id }).map((e) => `${e.level}:${e.status}`);
    expect(levels).toEqual(['CLAIMED_COMPLETE:PASSED', 'CHANGES_EXIST:FAILED']);
    env.clock.advance(5000);
    await drain(env); // second attempt writes an artifact
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
    expect(env.store.listEvidence({ taskId: t.id }).at(-1)).toMatchObject({
      level: 'CHANGES_EXIST',
      status: 'PASSED',
    });
  });

  it('configured build/test commands gate completion; failing output is captured as evidence', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { b: ['success'] } } } });
    const { registerAssignment } = await import('../../src/assignments/register.js');
    const { assignmentExample } = await import('../helpers/assignment.js');
    const reg = await registerAssignment(
      env.store,
      env.registry,
      'mock',
      assignmentExample({
        verification: {
          buildCommand: 'node -e "console.error(\'boom\'); process.exit(3)"',
          testCommand: 'node -e "process.exit(0)"',
        },
      }),
    );
    const t = env.store.enqueueTask({
      projectId: reg.project.id,
      title: 'b',
      instructions: 'x',
      maxRetries: 0,
      verificationRequired: ['BUILD_PASSES', 'TESTS_PASS'],
    }).task;
    await drain(env);
    const task = env.store.getTask(t.id)!;
    expect(task.status).toBe('FAILED'); // retries exhausted (maxRetries 0): provider "success" did not count
    const build = env.store.listEvidence({ taskId: t.id, level: 'BUILD_PASSES' })[0]!;
    expect(build.status).toBe('FAILED');
    expect(JSON.stringify(build.evidence)).toContain('boom');
    expect(JSON.stringify(build.evidence)).toContain('"exitCode":3');
  });

  it('build/test commands never receive provider credentials', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { e: ['success'] } } } });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-SHOULDNOTLEAK123456';
    try {
      const { registerAssignment } = await import('../../src/assignments/register.js');
      const { assignmentExample } = await import('../helpers/assignment.js');
      const reg = await registerAssignment(
        env.store,
        env.registry,
        'mock',
        assignmentExample({
          verification: { buildCommand: 'node -e "process.exit(process.env.ANTHROPIC_API_KEY ? 7 : 0)"' },
        }),
      );
      const t = env.store.enqueueTask({
        projectId: reg.project.id,
        title: 'e',
        instructions: 'x',
        maxRetries: 0,
        verificationRequired: ['BUILD_PASSES'],
      }).task;
      await drain(env);
      expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('unconfigured/unimplemented verifiers are recorded as unknown, never as passes', async () => {
    env = await makeEnv({ mock: { scenario: { tasks: { u: ['success'] } } } });
    const t = add('u', { verificationRequired: ['BUILD_PASSES'] });
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED'); // only FAILED blocks
    expect(env.store.listEvidence({ taskId: t.id, level: 'BUILD_PASSES' })[0]!.status).toBe('NOT_CONFIGURED');
    expect(env.store.getTask(t.id)!.completionEvidence).toContain('BUILD_PASSES=NOT_CONFIGURED');
  });
});

describe('schema migration from a Phase 1 database', () => {
  it('upgrades in place, keeping existing rows and applying safe defaults', () => {
    const db = openDatabase(':memory:');
    // Rebuild a Phase-1-shaped database: drop to migration 1 only.
    const fresh = openDatabase(':memory:');
    fresh.close();
    const raw = new (db.constructor as new (f: string) => typeof db)(':memory:');
    runMigrations(raw, [MIGRATIONS[0]!]);
    raw
      .prepare(
        "INSERT INTO projects(id,name,slug,repo_path,status,created_at,updated_at,last_activity_at,provider) VALUES ('p1','P','p','/x','ACTIVE',1,1,1,'mock')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO tasks(id,project_id,title,instructions,status,max_retries,dedupe_key,created_at,updated_at) VALUES ('t1','p1','T','i','QUEUED',3,'k',1,1)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO checkpoints(id,project_id,task_id,completed_summary,outstanding_summary,next_action,created_at) VALUES ('c1','p1','t1','a','b','c',1)",
      )
      .run();
    expect(runMigrations(raw)).toEqual(MIGRATIONS.slice(1).map((m) => m.version));
    const store = new Store(raw);
    expect(store.getProject('p1')).toMatchObject({ lifecycle: 'REGISTERED' });
    expect(store.getTask('t1')).toMatchObject({
      interruptionCount: 0,
      providerFailureStreak: 0,
      leaseExecutionId: null,
      verificationRequired: [],
    });
    // a legacy checkpoint (no integrity hash) is accepted as unchecked, not rejected
    expect(store.latestValidCheckpoint('t1').checkpoint!.id).toBe('c1');
    db.close();
  });
});

describe('real-restart reconciliation uses the same persistent state', () => {
  it('startup recovery after a dead supervisor resumes, and the hostname-scoped pid check is honoured', async () => {
    env = await makeEnv();
    const { t } = orphan('restart');
    env.store.db
      .prepare(
        "INSERT INTO supervisor_state(id,instance_id,pid,host,started_at,heartbeat_at,status) VALUES (1,'dead',2000000000,?,?,?,'RUNNING')",
      )
      .run(hostname(), env.clock.now(), env.clock.now());
    const run = env.supervisor.start();
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
    expect(readFileSync(env.store.latestExecution(t.id)!.logRef!, 'utf8')).toContain('"mode":"resume"');
  });
});
