import { type AppConfig, loadConfig, type LoadConfigOptions } from '../config/index.js';
import { openDatabase, type Db } from '../database/connection.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { MockProvider } from '../providers/mock/mock-provider.js';
import { ClaudeProvider } from '../providers/claude/claude-provider.js';
import { EnvCredentialSource } from '../providers/claude/credentials.js';
import type { ExecutionProvider } from '../providers/types.js';
import { Store } from '../queue/store.js';
import { WorkspaceRegistry } from '../workspaces/registry.js';
import { WorkflowEngine } from '../workflows/engine.js';

export interface App {
  config: AppConfig;
  db: Db;
  store: Store;
  log: Logger;
  registry: WorkspaceRegistry;
  provider: ExecutionProvider;
  workflows: WorkflowEngine;
  close(): void;
}

export function createProvider(config: AppConfig): ExecutionProvider {
  if (config.provider === 'claude') {
    return new ClaudeProvider({ config, credentials: new EnvCredentialSource(config.envFile) });
  }
  return new MockProvider({
    scenarioFile: config.mockScenarioFile,
    capacityFile: config.mockScenarioFile
      ? config.mockScenarioFile.replace(/\.json$/, '.capacity.json')
      : undefined,
  });
}

export function createApp(opts: LoadConfigOptions & { provider?: ExecutionProvider } = {}): App {
  const config = loadConfig(opts);
  const log = createLogger(config);
  const db = openDatabase(config.databasePath);
  const store = new Store(db, undefined, log);
  const registry = new WorkspaceRegistry(db, config.workspaceRoot);
  const provider = opts.provider ?? createProvider(config);
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
  return { config, db, store, log, registry, provider, workflows, close: () => db.close() };
}
