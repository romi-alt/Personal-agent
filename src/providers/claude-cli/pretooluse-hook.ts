/**
 * PreToolUse hook command for the native Claude Code CLI provider.
 *
 * The SDK provider enforces the tool policy with an in-process callback; a separately launched `claude -p` process can
 * only call back through a hook *command*. Claude Code runs this script before every tool call with the hook payload on
 * stdin (`tool_name`, `tool_input`, ...). Usage: `node pretooluse-hook.js <policy-file>`.
 *
 * FAIL CLOSED: in Claude Code, exit code 2 blocks the tool call while any other non-zero exit code is treated as a
 * non-blocking hook error (the tool would still run). Every error path therefore exits with 2.
 *
 * The policy file is written by the provider per execution, outside the project workspace, and contains no secrets.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { evaluateToolUse } from '../../security/policy.js';

/** Non-secret variables the provider injects into every worker; recorded once per execution as evidence. */
export const WATCHDOG_VARS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS',
  'CLAUDE_CODE_RESUME_INTERRUPTED_TURN',
  'CLAUDE_CODE_RESUME_PROMPT',
];

export interface HookPolicyFile {
  workspace: string;
  approvedTypes: string[];
  alsoRequire: string[];
  readOnly: boolean;
  allowWeb?: boolean;
  /** JSONL file that receives one line per decision so the provider can report denials with their approval type. */
  decisionsFile: string;
  /** Agent-owned directories shell commands must not reference (AGENT_HOME, the agent repository). */
  protectedPaths?: string[];
}

export interface HookDecisionRecord {
  at: number;
  tool: string;
  allow: boolean;
  reason: string;
  approvalType?: string;
  input: Record<string, unknown>;
}

const DENY_SUFFIX =
  'Do not retry this action; record it as requiring owner approval and continue with other work.';

/** Pure decision logic (unit-tested): returns the stdout JSON for a deny, or null to defer to the CLI's own rules. */
export function decide(
  policy: HookPolicyFile,
  payload: { tool_name?: unknown; tool_input?: unknown },
): { record: HookDecisionRecord; stdout: string | null } {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const input =
    payload.tool_input && typeof payload.tool_input === 'object'
      ? (payload.tool_input as Record<string, unknown>)
      : {};
  if (!tool) {
    const record = {
      at: Date.now(),
      tool: '(missing)',
      allow: false,
      reason: 'hook payload had no tool_name',
      input,
    };
    return { record, stdout: denyJson(record.reason) };
  }
  const d = evaluateToolUse(tool, input, policy.workspace, {
    approvedTypes: policy.approvedTypes,
    alsoRequire: policy.alsoRequire,
    readOnly: policy.readOnly,
    allowWeb: policy.allowWeb,
    protectedPaths: policy.protectedPaths,
  });
  const record: HookDecisionRecord = {
    at: Date.now(),
    tool,
    allow: d.allow,
    reason: d.reason,
    approvalType: d.approvalType,
    input,
  };
  return { record, stdout: d.allow ? null : denyJson(`${d.reason}. ${DENY_SUFFIX}`) };
}

function denyJson(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const policyPath = process.argv[2];
  if (!policyPath) throw new Error('policy file argument missing');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as HookPolicyFile;
  const payload = JSON.parse(await readStdin()) as { tool_name?: unknown; tool_input?: unknown };
  const { record, stdout } = decide(policy, payload);
  // Recording is best-effort evidence; the decision itself must still be enforced if it fails.
  try {
    // Once per execution: the (non-secret) watchdog variables this hook inherited from the claude worker process.
    if (!existsSync(policy.decisionsFile)) {
      const watchdog = Object.fromEntries(WATCHDOG_VARS.map((k) => [k, process.env[k] ?? null]));
      appendFileSync(policy.decisionsFile, JSON.stringify({ kind: 'env', at: Date.now(), watchdog }) + '\n');
    }
    appendFileSync(policy.decisionsFile, JSON.stringify(record) + '\n');
  } catch {
    /* ignore */
  }
  if (stdout) process.stdout.write(stdout);
}

const isMain = (() => {
  const arg = process.argv[1] ?? '';
  return /pretooluse-hook\.(ts|js)$/.test(arg);
})();

if (isMain) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`ELEVARIQ policy hook failed (tool call blocked): ${String(err)}\n`);
      process.exit(2);
    },
  );
}
