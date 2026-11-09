/**
 * Secret redaction used by every log sink and by event persistence.
 * Three layers:
 *  - key-name based (any object field that looks like a secret),
 *  - value-pattern based (well-known token formats and `key=value` pairs embedded in free text),
 *  - value based: the exact values of sensitive variables in this process's environment (V2.1 Phase C), so an
 *    opaque secret with no recognizable format is still removed when an error message or stderr echoes it.
 */

const SENSITIVE_KEY =
  /(api[-_]?key|token|secret|password|passwd|authorization|credential|cookie|private[-_]?key)/i;

/** Environment variable NAMES whose values are treated as secrets (layer 3). */
const SENSITIVE_ENV_NAME =
  /(api[-_]?key|token|secret|password|passwd|credential|cookie|private[-_]?key|access[-_]?key)/i; // not PWD (a path)

const VALUE_PATTERNS: RegExp[] = [
  // PEM private keys (whole block, or up to the end of the text when truncated).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys / OAuth tokens
  /sk-[A-Za-z0-9]{20,}/g, // generic provider-style secret keys
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /Basic\s+[A-Za-z0-9+/=]{12,}/g, // HTTP basic credentials
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, // JWTs
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm tokens
  /(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)\s*[=:]\s*\S+/gi,
];

/** `scheme://user:password@host` keeps the user and host. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+):([^\s@/'"]+)@/gi;

/**
 * `password=x`, `DB_PASSWORD: x`, `"api_key":"x"` (also JSON-in-JSON `\"token\":\"x\"`) in free text. The key keeps its
 * name; only the value is replaced. Pure numbers (`max_tokens=4096`, `inputTokens: 12`) are not secrets and stay.
 */
const KEY_VALUE =
  /\b([A-Za-z0-9_.-]*(?:api[-_]?key|apikey|token|secret|passw(?:or)?d|credential|private[-_]?key|access[-_]?key)[A-Za-z0-9_.-]*)((?:\\?")?\s*[=:]\s*(?:\\?["'])?)(?!\d+\b)(?!\[REDACTED\])([^\s"'\\,;&|)}\]]{4,})/gi;

export const REDACTED = '[REDACTED]';

/** Values of sensitive environment variables (>= 8 chars), longest first. */
function sensitiveEnvValues(): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(process.env))
    if (v && v.length >= 8 && SENSITIVE_ENV_NAME.test(k) && !/^(true|false|null|undefined)$/i.test(v))
      out.add(v);
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactString(input: string): string {
  let out = input;
  for (const v of sensitiveEnvValues()) if (out.includes(v)) out = out.split(v).join(REDACTED);
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, (m) => {
      const eq = m.match(/^([A-Za-z_]+\s*[=:]\s*)/);
      return eq ? `${eq[1]}${REDACTED}` : REDACTED;
    });
  }
  out = out.replace(URL_CREDENTIALS, `$1:${REDACTED}@`);
  out = out.replace(KEY_VALUE, `$1$2${REDACTED}`);
  return out;
}

/** redactString for nullable columns. */
export function redactNullable<T extends string | null | undefined>(input: T): T {
  return (typeof input === 'string' ? redactString(input) : input) as T;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        SENSITIVE_KEY.test(k) && v !== null && v !== undefined && v !== ''
          ? REDACTED
          : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Short non-reversible fingerprint to detect that a credential changed without storing it. */
export async function fingerprintSecret(secret: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}
