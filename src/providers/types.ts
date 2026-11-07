import type { ErrorClass } from '../types/index.js';

export interface AuthReadiness {
  ready: boolean;
  /** What was verified, without any secret material. */
  detail: string;
  /** Missing requirements when not ready. */
  missing: string[];
  /** Non-reversible credential fingerprint, used only to detect a credential change. */
  fingerprint?: string;
  /** True when this check made no network call (always true for Phase 1 preflight). */
  local: boolean;
}

export interface ProviderFailure {
  errorClass: ErrorClass;
  message: string;
  /** Server-provided retry guidance (retry-after), if any. */
  retryAfterMs?: number;
  /** Server-provided absolute reset time (epoch ms), if any. Never invented. */
  resetsAtMs?: number;
  /** Original provider error code for diagnostics. */
  code?: string;
}

export interface PermissionDenial {
  tool: string;
  reason: string;
  approvalType?: string;
  input?: Record<string, unknown>;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  /** Client-side estimate (e.g. SDK total_cost_usd). NOT a billing statement. */
  costUsdEstimate?: number;
  /** Actual billed cost; only set if the provider reports it reliably. */
  costUsdBilled?: number;
  turns?: number;
  raw?: Record<string, unknown>;
}

export type RunOutcome =
  | {
      kind: 'completed';
      summary: string;
      sessionId?: string;
      usage?: UsageInfo;
      testResults?: string;
      /** Tool calls denied during an otherwise "successful" run: work may be incomplete. */
      denials?: PermissionDenial[];
    }
  | {
      kind: 'partial';
      summary: string;
      outstanding?: string;
      sessionId?: string;
      usage?: UsageInfo;
      testResults?: string;
      nextAction?: string;
    }
  | {
      kind: 'failed';
      failure: ProviderFailure;
      summary?: string;
      sessionId?: string;
      usage?: UsageInfo;
      denials?: PermissionDenial[];
    };

export interface ExecutionEvent {
  type:
    | 'session'
    | 'assistant_text'
    | 'tool_use'
    | 'tool_result'
    | 'permission_denied'
    | 'rate_limit'
    | 'retry'
    | 'status'
    | 'result'
    /**
     * The provider process is alive and deliberately waiting for subscription capacity (official retry watchdog).
     * `data.waiting` true/false marks the start/end; `data.resetsAtMs` / `data.recheckAtMs` when known.
     * The runner suspends its execution timeout while waiting: a capacity wait is not a stall.
     */
    | 'capacity_wait'
    /** URLs a web tool was called with or returned (`data.urls`); research citations are checked against these. */
    | 'web_evidence'
    /** Watchdog variables observed in the worker's process environment (`data.vars`). */
    | 'worker_env';
  data: Record<string, unknown>;
}

export interface RunRequest {
  executionId: string;
  taskId: string;
  taskTitle: string;
  /** Fully assembled prompt (fresh, resume or recovery flavour). */
  prompt: string;
  /** Instructions appended to the system prompt: boundaries and task rules. */
  systemAppend: string;
  /** Project working directory. Already validated against the workspace registry. */
  cwd: string;
  /** Provider session to resume; absent => start a new session. */
  resumeSessionId?: string;
  /** Approval categories the owner has granted for this task (see security/policy.ts). */
  approvedActionTypes: string[];
  /** Planning workers: expose read-only tools only (no writes, no shell). */
  readOnly?: boolean;
  /** Read-only research workers: additionally expose WebSearch/WebFetch (policy still applies). */
  allowWeb?: boolean;
  /** Extra categories the project's approval policy forces to require approval. */
  alsoRequireApproval: string[];
  /** 1-based count of executions already made for this task (for deterministic mock scenarios). */
  attemptIndex: number;
  limits: { maxTurns: number; maxBudgetUsd?: number; timeoutMs: number };
  signal: AbortSignal;
  onEvent(event: ExecutionEvent): void;
  /** Called as soon as a provider session id is known so it can be persisted immediately. */
  onSession(sessionId: string): void;
  /** Child-process providers report the worker pid when spawned and null when it has exited. */
  onProcess?(pid: number | null): void;
}

export interface ExecutionProvider {
  readonly name: string;
  /**
   * Executable-name pattern of this provider's child worker process (child-process providers only). Used by recovery
   * only as a fallback when the worker's exact OS identity was not recorded before the supervisor died.
   */
  readonly workerImage?: RegExp;
  /** Local-only readiness check: must not consume provider quota. */
  preflight(): Promise<AuthReadiness>;
  run(req: RunRequest): Promise<RunOutcome>;
}
