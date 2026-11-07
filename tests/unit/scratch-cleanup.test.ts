import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanScratchDir, type ScratchCleanupRequest } from '../../src/workspaces/scratch-cleanup.js';
import { runScratchClean } from '../../src/workspaces/scratch-clean-main.js';
import { removeTempDir } from '../helpers/fs.js';

/**
 * Scoped scratch cleanup: the replacement for workers' `rm -rf <scratch>` (approval apr_mw67xtxk4c1e992a8e).
 * Every refusal case also asserts that nothing was deleted.
 */
let home: string;
let root: string;
let ws: string;
let outside: string;

/** Directory link: symlink where permitted, otherwise an NTFS junction (no privilege needed on Windows). */
function dirLink(target: string, at: string): void {
  try {
    symlinkSync(target, at, 'dir');
  } catch {
    symlinkSync(target, at, 'junction');
  }
}

function req(target: string, extra: Partial<ScratchCleanupRequest> = {}): ScratchCleanupRequest {
  return { agentHome: home, workspace: ws, allowedRoots: [root], target, actor: 'test', ...extra };
}

function auditLines(): Array<Record<string, unknown>> {
  const f = path.join(home, 'logs', 'scratch-cleanup.jsonl');
  return existsSync(f)
    ? readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'elevariq-scratch-'));
  root = path.join(home, 'workspaces');
  ws = path.join(root, 'proj');
  mkdirSync(path.join(ws, 'test'), { recursive: true });
  writeFileSync(path.join(ws, 'sum.js'), 'module.exports = 1;');
  outside = mkdtempSync(path.join(tmpdir(), 'elevariq-scratch-outside-'));
  writeFileSync(path.join(outside, 'precious.txt'), 'keep');
});
afterEach(() => {
  removeTempDir(home);
  removeTempDir(outside);
});

describe('cleanScratchDir', () => {
  it('deletes exactly a valid scratch directory and audits intent + outcome', () => {
    mkdirSync(path.join(ws, '.qa-mut', 'test'), { recursive: true });
    writeFileSync(path.join(ws, '.qa-mut', 'test', 'a.js'), 'x');
    const r = cleanScratchDir(req('.qa-mut'));
    expect(r.status).toBe('deleted');
    expect(r.entries).toBe(2);
    expect(existsSync(path.join(ws, '.qa-mut'))).toBe(false);
    expect(existsSync(path.join(ws, 'sum.js'))).toBe(true);
    expect(existsSync(path.join(ws, 'test'))).toBe(true);
    expect(auditLines().map((l) => l['status'])).toEqual(['deleting', 'deleted']);
    expect(auditLines()[0]!['actor']).toBe('test');
  });

  it('accepts a nested scratch directory given as an absolute path', () => {
    mkdirSync(path.join(ws, 'test', '.tmp-run1'), { recursive: true });
    expect(cleanScratchDir(req(path.join(ws, 'test', '.tmp-run1'))).status).toBe('deleted');
  });

  it('refuses the parent directory of a scratch dir', () => {
    mkdirSync(path.join(ws, 'test', '.qa-x'), { recursive: true });
    const r = cleanScratchDir(req('test'));
    expect(r.status).toBe('refused');
    expect(r.reason).toMatch(/not a generated scratch directory/);
    expect(existsSync(path.join(ws, 'test', '.qa-x'))).toBe(true);
  });

  it('refuses "..", the workspace root, the workspace root via traversal, and the managed root', () => {
    for (const t of ['.', '..', '.qa-mut/..', ws, root, home]) {
      const r = cleanScratchDir(req(t));
      expect(r.status, t).toBe('refused');
    }
    expect(existsSync(ws)).toBe(true);
    expect(auditLines().every((l) => l['status'] === 'refused')).toBe(true);
  });

  it('refuses a workspace that IS the managed root or AGENT_HOME', () => {
    mkdirSync(path.join(root, '.qa-x'));
    expect(cleanScratchDir(req('.qa-x', { workspace: root })).reason).toMatch(/not inside an allowed/);
    expect(
      cleanScratchDir(req('.qa-x', { workspace: home, allowedRoots: [path.dirname(home)] })).reason,
    ).toMatch(/AGENT_HOME/);
    expect(existsSync(path.join(root, '.qa-x'))).toBe(true);
  });

  it('refuses directories outside the workspace, including scratch-named ones and traversal to them', () => {
    mkdirSync(path.join(outside, '.qa-evil'));
    mkdirSync(path.join(root, 'other', '.qa-y'), { recursive: true });
    for (const t of [
      outside,
      path.join(outside, '.qa-evil'),
      path.relative(ws, path.join(outside, '.qa-evil')),
      '../other/.qa-y',
    ]) {
      const r = cleanScratchDir(req(t));
      expect(r.status, t).toBe('refused');
      expect(r.reason, t).toMatch(/outside the project workspace/);
    }
    expect(existsSync(path.join(outside, '.qa-evil'))).toBe(true);
    expect(existsSync(path.join(root, 'other', '.qa-y'))).toBe(true);
  });

  it('refuses wildcards, variables and home shortcuts', () => {
    for (const t of ['.qa-*', '$HOME/.qa-x', '~/.qa-x', '%TEMP%\\.qa-x', '.qa-x;rm']) {
      expect(cleanScratchDir(req(t)).status, t).toBe('refused');
    }
  });

  it('refuses a scratch-named link that points outside, and leaves the link target intact', () => {
    dirLink(outside, path.join(ws, '.qa-link'));
    const r = cleanScratchDir(req('.qa-link'));
    expect(r.status).toBe('refused');
    expect(r.reason).toMatch(/link|junction/);
    expect(readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep');
  });

  it('refuses when an ancestor is a link (escape via linked parent)', () => {
    mkdirSync(path.join(outside, '.qa-inner'));
    dirLink(outside, path.join(ws, 'linked'));
    const r = cleanScratchDir(req('linked/.qa-inner'));
    expect(r.status).toBe('refused');
    expect(existsSync(path.join(outside, '.qa-inner'))).toBe(true);
  });

  it('refuses a scratch directory that contains a link anywhere inside', () => {
    mkdirSync(path.join(ws, '.qa-mut', 'deep'), { recursive: true });
    dirLink(outside, path.join(ws, '.qa-mut', 'deep', 'escape'));
    const r = cleanScratchDir(req('.qa-mut'));
    expect(r.status).toBe('refused');
    expect(r.reason).toMatch(/contains a link/);
    expect(existsSync(path.join(ws, '.qa-mut'))).toBe(true);
    expect(readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep');
  });

  it('reports a missing directory as absent, and a repeated cleanup is idempotent', () => {
    mkdirSync(path.join(ws, '.scratch-a'));
    expect(cleanScratchDir(req('.scratch-a')).status).toBe('deleted');
    expect(cleanScratchDir(req('.scratch-a')).status).toBe('absent');
    expect(cleanScratchDir(req('.scratch-never')).status).toBe('absent');
    expect(cleanScratchDir(req('nope/.scratch-b')).status).toBe('absent');
    expect(auditLines().map((l) => l['status'])).toEqual([
      'deleting',
      'deleted',
      'absent',
      'absent',
      'absent',
    ]);
  });

  it('refuses files, .git internals, and protected paths', () => {
    writeFileSync(path.join(ws, '.qa-file'), 'x');
    expect(cleanScratchDir(req('.qa-file')).reason).toMatch(/not a directory/);
    mkdirSync(path.join(ws, '.git', '.qa-x'), { recursive: true });
    expect(cleanScratchDir(req('.git/.qa-x')).reason).toMatch(/\.git/);
    mkdirSync(path.join(ws, '.qa-p'));
    expect(cleanScratchDir(req('.qa-p', { protectedPaths: [path.join(ws, '.qa-p')] })).reason).toMatch(
      /protected/,
    );
    expect(existsSync(path.join(ws, '.qa-p'))).toBe(true);
  });

  it('refuses without a valid AGENT_HOME (no audit trail, no deletion)', () => {
    mkdirSync(path.join(ws, '.qa-mut'));
    for (const h of [undefined, '', 'relative/home', path.join(home, 'missing')]) {
      expect(cleanScratchDir(req('.qa-mut', { agentHome: h })).status).toBe('refused');
    }
    expect(existsSync(path.join(ws, '.qa-mut'))).toBe(true);
  });

  it('dry run checks everything and deletes nothing', () => {
    mkdirSync(path.join(ws, '.qa-mut'));
    expect(cleanScratchDir(req('.qa-mut', { dryRun: true })).status).toBe('would_delete');
    expect(existsSync(path.join(ws, '.qa-mut'))).toBe(true);
  });

  it('enforces the entry limit', () => {
    mkdirSync(path.join(ws, '.qa-big'));
    for (let i = 0; i < 5; i++) writeFileSync(path.join(ws, '.qa-big', `${i}`), '');
    expect(cleanScratchDir(req('.qa-big', { maxEntries: 3 })).reason).toMatch(/more than 3/);
    expect(existsSync(path.join(ws, '.qa-big'))).toBe(true);
  });
});

describe('worker entry (scratch-clean-main)', () => {
  it('takes workspace/home/root from the worker environment; only the scratch dir is an argument', () => {
    const env = {
      ELEVARIQ_AGENT_HOME: home,
      ELEVARIQ_WORKSPACE: ws,
      ELEVARIQ_WORKSPACE_ROOT: root,
      ELEVARIQ_EXECUTION_ID: 'exe_1',
    };
    mkdirSync(path.join(ws, '.qa-mut'));
    expect(runScratchClean(['.qa-mut'], env).code).toBe(0);
    expect(existsSync(path.join(ws, '.qa-mut'))).toBe(false);
    expect(runScratchClean([outside], env).code).toBe(1);
    expect(runScratchClean(['a', 'b'], env).code).toBe(2);
    expect(runScratchClean(['.qa-x'], {}).code).toBe(2);
    // A worker that points the context at the managed root itself is still refused.
    mkdirSync(path.join(root, '.qa-r'));
    expect(runScratchClean(['.qa-r'], { ...env, ELEVARIQ_WORKSPACE: root }).code).toBe(1);
    expect(existsSync(path.join(root, '.qa-r'))).toBe(true);
    expect(auditLines().find((l) => l['status'] === 'deleted')!['actor']).toBe('worker:exe_1');
    expect(existsSync(path.join(outside, 'precious.txt'))).toBe(true);
  });
});
