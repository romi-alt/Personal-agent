import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const num = (def: number, min = 0) => z.coerce.number().min(min).default(def);
const bool = (def: boolean) => z.stringbool().default(def);
const optStr = z.string().min(1).optional();
const optUrl = z.url().optional();

const schema = z
  .object({
    ENVIRONMENT: z.enum(['development', 'test', 'production']).default('development'),
    AGENT_HOME: z.string().min(1),
    DATABASE_PATH: z.string().min(1).optional(),
    WORKSPACE_ROOT: z.string().min(1).optional(),
    LOG_DIR: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_RETENTION_DAYS: int(14, 1),
    LOG_MAX_FILE_MB: int(20, 1),
    LOG_TO_CONSOLE: bool(true),

    EXECUTION_PROVIDER: z.enum(['mock', 'claude']).default('mock'),
    MOCK_SCENARIO_FILE: optStr,
    CLAUDE_MODEL: optStr,
    CLAUDE_CLI_PATH: optStr,

    MAX_CONCURRENT_WORKERS: int(1, 1),
    DEFAULT_MAX_RETRIES: int(3, 0),
    MAX_CONTINUATIONS: int(25, 1),
    MAX_TURNS_PER_EXECUTION: int(40, 1),

    BACKOFF_BASE_MS: int(30_000, 1),
    BACKOFF_MAX_MS: int(3_600_000, 1),
    BACKOFF_JITTER: num(0.2, 0),
    QUOTA_MIN_WAIT_MS: int(900_000, 1),
    RESET_MARGIN_MS: int(5_000, 0),

    WORKER_TIMEOUT_MS: int(1_800_000, 1000),
    HEARTBEAT_INTERVAL_MS: int(10_000, 100),
    LEASE_TTL_MS: int(60_000, 300),
    POLL_INTERVAL_MS: int(2_000, 50),
    SHUTDOWN_GRACE_MS: int(20_000, 100),

    ALLOW_PAID_API: bool(false),
    MAX_BUDGET_USD_PER_EXECUTION: num(0, 0),
    DAILY_BUDGET_USD: num(0, 0),

    HEALTH_PORT: int(0, 0),

    INTEGRATION_ERP_ENABLED: bool(false),
    INTEGRATION_CRM_ENABLED: bool(false),
    ELEVARIQ_ERP_BASE_URL: optUrl,
    ELEVARIQ_ERP_API_TOKEN: optStr,
    ELEVARIQ_CRM_BASE_URL: optUrl,
    ELEVARIQ_CRM_API_TOKEN: optStr,
  })
  .superRefine((c, ctx) => {
    if (c.LEASE_TTL_MS < c.HEARTBEAT_INTERVAL_MS * 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['LEASE_TTL_MS'],
        message: 'must be at least 3x HEARTBEAT_INTERVAL_MS',
      });
    }
    if (c.BACKOFF_MAX_MS < c.BACKOFF_BASE_MS) {
      ctx.addIssue({ code: 'custom', path: ['BACKOFF_MAX_MS'], message: 'must be >= BACKOFF_BASE_MS' });
    }
    if (c.INTEGRATION_ERP_ENABLED && !c.ELEVARIQ_ERP_BASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['ELEVARIQ_ERP_BASE_URL'],
        message: 'required when INTEGRATION_ERP_ENABLED=true',
      });
    }
    if (c.INTEGRATION_CRM_ENABLED && !c.ELEVARIQ_CRM_BASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['ELEVARIQ_CRM_BASE_URL'],
        message: 'required when INTEGRATION_CRM_ENABLED=true',
      });
    }
    if (c.EXECUTION_PROVIDER === 'claude' && c.ALLOW_PAID_API && c.MAX_BUDGET_USD_PER_EXECUTION <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAX_BUDGET_USD_PER_EXECUTION'],
        message:
          'must be > 0 when ALLOW_PAID_API=true with the claude provider (explicit spending cap required)',
      });
    }
  });

export interface AppConfig {
  environment: 'development' | 'test' | 'production';
  agentHome: string;
  databasePath: string;
  workspaceRoot: string;
  logDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logRetentionDays: number;
  logMaxFileBytes: number;
  logToConsole: boolean;
  provider: 'mock' | 'claude';
  mockScenarioFile?: string;
  claudeModel?: string;
  claudeCliPath?: string;
  maxConcurrentWorkers: number;
  defaultMaxRetries: number;
  maxContinuations: number;
  maxTurnsPerExecution: number;
  backoff: { baseMs: number; maxMs: number; jitter: number; quotaMinWaitMs: number; resetMarginMs: number };
  workerTimeoutMs: number;
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
  pollIntervalMs: number;
  shutdownGraceMs: number;
  allowPaidApi: boolean;
  maxBudgetUsdPerExecution: number;
  dailyBudgetUsd: number;
  healthPort: number;
  integrations: {
    erp: { enabled: boolean; baseUrl?: string; hasToken: boolean };
    crm: { enabled: boolean; baseUrl?: string; hasToken: boolean };
  };
  /** Absolute path of the optional .env file consulted for credentials. */
  envFile: string;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  /** Skip reading a .env file (tests). */
  noEnvFile?: boolean;
}

export function defaultAgentHome(env: NodeJS.ProcessEnv): string {
  if (env['AGENT_HOME']) return env['AGENT_HOME'];
  if (process.platform === 'win32') {
    return path.join(env['LOCALAPPDATA'] ?? path.join(homedir(), 'AppData', 'Local'), 'ElevariqAgent');
  }
  return path.resolve(process.cwd(), 'data');
}

/** Read a .env file (never mutates process.env). Real environment variables win. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const baseEnv = opts.env ?? process.env;
  const envFile = path.resolve(opts.envFile ?? baseEnv['AGENT_ENV_FILE'] ?? '.env');
  const merged: Record<string, string | undefined> = {
    ...(opts.noEnvFile ? {} : readEnvFile(envFile)),
    ...baseEnv,
  };
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v === 'string' && v.trim() !== '') raw[k] = v.trim();
  }
  raw['AGENT_HOME'] = defaultAgentHome(raw);

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  - ${issues.join('\n  - ')}`, issues);
  }
  const c = parsed.data;
  const home = path.resolve(c.AGENT_HOME);
  return {
    environment: c.ENVIRONMENT,
    agentHome: home,
    databasePath: path.resolve(c.DATABASE_PATH ?? path.join(home, 'agent.db')),
    workspaceRoot: path.resolve(c.WORKSPACE_ROOT ?? path.join(home, 'workspaces')),
    logDir: path.resolve(c.LOG_DIR ?? path.join(home, 'logs')),
    logLevel: c.LOG_LEVEL,
    logRetentionDays: c.LOG_RETENTION_DAYS,
    logMaxFileBytes: c.LOG_MAX_FILE_MB * 1024 * 1024,
    logToConsole: c.LOG_TO_CONSOLE,
    provider: c.EXECUTION_PROVIDER,
    mockScenarioFile: c.MOCK_SCENARIO_FILE ? path.resolve(c.MOCK_SCENARIO_FILE) : undefined,
    claudeModel: c.CLAUDE_MODEL,
    claudeCliPath: c.CLAUDE_CLI_PATH,
    maxConcurrentWorkers: c.MAX_CONCURRENT_WORKERS,
    defaultMaxRetries: c.DEFAULT_MAX_RETRIES,
    maxContinuations: c.MAX_CONTINUATIONS,
    maxTurnsPerExecution: c.MAX_TURNS_PER_EXECUTION,
    backoff: {
      baseMs: c.BACKOFF_BASE_MS,
      maxMs: c.BACKOFF_MAX_MS,
      jitter: c.BACKOFF_JITTER,
      quotaMinWaitMs: c.QUOTA_MIN_WAIT_MS,
      resetMarginMs: c.RESET_MARGIN_MS,
    },
    workerTimeoutMs: c.WORKER_TIMEOUT_MS,
    heartbeatIntervalMs: c.HEARTBEAT_INTERVAL_MS,
    leaseTtlMs: c.LEASE_TTL_MS,
    pollIntervalMs: c.POLL_INTERVAL_MS,
    shutdownGraceMs: c.SHUTDOWN_GRACE_MS,
    allowPaidApi: c.ALLOW_PAID_API,
    maxBudgetUsdPerExecution: c.MAX_BUDGET_USD_PER_EXECUTION,
    dailyBudgetUsd: c.DAILY_BUDGET_USD,
    healthPort: c.HEALTH_PORT,
    integrations: {
      erp: {
        enabled: c.INTEGRATION_ERP_ENABLED,
        baseUrl: c.ELEVARIQ_ERP_BASE_URL,
        hasToken: !!c.ELEVARIQ_ERP_API_TOKEN,
      },
      crm: {
        enabled: c.INTEGRATION_CRM_ENABLED,
        baseUrl: c.ELEVARIQ_CRM_BASE_URL,
        hasToken: !!c.ELEVARIQ_CRM_API_TOKEN,
      },
    },
    envFile,
  };
}
