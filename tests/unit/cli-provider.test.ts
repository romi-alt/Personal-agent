import { describe, expect, it } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { loadConfig } from '../../src/config/index.js';
import { ClaudeCliProvider, type CliDeps } from '../../src/providers/claude-cli/cli-provider.js';
import { buildWorkerEnv, compareVersions } from '../../src/providers/claude-cli/env.js';
import { decide } from '../../src/providers/claude-cli/pretooluse-hook.js';
import type { ExecutionEvent, RunRequest } from '../../src/providers/types.js';

/** Scripted stand-in for `claude -p --output-format stream-json`. Never spawns anything. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  prompt = '';
  stdin = new Writable({
    write: (c: Buffer, _e, cb) => {
      this.prompt += c.toString();
      cb();
    },
  });
  pid = 999_999;
  exitCode: number | null = null;
  emitLine(o: unknown) {
    this.stdout.write(JSON.stringify(o) + '\n');
  }
  exit(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => this.emit('close', code), 5);
  }
}

const home = mkdtempSync(path.join(tmpdir(), 'cli-prov-'));
const ws = mkdtempSync(path.join(tmpdir(), 'cli-ws-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(
  script: (c: FakeChild) => void | Promise<void>,
  over: Partial<CliDeps> = {},
  env: Record<string, string> = {},
) {
  const config = loadConfig({
    noEnvFile: true,
    env: { AGENT_HOME: home, EXECUTION_PROVIDER: 'claude-cli', CLAUDE_CLI_STALL_TIMEOUT_MS: '10000', ...env },
  });
  const calls: { cmd: string; args: string[]; env: Record<string, string>; child: FakeChild }[] = [];
  const provider = new ClaudeCliProvider({
    config,
    tickMs: 50,
    parentEnv: {
      PATH: 'x',
      ANTHROPIC_API_KEY: 'sk-ant-api-should-never-reach-the-worker',
      ANTHROPIC_AUTH_TOKEN: 'nope',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDECODE: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
    },
    terminateFn: (c) => (c as unknown as FakeChild).exit(143),
    spawnFn: (cmd, args, o) => {
      const child = new FakeChild();
      calls.push({ cmd, args, env: o.env, child });
      setTimeout(() => void script(child), 5);
      return child as unknown as ChildProcess;
    },
    ...over,
  });
  const events: ExecutionEvent[] = [];
  const sessions: string[] = [];
  const pids: (number | null)[] = [];
  const req = (o: Partial<RunRequest> = {}): RunRequest => ({
    executionId: `ex-${Math.random().toString(36).slice(2)}`,
    taskId: 't',
    taskTitle: 'T',
    prompt: 'do the task',
    systemAppend: 'rules',
    cwd: ws,
    approvedActionTypes: [],
    alsoRequireApproval: [],
    attemptIndex: 1,
    limits: { maxTurns: 7, timeoutMs: 60_000 },
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    onSession: (id) => sessions.push(id),
    onProcess: (p) => pids.push(p),
    ...o,
  });
  return { provider, calls, events, sessions, pids, req };
}

const init = (src = 'none') => ({
  type: 'system',
  subtype: 'init',
  session_id: 's',
  apiKeySource: src,
  model: 'm',
});
const text = (t: string) => ({
  type: 'assistant',
  session_id: 's',
  message: { content: [{ type: 'text', text: t }] },
});
const success = (t = 'all done') => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: t,
  session_id: 's',
  num_turns: 2,
  usage: { input_tokens: 10, output_tokens: 5 },
  total_cost_usd: 0.01,
});

describe('ClaudeCliProvider: launch contract', () => {
  it('launches print mode with stream-json, a pre-assigned session id, isolated settings and the watchdog env', async () => {
    const s = setup((c) => {
      c.emitLine(init());
      c.emitLine(text('ok'));
      c.emitLine(success());
      c.exit(0);
    });
    const out = await s.provider.run(s.req());
    expect(out.kind).toBe('completed');
    const { args, env, child } = s.calls[0]!;
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    const sid = args[args.indexOf('--session-id') + 1]!;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.sessions[0]).toBe(sid); // persisted before the process produced any output
    expect(out.sessionId).toBe(sid);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('7');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(child.prompt).toBe('do the task'); // prompt on stdin, not the command line
    // paid-API and parent-session variables never reach the worker; subscription token and watchdog do
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(env['CLAUDE_CODE_SESSION_ID']).toBeUndefined();
    expect(env['CLAUDECODE']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('subscription-token');
    expect(env['CLAUDE_CODE_RETRY_WATCHDOG']).toBe('1');
    expect(env['CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS']).toBe('300000');
    expect(env['CLAUDE_CODE_RESUME_INTERRUPTED_TURN']).toBe('1');
    expect(env['CLAUDE_CODE_RESUME_PROMPT']).toMatch(/latest durable checkpoint/);
    expect(s.pids).toEqual([999_999, null]);
    expect(out.kind === 'completed' && out.usage?.raw).toEqual({ billing: 'subscription' });
  });

  it('resumes an existing session with --resume and does not invent a new id', async () => {
    const s = setup((c) => {
      c.emitLine(init());
      c.emitLine(success());
      c.exit(0);
    });
    const out = await s.provider.run(s.req({ resumeSessionId: '11111111-2222-3333-4444-555555555555' }));
    const args = s.calls[0]!.args;
    expect(args[args.indexOf('--resume') + 1]).toBe('11111111-2222-3333-4444-555555555555');
    expect(args).not.toContain('--session-id');
    expect(out.sessionId).toBe('11111111-2222-3333-4444-555555555555');
  });
});

describe('ClaudeCliProvider: capacity waits are not stalls and not completion', () => {
  it('a usage-limit wait suspends the execution timeout; the same process continues when capacity returns', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const s = setup(
      async (c) => {
        c.emitLine(init());
        c.emitLine({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt },
        });
        c.emitLine({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 300,
          retry_delay_ms: 300000,
          error: 'rate_limit',
          error_status: 429,
        });
        await sleep(900); // silent for longer than both the execution timeout and the stall timeout
        c.emitLine(text('capacity is back, continuing'));
        c.emitLine(success('finished after the reset'));
        c.exit(0);
      },
      {},
      { CLAUDE_CLI_STALL_TIMEOUT_MS: '10000' },
    );
    const out = await s.provider.run(s.req({ limits: { maxTurns: 5, timeoutMs: 300 } }));
    expect(out).toMatchObject({ kind: 'completed', summary: 'finished after the reset' });
    expect(s.calls).toHaveLength(1); // no duplicate request/process
    const waits = s.events.filter((e) => e.type === 'capacity_wait');
    expect(waits.map((w) => w.data['waiting'])).toEqual([true, false]);
    expect(waits[0]!.data['resetsAtMs']).toBe(resetsAt * 1000);
    expect(typeof waits[0]!.data['recheckAtMs']).toBe('number');
  });

  it('outside a capacity wait the execution timeout applies (TIMEOUT), not success', async () => {
    const s = setup(
      async (c) => {
        c.emitLine(init());
        await sleep(5000);
      },
      {},
      { CLAUDE_CLI_STALL_TIMEOUT_MS: '10000' },
    );
    const p = new ClaudeCliProvider({ ...(s.provider as unknown as { d: CliDeps }).d });
    const out = await p.run(s.req({ limits: { maxTurns: 5, timeoutMs: 250 } }));
    expect(out).toMatchObject({ kind: 'failed', failure: { errorClass: 'TIMEOUT' } });
  });

  it('an optional capacity-wait ceiling ends the wait as QUOTA_EXHAUSTED with the server reset time, session kept', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    const s = setup(
      async (c) => {
        c.emitLine(init());
        c.emitLine({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt },
        });
        await sleep(3000);
      },
      {},
      { CLAUDE_CLI_MAX_CAPACITY_WAIT_MS: '200' },
    );
    const out = await s.provider.run(s.req());
    expect(out).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'QUOTA_EXHAUSTED', resetsAtMs: resetsAt * 1000 },
    });
    expect(out.sessionId).toBe(s.sessions[0]);
  });

  it('a usage-limit result (watchdog off) is QUOTA_EXHAUSTED, never completion', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 600;
    const s = setup(
      (c) => {
        c.emitLine(init());
        c.emitLine({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt },
        });
        c.emitLine({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ["You've hit your limit"],
          session_id: 's',
        });
        c.exit(1);
      },
      {},
      { CLAUDE_CODE_RETRY_WATCHDOG: 'false' },
    );
    const out = await s.provider.run(s.req());
    expect(out).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'QUOTA_EXHAUSTED', resetsAtMs: resetsAt * 1000 },
    });
    expect(s.calls[0]!.env['CLAUDE_CODE_RETRY_WATCHDOG']).toBe('0');
  });
});

describe('ClaudeCliProvider: authentication and failures', () => {
  it('refuses to run when Claude Code reports a non-subscription credential source', async () => {
    const s = setup(async (c) => {
      c.emitLine(init('ANTHROPIC_API_KEY'));
      await sleep(2000);
      c.emitLine(success());
    });
    const out = await s.provider.run(s.req());
    expect(out).toMatchObject({ kind: 'failed', failure: { errorClass: 'AUTHENTICATION' } });
    expect(out.kind === 'failed' && out.failure.message).toMatch(/no silent switch to API billing/);
  });

  it('classifies a not-logged-in exit as AUTHENTICATION and a silent crash as PROCESS_CRASH', async () => {
    const a = setup((c) => {
      c.stderr.write('Not logged in · Please run /login\n');
      c.exit(1);
    });
    expect(await a.provider.run(a.req())).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'AUTHENTICATION' },
    });
    const b = setup((c) => c.exit(3));
    expect(await b.provider.run(b.req())).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'PROCESS_CRASH' },
    });
  });

  it('a missing resumed session is INVALID_SESSION so recovery can rebuild context', async () => {
    const s = setup((c) => {
      c.stderr.write('No conversation found with session ID: abc\n');
      c.exit(1);
    });
    expect(await s.provider.run(s.req({ resumeSessionId: 'abc' }))).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'INVALID_SESSION' },
    });
  });

  it('max turns is a partial result to continue, and shutdown is INTERRUPTED', async () => {
    const a = setup((c) => {
      c.emitLine(init());
      c.emitLine({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], session_id: 's' });
      c.exit(1);
    });
    expect((await a.provider.run(a.req())).kind).toBe('partial');
    const ctl = new AbortController();
    const b = setup(async (c) => {
      c.emitLine(init());
      await sleep(3000);
    });
    setTimeout(() => ctl.abort(), 100);
    expect(await b.provider.run(b.req({ signal: ctl.signal }))).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'INTERRUPTED' },
    });
  });

  it('preflight: requires a subscription login and the verified minimum version; no secrets in the detail', async () => {
    const mk = (version: string, auth: Record<string, unknown> | null) =>
      setup(() => undefined, { probe: async () => ({ version, auth: auth as never }) }).provider.preflight();
    const ok = await mk('2.1.319', {
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      orgId: 'o1',
    });
    expect(ok.ready).toBe(true);
    expect(ok.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect((await mk('2.1.100', { loggedIn: true, authMethod: 'claude.ai' })).missing.join()).toMatch(
      /older than 2\.1\.319/,
    );
    expect((await mk('2.1.319', { loggedIn: false })).missing.join()).toMatch(/not logged in/);
    expect((await mk('2.1.319', { loggedIn: true, authMethod: 'api_key' })).missing.join()).toMatch(
      /never uses API billing/,
    );
    expect(
      (
        await mk('2.1.319', {
          loggedIn: true,
          authMethod: 'claude.ai',
          loginExpiresAt: '2001-01-01T00:00:00Z',
        })
      ).missing.join(),
    ).toMatch(/expired/);
  });
});

describe('policy hook command', () => {
  const policy = {
    workspace: ws,
    approvedTypes: [],
    alsoRequire: [],
    readOnly: false,
    decisionsFile: path.join(home, 'd.jsonl'),
  };
  it('denies approval-gated commands and out-of-workspace writes, defers allowed calls to the CLI', () => {
    const push = decide(policy, { tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
    expect(push.record).toMatchObject({ allow: false, approvalType: 'protected_branch_push' });
    expect(JSON.parse(push.stdout!).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decide(policy, { tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }).stdout).toBeNull();
    expect(
      decide(policy, { tool_name: 'Write', tool_input: { file_path: path.join(home, 'x') } }).record.allow,
    ).toBe(false);
    expect(
      decide({ ...policy, readOnly: true }, { tool_name: 'Edit', tool_input: { file_path: 'a' } }).record
        .allow,
    ).toBe(false);
    expect(decide(policy, { tool_input: {} }).record.allow).toBe(false);
  });
  it('fails closed: a broken invocation exits 2 (blocking), never 0 or 1', () => {
    const script = path.resolve(__dirname, '../../src/providers/claude-cli/pretooluse-hook.ts');
    const missing = spawnSync(
      process.execPath,
      ['--import', 'tsx', script, path.join(home, 'no-such-policy.json')],
      {
        input: '{"tool_name":"Bash","tool_input":{"command":"ls"}}',
        encoding: 'utf8',
      },
    );
    expect(missing.status).toBe(2);
    const pf = path.join(home, 'p.json');
    writeFileSync(pf, JSON.stringify(policy));
    const garbage = spawnSync(process.execPath, ['--import', 'tsx', script, pf], {
      input: 'not json',
      encoding: 'utf8',
    });
    expect(garbage.status).toBe(2);
    const deny = spawnSync(process.execPath, ['--import', 'tsx', script, pf], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm publish' } }),
      encoding: 'utf8',
    });
    expect(deny.status).toBe(0);
    expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('worker env helpers', () => {
  it('strips every inherited Claude/Anthropic variable except the subscription token and config dir', () => {
    const env = buildWorkerEnv(
      { ANTHROPIC_BASE_URL: 'x', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: 'd', HOME: 'h' },
      { CLAUDE_CODE_RETRY_WATCHDOG: '1' },
    );
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: 'd', HOME: 'h', CLAUDE_CODE_RETRY_WATCHDOG: '1' });
  });
  it('compares versions numerically', () => {
    expect(compareVersions('2.1.319', '2.1.319')).toBe(0);
    expect(compareVersions('2.1.40', '2.1.319')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
  });
});
