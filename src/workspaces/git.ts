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

/** Split off the first `n` space-separated fields; the remainder (a path, which may contain spaces) is returned last. */
function fields(line: string, n: number): string[] {
  const out: string[] = [];
  let rest = line;
  for (let i = 0; i < n; i++) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return [...out, rest];
    out.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  return [...out, rest];
}

/** Render one `git status --porcelain=v2` entry in the familiar short (`XY path`) form. */
export function shortStatusLine(entry: string): string | null {
  const kind = entry[0];
  if (kind === '?') return `?? ${entry.slice(2)}`;
  if (kind === '!') return `!! ${entry.slice(2)}`;
  const xy = (s: string | undefined) => (s ?? '??').replace(/\./g, ' ');
  if (kind === '1') {
    const f = fields(entry, 8);
    return `${xy(f[1])} ${f[8] ?? ''}`;
  }
  if (kind === '2') {
    const f = fields(entry, 9);
    const [to, from] = (f[9] ?? '').split('\t');
    return `${xy(f[1])} ${from ?? '?'} -> ${to ?? ''}`;
  }
  if (kind === 'u') {
    const f = fields(entry, 10);
    return `${xy(f[1])} ${f[10] ?? ''}`;
  }
  return null;
}

/**
 * One `git status --porcelain=v2 --branch` call yields HEAD, branch and changes. Process creation is expensive on
 * Windows (~150 ms per git spawn with real-time antivirus scanning), and this runs several times per task.
 */
export async function gitState(cwd: string): Promise<GitState> {
  const none: GitState = { isRepo: false, head: null, branch: null, dirty: null, changes: [] };
  if (!existsSync(cwd)) return none;
  let out: string;
  try {
    out = await git(cwd, ['status', '--porcelain=v2', '--branch']);
  } catch {
    return none;
  }
  let head: string | null = null;
  let branch: string | null = null;
  const changes: string[] = [];
  for (const line of out ? out.split('\n') : []) {
    if (line.startsWith('# branch.oid ')) {
      const v = line.slice('# branch.oid '.length).trim();
      head = v === '(initial)' ? null : v;
    } else if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length).trim();
      branch = v === '(detached)' ? 'HEAD' : v;
    } else if (!line.startsWith('#')) {
      const s = shortStatusLine(line);
      if (s) changes.push(s);
    }
  }
  return { isRepo: true, head, branch, dirty: changes.length > 0, changes: changes.slice(0, 50) };
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
