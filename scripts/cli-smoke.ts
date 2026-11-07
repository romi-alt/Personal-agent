/**
 * Live smoke test of the native Claude Code CLI provider (acceptance test 5). Uses the owner's existing
 * subscription login and makes two very small requests (haiku by default, few turns). Never uses an API key.
 *
 *   npx tsx scripts/cli-smoke.ts            # CLAUDE_CLI_PATH / CLAUDE_MODEL respected
 *
 * Verifies: subscription credential source, file write inside the workspace, policy-hook denial of `git push`
 * (with its approval type), session id persisted before launch, and `--resume` of that session.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { ClaudeCliProvider } from '../src/providers/claude-cli/cli-provider.js';
import type { ExecutionEvent, RunRequest } from '../src/providers/types.js';

const config = loadConfig({
  env: {
    ...process.env,
    EXECUTION_PROVIDER: 'claude-cli',
    CLAUDE_MODEL: process.env['CLAUDE_MODEL'] ?? 'haiku',
  },
  noEnvFile: true,
});
const provider = new ClaudeCliProvider({ config });
const ws = mkdtempSync(path.join(tmpdir(), 'elevariq-cli-smoke-'));
execFileSync('git', ['init', '-q'], { cwd: ws });

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });

async function runOnce(prompt: string, resume?: string) {
  const events: ExecutionEvent[] = [];
  let persisted: string | undefined;
  const req: RunRequest = {
    executionId: `smoke-${Date.now()}`,
    taskId: 'smoke',
    taskTitle: 'cli smoke',
    prompt,
    systemAppend: 'You are running an automated smoke test. Be brief.',
    cwd: ws,
    resumeSessionId: resume,
    approvedActionTypes: [],
    alsoRequireApproval: [],
    attemptIndex: 1,
    limits: { maxTurns: 6, timeoutMs: 300_000 },
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    onSession: (id) => (persisted ??= id),
  };
  const t0 = Date.now();
  const outcome = await provider.run(req);
  return { outcome, events, persisted, ms: Date.now() - t0 };
}

const pre = await provider.preflight();
check('preflight ready', pre.ready, pre.ready ? pre.detail : pre.missing.join('; '));
if (!pre.ready) finish();

const a = await runOnce(
  'Do exactly two things using tools: (1) create the file hello.txt containing exactly the word hello; ' +
    '(2) run the shell command `git push origin main` once (it is expected to be refused; do not retry). Then reply with the single word DONE.',
);
const init = a.events.find((e) => e.type === 'status' && e.data['subtype'] === 'init');
check(
  'init credential source is the subscription login',
  !!init && init.data['apiKeySource'] !== 'ANTHROPIC_API_KEY',
  `apiKeySource=${String(init?.data['apiKeySource'])} model=${String(init?.data['model'])} version=${String(init?.data['version'])}`,
);
check(
  'session id persisted before launch',
  !!a.persisted && a.outcome.sessionId === a.persisted,
  String(a.persisted),
);
check(
  'write inside workspace allowed',
  existsSync(path.join(ws, 'hello.txt')) &&
    readFileSync(path.join(ws, 'hello.txt'), 'utf8').trim() === 'hello',
);
const denials = 'denials' in a.outcome ? (a.outcome.denials ?? []) : [];
check(
  'git push denied by policy hook with approval type',
  denials.some((d) => d.approvalType === 'protected_branch_push'),
  JSON.stringify(denials.map((d) => ({ tool: d.tool, type: d.approvalType }))),
);
check(
  'outcome reports the pending approval (not silent success)',
  a.outcome.kind === 'failed' && a.outcome.failure.errorClass === 'PERMISSION_DENIED',
  `${a.outcome.kind}${a.outcome.kind === 'failed' ? ':' + a.outcome.failure.errorClass + ' ' + a.outcome.failure.message : ''} (${a.ms} ms)`,
);

if (a.persisted) {
  const b = await runOnce(
    'What is the name of the file you created earlier in this conversation? Reply with the file name only.',
    a.persisted,
  );
  const summary = 'summary' in b.outcome ? (b.outcome.summary ?? '') : '';
  check(
    'resume continues the same conversation',
    b.outcome.kind === 'completed' && /hello\.txt/i.test(summary),
    `${b.outcome.kind}: ${summary.slice(0, 80)} (${b.ms} ms)`,
  );
  check('resumed session id unchanged', b.outcome.sessionId === a.persisted, String(b.outcome.sessionId));
}
finish();

function finish(): never {
  for (const c of checks)
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  -- ${c.detail}` : ''}`);
  console.log(`workspace: ${ws}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
