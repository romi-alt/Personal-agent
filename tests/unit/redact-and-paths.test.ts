import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger, silentLogger } from '../../src/logging/logger.js';
import { redactString, redactValue } from '../../src/security/redact.js';
import { isPathInside, resolveInside, WorkspaceViolationError } from '../../src/workspaces/paths.js';
import { evaluateToolUse } from '../../src/security/policy.js';
import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';

describe('log redaction', () => {
  it('redacts known secret formats in strings', () => {
    const s =
      'key sk-ant-api03-ABCDEFGHIJKLMNOP and Bearer abcdef1234567890 ANTHROPIC_API_KEY=sk-ant-xyz12345678';
    const r = redactString(s);
    expect(r).not.toMatch(/ABCDEFGHIJKLMNOP|abcdef1234567890|xyz12345678/);
    expect(r).toContain('[REDACTED]');
  });
  it('redacts by key name, deeply, including Error objects', () => {
    const r = redactValue({
      a: { apiKey: 'x', token: 'y', ok: 'fine', nested: [{ password: 'p' }] },
      err: new Error('boom sk-ant-api03-ZZZZZZZZZZZZ'),
    }) as Record<string, any>;
    expect(r.a.apiKey).toBe('[REDACTED]');
    expect(r.a.token).toBe('[REDACTED]');
    expect(r.a.ok).toBe('fine');
    expect(r.a.nested[0].password).toBe('[REDACTED]');
    expect(JSON.stringify(r.err)).not.toContain('ZZZZZZZZZZZZ');
  });
  it('never emits secrets through the logger (captured output and file sink)', () => {
    const lines: string[] = [];
    const log = silentLogger((l) => lines.push(l));
    log.info('auth.check', {
      apiKey: 'sk-ant-api03-SECRETSECRETSECRET',
      note: 'used Bearer tok_1234567890abcdef',
    });
    expect(lines.join('')).not.toMatch(/SECRETSECRET|tok_1234567890abcdef/);
    const dir = mkdtempSync(path.join(tmpdir(), 'log-'));
    const real = createLogger({
      logDir: dir,
      logLevel: 'info',
      logMaxFileBytes: 1e6,
      logRetentionDays: 1,
      logToConsole: false,
    });
    real.error('x', { authorization: 'Bearer abcdefghijklmnop', msg: 'sk-ant-api03-FILEFILEFILEFILE' });
    const f = path.join(dir, 'app', readdirSync(path.join(dir, 'app'))[0]!);
    expect(readFileSync(f, 'utf8')).not.toMatch(/abcdefghijklmnop|FILEFILEFILEFILE/);
  });
  it('prunes log files older than the retention window', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'log-'));
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    const old = path.join(dir, 'app', 'agent-2020-01-01.log');
    writeFileSync(old, 'old\n');
    const past = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, past, past);
    createLogger({
      logDir: dir,
      logLevel: 'info',
      logMaxFileBytes: 1e6,
      logRetentionDays: 14,
      logToConsole: false,
    });
    expect(readdirSync(path.join(dir, 'app'))).not.toContain('agent-2020-01-01.log');
  });
});

describe('workspace path safety', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-'));
  it('accepts paths inside and rejects traversal', () => {
    expect(isPathInside(path.join(root, 'a/b'), root)).toBe(true);
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(path.join(root, '..', 'evil'), root)).toBe(false);
    expect(isPathInside(root + '-sibling', root)).toBe(false);
    expect(() => resolveInside(root, '../../etc/passwd')).toThrow(WorkspaceViolationError);
    expect(() => resolveInside(root, '/etc/passwd')).toThrow(WorkspaceViolationError);
    expect(resolveInside(root, 'src/x.ts')).toBe(path.join(root, 'src/x.ts'));
  });
  it('detects symlink escapes', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'outside-'));
    symlinkSync(outside, path.join(root, 'link'));
    expect(isPathInside(path.join(root, 'link', 'secret.txt'), root)).toBe(false);
  });
});

describe('tool permission policy', () => {
  const ws = '/tmp/ws-policy-root';
  it('allows in-workspace file tools and denies outside paths', () => {
    expect(evaluateToolUse('Write', { file_path: 'src/a.ts' }, ws).allow).toBe(true);
    expect(evaluateToolUse('Write', { file_path: '/etc/passwd' }, ws).allow).toBe(false);
    expect(evaluateToolUse('Read', { file_path: '../other/x' }, ws).allow).toBe(false);
  });
  it.each([
    ['npm publish', 'publish_release'],
    ['git push origin main', 'protected_branch_push'],
    ['kubectl apply -f prod.yaml', 'production_deploy'],
    ['rm -rf /var/data', 'destructive_delete'],
    ['npx prisma migrate deploy', 'live_database_migration'],
    ['sudo apt-get install foo', 'system_modification'],
  ])('requires owner approval for: %s', (command, type) => {
    const d = evaluateToolUse('Bash', { command }, ws);
    expect(d.allow).toBe(false);
    expect(d.approvalType).toBe(type);
    expect(evaluateToolUse('Bash', { command }, ws, { approvedTypes: [type] }).allow).toBe(true);
  });
  it('allows ordinary local development commands', () => {
    for (const c of ['npm test', 'npm install', 'git status', 'git commit -m x', 'node index.js', 'ls -la']) {
      expect(evaluateToolUse('Bash', { command: c }, ws).allow).toBe(true);
    }
  });
});
