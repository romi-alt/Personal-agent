/**
 * OPTIONAL live verification that a Claude session can be RESUMED from a different process (spends a few cents).
 * Phase "create": a real execution writes a file and states a secret word; the session id is saved to a state file.
 * Phase "resume": a NEW process resumes that session id and must recall the word without re-reading it.
 * On success records LIVE_RECOVERY_VERIFIED. This verifies session persistence/resume, NOT provider rate-limit
 * behaviour (that cannot be triggered on demand without burning real quota).
 *   npm run smoke:live-recovery
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { openDatabase } from '../src/database/connection.js';
import { SYSTEM_APPEND } from '../src/memory/context.js';
import { ClaudeProvider } from '../src/providers/claude/claude-provider.js';
import { EnvCredentialSource } from '../src/providers/claude/credentials.js';
import { installedSdkVersion } from '../src/providers/readiness.js';
import type { RunOutcome } from '../src/providers/types.js';
import { Store } from '../src/queue/store.js';

const WORD = `ember-${Math.random().toString(36).slice(2, 8)}`;
const stateFile = process.env['SMOKE_STATE_FILE'];
const phase = process.argv[2];

const config = loadConfig();
if (config.provider !== 'claude') {
  console.error('Refusing: set EXECUTION_PROVIDER=claude.');
  process.exit(2);
}
const provider = new ClaudeProvider({ config, credentials: new EnvCredentialSource(config.envFile) });
const pre = await provider.preflight();
if (!pre.ready) {
  console.error('Refusing: preflight failed:\n - ' + pre.missing.join('\n - '));
  process.exit(2);
}
const base = {
  executionId: 'smoke-recovery',
  taskId: 'smoke-recovery',
  taskTitle: 'smoke-recovery',
  attemptIndex: 1,
  approvedActionTypes: [] as string[],
  alsoRequireApproval: [] as string[],
  systemAppend: SYSTEM_APPEND,
  limits: { maxTurns: 6, maxBudgetUsd: Math.min(config.maxBudgetUsdPerExecution, 0.5), timeoutMs: 120_000 },
  signal: new AbortController().signal,
  onEvent: () => undefined,
};

if (phase === 'create') {
  const cwd = process.env['SMOKE_CWD']!;
  mkdirSync(cwd, { recursive: true });
  let session = '';
  const out: RunOutcome = await provider.run({
    ...base,
    cwd,
    prompt: `Write the exact text "${process.env['SMOKE_WORD']}" into a file named secret.txt, then reply with one short sentence. Remember the word.`,
    onSession: (s) => (session = s),
  });
  if (out.kind !== 'completed' || !session || !existsSync(path.join(cwd, 'secret.txt'))) {
    console.error('create phase failed:', out.kind, out.kind === 'failed' ? JSON.stringify(out.failure) : '');
    process.exit(1);
  }
  writeFileSync(stateFile!, JSON.stringify({ session, cwd, word: process.env['SMOKE_WORD'] }));
  console.log('create phase ok; session captured');
  process.exit(0);
}

if (phase === 'resume') {
  const st = JSON.parse(readFileSync(stateFile!, 'utf8')) as { session: string; cwd: string; word: string };
  let resumedSession = '';
  const out: RunOutcome = await provider.run({
    ...base,
    cwd: st.cwd,
    resumeSessionId: st.session,
    prompt:
      'Without reading any file or running any tool, what was the exact word you were told to remember? Reply with only that word.',
    onSession: (s) => (resumedSession = s),
  });
  const text = out.kind === 'completed' ? out.summary : '';
  const recalled = text.includes(st.word);
  console.log(
    'resume outcome:',
    out.kind,
    '| session id preserved:',
    resumedSession === st.session,
    '| recalled word:',
    recalled,
  );
  if (out.kind === 'failed') console.log('failure:', JSON.stringify(out.failure));
  if (out.kind === 'completed' && recalled) {
    const store = new Store(openDatabase(config.databasePath));
    store.setProviderVerification('claude', 'LIVE_RECOVERY_VERIFIED', installedSdkVersion(), {
      scope: 'session resume across separate processes',
      sessionIdPreserved: resumedSession === st.session,
    });
    console.log('recorded LIVE_RECOVERY_VERIFIED');
    process.exit(0);
  }
  process.exit(1);
}

// Orchestrator: run the two phases in two separate OS processes.
const dir = mkdtempSync(path.join(tmpdir(), 'elevariq-live-recovery-'));
const env = {
  ...process.env,
  SMOKE_STATE_FILE: path.join(dir, 'state.json'),
  SMOKE_CWD: path.join(dir, 'ws'),
  SMOKE_WORD: WORD,
};
for (const p of ['create', 'resume']) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1]!, p], { env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
