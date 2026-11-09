import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Narrowly scoped deletion of a generated scratch directory inside a project workspace.
 *
 * This replaces `rm -rf <dir>` for the one legitimate case workers hit in practice (a throw-away directory created
 * for a test or a mutation check). It deletes exactly one directory and only when ALL of these hold:
 *  - AGENT_HOME is set, absolute, an existing directory (the audit log lives there; no audit => no delete);
 *  - the project workspace is an existing, non-link directory strictly inside one of the allowed workspace roots
 *    (never a root itself, never AGENT_HOME or an ancestor of it);
 *  - the target is given as a plain path (no wildcards, variables, `~`, NUL) and resolves strictly inside the workspace,
 *    is not the workspace itself and has no `.git` component;
 *  - the target's own name follows the scratch convention `.qa-*`, `.scratch-*` or `.tmp-*`;
 *  - neither the target nor any directory between the workspace and the target is a symbolic link or junction, and the
 *    canonical (link-resolved) path equals the lexical one;
 *  - the target is not, and does not contain, a protected path (AGENT_HOME, workspace roots, the user profile, drive
 *    roots, and any extra protected paths supplied by the caller);
 *  - the tree under the target has at most `maxEntries` entries; symbolic links / junctions inside it are never
 *    followed: they are recorded in the audit line and removed as links before the directory is deleted (v2, A8).
 * A missing target is reported as `absent` (idempotent repeat). Every call, including refusals, appends one JSON line
 * to `<AGENT_HOME>/logs/scratch-cleanup.jsonl`; the intent is written BEFORE deletion and deletion does not happen if
 * that write fails.
 *
 * This is a guard against mistakes, not a sandbox: a worker that can run arbitrary programs can delete files without
 * this tool. See docs/SECURITY.md.
 */
export const SCRATCH_NAME = /^\.(qa|scratch|tmp)-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN_CHARS = /[*?[\]{}$%~`\0\r\n|<>;&]/;
const DEFAULT_MAX_ENTRIES = 50_000;

export type ScratchCleanupStatus = 'deleted' | 'absent' | 'refused' | 'would_delete';

export interface ScratchCleanupRequest {
  agentHome: string | undefined;
  /** The project workspace the scratch directory belongs to. */
  workspace: string;
  /** Managed directories that CONTAIN project workspaces (WORKSPACE_ROOT); the workspace must be strictly inside. */
  allowedRoots: string[];
  /** Owner-approved workspace directories (`workspace:approve`); the workspace may equal or be inside one. */
  approvedWorkspaces?: string[];
  /** Scratch directory, relative to the workspace (preferred) or absolute. */
  target: string;
  /** Who asked (worker execution id, `owner`, ...); recorded in the audit line. */
  actor: string;
  /** Additional paths that must never be deleted or contain the target's deletion. */
  protectedPaths?: string[];
  /** Check everything and report `would_delete` without deleting. */
  dryRun?: boolean;
  maxEntries?: number;
}

export interface ScratchCleanupResult {
  status: ScratchCleanupStatus;
  reason: string;
  /** Absolute target path (when it could be resolved). */
  resolved: string | null;
  entries?: number;
  auditFile: string | null;
}

class Refusal extends Error {}
const refuse = (msg: string): never => {
  throw new Refusal(msg);
};

const ci = process.platform === 'win32' || process.platform === 'darwin';
const key = (p: string) => {
  const n = path.resolve(p).replace(/[\\/]+$/, '');
  return ci ? n.toLowerCase() : n;
};
const same = (a: string, b: string) => key(a) === key(b);
/** a is strictly inside b. */
const strictlyInside = (a: string, b: string) => {
  const rel = path.relative(key(b), key(a));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const isLink = (p: string) => lstatSync(p).isSymbolicLink();

/** Remove a symbolic link or junction itself (never its target). Directory junctions need rmdir on Windows. */
function unlinkOnly(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EISDIR' || code === 'EACCES') rmdirSync(p);
    else throw e;
  }
}

export function cleanScratchDir(req: ScratchCleanupRequest): ScratchCleanupResult {
  let auditFile: string | null = null;
  let resolved: string | null = null;
  const base = {
    at: new Date().toISOString(),
    actor: req.actor,
    workspace: req.workspace,
    target: req.target,
  };
  const audit = (rec: Record<string, unknown>) => {
    if (!auditFile) return;
    appendFileSync(auditFile, JSON.stringify({ ...base, resolved, ...rec }) + '\n');
  };
  try {
    // 1. AGENT_HOME (audit destination) must be valid; without an audit trail nothing is deleted.
    const home = req.agentHome;
    if (!home || !path.isAbsolute(home)) refuse('AGENT_HOME is not set to an absolute path');
    if (!existsSync(home!) || !statSync(home!).isDirectory()) refuse('AGENT_HOME does not exist');
    const realHome = realpathSync.native(home!);
    const logs = path.join(realHome, 'logs');
    mkdirSync(logs, { recursive: true });
    auditFile = path.join(logs, 'scratch-cleanup.jsonl');

    // 2. Workspace: existing real directory strictly inside an allowed root.
    if (!path.isAbsolute(req.workspace)) refuse('workspace must be an absolute path');
    if (!existsSync(req.workspace)) refuse('workspace does not exist');
    if (isLink(req.workspace)) refuse('workspace is a symbolic link or junction');
    if (!statSync(req.workspace).isDirectory()) refuse('workspace is not a directory');
    const ws = realpathSync.native(req.workspace);
    const real = (list: string[] | undefined) =>
      (list ?? []).filter((r) => path.isAbsolute(r) && existsSync(r)).map((r) => realpathSync.native(r));
    const managed = real(req.allowedRoots);
    const approved = real(req.approvedWorkspaces);
    const roots = [...managed, ...approved];
    if (roots.length === 0) refuse('no allowed workspace root exists');
    const inManaged = managed.some((r) => strictlyInside(ws, r));
    const inApproved = approved.some((r) => same(ws, r) || strictlyInside(ws, r));
    if (!inManaged && !inApproved) refuse('workspace is not inside an allowed workspace root');
    if (same(ws, realHome) || strictlyInside(realHome, ws)) refuse('workspace is AGENT_HOME or contains it');

    // 3. Target string hygiene + lexical containment.
    const raw = req.target;
    if (typeof raw !== 'string' || raw.trim() === '') refuse('target is empty');
    if (FORBIDDEN_CHARS.test(raw)) refuse('target contains wildcard, variable, home or shell characters');
    const lexical = path.resolve(ws, raw);
    resolved = lexical;
    if (same(lexical, ws)) refuse('target is the workspace root');
    if (!strictlyInside(lexical, ws)) refuse('target is outside the project workspace');
    const parts = path.relative(ws, lexical).split(/[\\/]+/);
    if (parts.some((p) => p === '..' || p === '')) refuse('target contains path traversal');
    if (parts.some((p) => p.toLowerCase() === '.git')) refuse('target is inside .git');
    const name = parts[parts.length - 1]!;
    if (!SCRATCH_NAME.test(name))
      refuse(`"${name}" is not a generated scratch directory name (.qa-*, .scratch-*, .tmp-*)`);

    // 4. Protected paths: never the target, never inside the target.
    const protectedList = [
      realHome,
      ...roots,
      ws,
      os.homedir(),
      path.parse(lexical).root,
      ...(req.protectedPaths ?? []),
    ].filter(Boolean);
    for (const p of protectedList) {
      if (same(lexical, p) || strictlyInside(p, lexical))
        refuse(`target is or contains a protected path (${p})`);
    }

    // 5. Ancestors between workspace and target must exist as real directories (no links).
    let cur = ws;
    for (const part of parts.slice(0, -1)) {
      cur = path.join(cur, part);
      if (!existsSync(cur)) {
        audit({ status: 'absent', reason: 'parent directory does not exist' });
        return { status: 'absent', reason: 'parent directory does not exist', resolved, auditFile };
      }
      if (isLink(cur)) refuse(`ancestor ${cur} is a symbolic link or junction`);
      if (!statSync(cur).isDirectory()) refuse(`ancestor ${cur} is not a directory`);
    }

    // 6. Target itself.
    let st;
    try {
      st = lstatSync(lexical);
    } catch {
      audit({ status: 'absent', reason: 'target does not exist' });
      return { status: 'absent', reason: 'target does not exist (nothing to delete)', resolved, auditFile };
    }
    if (st.isSymbolicLink()) refuse('target is a symbolic link or junction');
    if (!st.isDirectory()) refuse('target is not a directory');
    if (!same(realpathSync.native(lexical), lexical)) refuse('target resolves through a link');

    // 7. Tree scan, bounded size. Links/junctions inside the tree (e.g. npm-workspace junctions such as
    // node_modules/@scope/pkg -> ../../apps/pkg in a fresh clone, A8) are never traversed: they are recorded, then
    // removed as links in step 8, so their targets are untouched.
    const max = req.maxEntries ?? DEFAULT_MAX_ENTRIES;
    let entries = 0;
    const links: { path: string; target: string | null }[] = [];
    const stack = [lexical];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        entries++;
        if (entries > max) refuse(`target has more than ${max} entries`);
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink() || isLink(full)) {
          let target: string | null = null;
          try {
            target = realpathSync.native(full);
          } catch {
            /* dangling link */
          }
          links.push({ path: full, target });
          continue; // never descend through a link
        }
        if (e.isDirectory()) stack.push(full);
      }
    }

    if (req.dryRun) {
      audit({ status: 'would_delete', entries, links });
      return { status: 'would_delete', reason: 'all checks passed (dry run)', resolved, entries, auditFile };
    }

    // 8. Intent first (fails closed), then unlink links WITHOUT following them, then delete exactly this directory.
    audit({ status: 'deleting', entries, links });
    for (const l of links) {
      if (!isLink(l.path)) refuse(`link ${l.path} changed during cleanup`);
      unlinkOnly(l.path);
      if (l.target && !existsSync(l.target)) refuse(`link target ${l.target} vanished while unlinking`);
    }
    rmSync(lexical, { recursive: true, force: false, maxRetries: 3 });
    if (existsSync(lexical)) refuse('directory still exists after deletion');
    audit({ status: 'deleted', entries });
    return { status: 'deleted', reason: 'scratch directory deleted', resolved, entries, auditFile };
  } catch (err) {
    const reason = err instanceof Refusal ? err.message : `error: ${(err as Error).message}`;
    try {
      audit({ status: 'refused', reason });
    } catch {
      /* the result still reports the refusal */
    }
    return { status: 'refused', reason, resolved, auditFile };
  }
}
