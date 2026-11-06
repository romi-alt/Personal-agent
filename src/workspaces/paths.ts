import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export class WorkspaceViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceViolationError';
  }
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);

/**
 * Resolve symlinks for the deepest existing ancestor, then re-append the not-yet-existing tail.
 * This defeats `..` traversal and symlink escapes even for paths that do not exist yet.
 */
export function canonicalize(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  const real = existsSync(cur) ? realpathSync.native(cur) : cur;
  return path.join(real, ...tail);
}

export function isPathInside(child: string, parent: string): boolean {
  const c = norm(canonicalize(child));
  const p = norm(canonicalize(parent));
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve `relative` under `root`, throwing if the result would escape it. */
export function resolveInside(root: string, relative: string): string {
  if (path.isAbsolute(relative) && !isPathInside(relative, root)) {
    throw new WorkspaceViolationError(`Path ${relative} is outside ${root}`);
  }
  const full = path.resolve(root, relative);
  if (!isPathInside(full, root)) throw new WorkspaceViolationError(`Path ${relative} escapes ${root}`);
  return full;
}
