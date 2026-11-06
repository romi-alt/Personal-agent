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
  | { kind: 'completed'; summary: string; sessionId?: string; usage?: UsageInfo; testResults?: string }
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
    | 'result';
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
  /** 1-based count of executions already made for this task (for deterministic mock scenarios). */
  attemptIndex: number;
  limits: { maxTurns: number; maxBudgetUsd?: number; timeoutMs: number };
  signal: AbortSignal;
  onEvent(event: ExecutionEvent): void;
  /** Called as soon as a provider session id is known so it can be persisted immediately. */
  onSession(sessionId: string): void;
}

export interface ExecutionProvider {
  readonly name: string;
  /** Local-only readiness check: must not consume provider quota. */
  preflight(): Promise<AuthReadiness>;
  run(req: RunRequest): Promise<RunOutcome>;
}
