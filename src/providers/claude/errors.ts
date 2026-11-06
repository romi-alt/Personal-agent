import type { ProviderFailure } from '../types.js';

/** Normalise SDK `resetsAt`: values below 1e12 are epoch seconds, otherwise milliseconds. */
export function resetsAtToMs(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? v * 1000 : v;
}

export interface RateInfoLike {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
}

/** Map documented SDKAssistantMessageError codes (+ rate-limit info) to our error classes. */
export function mapAssistantError(code: string, message: string, rate?: RateInfoLike): ProviderFailure {
  switch (code) {
    case 'rate_limit': {
      // A rejected plan-window limit (five_hour/seven_day...) is quota exhaustion with a server-provided reset.
      if (rate?.status === 'rejected' && rate.rateLimitType) {
        return {
          errorClass: 'QUOTA_EXHAUSTED',
          message: `${rate.rateLimitType} limit reached`,
          resetsAtMs: resetsAtToMs(rate.resetsAt),
          code,
        };
      }
      return { errorClass: 'RATE_LIMIT', message: message || 'rate limited', code };
    }
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'verification_required':
    case 'cloud_credential_error':
    case 'account_on_hold':
      return { errorClass: 'AUTHENTICATION', message: message || code, code };
    case 'billing_error':
      // Credits/billing problem: needs the owner; treated as quota with no reset time (conservative wait).
      return { errorClass: 'QUOTA_EXHAUSTED', message: message || 'billing error (credit balance?)', code };
    case 'overloaded':
    case 'server_error':
      return { errorClass: 'PROVIDER_OUTAGE', message: message || code, code };
    case 'invalid_request':
      return classifyText(message) ?? { errorClass: 'TASK_FAILURE', message: message || code, code };
    case 'model_not_found':
      return { errorClass: 'TASK_FAILURE', message: `model not found: ${message}`, code };
    default:
      return classifyText(message) ?? { errorClass: 'TASK_FAILURE', message: message || code, code };
  }
}

const NETWORK_RE =
  /(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|socket hang up|fetch failed|network error|getaddrinfo)/i;
const SESSION_RE =
  /(no conversation found|session.*(not found|does not exist|invalid)|invalid session|could not (find|resume).*session)/i;
const CRASH_RE =
  /(process exited with code|exited with code|terminated by signal|SIGKILL|SIGSEGV|spawn .* ENOENT|Claude Code process)/i;
const AUTH_RE = /(invalid api key|authentication|unauthorized|401|not logged in|please run \/login)/i;

export function classifyText(text: string): ProviderFailure | undefined {
  if (!text) return undefined;
  if (SESSION_RE.test(text)) return { errorClass: 'INVALID_SESSION', message: text };
  if (AUTH_RE.test(text)) return { errorClass: 'AUTHENTICATION', message: text };
  if (NETWORK_RE.test(text)) return { errorClass: 'NETWORK', message: text };
  if (CRASH_RE.test(text)) return { errorClass: 'PROCESS_CRASH', message: text };
  return undefined;
}

/** Classify an exception thrown by query()/the CLI subprocess. */
export function classifyThrown(
  err: unknown,
  ctx: { timedOut: boolean; shuttingDown: boolean },
): ProviderFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (ctx.shuttingDown)
    return { errorClass: 'INTERRUPTED', message: 'execution interrupted by supervisor shutdown' };
  if (ctx.timedOut) return { errorClass: 'TIMEOUT', message: 'execution exceeded worker timeout' };
  return classifyText(message) ?? { errorClass: 'PROCESS_CRASH', message };
}
