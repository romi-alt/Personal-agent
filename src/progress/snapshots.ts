import { newId } from '../core/ids.js';
import type { Store } from '../queue/store.js';
import type { WorkflowRepository } from '../workflows/repository.js';
import { computeProgress, summarize, type ProjectProgress } from './model.js';

const MAX_SNAPSHOTS_PER_PROJECT = 500;

export interface SnapshotRow {
  id: string;
  projectId: string;
  at: number;
  verifiedPercent: number;
  claimedPercent: number;
}

/**
 * Append a snapshot only when something material changed (task state, verification, milestone or requirement state),
 * refresh the project's one-line summary and current milestone, and keep the history bounded.
 * Returns the progress that was computed, plus whether a new snapshot row was written.
 */
export function recordSnapshotIfChanged(
  store: Store,
  repo: WorkflowRepository,
  projectId: string,
): { progress: ProjectProgress; recorded: boolean } {
  const progress = computeProgress(store, repo, projectId);
  const last = store.db
    .prepare(
      'SELECT fingerprint FROM progress_snapshots WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT 1',
    )
    .get(projectId) as { fingerprint: string } | undefined;
  if (last?.fingerprint === progress.fingerprint) return { progress, recorded: false };
  if (progress.totals.tasks === 0 && !last) return { progress, recorded: false }; // nothing to report yet

  store.db
    .transaction(() => {
      store.db
        .prepare(
          'INSERT INTO progress_snapshots(id,project_id,at,verified_percent,claimed_percent,fingerprint,data) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          newId('pgs'),
          projectId,
          store.clock.now(),
          progress.verifiedPercent,
          progress.claimedPercent,
          progress.fingerprint,
          JSON.stringify({
            totals: progress.totals,
            milestones: progress.milestones,
            blockers: progress.blockers.length,
          }),
        );
      const current = progress.milestones.find((m) => m.state !== 'VERIFIED');
      store.updateProject(projectId, {
        progressSummary: summarize(progress),
        currentMilestone: current ? `${current.key}: ${current.title}` : null,
      });
      for (const m of progress.milestones) {
        store.db
          .prepare('UPDATE milestones SET status = ? WHERE project_id = ? AND key = ?')
          .run(m.state, projectId, m.key);
      }
      store.db
        .prepare(
          `DELETE FROM progress_snapshots WHERE project_id = ? AND id NOT IN
             (SELECT id FROM progress_snapshots WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
        )
        .run(projectId, projectId, MAX_SNAPSHOTS_PER_PROJECT);
    })
    .immediate();
  return { progress, recorded: true };
}

/**
 * Called on every supervisor tick. Change detection uses a MONOTONIC token (the highest activity-event rowid), not a
 * timestamp: two changes inside the same millisecond (or under a frozen test clock) can never be missed. When the
 * token has not moved an idle system costs a single integer lookup per tick; when it has, every project is recomputed
 * and a snapshot row is appended only for projects whose fingerprint actually changed.
 */
export class ProgressTracker {
  private lastToken = -1;

  constructor(
    private readonly store: Store,
    private readonly repo: WorkflowRepository,
  ) {}

  sweep(): number {
    const row = this.store.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM activity_events').get() as {
      m: number;
    };
    if (row.m === this.lastToken) return 0;
    this.lastToken = row.m;
    let recorded = 0;
    for (const p of this.store.listProjects()) {
      if (recordSnapshotIfChanged(this.store, this.repo, p.id).recorded) recorded++;
    }
    return recorded;
  }
}

export function listSnapshots(store: Store, projectId: string, limit = 50): SnapshotRow[] {
  return (
    store.db
      .prepare(
        'SELECT id, project_id, at, verified_percent, claimed_percent FROM progress_snapshots WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?',
      )
      .all(projectId, limit) as Record<string, unknown>[]
  )
    .map((r) => ({
      id: r['id'] as string,
      projectId: r['project_id'] as string,
      at: r['at'] as number,
      verifiedPercent: r['verified_percent'] as number,
      claimedPercent: r['claimed_percent'] as number,
    }))
    .reverse();
}
