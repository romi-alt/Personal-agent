import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { loadConfig } from '../../src/config/index.js';
import { ActiveTimeMeter } from '../../src/core/active-clock.js';
import { ClaudeCliProvider } from '../../src/providers/claude-cli/cli-provider.js';
import type { ExecutionEvent, RunRequest } from '../../src/providers/types.js';
import { capacityEscalation, capacityStreakSince } from '../../src/recovery/capacity-escalation.js';
import { decide } from '../../src/recovery/decide.js';
import type { ExecutionRecord, ProviderState, Task } from '../../src/types/index.js';

/**
 * Regression tests for the pilot's D4 timing defects (TIMEOUT_INVESTIGATION_D4.md):
 *  A10 - after a usage-limit reset passed while the host slept, the in-process wait kept going for hours;
 *  A11 - host sleep was charged to the execution budget (false TIMEOUT 15 s after wake, retry consumed);
 *  A12 - the in-process capacity wait had no ceiling.
 * Host sleep is simulated deterministically: the injected clock jumps forward between two supervision ticks, exactly
 * what a suspended host looks like to a process (timers do not fire while suspended). Nothing sleeps a real machine,
 * and no real subscription limit is consumed.
 */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({ write: (_c, _e, cb) => cb() });
  pid = 999_998;
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

const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = mkdtempSync(path.join(tmpdir(), 'cap-sleep-'));
const ws = mkdtempSync(path.join(tmpdir(), 'cap-sleep-ws-'));

function setup(
  script: (c: FakeChild, host: { sleep(ms: number): void }) => void | Promise<void>,
  env: Record<string, string> = {},
) {
  let offset = 0;
  const now = () => Date.now() + offset;
  const host = { sleep: (ms: number) => void (offset += ms) };
  const config = loadConfig({
    noEnvFile: true,
    env: {
      AGENT_HOME: home,
      EXECUTION_PROVIDER: 'claude-cli',
      CLAUDE_CLI_STALL_TIMEOUT_MS: '10000',
      HOST_SUSPEND_THRESHOLD_MS: '1000',
      ...env,
    },
  });
  const calls: FakeChild[] = [];
  const provider = new ClaudeCliProvider({
    config,
    tickMs: 50,
    now,
    parentEnv: { PATH: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token' },
    terminateFn: (c) => (c as unknown as FakeChild).exit(143),
    spawnFn: () => {
      const child = new FakeChild();
      calls.push(child);
      setTimeout(() => void script(child, host), 5);
      return child as unknown as ChildProcess;
    },
  });
  const events: ExecutionEvent[] = [];
  const sessions: string[] = [];
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
    ...o,
  });
  return { provider, calls, events, sessions, req, now, config };
}

const init = { type: 'system', subtype: 'init', session_id: 's', apiKeySource: 'none', model: 'm' };
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
  usage: { input_tokens: 1, output_tokens: 1 },
});
const rejected = (resetsAtMs: number, kind = 'five_hour') => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', rateLimitType: kind, resetsAt: Math.floor(resetsAtMs / 1000) },
});
const retry429 = {
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 300,
  retry_delay_ms: 9_683_953,
  error: 'rate_limit',
  error_status: 429,
};

describe('A11: host sleep is not charged to the execution budget or the stall window', () => {
  it('11 min of work, 3 h asleep, then finishes: completed (v1: TIMEOUT 15 s after wake, retry consumed)', async () => {
    const s = setup(async (c, host) => {
      c.emitLine(init);
      c.emitLine(text('working'));
      await sleep(150);
      host.sleep(3 * HOUR + 14 * 60_000); // exe_mw85pdo9…: host slept 3h14m mid-execution
      await sleep(400);
      c.emitLine(text('awake again, finishing'));
      c.emitLine(success('finished after wake'));
      c.exit(0);
    });
    const out = await s.provider.run(s.req({ limits: { maxTurns: 5, timeoutMs: 30 * 60_000 } }));
    expect(out).toMatchObject({ kind: 'completed', summary: 'finished after wake' });
    const resumes = s.events.filter((e) => e.type === 'host_resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.data['suspendedMs']).toBeGreaterThan(3 * HOUR);
    expect(resumes[0]!.data['waiting']).toBe(false);
  });

  it('a genuine active-time overrun still times out after a sleep, and the message says the sleep was not charged', async () => {
    const s = setup(async (c, host) => {
      c.emitLine(init);
      await sleep(100);
      host.sleep(2 * HOUR);
      await sleep(5_000); // silent: active time runs out
    });
    const out = await s.provider.run(s.req({ limits: { maxTurns: 5, timeoutMs: 600 } }));
    expect(out).toMatchObject({ kind: 'failed', failure: { errorClass: 'TIMEOUT' } });
    const msg = out.kind === 'failed' ? out.failure.message : '';
    expect(msg).toMatch(/active time/);
    expect(msg).toMatch(/host suspended 7200s \(not charged\)/);
  });

  it('ActiveTimeMeter: only late ticks count as suspension; backward clock jumps are ignored', () => {
    let t = 1_000_000;
    const m = new ActiveTimeMeter(() => t, 1000, 30_000);
    t += 1000;
    expect(m.sample()).toBeUndefined();
    t += 25_000; // late but under threshold (busy event loop): not a suspension
    expect(m.sample()).toBeUndefined();
    t += 3 * HOUR;
    expect(m.sample()).toEqual({ suspendedMs: 3 * HOUR - 1000, at: t });
    t -= 5_000; // NTP correction backwards
    expect(m.sample()).toBeUndefined();
    expect(m.suspendedMs()).toBe(3 * HOUR - 1000);
    expect(m.activeSince(1_000_000, 0)).toBe(t - 1_000_000 - (3 * HOUR - 1000));
  });
});

describe('A10: the in-process wait ends once the reported reset has passed (sleep-safe resume)', () => {
  it('reset passes while the host sleeps: on wake the wait ends at a safe point as QUOTA_EXHAUSTED and resumes now', async () => {
    let reset = 0;
    const s = setup(async (c, host) => {
      c.emitLine(init);
      reset = s.now() + 20 * 60_000; // within the 30-min in-process ceiling, so the process waits
      c.emitLine(rejected(reset));
      c.emitLine(retry429);
      await sleep(200);
      host.sleep(12 * HOUR); // exe_mw72qpdx…: slept 00:44-12:52 across the 03:00 reset
      await sleep(10_000); // the CLI's own retry timer would keep waiting: it must not matter
    });
    const out = await s.provider.run(s.req());
    expect(out).toMatchObject({
      kind: 'failed',
      failure: { errorClass: 'QUOTA_EXHAUSTED', resetsAtMs: reset - (reset % 1000) },
    });
    expect(out.kind === 'failed' && out.failure.message).toMatch(/has passed; in-process wait ended/);
    expect(out.sessionId).toBe(s.sessions[0]); // session preserved for --resume
    expect(s.calls).toHaveLength(1);
    expect(s.events.some((e) => e.type === 'host_resume' && e.data['waiting'] === true)).toBe(true);

    // The recovery policy turns that into an immediate resume of the same session, without consuming a retry.
    const d = decide({
      task: {
        attemptCount: 0,
        maxRetries: 3,
        continuationCount: 0,
        providerFailureStreak: 0,
      } as unknown as Task,
      kind: 'failed',
      failure: out.kind === 'failed' ? out.failure : undefined,
      resumed: true,
      providerState: { consecutiveFailures: 0 } as unknown as ProviderState,
      now: s.now(),
      config: {
        backoff: s.config.backoff,
        maxContinuations: s.config.maxContinuations,
        maxProviderFailureStreak: s.config.maxProviderFailureStreak,
      },
    });
    expect(d).toMatchObject({ next: 'WAITING_FOR_CAPACITY', consumesAttempt: false, clearSession: false });
    expect(d.nextEligibleAt! - s.now()).toBeLessThanOrEqual(s.config.backoff.resetMarginMs);
  });

  it('without sleep, a reset that has not yet passed keeps the same process waiting (no premature kill)', async () => {
    const s = setup(async (c) => {
      c.emitLine(init);
      c.emitLine(rejected(Date.now() + 10 * 60_000));
      c.emitLine(retry429);
      await sleep(600);
      c.emitLine(text('capacity back'));
      c.emitLine(success('done in the same process'));
      c.exit(0);
    });
    const out = await s.provider.run(s.req({ limits: { maxTurns: 5, timeoutMs: 200 } }));
    expect(out).toMatchObject({ kind: 'completed', summary: 'done in the same process' });
    expect(s.calls).toHaveLength(1);
  });
});

describe('A12: bounded in-process capacity waits and escalation', () => {
  it('a reset beyond the in-process ceiling is handed to the durable queue immediately (session kept)', async () => {
    let reset = 0;
    const s = setup(async (c) => {
      c.emitLine(init);
      reset = s.now() + 4 * HOUR;
      c.emitLine(rejected(reset));
      c.emitLine(retry429);
      await sleep(10_000);
    });
    const t0 = Date.now();
    const out = await s.provider.run(s.req());
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(out).toMatchObject({ kind: 'failed', failure: { errorClass: 'QUOTA_EXHAUSTED' } });
    expect(out.kind === 'failed' && out.failure.message).toMatch(/beyond the in-process wait ceiling/);
    expect(out.kind === 'failed' && out.failure.resetsAtMs).toBe(reset - (reset % 1000));
    expect(out.sessionId).toBe(s.sessions[0]);
  });

  it('a wait with no reported reset ends at the ceiling (CLAUDE_CLI_MAX_CAPACITY_WAIT_MS)', async () => {
    const s = setup(
      async (c) => {
        c.emitLine(init);
        c.emitLine(retry429);
        await sleep(10_000);
      },
      { CLAUDE_CLI_MAX_CAPACITY_WAIT_MS: '300' },
    );
    const out = await s.provider.run(s.req());
    expect(out).toMatchObject({ kind: 'failed', failure: { errorClass: 'QUOTA_EXHAUSTED' } });
    expect(out.kind === 'failed' && out.failure.message).toMatch(/exceeded CLAUDE_CLI_MAX_CAPACITY_WAIT_MS/);
  });

  it('CLAUDE_CLI_MAX_CAPACITY_WAIT_MS=0 restores the v1 unbounded in-process wait (owner opt-out)', async () => {
    const s = setup(
      async (c) => {
        c.emitLine(init);
        c.emitLine(rejected(Date.now() + 4 * HOUR));
        c.emitLine(retry429);
        await sleep(500);
        c.emitLine(text('back'));
        c.emitLine(success('waited in process'));
        c.exit(0);
      },
      { CLAUDE_CLI_MAX_CAPACITY_WAIT_MS: '0' },
    );
    const out = await s.provider.run(s.req());
    expect(out).toMatchObject({ kind: 'completed', summary: 'waited in process' });
  });

  const exec = (startedAt: number, endedAt: number | null, errorClass: string | null): ExecutionRecord =>
    ({ startedAt, endedAt, errorClass }) as unknown as ExecutionRecord;

  it('the capacity streak starts at the first consecutive capacity execution and stops at any other outcome', () => {
    const e = [
      exec(0, 10, 'TIMEOUT'),
      exec(100, 200, 'QUOTA_EXHAUSTED'),
      exec(300, 400, 'RATE_LIMIT'),
      exec(500, 600, 'QUOTA_EXHAUSTED'),
    ];
    expect(capacityStreakSince(e)).toBe(100);
    expect(capacityStreakSince([...e, exec(700, 800, null)])).toBeNull(); // progress ends the streak
    expect(capacityStreakSince([...e, exec(700, null, null)])).toBe(100); // still running: ignored
  });

  it('escalation fires only past the threshold and never when disabled', () => {
    const e = [exec(0, 10, 'QUOTA_EXHAUSTED'), exec(20, 30, 'QUOTA_EXHAUSTED')];
    expect(capacityEscalation(e, 1000, 2000)).toBeNull();
    expect(capacityEscalation(e, 3000, 2000)).toEqual({ since: 0, waitedMs: 3000 });
    expect(capacityEscalation(e, 10 ** 9, 0)).toBeNull();
  });

  it('defaults: 30-min in-process ceiling, 60 s resume grace, 24 h escalation (notify)', () => {
    const c = loadConfig({ noEnvFile: true, env: { AGENT_HOME: home } });
    expect(c.claudeCli.maxCapacityWaitMs).toBe(1_800_000);
    expect(c.claudeCli.resumeGraceMs).toBe(60_000);
    expect(c.capacity).toEqual({ escalateAfterMs: 86_400_000, escalation: 'notify' });
  });
});
