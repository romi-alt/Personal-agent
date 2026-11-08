import { afterEach, describe, expect, it } from 'vitest';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { makeEnv, waitFor, type TestEnv } from '../helpers/env.js';

/** A9: the supervisor defers NEW work under memory pressure, never kills running work, and resumes on recovery. */
let env: TestEnv;
afterEach(() => env?.cleanup());

describe('memory-pressure gate (A9)', () => {
  it('defers claiming below MIN_FREE_MEMORY_MB, records one event per episode, resumes when memory recovers', async () => {
    env = await makeEnv({ env: { MIN_FREE_MEMORY_MB: '500' } });
    let free = 200 * 1024 * 1024;
    const sup = new Supervisor({
      config: env.config,
      store: env.store,
      provider: env.provider,
      registry: env.registry,
      log: env.log,
      rng: () => 0.5,
      workflows: env.workflows,
      qa: env.qa,
      freeMemory: () => free,
    });
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'build',
      instructions: 'b',
      maxRetries: 1,
    }).task;
    const r1 = await sup.tick();
    expect(r1.claimed).toBe(0);
    expect(r1.gate.reason).toMatch(/low memory: 200 MB free < MIN_FREE_MEMORY_MB 500/);
    expect((await sup.tick()).claimed).toBe(0);
    const ev = env.store.listEvents({}).filter((e) => e.type === 'supervisor.resource_deferred');
    expect(ev).toHaveLength(1); // once per episode, not per poll
    expect(env.store.getTask(t.id)!.status).toBe('QUEUED');

    free = 2 * 1024 * 1024 * 1024;
    expect((await sup.tick()).claimed).toBe(1);
    await waitFor(() => sup.activeWorkers === 0 && env.store.getTask(t.id)!.status === 'COMPLETED', 20_000);
  });
});
