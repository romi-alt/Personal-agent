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

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style secret key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: 'Slack token', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe live key', re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}/ },
];
const SCAN_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'vendor',
  '.next',
  'target',
  '.venv',
  'venv',
]);

/**
 * SECURITY_CHECKS_PASS (scope stated in every result): static secret scan of the working tree (high-signal credential
 * patterns, committed .env files). Dependency vulnerability audits need network access and are NOT part of this check.
 */
export class SecretScanVerifier implements Verifier {
  readonly level = 'SECURITY_CHECKS_PASS' as const;
  async verify(ctx: VerifyContext): Promise<VerifierResult> {
    const { readdirSync, readFileSync, statSync, existsSync } = await import('node:fs');
    const path = await import('node:path');
    if (!existsSync(ctx.cwd)) return { status: 'NOT_EVALUATED', summary: 'workspace missing', evidence: {} };
    const findings: { file: string; line: number; kind: string }[] = [];
    let files = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 15 || files > 20_000) return;
      for (const name of readdirSync(dir)) {
        if (SCAN_SKIP.has(name)) continue;
        const abs = path.join(dir, name);
        const rel = path.relative(ctx.cwd, abs).replace(/\\/g, '/');
        const st = statSync(abs);
        if (st.isDirectory()) {
          walk(abs, depth + 1);
          continue;
        }
        files++;
        if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name))
          findings.push({ file: rel, line: 0, kind: 'environment file in the repository' });
        if (st.size > 1024 * 1024) continue;
        let text: string;
        try {
          text = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue; // binary
        const lines = text.split('\n');
        lines.forEach((l, i) => {
          for (const p of SECRET_PATTERNS)
            if (p.re.test(l)) findings.push({ file: rel, line: i + 1, kind: p.name });
        });
      }
    };
    walk(ctx.cwd, 0);
    return findings.length
      ? {
          status: 'FAILED',
          summary: `secret scan: ${findings.length} finding(s) in ${files} files (values not recorded)`,
          evidence: {
            scope: 'secret scan of working tree; dependency audit not performed',
            findings: findings.slice(0, 100),
          },
        }
      : {
          status: 'PASSED',
          summary: `secret scan: 0 findings in ${files} files (scope: credential patterns + committed .env files; dependency audit not performed)`,
          evidence: { scope: 'secret scan of working tree; dependency audit not performed', files },
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
    // Project-level requirement coverage needs the database: verifyProject() aggregates independent-QA evidence.
    REQUIREMENTS_SATISFIED: new NotImplementedVerifier(
      'REQUIREMENTS_SATISFIED',
      'no planned requirements with independent reviews to aggregate',
    ),
    SECURITY_CHECKS_PASS: new SecretScanVerifier(),
  };
}
