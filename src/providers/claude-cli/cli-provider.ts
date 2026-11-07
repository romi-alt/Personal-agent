import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  AuthReadiness,
  ExecutionProvider,
  PermissionDenial,
  ProviderFailure,
  RunOutcome,
  RunRequest,
  UsageInfo,
} from '../types.js';
import { classifyText, mapAssistantError, resetsAtToMs, type RateInfoLike } from '../claude/errors.js';
import { buildWorkerEnv, compareVersions } from './env.js';
import { killTree } from '../../workers/process-tree.js';
import { WATCHDOG_VARS, type HookDecisionRecord, type HookPolicyFile } from './pretooluse-hook.js';

const execFileP = promisify(execFile);

/** Tools the worker may see. Permission decisions are made by the PreToolUse policy hook, which runs first. */
export const CLI_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite'];
export const CLI_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
/** Added to read-only research tasks only. */
export const CLI_WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** http(s) URLs found in a tool_result payload (string, or array of {type:'text',text}). Bounded. */
export function extractUrls(content: unknown): string[] {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((c) => (c && typeof c === 'object' ? String((c as { text?: unknown }).text ?? '') : ''))
            .join('\n')
        : '';
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    out.add(m[0].replace(/[.,;:]+$/, '').slice(0, 500));
    if (out.size >= 100) break;
  }
  return [...out];
}

/** Credential sources that mean "the owner's subscription login", as reported by `system/init.apiKeySource`. */
const SUBSCRIPTION_SOURCES = new Set([
  'none',
  'oauth',
  'claude.ai',
  'oauth_token',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);
/** `claude auth status` authMethod values that are subscription logins. */
const SUBSCRIPTION_AUTH_METHODS = new Set(['claude.ai', 'oauth_token']);

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  loginExpiresAt?: string;
  orgId?: string;
}

export interface CliDeps {
  config: {
    agentHome: string;
    /** Managed workspace root; scratch cleanup is offered only for workspaces strictly inside it. */
    workspaceRoot?: string;
    claudeCliPath?: string;
    claudeModel?: string;
    claudeCli: {
      minVersion: string;
      watchdogEnv: Record<string, string>;
      maxCapacityWaitMs: number;
      stallTimeoutMs: number;
    };
  };
  /** Injectable for tests. Defaults to node's spawn. */
  spawnFn?: (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => ChildProcess;
  /** Injectable for tests: returns `claude --version` and `claude auth status --json` (parsed, no secrets). */
  probe?: () => Promise<{ version: string | null; auth: AuthStatus | null; error?: string }>;
  now?: () => number;
  parentEnv?: NodeJS.ProcessEnv;
  /** Injectable for tests (a fake child must never reach taskkill). Defaults to killing the process tree. */
  terminateFn?: (child: ChildProcess) => void;
  /** Supervision tick interval (ms). */
  tickMs?: number;
  /** Cache lifetime of a healthy version/auth probe (default 60 s; 0 for an injected probe unless set). */
  probeTtlMs?: number;
}

type ProbeResult = { version: string | null; auth: AuthStatus | null; error?: string };

/** How to run the policy hook: compiled JS with plain node, or the TypeScript source through tsx in development. */
export function hookCommand(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, 'pretooluse-hook.js');
  const ts = path.join(here, 'pretooluse-hook.ts');
  const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  if (existsSync(js)) return `${q(process.execPath)} ${q(js)}`;
  // tsx is resolved from this package, not from the project workspace the hook runs in.
  const tsxLoader = import.meta.resolve('tsx');
  return `${q(process.execPath)} --import ${q(tsxLoader)} ${q(ts)}`;
}

/**
 * Variables that let a worker remove a generated scratch directory without `rm -rf` (which needs owner approval):
 * `"$ELEVARIQ_NODE" "$ELEVARIQ_SCRATCH_CLEAN" .qa-mut`. Only offered when the compiled script exists (plain node, no
 * loader). The context variables are not a privilege: a worker that changes them only changes what this one tool may
 * delete, which it could do with any program; the approval policy file is deliberately NOT exposed.
 */
export function scratchCleanEnv(
  agentHome: string,
  workspace: string,
  workspaceRoot: string,
  executionId: string,
): Record<string, string> {
  // Next to this module when running from dist; the built copy when running from src through tsx.
  const js = [
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'workspaces',
      'scratch-clean-main.js',
    ),
    path.join(agentRepoRoot(), 'dist', 'workspaces', 'scratch-clean-main.js'),
  ].find((p) => existsSync(p));
  if (!js) return {};
  return {
    ELEVARIQ_NODE: process.execPath,
    ELEVARIQ_SCRATCH_CLEAN: js,
    ELEVARIQ_AGENT_HOME: agentHome,
    ELEVARIQ_WORKSPACE: workspace,
    ELEVARIQ_WORKSPACE_ROOT: workspaceRoot,
    ELEVARIQ_EXECUTION_ID: executionId,
  };
}

/** Root of this agent's own repository/installation (two levels above src|dist/providers/claude-cli). */
export function agentRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export class ClaudeCliProvider implements ExecutionProvider {
  readonly name = 'claude-cli';
  readonly workerImage = /^claude(\.exe)?$/i;
  private readonly now: () => number;

  constructor(private readonly d: CliDeps) {
    this.now = d.now ?? Date.now;
  }

  private get exe(): string {
    return this.d.config.claudeCliPath ?? 'claude';
  }

  private probeCache?: { at: number; value: ProbeResult };

  /**
   * The supervisor calls preflight() on every scheduling tick; launching `claude` twice per tick (a 300+ MB
   * executable) kept an idle PC busy (~45 launches per 90 s observed). Results are cached: healthy for
   * `probeTtlMs` (default 60 s), failing for a quarter of that so a fresh login is noticed quickly.
   */
  private async probe(): Promise<ProbeResult> {
    const ttl = this.d.probeTtlMs ?? (this.d.probe ? 0 : 60_000);
    const c = this.probeCache;
    if (c && ttl > 0) {
      const ok = !c.value.error && !!c.value.auth?.loggedIn;
      if (this.now() - c.at < (ok ? ttl : ttl / 4)) return c.value;
    }
    const value = await this.probeOnce();
    this.probeCache = { at: this.now(), value };
    return value;
  }

  private async probeOnce(): Promise<ProbeResult> {
    if (this.d.probe) return this.d.probe();
    const env = buildWorkerEnv(this.d.parentEnv ?? process.env, {});
    let version: string | null;
    try {
      const { stdout } = await execFileP(this.exe, ['--version'], {
        env,
        timeout: 30_000,
        windowsHide: true,
      });
      version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
    } catch (err) {
      return {
        version: null,
        auth: null,
        error: `cannot run ${this.exe} --version: ${(err as Error).message}`,
      };
    }
    try {
      const { stdout } = await execFileP(this.exe, ['auth', 'status', '--json'], {
        env,
        timeout: 30_000,
        windowsHide: true,
      });
      return { version, auth: pickAuth(JSON.parse(stdout)) };
    } catch (err) {
      // exit code 1 = not logged in; stdout still carries the JSON
      const out = (err as { stdout?: string }).stdout;
      if (out) {
        try {
          return { version, auth: pickAuth(JSON.parse(out)) };
        } catch {
          /* fall through */
        }
      }
      return { version, auth: null, error: 'claude auth status failed' };
    }
  }

  /** Local checks only (version + stored login state). Never sends a model request. */
  async preflight(): Promise<AuthReadiness> {
    const missing: string[] = [];
    const p = await this.probe();
    if (p.error && !p.version) missing.push(p.error);
    if (p.version && compareVersions(p.version, this.d.config.claudeCli.minVersion) < 0) {
      missing.push(
        `Claude Code ${p.version} is older than ${this.d.config.claudeCli.minVersion}, the oldest version verified to support the retry watchdog`,
      );
    }
    const a = p.auth;
    if (!a) missing.push('could not read `claude auth status`');
    else if (!a.loggedIn) missing.push('Claude Code is not logged in: run `claude` and /login as the owner');
    else if (!a.authMethod || !SUBSCRIPTION_AUTH_METHODS.has(a.authMethod)) {
      missing.push(
        `Claude Code auth method is "${a.authMethod ?? 'unknown'}", not a subscription login; the claude-cli provider never uses API billing`,
      );
    }
    if (a?.loginExpiresAt) {
      const exp = Date.parse(a.loginExpiresAt);
      if (Number.isFinite(exp) && exp <= this.now())
        missing.push(`subscription login expired at ${a.loginExpiresAt}`);
    }
    const detail =
      missing.length === 0
        ? `Claude Code ${p.version}, ${a!.authMethod} login (${a!.subscriptionType ?? 'plan unknown'}), expires ${a!.loginExpiresAt ?? 'n/a'}; watchdog env injected per worker`
        : 'not ready';
    return {
      ready: missing.length === 0,
      detail,
      missing,
      // Identity fingerprint without secrets: detects a different account/org being logged in.
      fingerprint: a
        ? createHash('sha256')
            .update(`${a.authMethod}:${a.orgId ?? ''}`)
            .digest('hex')
            .slice(0, 12)
        : undefined,
      local: true,
    };
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    const cfg = this.d.config;
    const runDir = path.join(cfg.agentHome, 'run');
    mkdirSync(runDir, { recursive: true });
    const policyFile = path.join(runDir, `${req.executionId}.policy.json`);
    const decisionsFile = path.join(runDir, `${req.executionId}.decisions.jsonl`);
    const settingsFile = path.join(runDir, `${req.executionId}.settings.json`);
    const policy: HookPolicyFile = {
      workspace: req.cwd,
      approvedTypes: req.approvedActionTypes,
      alsoRequire: req.alsoRequireApproval,
      readOnly: !!req.readOnly,
      allowWeb: !!req.allowWeb,
      decisionsFile,
      protectedPaths: [cfg.agentHome, agentRepoRoot()],
    };
    // Read-only: a worker must not be able to widen its own policy by rewriting this file (guardrail; it is also
    // outside the workspace and commands naming *.policy.json are denied).
    writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o444 });
    writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: `${hookCommand()} "${policyFile.replace(/\\/g, '/')}"`,
                  timeout: 60,
                },
              ],
            },
          ],
        },
      }),
    );

    // New sessions get their id BEFORE launch: it is persisted first, so even a crash before the first output
    // leaves a resumable reference (and never two sessions for one execution).
    let sessionId = req.resumeSessionId;
    const sessionArgs: string[] = [];
    if (sessionId) sessionArgs.push('--resume', sessionId);
    else {
      sessionId = randomUUID();
      sessionArgs.push('--session-id', sessionId);
    }
    req.onSession(sessionId);
    req.onEvent({ type: 'session', data: { sessionId, resumed: !!req.resumeSessionId } });

    const tools = req.readOnly ? [...CLI_READ_ONLY_TOOLS, ...(req.allowWeb ? CLI_WEB_TOOLS : [])] : CLI_TOOLS;
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...sessionArgs,
      '--tools',
      tools.join(','),
      '--allowedTools',
      tools.join(','),
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      // No user/project/local settings: the workspace is model-writable, so its .claude/settings.json must not be able
      // to grant permissions, add hooks or MCP servers. Our policy hook comes from --settings.
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--settings',
      settingsFile,
      '--max-turns',
      String(req.limits.maxTurns),
      '--append-system-prompt',
      req.systemAppend,
    ];
    if (cfg.claudeModel) args.push('--model', cfg.claudeModel);

    const env = buildWorkerEnv(this.d.parentEnv ?? process.env, {
      ...cfg.claudeCli.watchdogEnv,
      ...(cfg.workspaceRoot
        ? scratchCleanEnv(cfg.agentHome, req.cwd, cfg.workspaceRoot, req.executionId)
        : {}),
    });
    const spawnFn =
      this.d.spawnFn ??
      ((cmd, a, o) =>
        spawn(cmd, a, {
          cwd: o.cwd,
          env: o.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // POSIX: lead a process group so the worker and its tool subprocesses can be stopped together (a child
          // outlives a killed supervisor there). Windows: stay in libuv's kill-on-close job object, which already
          // ends the whole worker tree when the supervisor dies.
          detached: process.platform !== 'win32',
        }));

    let child: ChildProcess;
    try {
      child = spawnFn(this.exe, args, { cwd: req.cwd, env });
    } catch (err) {
      cleanup();
      return { kind: 'failed', sessionId, failure: { errorClass: 'PROCESS_CRASH', message: String(err) } };
    }
    if (child.pid) req.onProcess?.(child.pid);
    // Evidence: the (non-secret) watchdog variables exactly as handed to the claude process.
    req.onEvent({
      type: 'worker_env',
      data: {
        observedIn: 'spawn environment of the claude worker',
        vars: Object.fromEntries(WATCHDOG_VARS.map((k) => [k, env[k] ?? null])),
      },
    });

    // ---- state
    let rate: RateInfoLike | undefined;
    let assistantError: { code: string; text: string } | undefined;
    let result: Record<string, unknown> | undefined;
    let initSource: string | undefined;
    let authRefusal: string | undefined;
    let lastText = '';
    const webCalls = new Map<string, string>();
    let stderr = '';
    let killedFor: 'timeout' | 'stall' | 'shutdown' | 'capacity_ceiling' | 'auth' | undefined;
    let waiting: { since: number; resetsAtMs?: number } | undefined;
    let lastOutputAt = this.now();
    let budgetStartedAt = this.now();

    const kill = (why: NonNullable<typeof killedFor>) => {
      if (killedFor) return;
      killedFor = why;
      (this.d.terminateFn ?? terminate)(child);
    };
    const startWait = (reason: string, resetsAtMs?: number, recheck?: boolean) => {
      if (!waiting) {
        waiting = { since: this.now(), resetsAtMs };
        const recheckMs = Number(
          cfg.claudeCli.watchdogEnv['CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS'],
        );
        req.onEvent({
          type: 'capacity_wait',
          data: {
            waiting: true,
            reason,
            resetsAtMs,
            recheckAtMs: recheck && recheckMs > 0 ? this.now() + recheckMs : undefined,
          },
        });
      } else if (resetsAtMs && !waiting.resetsAtMs) waiting.resetsAtMs = resetsAtMs;
    };
    const endWait = () => {
      if (!waiting) return;
      req.onEvent({ type: 'capacity_wait', data: { waiting: false, waitedMs: this.now() - waiting.since } });
      waiting = undefined;
      budgetStartedAt = this.now(); // fresh execution budget after a capacity wait
    };
    const watchdogOn = cfg.claudeCli.watchdogEnv['CLAUDE_CODE_RETRY_WATCHDOG'] === '1';

    const onMessage = (msg: Record<string, unknown>) => {
      lastOutputAt = this.now();
      const type = msg['type'];
      const subtype = msg['subtype'];
      if (type === 'system' && subtype === 'init') {
        initSource = typeof msg['apiKeySource'] === 'string' ? msg['apiKeySource'] : undefined;
        if (initSource && !SUBSCRIPTION_SOURCES.has(initSource)) {
          authRefusal = `Claude Code reported credential source "${initSource}", not the subscription login; refusing to run (no silent switch to API billing)`;
          kill('auth');
          return;
        }
        req.onEvent({
          type: 'status',
          data: {
            subtype: 'init',
            model: msg['model'],
            apiKeySource: initSource,
            // Non-secret evidence field (log redaction masks anything named like apiKey*/credential*).
            billing: 'subscription',
            version: msg['claude_code_version'],
          },
        });
        return;
      }
      if (type === 'system' && subtype === 'api_retry') {
        const error = String(msg['error'] ?? '');
        req.onEvent({
          type: 'retry',
          data: {
            attempt: msg['attempt'],
            max: msg['max_retries'],
            delayMs: msg['retry_delay_ms'],
            error,
            status: msg['error_status'],
          },
        });
        if (watchdogOn && (error === 'rate_limit' || msg['error_status'] === 429)) {
          startWait(
            'usage or rate limit: official retry watchdog waiting',
            resetsAtToMs(rate?.resetsAt),
            true,
          );
        }
        return;
      }
      if (type === 'rate_limit_event') {
        const info = (msg['rate_limit_info'] ?? {}) as RateInfoLike & { errorCode?: string };
        rate = info;
        const resetsAtMs = resetsAtToMs(info.resetsAt);
        req.onEvent({
          type: 'rate_limit',
          data: { status: info.status, type: info.rateLimitType, resetsAtMs, errorCode: info.errorCode },
        });
        if (info.status === 'rejected' && watchdogOn)
          startWait(`${info.rateLimitType ?? 'usage'} limit reached`, resetsAtMs, true);
        return;
      }
      // Any model/tool traffic means the provider is making progress again.
      if (type === 'assistant' || type === 'user' || type === 'stream_event' || type === 'tool_progress')
        endWait();
      if (type === 'assistant') {
        const m = msg['message'] as
          | {
              content?: {
                type: string;
                text?: string;
                name?: string;
                id?: string;
                input?: Record<string, unknown>;
              }[];
            }
          | undefined;
        const err = typeof msg['error'] === 'string' ? msg['error'] : undefined;
        for (const block of m?.content ?? []) {
          if (block.type === 'text' && block.text) {
            lastText = block.text;
            req.onEvent({ type: 'assistant_text', data: { chars: block.text.length } });
          } else if (block.type === 'tool_use') {
            req.onEvent({ type: 'tool_use', data: { tool: block.name, id: block.id } });
            if ((block.name === 'WebFetch' || block.name === 'WebSearch') && block.id) {
              webCalls.set(block.id, block.name);
              const url = block.input?.['url'];
              if (typeof url === 'string')
                req.onEvent({ type: 'web_evidence', data: { tool: block.name, urls: [url.slice(0, 500)] } });
            }
          }
        }
        if (err) assistantError = { code: err, text: lastText };
        return;
      }
      if (type === 'user') {
        req.onEvent({ type: 'tool_result', data: {} });
        // Research citation evidence: URLs that web tools actually returned (checked later against cited sources).
        const m = msg['message'] as { content?: unknown } | undefined;
        for (const block of Array.isArray(m?.content) ? (m.content as Record<string, unknown>[]) : []) {
          const tool = webCalls.get(String(block['tool_use_id'] ?? ''));
          if (block['type'] !== 'tool_result' || !tool) continue;
          const urls = extractUrls(block['content']);
          if (urls.length) req.onEvent({ type: 'web_evidence', data: { tool, urls } });
        }
        return;
      }
      if (type === 'result') result = msg;
    };

    // ---- stdout line parser
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          onMessage(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* non-JSON noise is ignored */
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      if (stderr.length < 16_000) stderr += c;
    });
    child.stdin?.on('error', () => {
      /* child exited before reading the prompt; reported via exit */
    });
    child.stdin?.end(req.prompt);

    // ---- supervision: shutdown, execution budget (paused while waiting), stall, optional capacity ceiling
    const onAbort = () => kill('shutdown');
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener('abort', onAbort, { once: true });
    const tick = setInterval(() => {
      const t = this.now();
      if (waiting) {
        if (cfg.claudeCli.maxCapacityWaitMs > 0 && t - waiting.since > cfg.claudeCli.maxCapacityWaitMs)
          kill('capacity_ceiling');
        return;
      }
      if (t - budgetStartedAt > req.limits.timeoutMs) kill('timeout');
      else if (t - lastOutputAt > cfg.claudeCli.stallTimeoutMs) kill('stall');
    }, this.d.tickMs ?? 1000);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('error', (err) => {
        stderr += `\n${String(err)}`;
        resolve(null);
      });
      child.once('close', (code) => resolve(code));
    });
    clearInterval(tick);
    req.signal.removeEventListener('abort', onAbort);
    req.onProcess?.(null);
    if (waiting) endWait();
    const workerEnv = readWorkerEnv(decisionsFile);
    if (workerEnv) req.onEvent({ type: 'worker_env', data: workerEnv });
    const denials = readDenials(decisionsFile, result);
    cleanup();

    const usage = result ? extractUsage(result) : undefined;
    const fail = (failure: ProviderFailure, summary?: string): RunOutcome => ({
      kind: 'failed',
      sessionId,
      usage,
      summary,
      denials: denials.length ? denials : undefined,
      failure,
    });

    if (killedFor === 'auth')
      return fail({ errorClass: 'AUTHENTICATION', message: authRefusal ?? 'credential source refused' });
    if (killedFor === 'shutdown')
      return fail({ errorClass: 'INTERRUPTED', message: 'execution interrupted by supervisor shutdown' });
    if (killedFor === 'timeout')
      return fail({ errorClass: 'TIMEOUT', message: 'execution exceeded worker timeout' });
    if (killedFor === 'stall')
      return fail({
        errorClass: 'TIMEOUT',
        message: `no output from Claude Code for ${Math.round(cfg.claudeCli.stallTimeoutMs / 1000)}s outside a capacity wait (stalled)`,
      });
    if (killedFor === 'capacity_ceiling')
      return fail({
        errorClass: 'QUOTA_EXHAUSTED',
        message:
          'usage-limit wait exceeded CLAUDE_CLI_MAX_CAPACITY_WAIT_MS; the session is preserved for resumption',
        resetsAtMs: resetsAtToMs(rate?.resetsAt),
      });

    if (!result) {
      const text = `${stderr.trim()}`.slice(0, 2000);
      if (assistantError)
        return fail(mapAssistantError(assistantError.code, assistantError.text || text, rate));
      return fail(
        classifyText(text) ?? {
          errorClass: 'PROCESS_CRASH',
          message: `Claude Code exited with code ${exitCode ?? 'n/a'} without a result${text ? `: ${text}` : ''}`,
        },
      );
    }

    const subtype = String(result['subtype'] ?? '');
    const resultText = typeof result['result'] === 'string' ? result['result'] : lastText;
    if (subtype === 'error_max_turns') {
      return {
        kind: 'partial',
        sessionId,
        usage,
        summary: lastText || 'max turns reached',
        outstanding: 'work remained when the turn limit was reached',
        nextAction: 'continue from the last checkpoint',
      };
    }
    if (subtype === 'error_max_budget_usd')
      return fail({ errorClass: 'BUDGET_EXHAUSTED', message: 'per-execution budget reached' });
    if (result['is_error'] === true || assistantError || subtype.startsWith('error')) {
      const errs = Array.isArray(result['errors'])
        ? (result['errors'] as unknown[]).map(String).join('; ')
        : '';
      const text = errs || resultText || subtype;
      if (assistantError)
        return fail(mapAssistantError(assistantError.code, assistantError.text || text, rate), resultText);
      if (rate?.status === 'rejected') return fail(mapAssistantError('rate_limit', text, rate), resultText);
      return fail(classifyText(text) ?? { errorClass: 'TASK_FAILURE', message: text }, resultText);
    }
    if (denials.some((x) => x.approvalType)) {
      return fail(
        {
          errorClass: 'PERMISSION_DENIED',
          message: `${denials.length} tool call(s) denied pending owner approval`,
        },
        resultText,
      );
    }
    return {
      kind: 'completed',
      sessionId,
      usage,
      summary: resultText || 'completed',
      denials: denials.length ? denials : undefined,
    };

    function cleanup(): void {
      for (const f of [policyFile, settingsFile, decisionsFile]) rmSync(f, { force: true });
    }
  }
}

function pickAuth(j: Record<string, unknown>): AuthStatus {
  // Only non-secret fields are kept; email/org names are never copied into logs or readiness evidence.
  return {
    loggedIn: j['loggedIn'] === true,
    authMethod: typeof j['authMethod'] === 'string' ? j['authMethod'] : undefined,
    subscriptionType: typeof j['subscriptionType'] === 'string' ? j['subscriptionType'] : undefined,
    loginExpiresAt: typeof j['loginExpiresAt'] === 'string' ? j['loginExpiresAt'] : undefined,
    orgId: typeof j['orgId'] === 'string' ? j['orgId'] : undefined,
  };
}

/** Watchdog variables as seen by the policy hook, a direct child process of `claude` (evidence of injection). */
function readWorkerEnv(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const r = JSON.parse(line) as { kind?: string; watchdog?: Record<string, string | null> };
      if (r.kind === 'env' && r.watchdog)
        return { observedIn: 'policy hook process (child of claude)', vars: r.watchdog };
    } catch {
      /* partial line */
    }
  }
  return null;
}

function readDenials(file: string, result?: Record<string, unknown>): PermissionDenial[] {
  const out: PermissionDenial[] = [];
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as HookDecisionRecord & { kind?: string };
        if (r.kind === 'env') continue;
        if (!r.allow)
          out.push({ tool: r.tool, reason: r.reason, approvalType: r.approvalType, input: r.input });
      } catch {
        /* partial line */
      }
    }
  }
  const fromResult = (result?.['permission_denials'] ?? []) as {
    tool_name: string;
    tool_input: Record<string, unknown>;
  }[];
  for (const d of fromResult) {
    if (!out.some((o) => o.tool === d.tool_name && JSON.stringify(o.input) === JSON.stringify(d.tool_input)))
      out.push({ tool: d.tool_name, reason: 'denied by permission system', input: d.tool_input });
  }
  return out;
}

function extractUsage(r: Record<string, unknown>): UsageInfo {
  const u = r['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    inputTokens: u?.input_tokens,
    outputTokens: u?.output_tokens,
    turns: typeof r['num_turns'] === 'number' ? r['num_turns'] : undefined,
    // Under a subscription this is a notional client-side figure, not money spent.
    costUsdEstimate: typeof r['total_cost_usd'] === 'number' ? r['total_cost_usd'] : undefined,
    raw: { billing: 'subscription' },
  };
}

/** Stop the worker and everything it started (Bash tool children). Windows has no process groups: use taskkill /T. */
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    void killTree(child.pid);
  } else {
    const pid = child.pid;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig); // the worker leads its own process group (spawned detached)
      } catch {
        child.kill(sig);
      }
    };
    signalGroup('SIGINT'); // ends the turn cleanly (documented); escalate if it lingers
    setTimeout(() => child.exitCode === null && signalGroup('SIGKILL'), 10_000).unref();
  }
}

export const _test = { pickAuth, readDenials };
