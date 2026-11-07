import { afterEach, describe, expect, it } from 'vitest';
import {
  providerReadiness,
  verifyApiAccess,
  installedSdkVersion,
  READINESS_LEVELS,
} from '../../src/providers/readiness.js';
import { ClaudeProvider } from '../../src/providers/claude/claude-provider.js';
import { fingerprint } from '../../src/providers/claude/credentials.js';
import type { RunRequest } from '../../src/providers/types.js';
import { makeEnv, type TestEnv } from '../helpers/env.js';

let env: TestEnv;
afterEach(() => env?.cleanup());
const creds = (key?: string) => ({ getApiKey: () => key });
const KEY = 'sk-ant-api03-TESTKEYTESTKEYTESTKEY';

describe('provider readiness report', () => {
  it('importing the SDK is NOT enough: everything else is NO / NOT_VERIFIED by default', async () => {
    env = await makeEnv();
    const r = await providerReadiness(env.config, env.store, creds(undefined));
    expect(r.levels.SDK_INSTALLED.state).toBe('YES');
    expect(r.levels.CREDENTIALS_CONFIGURED.state).toBe('NO');
    expect(r.levels.API_ACCESS_VERIFIED.state).toBe('NOT_VERIFIED');
    expect(r.levels.BUDGET_AUTHORIZED.state).toBe('NO');
    expect(r.levels.LIVE_EXECUTION_VERIFIED.state).toBe('NOT_VERIFIED');
    expect(r.levels.LIVE_RECOVERY_VERIFIED.state).toBe('NOT_VERIFIED');
    expect(r.operational).toBe(false);
    expect(r.unattendedReady).toBe(false);
    expect(r.blockers).toHaveLength(READINESS_LEVELS.length - 1);
  });

  it('credentials + budget configured still does not make the provider operational without live evidence', async () => {
    env = await makeEnv({
      env: { ALLOW_PAID_API: 'true', MAX_BUDGET_USD_PER_EXECUTION: '2', EXECUTION_PROVIDER: 'claude' },
    });
    const r = await providerReadiness(env.config, env.store, creds(KEY));
    expect(r.levels.CREDENTIALS_CONFIGURED.state).toBe('YES');
    expect(r.levels.BUDGET_AUTHORIZED.state).toBe('YES');
    expect(r.operational).toBe(false);
    expect(JSON.stringify(r)).not.toContain('TESTKEYTESTKEY'); // only a fingerprint is ever shown
  });

  it('becomes operational only after API access AND a live execution were verified; recovery is a separate level', async () => {
    env = await makeEnv({
      env: { ALLOW_PAID_API: 'true', MAX_BUDGET_USD_PER_EXECUTION: '2', EXECUTION_PROVIDER: 'claude' },
    });
    const sdk = installedSdkVersion();
    env.store.setProviderVerification('claude', 'API_ACCESS_VERIFIED', sdk, {
      fingerprint: fingerprint(KEY),
    });
    expect((await providerReadiness(env.config, env.store, creds(KEY))).operational).toBe(false);
    env.store.setProviderVerification('claude', 'LIVE_EXECUTION_VERIFIED', sdk, {});
    const r = await providerReadiness(env.config, env.store, creds(KEY));
    expect(r.operational).toBe(true);
    expect(r.unattendedReady).toBe(false);
    env.store.setProviderVerification('claude', 'LIVE_RECOVERY_VERIFIED', sdk, {});
    expect((await providerReadiness(env.config, env.store, creds(KEY))).unattendedReady).toBe(true);
  });

  it('evidence goes STALE when the SDK version or the credential changes', async () => {
    env = await makeEnv({ env: { ALLOW_PAID_API: 'true', MAX_BUDGET_USD_PER_EXECUTION: '2' } });
    env.store.setProviderVerification('claude', 'API_ACCESS_VERIFIED', installedSdkVersion(), {
      fingerprint: fingerprint(KEY),
    });
    env.store.setProviderVerification('claude', 'LIVE_EXECUTION_VERIFIED', '0.0.1-old', {});
    const r = await providerReadiness(env.config, env.store, creds('sk-ant-api03-ANOTHERKEYANOTHERKEY'));
    expect(r.levels.API_ACCESS_VERIFIED.state).toBe('STALE');
    expect(r.levels.LIVE_EXECUTION_VERIFIED.state).toBe('STALE');
    expect(r.operational).toBe(false);
  });

  it('a subscription OAuth token is never accepted as configured credentials', async () => {
    env = await makeEnv();
    const r = await providerReadiness(env.config, env.store, creds('sk-ant-oat01-abcdefghijklmnop'));
    expect(r.levels.CREDENTIALS_CONFIGURED.state).toBe('NO');
  });
});

describe('verifyApiAccess (non-billable, explicit, never automatic)', () => {
  const fakeFetch = (status: number) => (async () => ({ status }) as Response) as unknown as typeof fetch;
  it('records evidence only on HTTP 200', async () => {
    env = await makeEnv();
    expect(await verifyApiAccess(env.store, creds(KEY), fakeFetch(401))).toMatchObject({ ok: false });
    expect(env.store.getProviderVerifications('claude')['API_ACCESS_VERIFIED']).toBeUndefined();
    expect(await verifyApiAccess(env.store, creds(KEY), fakeFetch(200))).toMatchObject({ ok: true });
    expect(env.store.getProviderVerifications('claude')['API_ACCESS_VERIFIED']!.detail['fingerprint']).toBe(
      fingerprint(KEY),
    );
  });
  it('sends only a models-list request (no inference) and reports network errors without leaking the key', async () => {
    env = await makeEnv();
    let url = '';
    const spy = (async (u: string) => {
      url = u;
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const r = await verifyApiAccess(env.store, creds(KEY), spy);
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain('TESTKEY');
  });
  it('refuses with no key or a subscription token before any request', async () => {
    env = await makeEnv();
    let called = false;
    const spy = (async () => ((called = true), { status: 200 })) as unknown as typeof fetch;
    expect((await verifyApiAccess(env.store, creds(undefined), spy)).ok).toBe(false);
    expect((await verifyApiAccess(env.store, creds('sk-ant-oat01-abcdefghijkl'), spy)).ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('Claude adapter: permission enforcement against the real SDK semantics', () => {
  const cfg = {
    allowPaidApi: true,
    maxBudgetUsdPerExecution: 2,
    claudeModel: undefined,
    claudeCliPath: undefined,
    maxTurnsPerExecution: 10,
  };
  const req = (over: Partial<RunRequest> = {}): RunRequest => ({
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
    onEvent: () => undefined,
    onSession: () => undefined,
    ...over,
  });
  const done = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: 's',
    permission_denials: [],
    errors: [],
  };

  /** Captures options and lets the test invoke the PreToolUse hook exactly as the SDK would. */
  function harness(extra?: Partial<ConstructorParameters<typeof ClaudeProvider>[0]>) {
    const cap: { options?: any } = {};
    const provider = new ClaudeProvider({
      config: cfg,
      credentials: creds(KEY),
      queryFn: ((p: { options?: any }) => {
        cap.options = p.options;
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 's',
              apiKeySource: 'ANTHROPIC_API_KEY',
            } as never;
            yield done as never;
          },
          close() {},
        };
      }) as never,
      ...extra,
    });
    return { cap, provider };
  }
  const hook = (cap: { options?: any }, tool: string, input: Record<string, unknown>) =>
    cap.options.hooks.PreToolUse[0].hooks[0](
      { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input },
      'id',
      { signal: new AbortController().signal },
    );

  it('does not use allowedTools (which would bypass canUseTool) and restricts the tool set instead', async () => {
    const { cap, provider } = harness();
    await provider.run(req());
    expect(cap.options.allowedTools).toBeUndefined();
    expect(cap.options.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite']);
    expect(cap.options.permissionMode).toBe('default');
  });

  it('PreToolUse hook denies approval-gated and out-of-workspace calls (hook deny wins over any allow rule)', async () => {
    const { cap, provider } = harness();
    const events: string[] = [];
    await provider.run(req({ onEvent: (e) => events.push(`${e.type}:${String(e.data['layer'] ?? '')}`) }));
    const deny = await hook(cap, 'Bash', { command: 'git push origin main' });
    expect(deny.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(
      (await hook(cap, 'Write', { file_path: '/etc/cron.d/x' })).hookSpecificOutput.permissionDecision,
    ).toBe('deny');
    expect(await hook(cap, 'Bash', { command: 'npm test' })).toEqual({}); // allowed => defer to normal flow
    expect(events).toContain('permission_denied:hook');
  });

  it('owner-approved categories pass the hook; assignment can force web access to need approval', async () => {
    const { cap, provider } = harness();
    await provider.run(
      req({ approvedActionTypes: ['publish_release'], alsoRequireApproval: ['web_access'] }),
    );
    expect(await hook(cap, 'Bash', { command: 'npm publish' })).toEqual({});
    expect(
      (await hook(cap, 'WebFetch', { url: 'https://example.com' })).hookSpecificOutput.permissionDecision,
    ).toBe('deny');
  });

  it('a denial recorded by the hook turns an otherwise "successful" run into PERMISSION_DENIED', async () => {
    const cap: { options?: any } = {};
    const provider = new ClaudeProvider({
      config: cfg,
      credentials: creds(KEY),
      queryFn: ((p: { options?: any }) => {
        cap.options = p.options;
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 's',
              apiKeySource: 'ANTHROPIC_API_KEY',
            } as never;
            await hook(cap, 'Bash', { command: 'kubectl apply -f prod.yaml' });
            yield done as never;
          },
          close() {},
        };
      }) as never,
    });
    expect(await provider.run(req())).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'PERMISSION_DENIED' },
      denials: [{ approvalType: 'production_deploy' }],
    });
  });

  it('a missing local session is detected BEFORE any request and reported as INVALID_SESSION', async () => {
    let queried = false;
    const provider = new ClaudeProvider({
      config: cfg,
      credentials: creds(KEY),
      sessionExists: async () => false,
      queryFn: (() => ((queried = true), {})) as never,
    });
    const out = await provider.run(req({ resumeSessionId: 'gone-session' }));
    expect(out).toMatchObject({ kind: 'failed', failure: { errorClass: 'INVALID_SESSION' } });
    expect(queried).toBe(false);
  });

  it('an existing session is resumed through options.resume', async () => {
    const { cap, provider } = harness({ sessionExists: async () => true });
    await provider.run(req({ resumeSessionId: 'known' }));
    expect(cap.options.resume).toBe('known');
  });

  it('the child environment never carries subscription/alternate-provider credentials', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'sk-ant-oat01-should-be-removed';
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'x';
    try {
      const { cap, provider } = harness();
      await provider.run(req());
      expect(cap.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(cap.options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(cap.options.env.ANTHROPIC_API_KEY).toBe(KEY);
    } finally {
      delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
      delete process.env['ANTHROPIC_AUTH_TOKEN'];
    }
  });
});
