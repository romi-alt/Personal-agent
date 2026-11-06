/**
 * OPTIONAL real-provider smoke test (spends a small amount of real money).
 * Refuses to run unless: EXECUTION_PROVIDER=claude, ANTHROPIC_API_KEY set, ALLOW_PAID_API=true and
 * MAX_BUDGET_USD_PER_EXECUTION > 0. Runs ONE tiny task in a throwaway workspace.
 *   npm run smoke:live
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { ClaudeProvider } from '../src/providers/claude/claude-provider.js';
import { EnvCredentialSource } from '../src/providers/claude/credentials.js';
import { SYSTEM_APPEND } from '../src/memory/context.js';

const config = loadConfig();
if (config.provider !== 'claude') {
  console.error('Refusing: set EXECUTION_PROVIDER=claude to run the live smoke test.');
  process.exit(2);
}
const provider = new ClaudeProvider({ config, credentials: new EnvCredentialSource(config.envFile) });
const pre = await provider.preflight();
if (!pre.ready) {
  console.error('Refusing: authentication/budget preflight failed:\n - ' + pre.missing.join('\n - '));
  process.exit(2);
}
const cwd = mkdtempSync(path.join(tmpdir(), 'elevariq-live-smoke-'));
const events: string[] = [];
const outcome = await provider.run({
  executionId: 'smoke',
  taskId: 'smoke',
  taskTitle: 'smoke',
  cwd,
  attemptIndex: 1,
  approvedActionTypes: [],
  prompt:
    'Create a file named hello.txt in the current directory containing exactly the text: hello from elevariq. Then reply "done".',
  systemAppend: SYSTEM_APPEND,
  limits: { maxTurns: 6, maxBudgetUsd: Math.min(config.maxBudgetUsdPerExecution, 0.5), timeoutMs: 120_000 },
  signal: new AbortController().signal,
  onEvent: (e) => events.push(e.type),
  onSession: (s) => console.log('session id captured:', s),
});
console.log('outcome:', JSON.stringify(outcome, null, 2));
const file = path.join(cwd, 'hello.txt');
console.log(
  'artifact exists:',
  existsSync(file),
  existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : '',
);
console.log('event types seen:', [...new Set(events)].join(', '));
process.exit(outcome.kind === 'completed' && existsSync(file) ? 0 : 1);
