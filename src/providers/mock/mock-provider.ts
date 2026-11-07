import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readTextFile } from '../../core/text.js';
import type { AuthReadiness, ExecutionProvider, RunOutcome, RunRequest } from '../types.js';

/**
 * Deterministic provider for tests and offline development. No network, no cost.
 *
 * Behaviour is scripted per task title (or "*") as a list of steps consumed by
 * attempt index (1-based; the last step repeats). Scenarios can be passed
 * in-memory or loaded from a JSON file so they survive across supervisor processes.
 *
 * A control file (`capacityFile`) can globally flip availability: {"available": false,
 * "mode": "rate_limit"|"quota", "retryAfterMs"?: n, "resetsInMs"?: n}.
 */
export type MockStepType =
  | 'success'
  | 'partial'
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'timeout'
  | 'crash'
  | 'permission_denied'
  | 'budget'
  | 'fatal'
  | 'invalid_session'
  | 'network'
  | 'outage'
  | 'hang'
  /**
   * Simulates the official Claude Code retry watchdog: the provider process stays alive and silent while the usage
   * limit is in force (at least `delayMs`, and while the capacity file says unavailable), then continues the same
   * request and succeeds. No new request is made during the wait.
   */
  | 'watchdog_wait'
  /**
   * Spawns a REAL long-running child process (node) as the "worker", reports its pid like the CLI provider does, and
   * waits for it to exit (`delayMs`, default 60 s). The child appends `<pid> <ms>` lines to `.mock-worker.beat` in the
   * workspace while alive. `writes` are applied BEFORE the worker starts (completed earlier step). Used to test orphan
   * worker detection and identity-verified termination without the real Claude CLI.
   */
  | 'spawn_worker';

export interface MockStep {
  type: MockStepType;
  delayMs?: number;
  retryAfterMs?: number;
  /** Relative reset time converted to an absolute timestamp when the step runs (simulates a provider-supplied reset). */
  resetsInMs?: number;
  summary?: string;
  /** Files (relative to cwd) to write, simulating real artifacts. */
  writes?: { file: string; content: string }[];
  /** For 'success': do not create the default `<taskId>.done` artifact (simulates a claim of success with no changes). */
  noArtifact?: boolean;
  /** Estimated cost reported in usage (for budget tests). */
  costUsd?: number;
  /** For 'watchdog_wait': capacity "returns" once this file exists. */
  untilFile?: string;
  /** For 'spawn_worker': start the worker detached so it survives the supervisor being killed. */
  detached?: boolean;
  /** URLs the simulated web tools "returned" (emitted as web_evidence events; research citation tests). */
  webEvidence?: string[];
}

export interface MockScenario {
  tasks: Record<string, (MockStepType | MockStep)[]>;
  /** Known session ids; resuming any other id yields INVALID_SESSION. If omitted all mock-* ids are valid. */
  validSessions?: string[];
}

export interface MockProviderOptions {
  scenario?: MockScenario;
  scenarioFile?: string;
  capacityFile?: string;
  /** Clock used to turn relative reset times into absolute ones (inject a fake clock in tests). */
  now?: () => number;
  authReady?: () => boolean;
  /** Simulated credential fingerprint; change it to simulate the owner rotating/fixing a credential. */
  fingerprint?: () => string;
}

const norm = (s: MockStepType | MockStep): MockStep => (typeof s === 'string' ? { type: s } : s);
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const MOCK_WORKER_SRC =
  "const fs=require('fs');const [f,ms]=process.argv.slice(1);const end=Date.now()+Number(ms);" +
  "const beat=()=>fs.appendFileSync(f,process.pid+' '+Date.now()+'\\n');beat();" +
  'const t=setInterval(()=>{beat();if(Date.now()>=end){clearInterval(t);}},250);';

export class MockProvider implements ExecutionProvider {
  readonly name = 'mock';
  readonly workerImage = /^node(\.exe)?$/i;
  /** Execution log kept in-memory for assertions. */
  readonly runs: {
    taskTitle: string;
    attemptIndex: number;
    resumed: string | undefined;
    step: MockStepType;
    /** The exact prompt the worker sent (lets tests assert recovery context). */
    prompt: string;
    readOnly: boolean;
    allowWeb: boolean;
  }[] = [];

  /** Number of model requests that entered a watchdog wait (each wait is ONE request, however long it lasts). */
  watchdogRequests = 0;

  constructor(private readonly opts: MockProviderOptions = {}) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async preflight(): Promise<AuthReadiness> {
    const ready = this.opts.authReady ? this.opts.authReady() : true;
    return ready
      ? {
          ready: true,
          detail: 'mock provider (no credentials required)',
          missing: [],
          local: true,
          fingerprint: this.opts.fingerprint?.() ?? 'mock',
        }
      : {
          ready: false,
          detail: 'mock provider configured as unauthenticated',
          missing: ['MOCK_AUTH'],
          local: true,
          fingerprint: this.opts.fingerprint?.() ?? 'mock-none',
        };
  }

  private scenario(): MockScenario {
    if (this.opts.scenarioFile && existsSync(this.opts.scenarioFile)) {
      return JSON.parse(readTextFile(this.opts.scenarioFile)) as MockScenario;
    }
    return this.opts.scenario ?? { tasks: {} };
  }

  private capacity(): { available: boolean; mode?: string; retryAfterMs?: number; resetsInMs?: number } {
    if (this.opts.capacityFile && existsSync(this.opts.capacityFile)) {
      return JSON.parse(readTextFile(this.opts.capacityFile)) as { available: boolean };
    }
    return { available: true };
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    const scn = this.scenario();
    const steps = scn.tasks[req.taskTitle] ?? scn.tasks['*'] ?? ['success'];
    const step = norm(steps[Math.min(req.attemptIndex, steps.length) - 1] ?? 'success');
    this.runsPush(req, step.type);

    const sessionId = req.resumeSessionId ?? `mock-session-${req.taskId}`;
    if (req.resumeSessionId) {
      const valid = scn.validSessions
        ? scn.validSessions.includes(req.resumeSessionId)
        : req.resumeSessionId.startsWith('mock-');
      if (!valid || step.type === 'invalid_session') {
        return {
          kind: 'failed',
          failure: {
            errorClass: 'INVALID_SESSION',
            message: `No conversation found with session ID ${req.resumeSessionId}`,
          },
        };
      }
    }
    req.onSession(sessionId);
    req.onEvent({ type: 'session', data: { sessionId, resumed: !!req.resumeSessionId } });

    const cap = this.capacity();
    if (!cap.available) {
      const quota = cap.mode === 'quota';
      return {
        kind: 'failed',
        sessionId,
        failure: {
          errorClass: quota ? 'QUOTA_EXHAUSTED' : 'RATE_LIMIT',
          message: `mock provider unavailable (${cap.mode ?? 'rate_limit'})`,
          retryAfterMs: cap.retryAfterMs,
          resetsAtMs: cap.resetsInMs !== undefined ? this.now() + cap.resetsInMs : undefined,
        },
      };
    }

    // Record execution marker in the workspace so tests can prove no work is duplicated.
    mkdirSync(req.cwd, { recursive: true });
    // (Skipped for noArtifact steps, which must leave the working tree untouched.)
    if (!step.noArtifact && !req.readOnly) {
      appendFileSync(
        path.join(req.cwd, '.mock-executions.log'),
        `${req.taskTitle}\t${req.attemptIndex}\t${step.type}\t${req.resumeSessionId ?? 'new'}\n`,
      );
    }

    req.onEvent({ type: 'tool_use', data: { tool: 'mock_work', step: step.type } });
    if (step.webEvidence?.length && req.allowWeb)
      req.onEvent({ type: 'web_evidence', data: { tool: 'WebSearch', urls: step.webEvidence } });
    if (step.type === 'watchdog_wait') {
      const started = Date.now();
      req.onEvent({
        type: 'capacity_wait',
        data: {
          waiting: true,
          reason: 'mock five_hour limit reached',
          resetsAtMs: step.resetsInMs !== undefined ? this.now() + step.resetsInMs : undefined,
        },
      });
      this.watchdogRequests++;
      const released = () => !step.untilFile || existsSync(step.untilFile);
      while (!req.signal.aborted && (Date.now() - started < (step.delayMs ?? 0) || !released())) {
        await sleep(25, req.signal);
      }
      if (req.signal.aborted)
        return {
          kind: 'failed',
          failure: { errorClass: 'INTERRUPTED', message: 'aborted during capacity wait' },
          sessionId,
        };
      req.onEvent({ type: 'capacity_wait', data: { waiting: false, waitedMs: Date.now() - started } });
      if (!step.noArtifact && !req.readOnly)
        writeFileSync(path.join(req.cwd, `${req.taskId}.done`), 'done\n');
      return {
        kind: 'completed',
        summary: step.summary ?? 'completed after capacity returned',
        sessionId,
        usage: { turns: 1 },
      };
    }
    if (step.type === 'spawn_worker') {
      for (const w of step.writes ?? []) {
        const target = path.join(req.cwd, w.file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, w.content);
      }
      const child = spawn(
        process.execPath,
        ['-e', MOCK_WORKER_SRC, path.join(req.cwd, '.mock-worker.beat'), String(step.delayMs ?? 60_000)],
        // detached: on Windows a non-detached child sits in libuv's kill-on-close job object and dies with its parent;
        // detached simulates a worker that escaped it (the normal case on Linux, where children are reparented).
        { stdio: 'ignore', windowsHide: true, detached: !!step.detached },
      );
      if (child.pid) req.onProcess?.(child.pid);
      const onAbort = () => child.kill();
      req.signal.addEventListener('abort', onAbort, { once: true });
      const code = await new Promise<number | null>((resolve) => {
        child.once('exit', (c) => resolve(c));
        child.once('error', () => resolve(-1));
      });
      req.signal.removeEventListener('abort', onAbort);
      req.onProcess?.(null);
      if (req.signal.aborted)
        return { kind: 'failed', failure: { errorClass: 'INTERRUPTED', message: 'aborted' }, sessionId };
      if (code !== 0)
        return {
          kind: 'failed',
          sessionId,
          failure: { errorClass: 'PROCESS_CRASH', message: `mock worker exited with code ${String(code)}` },
        };
      if (!step.noArtifact && !req.readOnly)
        writeFileSync(path.join(req.cwd, `${req.taskId}.done`), 'done\n');
      return {
        kind: 'completed',
        summary: step.summary ?? 'mock worker finished',
        sessionId,
        usage: { turns: 1 },
      };
    }
    await sleep(step.delayMs ?? 0, req.signal);
    if (req.signal.aborted)
      return { kind: 'failed', failure: { errorClass: 'INTERRUPTED', message: 'aborted' }, sessionId };

    for (const w of step.writes ?? []) {
      const target = path.join(req.cwd, w.file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, w.content);
    }
    const summary = step.summary ?? `mock ${step.type} for "${req.taskTitle}"`;

    switch (step.type) {
      case 'success':
        if (!step.noArtifact && !req.readOnly)
          writeFileSync(path.join(req.cwd, `${req.taskId}.done`), 'done\n');
        return {
          kind: 'completed',
          summary,
          sessionId,
          usage: { turns: 1, costUsdEstimate: step.costUsd ?? 0 },
          testResults: 'mock: 1 passed',
        };
      case 'partial':
        return {
          kind: 'partial',
          summary,
          sessionId,
          outstanding: 'remaining mock work',
          nextAction: 'continue remaining mock work',
          usage: { turns: 1, costUsdEstimate: 0 },
        };
      case 'rate_limit':
        return {
          kind: 'failed',
          sessionId,
          failure: { errorClass: 'RATE_LIMIT', message: 'mock rate limit', retryAfterMs: step.retryAfterMs },
        };
      case 'quota':
        return {
          kind: 'failed',
          sessionId,
          failure: {
            errorClass: 'QUOTA_EXHAUSTED',
            message: 'mock usage quota exhausted',
            resetsAtMs: step.resetsInMs !== undefined ? this.now() + step.resetsInMs : undefined,
          },
        };
      case 'auth':
        return {
          kind: 'failed',
          failure: { errorClass: 'AUTHENTICATION', message: 'mock authentication failure' },
        };
      case 'timeout':
        return {
          kind: 'failed',
          sessionId,
          failure: { errorClass: 'TIMEOUT', message: 'mock execution timeout' },
        };
      case 'crash':
        throw new Error('mock worker process exited with code 1');
      case 'permission_denied':
        return {
          kind: 'failed',
          sessionId,
          failure: {
            errorClass: 'PERMISSION_DENIED',
            message: 'mock permission denied for Bash(npm publish)',
          },
          denials: [
            {
              tool: 'Bash',
              reason: 'Publishing a release or package requires owner approval',
              approvalType: 'publish_release',
              input: { command: 'npm publish' },
            },
          ],
        };
      case 'budget':
        return {
          kind: 'failed',
          sessionId,
          failure: { errorClass: 'BUDGET_EXHAUSTED', message: 'mock budget exhausted' },
          usage: { costUsdEstimate: 1 },
        };
      case 'network':
        return { kind: 'failed', sessionId, failure: { errorClass: 'NETWORK', message: 'mock ECONNRESET' } };
      case 'outage':
        return {
          kind: 'failed',
          sessionId,
          failure: { errorClass: 'PROVIDER_OUTAGE', message: 'mock 529 overloaded' },
        };
      case 'fatal':
        return {
          kind: 'failed',
          sessionId,
          failure: { errorClass: 'TASK_FAILURE', message: 'mock unrecoverable failure' },
        };
      case 'hang':
        // Waits until aborted (used to test timeouts, shutdown and kill -9 recovery).
        await new Promise<void>((resolve) =>
          req.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return {
          kind: 'failed',
          sessionId,
          failure: { errorClass: 'INTERRUPTED', message: 'aborted while hanging' },
        };
      case 'invalid_session':
        return { kind: 'completed', summary, sessionId };
    }
  }

  private runsPush(req: RunRequest, step: MockStepType): void {
    this.runs.push({
      taskTitle: req.taskTitle,
      attemptIndex: req.attemptIndex,
      resumed: req.resumeSessionId,
      step,
      prompt: req.prompt,
      readOnly: !!req.readOnly,
      allowWeb: !!req.allowWeb,
    });
  }
}
