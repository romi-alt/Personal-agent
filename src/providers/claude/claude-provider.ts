import {
  getSessionInfo,
  query as sdkQuery,
  type HookCallback,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig } from '../../config/index.js';
import { evaluateToolUse } from '../../security/policy.js';
import type {
  AuthReadiness,
  ExecutionProvider,
  PermissionDenial,
  ProviderFailure,
  RunOutcome,
  RunRequest,
  UsageInfo,
} from '../types.js';
import { type CredentialSource, fingerprint, looksLikeSubscriptionToken } from './credentials.js';
import {
  classifyText,
  classifyThrown,
  mapAssistantError,
  resetsAtToMs,
  type RateInfoLike,
} from './errors.js';

type QueryFn = (params: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage> & { close?: () => void; interrupt?: () => Promise<void> };

export interface ClaudeProviderDeps {
  config: Pick<
    AppConfig,
    'allowPaidApi' | 'maxBudgetUsdPerExecution' | 'claudeModel' | 'claudeCliPath' | 'maxTurnsPerExecution'
  >;
  credentials: CredentialSource;
  /** Injectable for tests; defaults to the official SDK query(). */
  queryFn?: QueryFn;
  /** Injectable local session lookup (no network). Defaults to the SDK's getSessionInfo. */
  sessionExists?: (sessionId: string, cwd: string) => Promise<boolean>;
}

/** Env vars that would let the child CLI authenticate with a subscription/other identity instead of the Console API key. */
const STRIPPED_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/**
 * Tools the model may even see (`tools`). NOTE: we deliberately do NOT use `allowedTools`: per the SDK docs
 * (and type definitions) tools in `allowedTools` are auto-approved and "never reach canUseTool", which would
 * let Bash/Write bypass our approval policy. Permission decisions are made by a PreToolUse hook (runs first,
 * and a hook deny wins over allow rules) and, as a second layer, by canUseTool.
 */
const AVAILABLE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite'];

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

async function defaultSessionExists(sessionId: string, cwd: string): Promise<boolean> {
  try {
    return !!(await getSessionInfo(sessionId, { dir: cwd })) || !!(await getSessionInfo(sessionId));
  } catch {
    // If the local lookup itself fails we cannot prove the session is missing: let the SDK try the resume.
    return true;
  }
}

export class ClaudeProvider implements ExecutionProvider {
  readonly name = 'claude';
  private readonly queryFn: QueryFn;
  private readonly sessionExists: (sessionId: string, cwd: string) => Promise<boolean>;

  constructor(private readonly deps: ClaudeProviderDeps) {
    this.queryFn = deps.queryFn ?? (sdkQuery as unknown as QueryFn);
    this.sessionExists = deps.sessionExists ?? (deps.queryFn ? async () => true : defaultSessionExists);
  }

  /** Local-only: verifies configuration and key presence. Never calls the API. */
  async preflight(): Promise<AuthReadiness> {
    const missing: string[] = [];
    const key = this.deps.credentials.getApiKey();
    if (!key) missing.push('ANTHROPIC_API_KEY (Anthropic Console API key) not set in environment or .env');
    else if (looksLikeSubscriptionToken(key))
      missing.push(
        'ANTHROPIC_API_KEY holds a subscription OAuth token; a Console API key is required for unattended runs',
      );
    if (!this.deps.config.allowPaidApi)
      missing.push('ALLOW_PAID_API=true is required to authorise paid API use');
    if (this.deps.config.maxBudgetUsdPerExecution <= 0)
      missing.push('MAX_BUDGET_USD_PER_EXECUTION must be > 0');
    return {
      ready: missing.length === 0,
      detail:
        missing.length === 0
          ? 'Console API key present, paid API use authorised with a per-execution cap (not live-verified by a request)'
          : 'not ready',
      missing,
      fingerprint: key ? fingerprint(key) : undefined,
      local: true,
    };
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    const key = this.deps.credentials.getApiKey();
    if (!key) {
      return {
        kind: 'failed',
        failure: { errorClass: 'AUTHENTICATION', message: 'ANTHROPIC_API_KEY is not configured' },
      };
    }
    if (req.resumeSessionId && !(await this.sessionExists(req.resumeSessionId, req.cwd))) {
      // Free, local detection: avoids a doomed request and lets recovery rebuild context immediately.
      return {
        kind: 'failed',
        failure: {
          errorClass: 'INVALID_SESSION',
          message: `session ${req.resumeSessionId} not found in local session storage`,
        },
      };
    }
    const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: key };
    for (const k of STRIPPED_ENV) delete env[k];

    const abort = new AbortController();
    let timedOut = false;
    let shuttingDown = false;
    const onExternalAbort = () => {
      shuttingDown = true;
      abort.abort();
    };
    if (req.signal.aborted) onExternalAbort();
    else req.signal.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, req.limits.timeoutMs);

    const denials: PermissionDenial[] = [];
    const workspace = req.cwd;

    const preToolUseHook: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {};
      const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
      const decision = evaluateToolUse(hookInput.tool_name, toolInput, workspace, {
        approvedTypes: req.approvedActionTypes,
        alsoRequire: req.alsoRequireApproval,
        readOnly: req.readOnly,
      });
      if (decision.allow) return {}; // defer to the normal permission flow (canUseTool is the second layer)
      denials.push({
        tool: hookInput.tool_name,
        reason: decision.reason,
        approvalType: decision.approvalType,
        input: toolInput,
      });
      req.onEvent({
        type: 'permission_denied',
        data: {
          tool: hookInput.tool_name,
          reason: decision.reason,
          approvalType: decision.approvalType,
          layer: 'hook',
        },
      });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${decision.reason}. Do not retry this action; record it as requiring owner approval and continue with other work.`,
        },
      };
    };

    const options: Options = {
      cwd: workspace,
      abortController: abort,
      env,
      model: this.deps.config.claudeModel,
      pathToClaudeCodeExecutable: this.deps.config.claudeCliPath,
      maxTurns: req.limits.maxTurns,
      maxBudgetUsd: req.limits.maxBudgetUsd,
      permissionMode: 'default',
      tools: req.readOnly ? READ_ONLY_TOOLS : AVAILABLE_TOOLS,
      // SDK isolation mode: load NO filesystem settings (user, project or local). Project settings can define hooks,
      // MCP servers and allow-rules; since the model can write files in its own workspace, honouring them would let it
      // grant itself permissions or run commands outside the policy. Context is supplied by the supervisor's prompt instead.
      // The owner's global ~/.claude settings and login are likewise neither read nor modified.
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemAppend },
      hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] },
      canUseTool: async (toolName, input) => {
        const decision = evaluateToolUse(toolName, input, workspace, {
          approvedTypes: req.approvedActionTypes,
          alsoRequire: req.alsoRequireApproval,
          readOnly: req.readOnly,
        });
        if (decision.allow) return { behavior: 'allow', updatedInput: input };
        denials.push({ tool: toolName, reason: decision.reason, approvalType: decision.approvalType, input });
        req.onEvent({
          type: 'permission_denied',
          data: { tool: toolName, reason: decision.reason, approvalType: decision.approvalType },
        });
        return {
          behavior: 'deny',
          message: `${decision.reason}. Do not retry this action; record it as requiring owner approval and continue with other work.`,
        };
      },
    };
    if (req.resumeSessionId) options.resume = req.resumeSessionId;

    let sessionId: string | undefined;
    let lastText = '';
    let assistantError: { code: string; text: string } | undefined;
    let rate: RateInfoLike | undefined;
    let result: Extract<SDKMessage, { type: 'result' }> | undefined;
    let sawInit = false;

    const q = this.queryFn({ prompt: req.prompt, options });
    try {
      for await (const msg of q) {
        if (
          'session_id' in msg &&
          typeof msg.session_id === 'string' &&
          msg.session_id &&
          msg.session_id !== sessionId
        ) {
          sessionId = msg.session_id;
          req.onSession(sessionId);
          req.onEvent({ type: 'session', data: { sessionId } });
        }
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              sawInit = true;
              const src = (msg as { apiKeySource?: string }).apiKeySource;
              // Guard: never silently run on a subscription identity or a different credential source.
              if (src && src !== 'ANTHROPIC_API_KEY') {
                abort.abort();
                return {
                  kind: 'failed',
                  sessionId,
                  failure: {
                    errorClass: 'AUTHENTICATION',
                    message: `Claude Code reported credential source "${src}", expected ANTHROPIC_API_KEY; refusing to run`,
                  },
                };
              }
              req.onEvent({
                type: 'status',
                data: { subtype: 'init', model: (msg as { model?: string }).model, apiKeySource: src },
              });
            } else if (msg.subtype === 'api_retry') {
              const m = msg as {
                attempt: number;
                max_retries: number;
                retry_delay_ms: number;
                error: string;
                error_status: number | null;
              };
              req.onEvent({
                type: 'retry',
                data: {
                  attempt: m.attempt,
                  max: m.max_retries,
                  delayMs: m.retry_delay_ms,
                  error: m.error,
                  status: m.error_status,
                },
              });
            }
            break;
          case 'assistant': {
            if (msg.error) assistantError = { code: msg.error, text: lastText };
            for (const block of msg.message.content as unknown as {
              type: string;
              text?: string;
              name?: string;
              id?: string;
              input?: unknown;
            }[]) {
              if (block.type === 'text' && block.text) {
                lastText = block.text;
                if (msg.error) assistantError = { code: msg.error, text: block.text };
                req.onEvent({ type: 'assistant_text', data: { chars: block.text.length } });
              } else if (block.type === 'tool_use') {
                req.onEvent({ type: 'tool_use', data: { tool: block.name, id: block.id } });
              }
            }
            break;
          }
          case 'user':
            req.onEvent({ type: 'tool_result', data: {} });
            break;
          case 'rate_limit_event': {
            const info = (msg as { rate_limit_info: RateInfoLike }).rate_limit_info;
            rate = info;
            req.onEvent({
              type: 'rate_limit',
              data: {
                status: info.status,
                type: info.rateLimitType,
                resetsAtMs: resetsAtToMs(info.resetsAt),
              },
            });
            break;
          }
          case 'result':
            result = msg;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      return {
        kind: 'failed',
        sessionId,
        failure: classifyThrown(err, { timedOut, shuttingDown }),
        denials: denials.length ? denials : undefined,
      };
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onExternalAbort);
      try {
        q.close?.();
      } catch {
        /* already closed */
      }
    }

    if (timedOut)
      return {
        kind: 'failed',
        sessionId,
        failure: { errorClass: 'TIMEOUT', message: 'execution exceeded worker timeout' },
      };
    if (shuttingDown)
      return {
        kind: 'failed',
        sessionId,
        failure: { errorClass: 'INTERRUPTED', message: 'execution interrupted by supervisor shutdown' },
      };
    if (!result) {
      const f: ProviderFailure = assistantError
        ? mapAssistantError(assistantError.code, assistantError.text, rate)
        : {
            errorClass: 'PROCESS_CRASH',
            message: sawInit ? 'stream ended without a result message' : 'Claude Code produced no output',
          };
      return { kind: 'failed', sessionId, failure: f };
    }

    const usage = extractUsage(result);
    const resultText = 'result' in result && typeof result.result === 'string' ? result.result : lastText;
    const permissionDenials = mergeDenials(
      denials,
      (result as { permission_denials?: { tool_name: string; tool_input: Record<string, unknown> }[] })
        .permission_denials,
    );

    if (result.subtype === 'error_max_budget_usd') {
      return {
        kind: 'failed',
        sessionId,
        usage,
        denials: permissionDenials,
        failure: { errorClass: 'BUDGET_EXHAUSTED', message: 'per-execution budget (maxBudgetUsd) reached' },
      };
    }
    if (result.subtype === 'error_max_turns') {
      return {
        kind: 'partial',
        sessionId,
        usage,
        summary: lastText || 'max turns reached',
        outstanding: 'work remained when the turn limit was reached',
        nextAction: 'continue from the last checkpoint',
      };
    }
    if (result.is_error || assistantError) {
      const errs = (result as { errors?: string[] }).errors?.join('; ') ?? '';
      const text = errs || resultText;
      // Prefer the documented structured error code; fall back to text patterns; otherwise a genuine task failure.
      const f: ProviderFailure = assistantError
        ? mapAssistantError(assistantError.code, assistantError.text || text, rate)
        : (classifyText(text) ?? { errorClass: 'TASK_FAILURE', message: text || result.subtype });
      return { kind: 'failed', sessionId, usage, denials: permissionDenials, failure: f };
    }
    if (permissionDenials.length > 0) {
      // Denied actions needed owner approval: surface them instead of reporting silent success.
      const needsApproval = permissionDenials.some((d) => d.approvalType);
      if (needsApproval) {
        return {
          kind: 'failed',
          sessionId,
          usage,
          denials: permissionDenials,
          summary: resultText,
          failure: {
            errorClass: 'PERMISSION_DENIED',
            message: `${permissionDenials.length} tool call(s) denied pending owner approval`,
          },
        };
      }
    }
    return {
      kind: 'completed',
      sessionId,
      usage,
      summary: resultText || 'completed',
      denials: permissionDenials.length ? permissionDenials : undefined,
    };
  }
}

function mergeDenials(
  local: PermissionDenial[],
  fromResult?: { tool_name: string; tool_input: Record<string, unknown> }[],
): PermissionDenial[] {
  const out = [...local];
  for (const d of fromResult ?? []) {
    if (
      !out.some((o) => o.tool === d.tool_name && JSON.stringify(o.input) === JSON.stringify(d.tool_input))
    ) {
      out.push({ tool: d.tool_name, reason: 'denied by permission system', input: d.tool_input });
    }
  }
  return out;
}

function extractUsage(result: Extract<SDKMessage, { type: 'result' }>): UsageInfo {
  const u = (result as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  return {
    inputTokens: u?.input_tokens,
    outputTokens: u?.output_tokens,
    turns: (result as { num_turns?: number }).num_turns,
    // total_cost_usd is a client-side ESTIMATE per the SDK docs, never recorded as billed cost.
    costUsdEstimate: (result as { total_cost_usd?: number }).total_cost_usd,
  };
}
