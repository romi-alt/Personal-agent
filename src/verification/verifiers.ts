import { spawn } from 'node:child_process';
import { redactString } from '../security/redact.js';
import { commitCount, treeFingerprint } from '../workspaces/git.js';
import type { VerificationLevel, Verifier, VerifierResult, VerifyContext } from './types.js';

/** Environment for owner-configured build/test commands: never hand the model/provider credentials to project code. */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|ELEVARIQ_.*TOKEN)/i.test(k)) delete env[k];
  }
  return env;
}

export interface CommandRun {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: sanitizedEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const keep = (b: Buffer) => {
      out += b.toString();
      if (out.length > 16_000) out = out.slice(-8_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        outputTail: redactString(out.slice(-4_000)),
      });
    };
    child.once('error', (e) => {
      out += String(e);
      done(null);
    });
    child.once('close', (code) => done(code));
  });
}

/** CLAIMED_COMPLETE is produced from the provider outcome by the runner; this is a convenience result builder. */
export const claimedComplete = (summary: string): VerifierResult => ({
  status: 'PASSED',
  summary: 'provider reported success (a claim, not proof)',
  evidence: { providerSummary: summary.slice(0, 1000) },
});

export class ChangesExistVerifier implements Verifier {
  readonly level = 'CHANGES_EXIST' as const;
  async verify(ctx: VerifyContext): Promise<VerifierResult> {
    const now = await treeFingerprint(ctx.cwd);
    if (now.head === null && now.statusHash === null) {
      return {
        status: 'NOT_EVALUATED',
        summary: 'workspace is not a git repository; cannot detect changes',
        evidence: {},
      };
    }
    if (ctx.baseline) {
      const changed = now.head !== ctx.baseline.head || now.statusHash !== ctx.baseline.statusHash;
      return {
        status: changed ? 'PASSED' : 'FAILED',
        summary: changed
          ? 'working tree/HEAD differ from the task baseline'
          : 'no file changes since the task started although the task reported success',
        evidence: {
          baselineHead: ctx.baseline.head,
          head: now.head,
          headMoved: now.head !== ctx.baseline.head,
        },
      };
    }
    // Project-level: any commit beyond the initial one, or any uncommitted content.
    const commits = await commitCount(ctx.cwd);
    const dirty = now.statusHash !== null && now.statusHash !== EMPTY_TREE_HASH;
    const changed = commits > 1 || dirty;
    return {
      status: changed ? 'PASSED' : 'FAILED',
      summary: changed
        ? `repository has ${commits} commit(s) and/or uncommitted work`
        : 'repository contains nothing beyond its initial empty commit',
      evidence: { commits, dirty },
    };
  }
}
/** sha256 of the empty string: the fingerprint of a clean tree with no diff and no untracked files. */
const EMPTY_TREE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export class CommandVerifier implements Verifier {
  constructor(
    readonly level: 'BUILD_PASSES' | 'TESTS_PASS',
    private readonly pick: (c: VerifyContext['commands']) => string | undefined,
  ) {}
  async verify(ctx: VerifyContext): Promise<VerifierResult> {
    const command = this.pick(ctx.commands);
    if (!command)
      return {
        status: 'NOT_CONFIGURED',
        summary: `no ${this.level === 'BUILD_PASSES' ? 'build' : 'test'} command configured in the assignment`,
        evidence: {},
      };
    const r = await runCommand(command, ctx.cwd, ctx.timeoutMs, ctx.signal);
    const ok = r.exitCode === 0 && !r.timedOut;
    return {
      status: ok ? 'PASSED' : 'FAILED',
      summary: ok
        ? `\`${command}\` exited 0 in ${r.durationMs} ms`
        : r.timedOut
          ? `\`${command}\` timed out after ${ctx.timeoutMs} ms`
          : `\`${command}\` exited with code ${r.exitCode}`,
      evidence: {
        command,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        outputTail: r.outputTail,
      },
    };
  }
}

/** Honest placeholder: the check does not exist yet, so the answer is "unknown", never "pass". */
export class NotImplementedVerifier implements Verifier {
  constructor(
    readonly level: 'REQUIREMENTS_SATISFIED' | 'SECURITY_CHECKS_PASS',
    private readonly why: string,
  ) {}
  async verify(): Promise<VerifierResult> {
    return { status: 'NOT_EVALUATED', summary: this.why, evidence: { implemented: false } };
  }
}

export function defaultVerifiers(): Record<
  Exclude<VerificationLevel, 'CLAIMED_COMPLETE' | 'OWNER_APPROVAL'>,
  Verifier
> {
  return {
    CHANGES_EXIST: new ChangesExistVerifier(),
    BUILD_PASSES: new CommandVerifier('BUILD_PASSES', (c) => c.build),
    TESTS_PASS: new CommandVerifier('TESTS_PASS', (c) => c.test),
    REQUIREMENTS_SATISFIED: new NotImplementedVerifier(
      'REQUIREMENTS_SATISFIED',
      'requirement-by-requirement verification is a Phase 2 capability and is NOT implemented',
    ),
    SECURITY_CHECKS_PASS: new NotImplementedVerifier(
      'SECURITY_CHECKS_PASS',
      'security verification is a Phase 2 capability and is NOT implemented',
    ),
  };
}
