import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { normalizeText } from '../core/text.js';

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

    EXECUTION_PROVIDER: z.enum(['mock', 'claude', 'claude-cli']).default('mock'),
    MOCK_SCENARIO_FILE: optStr,
    CLAUDE_MODEL: optStr,
    CLAUDE_CLI_PATH: optStr,

    // --- native Claude Code CLI provider (subscription login) ---
    /** Oldest Claude Code version on which the retry-watchdog variables below were verified to exist. */
    CLAUDE_CLI_MIN_VERSION: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default('2.1.319'),
    /** Injected into every CLI worker (never into the supervisor's own environment). */
    CLAUDE_CODE_RETRY_WATCHDOG: bool(true),
    // Documented range 60000..10800000; outside it Claude Code silently disables the recheck.
    CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(10_800_000)
      .default(300_000),
    CLAUDE_CODE_RESUME_INTERRUPTED_TURN: bool(true),
    CLAUDE_CODE_RESUME_PROMPT: z
      .string()
      .min(1)
      .default(
        'Resume from the latest durable checkpoint. Inspect existing work, determine the next incomplete task, and continue implementation without repeating completed work.',
      ),
    /** Optional ceiling on how long the supervisor lets a CLI worker sit in a usage-limit wait (0 = no ceiling). */
    CLAUDE_CLI_MAX_CAPACITY_WAIT_MS: int(0, 0),
    /** Without model output or a known capacity wait for this long, a CLI worker is treated as stalled. */
    CLAUDE_CLI_STALL_TIMEOUT_MS: int(900_000, 10_000),

    MAX_CONCURRENT_WORKERS: int(1, 1),
    DEFAULT_MAX_RETRIES: int(3, 0),
    MAX_CONTINUATIONS: int(25, 1),
    MAX_TURNS_PER_EXECUTION: int(40, 1),
    MAX_INTERRUPTIONS: int(3, 1),
    MAX_PROVIDER_FAILURE_STREAK: int(20, 1),
    EVENT_RETENTION_DAYS: int(30, 1),
    VERIFY_COMMAND_TIMEOUT_MS: int(600_000, 1000),
    PLAN_APPROVAL: z.enum(['required', 'auto']).default('required'),
    MAX_PLAN_TASKS: int(60, 1),
    MAX_PLAN_REPAIRS: int(2, 0),
    /** Research step may use read-only WebSearch/WebFetch (never when a project requires web_access approval). */
    RESEARCH_WEB_ACCESS: bool(true),
    /** Write ADRs / architecture / research / review documents into the project repository. */
    WRITE_PLAN_DOCS: bool(true),
    /** Phase 3: planned coding tasks need an independent review before dependants run. */
    INDEPENDENT_REVIEW: bool(true),
    /** Owner command center (Phase 5). Loopback only unless DASHBOARD_ALLOW_REMOTE=true. */
    DASHBOARD_HOST: z.string().default('127.0.0.1'),
    DASHBOARD_PORT: int(4317, 1),
    DASHBOARD_ALLOW_REMOTE: bool(false),
    DASHBOARD_ALLOWED_HOSTS: z.string().default(''),
    DASHBOARD_SECURE_COOKIES: bool(false),
    /** Phase 6: online database backups by the supervisor (0 = off), kept BACKUP_RETENTION deep. */
    BACKUP_DIR: optStr,
    BACKUP_INTERVAL_HOURS: int(24, 0),
    BACKUP_RETENTION: int(14, 1),
    /** Optional owner-configured webhook for error/approval notifications (off when empty). */
    NOTIFY_WEBHOOK_URL: optStr,
    MAX_CORRECTION_ROUNDS: int(2, 0),

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
  provider: 'mock' | 'claude' | 'claude-cli';
  mockScenarioFile?: string;
  claudeModel?: string;
  claudeCliPath?: string;
  claudeCli: {
    minVersion: string;
    /** Exact variables injected into each worker process. */
    watchdogEnv: Record<string, string>;
    maxCapacityWaitMs: number;
    stallTimeoutMs: number;
  };
  maxConcurrentWorkers: number;
  defaultMaxRetries: number;
  maxContinuations: number;
  maxTurnsPerExecution: number;
  /** Escalate (BLOCK) a task after this many consecutive crash/restart interruptions. */
  maxInterruptions: number;
  /** Escalate a task after this many consecutive network/outage/rate-limit failures. */
  maxProviderFailureStreak: number;
  eventRetentionDays: number;
  verifyCommandTimeoutMs: number;
  /** 'required': the owner must approve a generated plan before coding tasks are created. */
  planApproval: 'required' | 'auto';
  maxPlanTasks: number;
  maxPlanRepairs: number;
  researchWeb: boolean;
  writePlanDocs: boolean;
  independentReview: boolean;
  dashboard: {
    host: string;
    port: number;
    allowRemote: boolean;
    allowedHosts: string[];
    secureCookies: boolean;
  };
  backup: { dir: string; intervalHours: number; retention: number };
  notifyWebhookUrl: string | undefined;
  maxCorrectionRounds: number;
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
  return parseEnv(normalizeText(readFileSync(file, 'utf8'))) as Record<string, string>;
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
    backup: {
      dir: path.resolve(c.BACKUP_DIR ?? path.join(home, 'backups')),
      intervalHours: c.BACKUP_INTERVAL_HOURS,
      retention: c.BACKUP_RETENTION,
    },
    notifyWebhookUrl: c.NOTIFY_WEBHOOK_URL,
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
    claudeCli: {
      minVersion: c.CLAUDE_CLI_MIN_VERSION,
      watchdogEnv: {
        CLAUDE_CODE_RETRY_WATCHDOG: c.CLAUDE_CODE_RETRY_WATCHDOG ? '1' : '0',
        CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS: String(
          c.CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS,
        ),
        CLAUDE_CODE_RESUME_INTERRUPTED_TURN: c.CLAUDE_CODE_RESUME_INTERRUPTED_TURN ? '1' : '0',
        CLAUDE_CODE_RESUME_PROMPT: c.CLAUDE_CODE_RESUME_PROMPT,
      },
      maxCapacityWaitMs: c.CLAUDE_CLI_MAX_CAPACITY_WAIT_MS,
      stallTimeoutMs: c.CLAUDE_CLI_STALL_TIMEOUT_MS,
    },
    maxConcurrentWorkers: c.MAX_CONCURRENT_WORKERS,
    defaultMaxRetries: c.DEFAULT_MAX_RETRIES,
    maxContinuations: c.MAX_CONTINUATIONS,
    maxTurnsPerExecution: c.MAX_TURNS_PER_EXECUTION,
    maxInterruptions: c.MAX_INTERRUPTIONS,
    maxProviderFailureStreak: c.MAX_PROVIDER_FAILURE_STREAK,
    eventRetentionDays: c.EVENT_RETENTION_DAYS,
    verifyCommandTimeoutMs: c.VERIFY_COMMAND_TIMEOUT_MS,
    planApproval: c.PLAN_APPROVAL,
    maxPlanTasks: c.MAX_PLAN_TASKS,
    maxPlanRepairs: c.MAX_PLAN_REPAIRS,
    researchWeb: c.RESEARCH_WEB_ACCESS,
    writePlanDocs: c.WRITE_PLAN_DOCS,
    independentReview: c.INDEPENDENT_REVIEW,
    dashboard: {
      host: c.DASHBOARD_HOST,
      port: c.DASHBOARD_PORT,
      allowRemote: c.DASHBOARD_ALLOW_REMOTE,
      allowedHosts: c.DASHBOARD_ALLOWED_HOSTS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      secureCookies: c.DASHBOARD_SECURE_COOKIES,
    },
    maxCorrectionRounds: c.MAX_CORRECTION_ROUNDS,
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
