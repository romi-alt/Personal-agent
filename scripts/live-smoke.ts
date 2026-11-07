/**
 * OPTIONAL real-provider smoke test (spends a small amount of real money).
 * Refuses to run unless: EXECUTION_PROVIDER=claude, ANTHROPIC_API_KEY set, ALLOW_PAID_API=true and
 * MAX_BUDGET_USD_PER_EXECUTION > 0. Runs ONE tiny task in a throwaway workspace.
 * On success it records LIVE_EXECUTION_VERIFIED (with SDK version + timestamp) in the agent database.
 *   npm run smoke:live
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { openDatabase } from '../src/database/connection.js';
import { SYSTEM_APPEND } from '../src/memory/context.js';
import { ClaudeProvider } from '../src/providers/claude/claude-provider.js';
import { EnvCredentialSource } from '../src/providers/claude/credentials.js';
import { installedSdkVersion } from '../src/providers/readiness.js';
import { Store } from '../src/queue/store.js';

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
const sessions: string[] = [];
const denials: string[] = [];
const outcome = await provider.run({
  executionId: 'smoke',
  taskId: 'smoke',
  taskTitle: 'smoke',
  cwd,
  attemptIndex: 1,
  approvedActionTypes: [],
  alsoRequireApproval: [],
  prompt:
    'Create a file named hello.txt in the current directory containing exactly the text: hello from elevariq. Then reply "done".',
  systemAppend: SYSTEM_APPEND,
  limits: { maxTurns: 6, maxBudgetUsd: Math.min(config.maxBudgetUsdPerExecution, 0.5), timeoutMs: 120_000 },
  signal: new AbortController().signal,
  onEvent: (e) => {
    events.push(e.type);
    if (e.type === 'permission_denied') denials.push(JSON.stringify(e.data));
  },
  onSession: (s) => sessions.push(s),
});
console.log('outcome kind:', outcome.kind);
if (outcome.kind === 'failed') console.log('failure:', JSON.stringify(outcome.failure));
if ('usage' in outcome && outcome.usage)
  console.log('usage (client-side ESTIMATE, not billing):', JSON.stringify(outcome.usage));
console.log('session ids captured:', sessions.join(', ') || '(none)');
const file = path.join(cwd, 'hello.txt');
const exists = existsSync(file);
console.log('artifact exists:', exists, exists ? JSON.stringify(readFileSync(file, 'utf8')) : '');
console.log('event types seen:', [...new Set(events)].join(', '));
if (denials.length) console.log('permission denials:', denials.join(' | '));

const ok = outcome.kind === 'completed' && exists && sessions.length > 0;
if (ok) {
  const store = new Store(openDatabase(config.databasePath));
  store.setProviderVerification('claude', 'LIVE_EXECUTION_VERIFIED', installedSdkVersion(), {
    sessionId: sessions[0],
    eventTypes: [...new Set(events)],
    costUsdEstimate: 'usage' in outcome ? (outcome.usage?.costUsdEstimate ?? null) : null,
  });
  console.log('recorded LIVE_EXECUTION_VERIFIED. Next: npm run smoke:live-recovery');
}
process.exit(ok ? 0 : 1);
