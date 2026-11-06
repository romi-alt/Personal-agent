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
