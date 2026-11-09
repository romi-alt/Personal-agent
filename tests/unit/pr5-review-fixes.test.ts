import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateToolUse } from '../../src/security/policy.js';
import { ownerCredentialDirs } from '../../src/providers/claude-cli/cli-provider.js';
import { redactString } from '../../src/security/redact.js';

/** Regression tests for the independent PR #5 security review (worker-isolation/01_PR5_SECURITY_REVIEW.md). */
const home = path.resolve('C:/Users/owner/AppData/Local/ElevariqAgent');
const repo = path.resolve('E:/Agent/Personal-agent');
const ws = path.join(home, 'workspaces', 'proj');
const prot = [home, repo, ...ownerCredentialDirs(path.resolve('C:/Users/owner'))];
const kind = (d: { allow: boolean; approvalType?: string }) =>
  d.allow ? 'ALLOW' : d.approvalType ? `APPROVAL(${d.approvalType})` : 'DENY';
const bash = (command: string, approvedTypes: string[] = [], protectedPaths = prot) =>
  kind(evaluateToolUse('Bash', { command }, ws, { approvedTypes, protectedPaths }));

describe('finding 1: every V2.1 category in a chained command must be approved', () => {
  it.each([
    [
      'rm --recursive x && git -c alias.p=push p origin main',
      ['destructive_delete'],
      'APPROVAL(protected_branch_push)',
    ],
    [
      'git -c alias.p=push p && schtasks /create /tn x /tr y',
      ['protected_branch_push'],
      'APPROVAL(system_modification)',
    ],
    [
      'schtasks /create /tn x /tr y && rm --recursive x',
      ['system_modification'],
      'APPROVAL(destructive_delete)',
    ],
  ])('%s with %j approved -> %s', (c, a, k) => expect(bash(c, a)).toBe(k));
  it('all categories approved -> allowed', () =>
    expect(
      bash('rm --recursive x && git -c alias.p=push p', ['destructive_delete', 'protected_branch_push']),
    ).toBe('ALLOW'));
});

describe('finding 2: computed command names', () => {
  it.each([
    '"$(tr a-z n-za-m <<< ez)" --recursive /tmp/x',
    "x=$(printf '\\x72\\x6d'); $x -rf /tmp/x",
    'c=`printf rm`; "$c" -rf /tmp/x',
  ])('%s -> DENY', (c) => expect(bash(c)).toBe('DENY'));
  it('ordinary substitutions as arguments stay allowed', () => {
    expect(bash('X=$(git rev-parse HEAD); echo $X')).toBe('ALLOW');
    expect(bash('echo "built at $(date)"')).toBe('ALLOW');
  });
});

describe('finding 3: protected paths containing spaces', () => {
  const spaced = path.resolve('C:/Users/John Smith/.claude');
  it.each([
    'cat "/c/Users/John Smith/.cla*/x"',
    'cat /c/Users/John\\ Smith/.claude/x',
    "cat 'C:/Users/John Smith/.claude/x'",
  ])('%s -> DENY', (c) => expect(bash(c, [], [home, repo, spaced])).toBe('DENY'));
});

describe('finding 4: every per-user credential store', () => {
  it.each([
    'cat ~/.ssh/id_ed25519',
    'cat ~/.npmrc',
    'cat ~/.config/gh/hosts.yml',
    'cat ~/.aws/credentials',
    'type %USERPROFILE%\\.docker\\config.json',
    'cat "/c/Users/owner/.ssh/known_hosts"',
    'cp /c/Users/owner/.kube/config ./k',
  ])('%s -> DENY', (c) => expect(bash(c)).toBe('DENY'));
  it('the provider protects the credential directories', () =>
    expect(ownerCredentialDirs('C:/h').map((p) => path.basename(p))).toEqual(
      expect.arrayContaining(['.claude', '.ssh', '.aws', '.docker', 'gh']),
    ));
});

describe('finding 5: redact before truncating audit input', () => {
  it('no secret fragment survives the cut', () => {
    const key = 'sk-ant-' + 'A'.repeat(40);
    const input = JSON.stringify({ command: 'x'.repeat(1975) + ' ' + key });
    expect(redactString(input).slice(0, 2000)).not.toContain('sk-ant-A');
  });
});

describe('finding 6: credential markers inside quoted data are not commands', () => {
  it.each([
    'git commit -m "docs: explain ~/.claude settings for contributors"',
    'echo "store your key in ~/.ssh with mode 600"',
  ])('%s -> ALLOW', (c) => expect(bash(c)).toBe('ALLOW'));
  it('but executed forms stay denied', () => {
    expect(bash('cat ~/.claude/settings.json')).toBe('DENY');
    expect(bash('bash -c "cat ~/.ssh/id_rsa"')).toBe('DENY');
  });
});

describe('npm script bodies (review confirmation)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pr5r-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { deploy: 'git -c alias.p=push p' } }),
  );
  it('V2.1-only categories inside bodies are found', () =>
    expect(evaluateToolUse('Bash', { command: 'npm run deploy' }, dir, {}).approvalType).toBe(
      'protected_branch_push',
    ));
});
