/**
 * V2.1 Phase C: redact-before-persistence, verified on the bytes that reach disk.
 *
 * Every persistence path that can carry text from a worker, a provider, QA or an exception is fed SYNTHETIC secrets in
 * many formats; afterwards the raw SQLite files (main + WAL) and every log/JSONL file under the agent home are scanned
 * for the distinctive marker inside each secret. No real secret is used or read.
 */
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { drain, makeEnv, type TestEnv } from '../helpers/env.js';
import type { ExecutionProvider, RunOutcome, RunRequest } from '../../src/providers/types.js';
import { decide, type HookPolicyFile } from '../../src/providers/claude-cli/pretooluse-hook.js';
import { redactString, redactValue } from '../../src/security/redact.js';
import { readUntrackedSafely } from '../../src/engineering/qa.js';

const OPAQUE_ENV = 'ELEVARIQ_TEST_SYNTH_SERVICE_TOKEN';
const OPAQUE_VALUE = 'SYNTHMKNNopaque9931';

export const SYNTHETIC_SECRETS: { id: string; value: string; mark: string }[] = [
  { id: 'anthropic', value: `sk-ant-oat01-SYNTHMKAA${'a'.repeat(20)}`, mark: 'SYNTHMKAA' },
  { id: 'github-classic', value: `ghp_SYNTHMKBB${'b'.repeat(27)}`, mark: 'SYNTHMKBB' },
  { id: 'github-fine-grained', value: `github_pat_11SYNTHMKCC${'c'.repeat(30)}`, mark: 'SYNTHMKCC' },
  { id: 'aws-access-key', value: 'AKIASYNTHMKDDQWERTYZ', mark: 'SYNTHMKDD' },
  { id: 'password-kv', value: 'DB_PASSWORD=SYNTHMKEEpw', mark: 'SYNTHMKEE' },
  { id: 'jwt', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SYNTHMKFFsignature', mark: 'SYNTHMKFF' },
  {
    id: 'pem-private-key',
    value:
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt SYNTHMKGG\n-----END OPENSSH PRIVATE KEY-----',
    mark: 'SYNTHMKGG',
  },
  {
    id: 'url-credentials',
    value: 'https://x-access-token:SYNTHMKHHtok@github.com/o/r.git',
    mark: 'SYNTHMKHH',
  },
  { id: 'slack', value: 'xoxb-1111-SYNTHMKII-abcdefgh', mark: 'SYNTHMKII' },
  { id: 'npm', value: `npm_SYNTHMKJJ${'j'.repeat(27)}`, mark: 'SYNTHMKJJ' },
  { id: 'bearer', value: 'Authorization: Bearer SYNTHMKKKopaque123', mark: 'SYNTHMKKK' },
  { id: 'oauth-env-assignment', value: 'CLAUDE_CODE_OAUTH_TOKEN=SYNTHMKLLvalue', mark: 'SYNTHMKLL' },
  { id: 'api-key-json-text', value: '{"api_key":"SYNTHMKMMvalue"}', mark: 'SYNTHMKMM' },
  { id: 'env-derived-opaque', value: `upstream said: ${OPAQUE_VALUE}`, mark: 'SYNTHMKNN' },
];
const BLOB = SYNTHETIC_SECRETS.map((s) => s.value).join(' | ');
const MARKS = SYNTHETIC_SECRETS.map((s) => s.mark);

/** Every file under `dir` (recursive) whose bytes contain a marker. */
function scan(dir: string): { file: string; marks: string[] }[] {
  const hits: { file: string; marks: string[] }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const f = path.join(d, e);
      const st = statSync(f);
      if (st.isDirectory()) {
        if (e === '.git' || e === 'workspaces') continue; // owner-provided project content, not agent records
        walk(f);
      } else {
        const text = readFileSync(f).toString('latin1');
        const marks = MARKS.filter((m) => text.includes(m));
        if (marks.length) hits.push({ file: path.relative(dir, f), marks });
      }
    }
  };
  walk(dir);
  return hits;
}

let env: TestEnv | undefined;
afterEach(async () => {
  delete process.env[OPAQUE_ENV];
  await env?.cleanup();
  env = undefined;
});

describe('V2.1 Phase C: redaction primitives', () => {
  it.each(SYNTHETIC_SECRETS)('redactString removes $id', (s) => {
    process.env[OPAQUE_ENV] = OPAQUE_VALUE;
    expect(redactString(`prefix ${s.value} suffix`)).not.toContain(s.mark);
  });
  it('redactValue removes every format in nested objects, arrays and Error objects', () => {
    process.env[OPAQUE_ENV] = OPAQUE_VALUE;
    const v = redactValue({ a: { b: [{ c: BLOB }] }, err: new Error(BLOB), note: BLOB });
    const s = JSON.stringify(v);
    for (const m of MARKS) expect(s).not.toContain(m);
  });
  it('keeps ordinary development text intact (no over-redaction of numbers, paths, plain words)', () => {
    const benign =
      'max_tokens=4096 inputTokens: 12 cwd=E:\\Agent\\ws tests passed 12/12; git push origin feature/x; token budget ok';
    expect(redactString(benign)).toBe(benign);
  });
});

describe('V2.1 Phase C: persisted bytes contain no synthetic secret', () => {
  it('store write paths (transitions, errors, executions, checkpoints, provider/supervisor state, approvals, evidence, events, outputs)', async () => {
    process.env[OPAQUE_ENV] = OPAQUE_VALUE;
    env = await makeEnv();
    const s = env.store;
    const t = s.enqueueTask({
      projectId: env.project.id,
      title: 'redaction',
      instructions: 'benign',
      maxRetries: 3,
    }).task;
    const c = s.claimNext({
      workerId: 'w1',
      leaseTtlMs: 60_000,
      maxConcurrent: 1,
      provider: 'mock',
      pid: process.pid,
    })!;
    s.addCheckpoint({
      projectId: env.project.id,
      taskId: t.id,
      executionId: c.execution.id,
      sessionRef: null,
      repoRef: null,
      gitDirty: null,
      completedSummary: BLOB,
      outstandingSummary: BLOB,
      testResults: BLOB,
      nextAction: BLOB,
    });
    s.endExecution(c.execution.id, {
      outcome: 'failed',
      errorClass: 'TASK_FAILURE',
      retryReason: BLOB,
      usage: { raw: { stderr: BLOB } },
      summary: BLOB,
    });
    s.transition(t.id, 'RETRY_SCHEDULED', {
      reason: `provider error: ${BLOB}`,
      patch: { lastErrorMessage: BLOB, completionEvidence: BLOB },
    });
    s.setProviderState({
      provider: 'mock',
      status: 'OK',
      blockedUntil: null,
      reason: BLOB,
      errorClass: null,
      consecutiveFailures: 0,
      credentialFingerprint: null,
    });
    s.acquireSupervisorLock('sup-1', 60_000);
    s.heartbeatSupervisor('sup-1', 'RUNNING', null, `exception: ${new Error(BLOB).message}`);
    const a = s.createApproval({
      projectId: env.project.id,
      taskId: t.id,
      actionType: 'protected_branch_push',
      description: `needs approval: ${BLOB}`,
      payload: { tool: 'Bash', input: { command: BLOB, password: 'SYNTHMKAAplain' } },
    });
    s.decideApproval(a.id, 'DENIED', 'owner-cli');
    s.addEvidence({
      projectId: env.project.id,
      taskId: t.id,
      level: 'TESTS_PASS',
      status: 'FAILED',
      summary: `QA: ${BLOB}`,
      evidence: { outputTail: BLOB, nested: { deeper: [BLOB] } },
    });
    s.recordEvent({
      type: 'test.nested',
      projectId: env.project.id,
      payload: { a: { b: [{ c: BLOB }] }, err: new Error(BLOB) as unknown as string },
    });
    s.saveTaskOutput(t.id, c.execution.id, `final answer: ${BLOB}`);
    env.log.error('provider.error', { message: BLOB, err: new Error(BLOB) });
    expect(scan(env.dir)).toEqual([]);
  });

  it('a hostile provider run (tool_use, web evidence, denials, error, summary) leaves no secret on disk', async () => {
    process.env[OPAQUE_ENV] = OPAQUE_VALUE;
    const provider: ExecutionProvider = {
      name: 'mock',
      preflight: async () => ({ ready: true, detail: 'synthetic', missing: [], local: true }),
      run: async (req: RunRequest): Promise<RunOutcome> => {
        req.onEvent({
          type: 'tool_use',
          data: { tool: 'Bash', input: { command: BLOB, password: 'p4ssSYNTHMKEE' } },
        });
        req.onEvent({
          type: 'web_evidence',
          data: { tool: 'WebFetch', urls: [`https://u:SYNTHMKHHx@example.com/?q=1`] },
        });
        req.onEvent({ type: 'status', data: { note: BLOB, err: String(new Error(BLOB)) } });
        return {
          kind: 'failed',
          failure: { errorClass: 'PERMISSION_DENIED', message: `cli stderr: ${BLOB}` },
          summary: BLOB,
          denials: [
            {
              tool: 'Bash',
              reason: `needs approval ${BLOB}`,
              approvalType: 'protected_branch_push',
              input: { command: `git push ${BLOB}` },
            },
          ],
        };
      },
    };
    env = await makeEnv({ provider });
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'hostile',
      instructions: 'benign',
      maxRetries: 3,
    }).task;
    await drain(env);
    expect(env.store.requireTask(t.id).status).toBe('WAITING_FOR_APPROVAL');
    expect(env.store.listApprovals('PENDING').map((a) => a.actionType)).toContain('protected_branch_push');
    expect(existsSync(path.join(env.dir, 'logs'))).toBe(true);
    expect(scan(env.dir)).toEqual([]);
  });
});

describe('V2.1 Phase C: hook decisions file', () => {
  it('the decision record persisted by the PreToolUse hook is redacted; the decision still sees the raw input', () => {
    process.env[OPAQUE_ENV] = OPAQUE_VALUE;
    const policy: HookPolicyFile = {
      workspace: process.cwd(),
      approvedTypes: [],
      alsoRequire: [],
      readOnly: false,
      decisionsFile: 'unused',
      protectedPaths: [],
    };
    const { record, stdout } = decide(policy, {
      tool_name: 'Bash',
      tool_input: {
        command: 'git push https://x-access-token:SYNTHMKHHtok@github.com/o/r.git HEAD:main',
        password: 'SYNTHMKEEx',
      },
    });
    expect(record.approvalType).toBe('protected_branch_push');
    expect(record.allow).toBe(false);
    // A record of a hard-denied command carrying every format is redacted too.
    const hard = decide(policy, { tool_name: 'Bash', tool_input: { command: `echo ${BLOB}` } }).record;
    for (const m of MARKS) expect(JSON.stringify(hard)).not.toContain(m);
    expect(stdout).toContain('deny');
    const s = JSON.stringify(record);
    for (const m of MARKS) expect(s).not.toContain(m);
  });
});

describe('V2.1 Phase D: QA does not follow links planted by the worker (confused deputy)', () => {
  it('junction and hard link to an owner-only file are not read; a regular new file is', async () => {
    env = await makeEnv();
    const ws = env.project.repoPath;
    const owner = path.join(env.dir, 'owner-only');
    mkdirSync(owner, { recursive: true });
    writeFileSync(path.join(owner, 'credentials.json'), '{"token":"SYNTHMKAAowner"}');
    writeFileSync(path.join(ws, 'regular.txt'), 'hello');
    let junction = false;
    if (process.platform === 'win32') {
      execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(ws, 'leakdir'), owner], {
        stdio: 'ignore',
      });
      junction = true;
    }
    linkSync(path.join(owner, 'credentials.json'), path.join(ws, 'notes.json'));
    expect(readUntrackedSafely(ws, 'regular.txt')).toEqual({ ok: true, text: 'hello' });
    expect(readUntrackedSafely(ws, 'notes.json')).toMatchObject({ ok: false, why: 'hard link' });
    if (junction)
      // Rejected by the canonical (realpath) containment check before the explicit realpath comparison.
      expect(readUntrackedSafely(ws, 'leakdir/credentials.json')).toMatchObject({ ok: false });
    expect(readUntrackedSafely(ws, '../owner-only/credentials.json')).toMatchObject({ ok: false });
  });
});
