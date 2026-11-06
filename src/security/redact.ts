/**
 * Secret redaction used by every log sink and by event persistence.
 * Two layers: key-name based (any field that looks like a secret) and
 * value-pattern based (well-known token formats embedded in free text).
 */

const SENSITIVE_KEY =
  /(api[-_]?key|token|secret|password|passwd|authorization|credential|cookie|private[-_]?key)/i;

const VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys / OAuth tokens
  /sk-[A-Za-z0-9]{20,}/g, // generic provider-style secret keys
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)\s*[=:]\s*\S+/gi,
];

export const REDACTED = '[REDACTED]';

export function redactString(input: string): string {
  let out = input;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, (m) => {
      const eq = m.match(/^([A-Za-z_]+\s*[=:]\s*)/);
      return eq ? `${eq[1]}${REDACTED}` : REDACTED;
    });
  }
  return out;
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
