import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { makeEnv, waitFor, type TestEnv } from '../helpers/env.js';

/**
 * A9 memory policy (owner decision 2026-11-09): pause NEW workers below 1 GB available, resume only above 1.5 GB
 * (hysteresis), never kill running work. The free-memory probe is injected, so no real memory pressure is created.
 */
let env: TestEnv;
afterEach(() => env?.cleanup());
const MB = 1024 * 1024;

function supervisorWith(free: () => number): Supervisor {
  return new Supervisor({
    config: env.config,
    store: env.store,
    provider: env.provider,
    registry: env.registry,
    log: env.log,
    rng: () => 0.5,
    workflows: env.workflows,
    qa: env.qa,
    freeMemory: free,
  });
}
const events = (type: string) => env.store.listEvents({}).filter((e) => e.type === type);

describe('memory-pressure policy with hysteresis (A9)', () => {
  it('defaults: pause below 1024 MB, resume above 1536 MB', () => {
    const c = loadConfig({ noEnvFile: true, env: { AGENT_HOME: 'C:/x' } });
    expect([c.minFreeMemoryMb, c.resumeFreeMemoryMb]).toEqual([1024, 1536]);
  });

  it('pauses below the low mark, stays paused in the band, resumes only above the high mark; no flapping', async () => {
    env = await makeEnv({ env: { MIN_FREE_MEMORY_MB: '1024', RESUME_FREE_MEMORY_MB: '1536' } });
    let freeMb = 900;
    const sup = supervisorWith(() => freeMb * MB);
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'build',
      instructions: 'b',
      maxRetries: 1,
    }).task;

    const r1 = await sup.tick();
    expect(r1.claimed).toBe(0);
    expect(r1.gate.reason).toMatch(/900 MB available \(paused below 1024 MB, resumes above 1536 MB\)/);
    // Oscillation inside the band (and dips below it) neither resumes nor re-raises the event.
    for (const v of [1100, 1500, 1000, 1535, 1200]) {
      freeMb = v;
      expect((await sup.tick()).claimed, `${v} MB`).toBe(0);
    }
    expect(events('supervisor.resource_deferred')).toHaveLength(1);
    expect(events('supervisor.resource_resumed')).toHaveLength(0);
    expect(env.store.getTask(t.id)!.status).toBe('QUEUED');

    freeMb = 1600;
    expect((await sup.tick()).claimed).toBe(1);
    expect(events('supervisor.resource_resumed')).toHaveLength(1);
    await waitFor(() => sup.activeWorkers === 0 && env.store.getTask(t.id)!.status === 'COMPLETED', 20_000);

    // Once running, it does not pause again until memory drops below the LOW mark (1200 is inside the band).
    freeMb = 1200;
    const t2 = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'b2',
      instructions: 'b',
      maxRetries: 1,
    }).task;
    expect((await sup.tick()).claimed).toBe(1);
    await waitFor(() => sup.activeWorkers === 0 && env.store.getTask(t2.id)!.status === 'COMPLETED', 20_000);
    expect(events('supervisor.resource_deferred')).toHaveLength(1);
  });

  it('memory pressure never kills a running worker; only new claims wait', async () => {
    env = await makeEnv({
      env: { MIN_FREE_MEMORY_MB: '1024', RESUME_FREE_MEMORY_MB: '1536', MAX_CONCURRENT_WORKERS: '2' },
      mock: { scenario: { tasks: { long: [{ type: 'success', delayMs: 1500 }], next: ['success'] } } },
    });
    let freeMb = 2000;
    const sup = supervisorWith(() => freeMb * MB);
    const long = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'long',
      instructions: 'x',
      maxRetries: 1,
    }).task;
    expect((await sup.tick()).claimed).toBe(1);
    await waitFor(() => env.store.getTask(long.id)!.status === 'RUNNING', 10_000);

    freeMb = 500; // pressure arrives while `long` runs
    const next = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'next',
      instructions: 'x',
      maxRetries: 1,
    }).task;
    expect((await sup.tick()).claimed).toBe(0);
    await waitFor(() => env.store.getTask(long.id)!.status === 'COMPLETED', 20_000); // not killed
    expect(env.store.listExecutions(long.id)).toHaveLength(1);
    expect(env.store.listExecutions(long.id)[0]!.errorClass).toBeNull();
    expect(env.store.getTask(next.id)!.status).toBe('QUEUED');
    expect(events('supervisor.resource_deferred')[0]!.payload).toMatchObject({
      freeMb: 500,
      runningWorkers: 1,
    });
  });
});
