import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../database/connection.js';
import { newId } from '../core/ids.js';
import { type Clock, systemClock } from '../types/index.js';
import { canonicalize, isPathInside, WorkspaceViolationError } from './paths.js';
import { ensureBranch, gitState, initRepo } from './git.js';
import type { Store } from '../queue/store.js';
import type { Project } from '../types/index.js';

export interface WorkspaceEntry {
  id: string;
  path: string;
  name: string;
  approvedAt: number;
  approvedBy: string;
}

/**
 * Registry of explicitly approved workspace roots. A project's repository path must live
 * inside one of them; the managed WORKSPACE_ROOT is always approved.
 */
export class WorkspaceRegistry {
  constructor(
    private readonly db: Db,
    private readonly managedRoot: string,
    private readonly clock: Clock = systemClock,
  ) {
    mkdirSync(managedRoot, { recursive: true });
  }

  get root(): string {
    return canonicalize(this.managedRoot);
  }

  register(dir: string, name: string, approvedBy: string): WorkspaceEntry {
    const p = canonicalize(dir);
    mkdirSync(p, { recursive: true });
    const existing = this.list().find((w) => w.path === p);
    if (existing) return existing;
    const id = newId('wsp');
    this.db
      .prepare('INSERT INTO workspaces(id,path,name,approved_at,approved_by) VALUES (?,?,?,?,?)')
      .run(id, p, name, this.clock.now(), approvedBy);
    return this.list().find((w) => w.id === id)!;
  }

  list(): WorkspaceEntry[] {
    return (
      this.db.prepare('SELECT * FROM workspaces ORDER BY approved_at').all() as Record<string, unknown>[]
    ).map((r) => ({
      id: r['id'] as string,
      path: r['path'] as string,
      name: r['name'] as string,
      approvedAt: r['approved_at'] as number,
      approvedBy: r['approved_by'] as string,
    }));
  }

  approvedRoots(): string[] {
    return [this.root, ...this.list().map((w) => w.path)];
  }

  isApproved(target: string): boolean {
    return this.approvedRoots().some((r) => isPathInside(target, r));
  }

  assertApproved(target: string): string {
    if (!this.isApproved(target)) {
      throw new WorkspaceViolationError(
        `Path ${target} is not inside an approved workspace. Approve it with: workspace:approve <path>`,
      );
    }
    return canonicalize(target);
  }

  /** Create a fresh isolated project directory (git-initialised) under the managed root. */
  async createManagedProject(
    store: Store,
    input: { name: string; description?: string; priority?: number; provider: string },
  ): Promise<Project> {
    const slugBase =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'project';
    let dir = path.join(this.root, slugBase);
    let n = 1;
    while (this.db.prepare('SELECT 1 FROM projects WHERE repo_path = ?').get(dir))
      dir = path.join(this.root, `${slugBase}-${++n}`);
    this.assertApproved(dir);
    mkdirSync(dir, { recursive: true });
    const state = await gitState(dir);
    if (!state.isRepo) await initRepo(dir);
    const project = store.createProject({ ...input, repoPath: dir });
    await ensureBranch(dir, `agent/${project.slug}`);
    return project;
  }

  /**
   * Attach an existing repository that lives inside an approved workspace.
   * Refuses a dirty working tree unless `allowDirty` (original changes are never discarded).
   * Work happens on a dedicated `agent/<slug>` branch, never on the current branch.
   */
  async registerExistingProject(
    store: Store,
    input: {
      name: string;
      repoPath: string;
      description?: string;
      priority?: number;
      provider: string;
      allowDirty?: boolean;
    },
  ): Promise<Project> {
    const repoPath = this.assertApproved(input.repoPath);
    const state = await gitState(repoPath);
    if (state.isRepo && state.dirty && !input.allowDirty) {
      throw new WorkspaceViolationError(
        `Repository ${repoPath} has uncommitted changes. Commit/stash them or pass --allow-dirty to proceed on a dedicated branch without discarding them.`,
      );
    }
    if (!state.isRepo) await initRepo(repoPath);
    const project = store.createProject({ ...input, repoPath });
    // Switching branches is safe with a dirty tree only if it carries the changes; checkout -b does.
    await ensureBranch(repoPath, `agent/${project.slug}`);
    return project;
  }
}
