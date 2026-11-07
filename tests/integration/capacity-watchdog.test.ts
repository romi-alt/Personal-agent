import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { reconcileOrphans } from '../../src/recovery/reconcile.js';
import { buildStatus } from '../../src/supervisor/status.js';
import { TaskRunner } from '../../src/workers/runner.js';
import { makeEnv, waitFor, type TestEnv } from '../helpers/env.js';

/**
 * Acceptance test 4 (simulated subscription usage limit) through the real supervisor, runner and store.
 * The mock behaves like the official retry watchdog: ONE request stays open and silent until capacity returns
 * (signalled by a release file), then continues. The real subscription is never exhausted to test this.
 */
let env: TestEnv;
afterEach(() => env?.cleanup());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('official retry watchdog wait (simulated)', () => {
  it('preserves the task, keeps the supervisor healthy, sends no duplicate request, and resumes when capacity returns', async () => {
    env = await makeEnv();
    const release = path.join(env.dir, 'capacity-returned');
    env.mock!['opts'].scenario = {
      tasks: { build: [{ type: 'watchdog_wait', delayMs: 50, resetsInMs: 3_600_000, untilFile: release }] },
    };
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'build',
      instructions: 'build it',
      maxRetries: 2,
    }).task;
    await env.supervisor.tick();
    await waitFor(() => !!env.store.latestExecution(t.id)?.capacityWait, 15_000);

    // ---- while waiting: not completed, not failed, one execution, visible as WAITING_FOR_USAGE_RESET
    const exec = env.store.latestExecution(t.id)!;
    expect(env.store.getTask(t.id)!.status).toBe('RUNNING');
    expect(exec.capacityWait).toMatchObject({ reason: 'mock five_hour limit reached' });
    expect(exec.capacityWait!.resetsAt).toBeGreaterThan(env.clock.now());
    const st = await buildStatus(env.store, env.provider, env.config.leaseTtlMs);
    expect(st.workerState).toBe('WAITING_FOR_USAGE_RESET');
    expect(st.currentExecution?.id).toBe(exec.id);

    // Time passes beyond the lease TTL. Heartbeats continue without any model request, so a lease sweep run as if
    // from ANOTHER process (no local-activity shortcut) still sees a valid lease and reclaims nothing.
    env.clock.advance(env.config.leaseTtlMs * 5);
    await sleep(env.config.heartbeatIntervalMs * 4);
    const runner = new TaskRunner({
      config: env.config,
      store: env.store,
      provider: env.provider,
      registry: env.registry,
      log: env.log,
      workerId: 'other-process',
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

    // Further scheduling passes neither start a second execution nor send another request.
    await env.supervisor.tick();
    await env.supervisor.tick();
    expect(env.store.listExecutions(t.id)).toHaveLength(1);
    expect(env.mock!.watchdogRequests).toBe(1);
    expect(env.mock!.runs).toHaveLength(1);

    // ---- capacity returns: the same request continues and the task completes through normal verification
    writeFileSync(release, '');
    await waitFor(() => env.store.getTask(t.id)!.status === 'COMPLETED', 20_000);
    expect(env.store.listExecutions(t.id)).toHaveLength(1);
    expect(env.mock!.runs).toHaveLength(1);
    expect(env.store.latestExecution(t.id)!.capacityWait).toBeNull();
    const types = env.store.listEvents({ taskId: t.id }).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['provider.capacity_wait_started', 'provider.capacity_wait_ended']),
    );
  });
});
