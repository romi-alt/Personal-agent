import { mkdtempSync } from 'node:fs';
import { removeTempDir } from './fs.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type AppConfig, loadConfig } from '../../src/config/index.js';
import { openDatabase } from '../../src/database/connection.js';
import { type Logger, silentLogger } from '../../src/logging/logger.js';
import { MockProvider, type MockProviderOptions } from '../../src/providers/mock/mock-provider.js';
import type { ExecutionProvider } from '../../src/providers/types.js';
import { Store } from '../../src/queue/store.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { WorkflowEngine } from '../../src/workflows/engine.js';
import type { Clock, Project } from '../../src/types/index.js';
import { WorkspaceRegistry } from '../../src/workspaces/registry.js';

export class FakeClock implements Clock {
  constructor(public t = 1_800_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface TestEnv {
  dir: string;
  config: AppConfig;
  clock: FakeClock;
  store: Store;
  registry: WorkspaceRegistry;
  provider: ExecutionProvider;
  mock?: MockProvider;
  project: Project;
  supervisor: Supervisor;
  workflows: WorkflowEngine;
  lines: string[];
  log: Logger;
  cleanup(): Promise<void>;
}

export async function makeEnv(
  opts: {
    mock?: MockProviderOptions;
    provider?: ExecutionProvider;
    env?: Record<string, string>;
    startClock?: number;
  } = {},
): Promise<TestEnv> {
  const dir = mkdtempSync(path.join(tmpdir(), 'elevariq-test-'));
  const config = loadConfig({
    noEnvFile: true,
    env: {
      AGENT_HOME: dir,
      LOG_TO_CONSOLE: 'false',
      HEARTBEAT_INTERVAL_MS: '100',
      LEASE_TTL_MS: '1000',
      POLL_INTERVAL_MS: '50',
      SHUTDOWN_GRACE_MS: '2000',
      BACKOFF_BASE_MS: '1000',
      BACKOFF_MAX_MS: '60000',
      BACKOFF_JITTER: '0',
      ...opts.env,
    },
  });
  const db = openDatabase(path.join(dir, 'test.db'));
  const clock = new FakeClock(opts.startClock);
  const lines: string[] = [];
  const log = silentLogger((l) => lines.push(l));
  const store = new Store(db, clock, log);
  const registry = new WorkspaceRegistry(db, config.workspaceRoot, clock);
  const mock = opts.provider ? undefined : new MockProvider({ now: () => clock.now(), ...opts.mock });
  const provider = opts.provider ?? mock!;
  const project = await registry.createManagedProject(store, {
    name: 'Test Project',
    provider: provider.name,
  });
  const workflows = new WorkflowEngine(
    store,
    {
      planApproval: config.planApproval,
      maxPlanTasks: config.maxPlanTasks,
      maxPlanRepairs: config.maxPlanRepairs,
      defaultMaxRetries: config.defaultMaxRetries,
    },
    log,
  );
  const supervisor = new Supervisor({ config, store, provider, registry, log, rng: () => 0.5, workflows });
  return {
    dir,
    config,
    clock,
    store,
    registry,
    provider,
    mock,
    project,
    supervisor,
    workflows,
    lines,
    log,
    cleanup: async () => {
      // A worker still in flight (slow git/process spawns on Windows) would otherwise write to a closed database.
      try {
        await waitFor(() => supervisor.activeWorkers === 0, 30_000);
      } catch {
        /* report via the test itself; still release resources */
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
      removeTempDir(dir);
    },
  };
}

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  stepMs = 20,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Tick the supervisor until no worker is active and nothing more is claimable now. */
export async function drain(env: TestEnv, maxRounds = 50): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const { claimed } = await env.supervisor.tick();
    await waitFor(() => env.supervisor.activeWorkers === 0);
    if (claimed === 0) return;
  }
}

export const statuses = (env: TestEnv, taskId: string): string[] =>
  env.store.listTransitions(taskId).map((t) => t.to);

/** Drive supervisor ticks and workflow advancement until nothing more can happen right now. */
export async function settle(env: TestEnv, maxRounds = 80): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const { claimed } = await env.supervisor.tick();
    await waitFor(() => env.supervisor.activeWorkers === 0);
    const changed = env.workflows.advanceAll();
    if (claimed === 0 && changed === 0) return;
  }
  throw new Error('settle: still making progress after ' + maxRounds + ' rounds');
}
