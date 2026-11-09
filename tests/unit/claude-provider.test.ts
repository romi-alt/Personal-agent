import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { ClaudeProvider } from '../../src/providers/claude/claude-provider.js';
import { mapAssistantError, resetsAtToMs, classifyThrown } from '../../src/providers/claude/errors.js';
import type { RunRequest } from '../../src/providers/types.js';

/**
 * These tests drive the adapter with a scripted message stream shaped like the documented SDK types.
 * They verify mapping logic only; they are NOT evidence of live Anthropic behaviour.
 */
const cfg = {
  allowPaidApi: true,
  maxBudgetUsdPerExecution: 2,
  claudeModel: undefined,
  claudeCliPath: undefined,
  maxTurnsPerExecution: 10,
};
const creds = (key?: string) => ({ getApiKey: () => key });
const baseReq = (over: Partial<RunRequest> = {}): RunRequest & { events: string[]; sessions: string[] } => {
  const events: string[] = [];
  const sessions: string[] = [];
  return {
    executionId: 'e',
    taskId: 't',
    taskTitle: 't',
    prompt: 'p',
    systemAppend: 's',
    cwd: '/tmp/ws',
    approvedActionTypes: [],
    alsoRequireApproval: [],
    attemptIndex: 1,
    limits: { maxTurns: 5, maxBudgetUsd: 2, timeoutMs: 5000 },
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e.type),
    onSession: (s) => sessions.push(s),
    events,
    sessions,
    ...over,
  };
};
const stream = (msgs: unknown[], capture?: { options?: any }) => (params: { options?: any }) => {
  if (capture) capture.options = params.options;
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) yield m as never;
    },
    close() {},
  } as never;
};
const init = (src = 'ANTHROPIC_API_KEY') => ({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  apiKeySource: src,
  model: 'm',
});
const okResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'all done',
  session_id: 'sess-1',
  num_turns: 3,
  total_cost_usd: 0.12,
  usage: { input_tokens: 10, output_tokens: 5 },
  permission_denials: [],
  errors: [],
};

describe('ClaudeProvider preflight (local only)', () => {
  it('is not ready without a key, paid-API authorisation, or a budget cap, and never leaks the key', async () => {
    const p = new ClaudeProvider({
      config: { ...cfg, allowPaidApi: false, maxBudgetUsdPerExecution: 0 },
      credentials: creds(undefined),
    });
    const r = await p.preflight();
    expect(r.ready).toBe(false);
    expect(r.local).toBe(true);
    expect(r.missing.join(' ')).toMatch(/ANTHROPIC_API_KEY/);
    expect(r.missing.join(' ')).toMatch(/ALLOW_PAID_API/);
    expect(r.missing.join(' ')).toMatch(/MAX_BUDGET/);
    const ready = await new ClaudeProvider({
      config: cfg,
      credentials: creds('sk-ant-api03-REALLYSECRETKEY1234'),
    }).preflight();
    expect(ready.ready).toBe(true);
    expect(JSON.stringify(ready)).not.toContain('REALLYSECRET');
  });
  it('refuses a subscription OAuth token as the unattended credential', async () => {
    const r = await new ClaudeProvider({
      config: cfg,
      credentials: creds('sk-ant-oat01-abcdefghijkl'),
    }).preflight();
    expect(r.ready).toBe(false);
    expect(r.missing.join(' ')).toMatch(/subscription/);
  });
});

describe('ClaudeProvider run mapping', () => {
  const mk = (msgs: unknown[], capture?: { options?: any }) =>
    new ClaudeProvider({
      config: cfg,
      credentials: creds('sk-ant-api03-KEYKEYKEYKEYKEY'),
      queryFn: stream(msgs, capture),
    });

  it('maps success, captures session id immediately, passes safe options', async () => {
    const cap: { options?: any } = {};
    const req = baseReq({ resumeSessionId: 'old-sess' });
    const out = await mk(
      [
        init(),
        {
          type: 'assistant',
          session_id: 'sess-1',
          message: { content: [{ type: 'text', text: 'working' }] },
        },
        okResult,
      ],
      cap,
    ).run(req);
    expect(out).toMatchObject({ kind: 'completed', sessionId: 'sess-1', summary: 'all done' });
    expect(req.sessions).toEqual(['sess-1']);
    expect(cap.options.resume).toBe('old-sess');
    expect(cap.options.permissionMode).toBe('default');
    // Regression: allowedTools would auto-approve tools and bypass canUseTool, so it must not be set.
    expect(cap.options.allowedTools).toBeUndefined();
    // Regression: workspace .claude/settings.json (hooks/MCP/allow rules) must never be honoured.
    expect(cap.options.settingSources).toEqual([]);
    expect(cap.options.tools).toEqual(expect.arrayContaining(['Bash', 'Write']));
    expect(cap.options.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(cap.options.permissionMode).not.toBe('bypassPermissions');
    expect(cap.options.maxBudgetUsd).toBe(2);
    expect(cap.options.cwd).toBe('/tmp/ws');
    expect(cap.options.env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-api03/);
    expect(cap.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    if (out.kind === 'completed') expect(out.usage).toMatchObject({ costUsdEstimate: 0.12, turns: 3 });
  });
  it('reports estimated cost as an estimate, never as billed cost', async () => {
    const out = await mk([init(), okResult]).run(baseReq());
    expect(out.kind === 'completed' && out.usage?.costUsdBilled).toBeFalsy();
  });
  it('refuses to run if the CLI reports a non-API-key credential source', async () => {
    const out = await mk([init('none')]).run(baseReq());
    expect(out).toMatchObject({ kind: 'failed', failure: { errorClass: 'AUTHENTICATION' } });
  });
  it('maps a rejected plan-window limit to QUOTA_EXHAUSTED with the provider reset time', async () => {
    const reset = Math.floor(Date.now() / 1000) + 7200;
    const out = await mk([
      init(),
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset },
      },
      {
        type: 'assistant',
        session_id: 'sess-1',
        error: 'rate_limit',
        message: { content: [{ type: 'text', text: 'limit reached' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'limit reached',
        session_id: 'sess-1',
        errors: [],
        permission_denials: [],
      },
    ]).run(baseReq());
    expect(out).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'QUOTA_EXHAUSTED', resetsAtMs: reset * 1000 },
    });
  });
  it('maps a bare rate_limit error (no window info) to short-lived RATE_LIMIT', async () => {
    const out = await mk([
      init(),
      {
        type: 'assistant',
        error: 'rate_limit',
        session_id: 'sess-1',
        message: { content: [{ type: 'text', text: 'slow down' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'slow down',
        session_id: 'sess-1',
        errors: [],
        permission_denials: [],
      },
    ]).run(baseReq());
    expect(out).toMatchObject({ kind: 'failed', failure: { errorClass: 'RATE_LIMIT' } });
  });
  it('maps authentication, overload, budget, max-turns and generic error results distinctly', async () => {
    const errResult = (subtype: string, extra: object = {}) => ({
      type: 'result',
      subtype,
      is_error: true,
      session_id: 'sess-1',
      errors: ['boom'],
      permission_denials: [],
      total_cost_usd: 1,
      ...extra,
    });
    const asst = (error: string) => ({
      type: 'assistant',
      error,
      session_id: 'sess-1',
      message: { content: [{ type: 'text', text: 'e' }] },
    });
    expect(
      await mk([init(), asst('authentication_failed'), errResult('success')]).run(baseReq()),
    ).toMatchObject({ failure: { errorClass: 'AUTHENTICATION' } });
    expect(await mk([init(), asst('overloaded'), errResult('success')]).run(baseReq())).toMatchObject({
      failure: { errorClass: 'PROVIDER_OUTAGE' },
    });
    expect(await mk([init(), errResult('error_max_budget_usd')]).run(baseReq())).toMatchObject({
      failure: { errorClass: 'BUDGET_EXHAUSTED' },
    });
    expect(await mk([init(), errResult('error_max_turns')]).run(baseReq())).toMatchObject({
      kind: 'partial',
    });
    expect(await mk([init(), errResult('error_during_execution')]).run(baseReq())).toMatchObject({
      failure: { errorClass: 'TASK_FAILURE' },
    });
  });
  it('surfaces permission denials that need approval instead of reporting silent success', async () => {
    const out = await mk([
      init(),
      {
        ...okResult,
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 'u', tool_input: { command: 'npm publish' } }],
      },
    ]).run(baseReq());
    expect(out.kind).toBe('completed'); // denial from the SDK alone has no approval type
    const cap: { options?: any } = {};
    const p = new ClaudeProvider({
      config: cfg,
      credentials: creds('sk-ant-api03-KEYKEYKEYKEYKEY'),
      queryFn: ((params: { options?: any }) => ({
        async *[Symbol.asyncIterator]() {
          cap.options = params.options;
          yield init() as never;
          await params.options.canUseTool(
            'Bash',
            { command: 'npm publish' },
            { signal: new AbortController().signal },
          );
          yield okResult as never;
        },
        close() {},
      })) as never,
    });
    const r = await p.run(baseReq());
    expect(r).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'PERMISSION_DENIED' },
      denials: [{ tool: 'Bash', approvalType: 'publish_release' }],
    });
  });
  it('canUseTool denies out-of-workspace writes and allows in-workspace work', async () => {
    const cap: { options?: any } = {};
    await mk([init(), okResult], cap).run(baseReq());
    const sig = { signal: new AbortController().signal };
    expect((await cap.options.canUseTool('Write', { file_path: '/etc/hosts' }, sig)).behavior).toBe('deny');
    expect((await cap.options.canUseTool('Write', { file_path: '/tmp/ws/a.ts' }, sig)).behavior).toBe(
      'allow',
    );
    expect((await cap.options.canUseTool('Bash', { command: 'git push' }, sig)).behavior).toBe('deny');
    // Agent-control guard and protected agent repository path, same as the CLI provider.
    const repo = path.resolve(__dirname, '../..');
    for (const command of ['npm run agent -- approve apr_abcdefgh12', `cat "${path.join(repo, '.env')}"`]) {
      expect((await cap.options.canUseTool('Bash', { command }, sig)).behavior, command).toBe('deny');
      const hook = await cap.options.hooks.PreToolUse[0].hooks[0]({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      });
      expect(JSON.stringify(hook), command).toContain('deny');
    }
  });
  it('classifies thrown errors: crash, network, timeout, shutdown, invalid session', async () => {
    const thrower = (e: Error) =>
      new ClaudeProvider({
        config: cfg,
        credentials: creds('sk-ant-api03-KEYKEYKEYKEYKEY'),
        queryFn: (() => ({
          async *[Symbol.asyncIterator]() {
            throw e;
            yield 1 as never;
          },
          close() {},
        })) as never,
      });
    expect(await thrower(new Error('Claude Code process exited with code 1')).run(baseReq())).toMatchObject({
      failure: { errorClass: 'PROCESS_CRASH' },
    });
    expect(await thrower(new Error('fetch failed: ECONNRESET')).run(baseReq())).toMatchObject({
      failure: { errorClass: 'NETWORK' },
    });
    expect(
      await thrower(new Error('No conversation found with session ID: abc')).run(baseReq()),
    ).toMatchObject({ failure: { errorClass: 'INVALID_SESSION' } });
    expect(classifyThrown(new Error('x'), { timedOut: true, shuttingDown: false }).errorClass).toBe(
      'TIMEOUT',
    );
    expect(classifyThrown(new Error('x'), { timedOut: false, shuttingDown: true }).errorClass).toBe(
      'INTERRUPTED',
    );
  });
  it('without a key it fails as AUTHENTICATION and never starts a query', async () => {
    let called = false;
    const p = new ClaudeProvider({
      config: cfg,
      credentials: creds(undefined),
      queryFn: (() => {
        called = true;
        return {} as never;
      }) as never,
    });
    expect(await p.run(baseReq())).toMatchObject({ failure: { errorClass: 'AUTHENTICATION' } });
    expect(called).toBe(false);
  });
});

describe('error helpers', () => {
  it('normalises reset timestamps in seconds or milliseconds', () => {
    expect(resetsAtToMs(1_900_000_000)).toBe(1_900_000_000_000);
    expect(resetsAtToMs(1_900_000_000_000)).toBe(1_900_000_000_000);
    expect(resetsAtToMs(undefined)).toBeUndefined();
  });
  it('maps documented assistant error codes', () => {
    expect(mapAssistantError('billing_error', '').errorClass).toBe('QUOTA_EXHAUSTED');
    expect(mapAssistantError('server_error', '').errorClass).toBe('PROVIDER_OUTAGE');
    expect(mapAssistantError('model_not_found', 'x').errorClass).toBe('TASK_FAILURE');
  });
});

describe('success claimed despite denied tool calls', () => {
  it('surfaces denials on a completed outcome so the worker can flag possibly-incomplete work', async () => {
    const provider = new ClaudeProvider({
      config: cfg,
      credentials: creds('sk-ant-api03-KEYKEYKEYKEYKEY'),
      queryFn: stream([
        init(),
        {
          ...okResult,
          permission_denials: [{ tool_name: 'Write', tool_use_id: 'u', tool_input: { file_path: '/etc/x' } }],
        },
      ]),
    });
    const out = await provider.run(baseReq());
    expect(out).toMatchObject({ kind: 'completed', denials: [{ tool: 'Write' }] });
  });
});
