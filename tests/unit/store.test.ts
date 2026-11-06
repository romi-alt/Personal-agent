import { afterEach, describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../src/queue/state-machine.js';
import { TASK_STATUSES } from '../../src/types/index.js';
import { TRANSITIONS } from '../../src/queue/state-machine.js';
import { makeEnv, type TestEnv } from '../helpers/env.js';

let env: TestEnv;
afterEach(() => env?.cleanup());
const add = (title: string, extra: Record<string, unknown> = {}) =>
  env.store.enqueueTask({
    projectId: env.project.id,
    title,
    instructions: `do ${title}`,
    maxRetries: 3,
    ...extra,
  }).task;
const claim = (workerId = 'w1') =>
  env.store.claimNext({ workerId, leaseTtlMs: 1000, maxConcurrent: 1, provider: 'mock', pid: process.pid });

describe('projects and tasks', () => {
  it('creates an isolated, git-initialised project workspace', async () => {
    env = await makeEnv();
    expect(env.project.repoPath.startsWith(env.registry.root)).toBe(true);
    expect(env.project.status).toBe('ACTIVE');
    expect(env.store.getProject(env.project.slug)?.id).toBe(env.project.id);
  });
  it('adds a task in QUEUED with a persisted initial transition', async () => {
    env = await makeEnv();
    const t = add('one');
    expect(t.status).toBe('QUEUED');
    expect(env.store.listTransitions(t.id)).toMatchObject([{ from: null, to: 'QUEUED', reason: 'enqueued' }]);
  });
  it('orders the queue by project priority, task priority, then insertion order', async () => {
    env = await makeEnv();
    const a = add('a');
    const b = add('b', { priority: 5 });
    const c = add('c');
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const x = claim()!;
      order.push(x.task.id);
      env.store.transition(x.task.id, 'CHECKPOINTING', { reason: 't' });
      env.store.transition(x.task.id, 'COMPLETED', { reason: 't' });
    }
    expect(order).toEqual([b.id, a.id, c.id]);
  });
  it('rejects duplicate tasks (idempotent enqueue) and supports explicit dedupe keys', async () => {
    env = await makeEnv();
    const first = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'same',
      instructions: 'x',
      maxRetries: 1,
    });
    const second = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'same',
      instructions: 'x',
      maxRetries: 1,
    });
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    const k1 = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'a',
      instructions: 'x',
      maxRetries: 1,
      dedupeKey: 'erp-42',
    });
    const k2 = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'b',
      instructions: 'y',
      maxRetries: 1,
      dedupeKey: 'erp-42',
    });
    expect(k2.created).toBe(false);
    expect(k2.task.id).toBe(k1.task.id);
    expect(env.store.listTasks()).toHaveLength(2);
  });
  it('does not claim a task until its dependencies are COMPLETED', async () => {
    env = await makeEnv();
    const a = add('a');
    const b = add('b', { dependsOn: [a.id] });
    expect(claim()!.task.id).toBe(a.id);
    env.store.transition(a.id, 'CHECKPOINTING', { reason: 't' });
    expect(claim('w2')).toBeNull(); // maxConcurrent 1 and b blocked by a
    env.store.transition(a.id, 'COMPLETED', { reason: 't' });
    expect(claim()!.task.id).toBe(b.id);
  });
  it('respects scheduled start and next-eligible time', async () => {
    env = await makeEnv();
    const t = add('later', { scheduledStart: env.clock.now() + 5000 });
    expect(claim()).toBeNull();
    env.clock.advance(5001);
    expect(claim()!.task.id).toBe(t.id);
  });
});

describe('state machine', () => {
  it('rejects invalid transitions centrally and keeps history', async () => {
    env = await makeEnv();
    const t = add('x');
    expect(() => env.store.transition(t.id, 'COMPLETED', { reason: 'nope' })).toThrow(InvalidTransitionError);
    expect(() => env.store.transition(t.id, 'CHECKPOINTING', { reason: 'nope' })).toThrow(
      InvalidTransitionError,
    );
    expect(env.store.getTask(t.id)!.status).toBe('QUEUED');
    expect(env.store.listTransitions(t.id)).toHaveLength(1);
  });
  it('persists timestamp, reason and execution id for each transition', async () => {
    env = await makeEnv();
    const t = add('x');
    const c = claim()!;
    env.clock.advance(1234);
    env.store.transition(t.id, 'CHECKPOINTING', { reason: 'done', executionId: c.execution.id });
    const tr = env.store.listTransitions(t.id);
    expect(tr.map((x) => x.to)).toEqual(['QUEUED', 'RUNNING', 'CHECKPOINTING']);
    expect(tr[1]).toMatchObject({ reason: 'claimed', executionId: c.execution.id });
    expect(tr[2]!.at - tr[1]!.at).toBe(1234);
  });
  it('terminal states have no outgoing transitions and every status is defined', () => {
    expect(TRANSITIONS.COMPLETED).toEqual([]);
    expect(TRANSITIONS.CANCELLED).toEqual([]);
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
  });
});

describe('worker leasing', () => {
  it('lets only one claimer win when two supervisors race for the same task', async () => {
    env = await makeEnv();
    add('only');
    const second = new (await import('../../src/queue/store.js')).Store(env.store.db, env.clock);
    const a = claim('sup-A');
    const b = second.claimNext({
      workerId: 'sup-B',
      leaseTtlMs: 1000,
      maxConcurrent: 5,
      provider: 'mock',
      pid: process.pid,
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(env.store.getTask(a!.task.id)!.assignedWorker).toBe('sup-A');
  });
  it('enforces max concurrency and extends the lease on heartbeat only for the holder', async () => {
    env = await makeEnv();
    add('a');
    add('b');
    const a = claim('w1')!;
    expect(claim('w1')).toBeNull();
    env.clock.advance(500);
    expect(env.store.heartbeat(a.execution.id, a.task.id, 'w1', 1000)).toBe(true);
    expect(env.store.heartbeat(a.execution.id, a.task.id, 'intruder', 1000)).toBe(false);
    expect(env.store.getTask(a.task.id)!.leaseExpiresAt).toBe(env.clock.now() + 1000);
  });
  it('allows only one live supervisor instance', async () => {
    env = await makeEnv();
    env.store.acquireSupervisorLock('sup-1', 1000);
    expect(() => env.store.acquireSupervisorLock('sup-2', 1000)).toThrow(/Another supervisor/);
    env.clock.advance(5000); // heartbeat stale => takeover allowed
    expect(env.store.acquireSupervisorLock('sup-2', 1000).previous?.instanceId).toBe('sup-1');
  });
});
