/**
 * In-process backend for the browser tests: a real agent (SQLite store, workflows, QA, supervisor loop) on the
 * deterministic mock provider, plus the real command-center server. Tests drive the UI in Microsoft Edge and assert
 * the resulting BACKEND state through `app.store` - screenshots are never the evidence.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, type App } from '../../src/core/app.js';
import { tokenFile } from '../../src/dashboard/auth.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { MockProvider } from '../../src/providers/mock/mock-provider.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { assignmentExample } from '../helpers/assignment.js';
import { removeTempDir } from '../helpers/fs.js';
import { happyPlanning, reply } from '../helpers/plan-fixtures.js';

export const LIVE_TASK = 'Live worker demo (waits for usage reset)';

export interface Harness {
  app: App;
  base: string;
  token: string;
  home: string;
  /** Creating this file ends the simulated usage-limit wait of LIVE_TASK. */
  releaseCapacity(): void;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const home = mkdtempSync(path.join(tmpdir(), 'elevariq-pw-'));
  const untilFile = path.join(home, 'capacity-returned');
  const provider = new MockProvider({
    scenario: {
      tasks: {
        ...happyPlanning(),
        // Natural-language intake: the model's structured contract for whatever the owner typed.
        'Plan: intake': [
          reply(JSON.stringify({ ...assignmentExample(), title: 'Browser QA school system' })),
        ],
        // Simulated official retry watchdog: the worker stays alive and silent until capacity returns.
        [LIVE_TASK]: [{ type: 'watchdog_wait', delayMs: 0, untilFile }],
      } as never,
    },
  });
  const app = createApp({
    noEnvFile: true,
    provider,
    env: {
      AGENT_HOME: home,
      LOG_TO_CONSOLE: 'false',
      PLAN_APPROVAL: 'required',
      INDEPENDENT_REVIEW: 'false',
      BACKUP_INTERVAL_HOURS: '0',
      MIN_FREE_MEMORY_MB: '0', // host memory must not decide UI-test outcomes (the gate has its own test)
      POLL_INTERVAL_MS: '100',
      HEARTBEAT_INTERVAL_MS: '500',
    },
  });
  const sup = new Supervisor({
    config: app.config,
    store: app.store,
    provider,
    registry: app.registry,
    log: app.log,
    workflows: app.workflows,
    qa: app.qa,
  });
  const running = sup.start();
  const port = 43000 + Math.floor(Math.random() * 1500);
  const server: Server = await startDashboard(app, { host: '127.0.0.1', port });
  return {
    app,
    home,
    base: `http://127.0.0.1:${port}/`,
    token: readFileSync(tokenFile(home), 'utf8').trim(),
    releaseCapacity: () => writeFileSync(untilFile, 'ok'),
    async close() {
      writeFileSync(untilFile, 'ok');
      sup.requestStop('browser tests finished');
      await running.catch(() => undefined);
      await new Promise<void>((r) => server.close(() => r()));
      app.close();
      removeTempDir(home);
    },
  };
}

/** Poll a backend condition (the store is the source of truth). */
export async function until<T>(
  fn: () => T | null | undefined | false,
  what: string,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
