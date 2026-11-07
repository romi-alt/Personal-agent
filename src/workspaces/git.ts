import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitState {
  isRepo: boolean;
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  /** First lines of `git status --porcelain` (bounded). */
  changes: string[];
}

async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

export async function gitState(cwd: string): Promise<GitState> {
  if (!existsSync(cwd)) return { isRepo: false, head: null, branch: null, dirty: null, changes: [] };
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { isRepo: false, head: null, branch: null, dirty: null, changes: [] };
  }
  let head: string | null = null;
  try {
    head = await git(cwd, ['rev-parse', 'HEAD']);
  } catch {
    /* repo with no commits */
  }
  let branch: string | null = null;
  try {
    branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    try {
      branch = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
    } catch {
      /* detached/unborn */
    }
  }
  const porcelain = await git(cwd, ['status', '--porcelain']);
  const lines = porcelain ? porcelain.split('\n') : [];
  return { isRepo: true, head, branch, dirty: lines.length > 0, changes: lines.slice(0, 50) };
}

/** Create a repo with an initial empty commit using an explicit local identity (never touches global git config). */
export async function initRepo(dir: string): Promise<void> {
  await git(path.dirname(dir) === dir ? dir : dir, ['init', '-q']);
  await git(dir, [
    '-c',
    'user.name=ELEVARIQ Agent',
    '-c',
    'user.email=agent@elevariq.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'Initial commit (workspace created by ELEVARIQ Personal Agent)',
  ]);
}

export async function ensureBranch(dir: string, branch: string): Promise<void> {
  const state = await gitState(dir);
  if (state.branch === branch) return;
  try {
    await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    await git(dir, ['checkout', '-q', branch]);
  } catch {
    await git(dir, ['checkout', '-q', '-b', branch]);
  }
}

export interface TreeFingerprint {
  head: string | null;
  /** Hash of tracked-file diff vs HEAD plus names+content hashes of untracked files. Detects edits to already-dirty files. */
  statusHash: string | null;
}

/** Content-level fingerprint of the working tree; two equal fingerprints mean no file content changed in between. */
export async function treeFingerprint(cwd: string): Promise<TreeFingerprint> {
  const { createHash } = await import('node:crypto');
  const { readFileSync, statSync } = await import('node:fs');
  const st = await gitState(cwd);
  if (!st.isRepo) return { head: null, statusHash: null };
  const h = createHash('sha256');
  try {
    const { stdout } = await run('git', ['diff', 'HEAD', '--no-color'], {
      cwd,
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    h.update(stdout);
  } catch {
    /* repo without commits: untracked listing below still covers it */
  }
  try {
    const { stdout } = await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const rel of stdout.split('\0').filter(Boolean).sort()) {
      h.update(`\nU:${rel}:`);
      try {
        const full = path.join(cwd, rel);
        if (statSync(full).size <= 1_000_000) h.update(readFileSync(full));
        else h.update(`size:${statSync(full).size}`);
      } catch {
        /* file vanished mid-scan */
      }
    }
  } catch {
    /* ignore */
  }
  return { head: st.head, statusHash: h.digest('hex') };
}

/** Number of commits reachable from HEAD (0 for an unborn branch). */
export async function commitCount(cwd: string): Promise<number> {
  try {
    return Number(await git(cwd, ['rev-list', '--count', 'HEAD']));
  } catch {
    return 0;
  }
}

/** True if `ref` names a commit that exists in the repository. */
export async function commitExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['cat-file', '-e', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
