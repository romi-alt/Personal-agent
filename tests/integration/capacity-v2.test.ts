import { afterEach, describe, expect, it } from 'vitest';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { drain, makeEnv, statuses, type TestEnv } from '../helpers/env.js';

/**
 * Supervisor-level capacity behaviour for v2 (A10/A12), through the real supervisor, runner, decide() and store.
 * "Host sleep across a reset" is the wall clock jumping past the reset while nothing runs: the durable queue compares
 * next_eligible_at with the wall clock on every scheduling pass, so it is sleep-safe by construction.
 * The real subscription is never exhausted.
 */
const HOUR = 3_600_000;
let env: TestEnv;
afterEach(() => env?.cleanup());

const quota = (resetsInMs: number) => ({ type: 'quota' as const, resetsInMs });

describe('capacity waits in the durable queue (v2)', () => {
  it('multiple consecutive resets: waits each time, resumes the same session, consumes no retry, one worker at a time', async () => {
    env = await makeEnv();
    env.mock!['opts'].scenario = { tasks: { build: [quota(HOUR), quota(5 * HOUR), 'success'] } };
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'build',
      instructions: 'b',
      maxRetries: 1,
    }).task;

    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('WAITING_FOR_CAPACITY');
    const eligible1 = env.store.getTask(t.id)!.nextEligibleAt!;
    expect(eligible1 - env.clock.now()).toBe(HOUR + env.config.backoff.resetMarginMs);

    // Before the reset nothing is claimed, however often the supervisor polls.
    env.clock.advance(HOUR - 60_000);
    expect((await env.supervisor.tick()).claimed).toBe(0);

    // Host slept across the reset (wall clock jumped well past it): first pass after wake resumes.
    env.clock.advance(9 * HOUR);
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('WAITING_FOR_CAPACITY'); // second limit
    env.clock.advance(5 * HOUR + 10_000);
    await drain(env);

    const task = env.store.getTask(t.id)!;
    expect(task.status).toBe('COMPLETED');
    expect(task.attemptCount).toBe(0); // capacity waits never consume retries (maxRetries 1 would have failed it)
    const runs = env.mock!.runs.filter((r) => r.taskTitle === 'build');
    expect(runs).toHaveLength(3);
    expect(runs[0]!.resumed).toBeUndefined();
    expect(runs[1]!.resumed).toBe(`mock-session-${t.id}`); // same session resumed after each reset
    expect(runs[2]!.resumed).toBe(`mock-session-${t.id}`);
    // never two executions overlapping
    const ex = env.store.listExecutions(t.id);
    for (let i = 1; i < ex.length; i++) expect(ex[i]!.startedAt).toBeGreaterThanOrEqual(ex[i - 1]!.endedAt!);
    expect(statuses(env, t.id).filter((s) => s === 'WAITING_FOR_CAPACITY')).toHaveLength(2);
  });

  it('A12 notify: a capacity streak past CAPACITY_ESCALATE_AFTER_MS is escalated ONCE and the task keeps waiting', async () => {
    env = await makeEnv({ env: { CAPACITY_ESCALATE_AFTER_MS: String(2 * HOUR) } });
    env.mock!['opts'].scenario = {
      tasks: { build: [quota(HOUR), quota(HOUR), quota(HOUR), quota(HOUR), 'success'] },
    };
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'build',
      instructions: 'b',
      maxRetries: 2,
    }).task;
    for (let i = 0; i < 5; i++) {
      await drain(env);
      env.clock.advance(HOUR + 10_000);
    }
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
    const esc = env.store.listEvents({ taskId: t.id }).filter((e) => e.type === 'capacity.escalated');
    expect(esc).toHaveLength(1);
    expect(esc[0]!.payload).toMatchObject({ policy: 'notify' });
  });

  it('A12 block: the escalation BLOCKS the task for owner review instead of waiting on', async () => {
    env = await makeEnv({
      env: { CAPACITY_ESCALATE_AFTER_MS: String(2 * HOUR), CAPACITY_ESCALATION: 'block' },
    });
    env.mock!['opts'].scenario = { tasks: { build: [quota(HOUR)] } };
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'build',
      instructions: 'b',
      maxRetries: 2,
    }).task;
    for (let i = 0; i < 4 && env.store.getTask(t.id)!.status !== 'BLOCKED'; i++) {
      await drain(env);
      env.clock.advance(HOUR + 10_000);
    }
    expect(env.store.getTask(t.id)!.status).toBe('BLOCKED');
    const types = env.store.listEvents({ taskId: t.id }).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['capacity.escalated', 'task.escalated']));
  });

  it('supervisor restart while a task waits for capacity: the new instance keeps waiting, then resumes; no duplicate', async () => {
    env = await makeEnv();
    env.mock!['opts'].scenario = { tasks: { build: [quota(2 * HOUR), 'success'] } };
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'build',
      instructions: 'b',
      maxRetries: 2,
    }).task;
    await drain(env);
    expect(env.store.getTask(t.id)!.status).toBe('WAITING_FOR_CAPACITY');

    // Crash/restart: a fresh Supervisor on the same durable store (the old instance is simply abandoned).
    const second = new Supervisor({
      config: env.config,
      store: env.store,
      provider: env.provider,
      registry: env.registry,
      log: env.log,
      rng: () => 0.5,
      workflows: env.workflows,
      qa: env.qa,
    });
    expect((await second.tick()).claimed).toBe(0);
    env.clock.advance(2 * HOUR + 10_000);
    const { claimed } = await second.tick();
    expect(claimed).toBe(1);
    expect((await env.supervisor.tick()).claimed).toBe(0); // the old instance cannot claim it too
    for (let i = 0; i < 100 && second.activeWorkers > 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
    expect(env.store.listExecutions(t.id)).toHaveLength(2);
  });
});
