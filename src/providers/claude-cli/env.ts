/**
 * Environment for a native Claude Code CLI worker.
 *
 * Inherited Claude/Anthropic variables are removed and only explicitly chosen ones are set:
 *  - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN would make `claude -p` bill the API instead of the subscription
 *    ("in non-interactive mode the key is always used when present"), i.e. a silent switch to paid usage.
 *  - CLAUDE_CODE_* / CLAUDECODE / CLAUDE_PID from a parent Claude Code session (session id, messaging socket,
 *    attended flag) must not leak into an independent worker.
 *  - Bedrock/Vertex/Foundry switches would change the identity being used.
 * Kept: CLAUDE_CODE_OAUTH_TOKEN (a subscription token from `claude setup-token`, deliberately configured by the
 * owner for headless services) and CLAUDE_CONFIG_DIR (which login/config directory to use).
 */
const KEEP = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']);
const DROP = /^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_AGENT_SDK)/;

export function buildWorkerEnv(
  parent: NodeJS.ProcessEnv,
  inject: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (DROP.test(k) && !KEEP.has(k)) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(inject)) env[k] = v;
  return env;
}

/** Names (never values) of the variables that were removed, for diagnostics. */
export function strippedVariableNames(parent: NodeJS.ProcessEnv): string[] {
  return Object.keys(parent)
    .filter((k) => DROP.test(k) && !KEEP.has(k))
    .sort();
}

/** Compare dotted numeric versions: negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
