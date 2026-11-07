import { createHash } from 'node:crypto';
import type { ProjectAssignmentInput } from '../assignments/schema.js';
import { newId } from '../core/ids.js';
import type { Store } from '../queue/store.js';
import type { ErpSyncSource, Page } from './contracts.js';
import { IntegrationError, type ErpProjectDetails, type ErpTeamMember } from './types.js';

/**
 * Read-only ERP synchronisation (Phase 4 preparation; runs only against mock sources until a live adapter exists).
 *
 *  - Idempotent: records are keyed by (system, kind, external_id); a re-sync of unchanged data changes nothing.
 *    Content changes are detected by a SHA-256 of the normalised record.
 *  - Resumable: the pagination cursor is persisted after every page, so a crash or a rate limit resumes where it
 *    stopped instead of starting over.
 *  - Audited: every run is a sync_runs row (counts, pages, error) and changes are activity events.
 *  - Minimal personal data: team members are stored with id, display name and role only.
 */
export type SyncKind = 'project' | 'task' | 'member' | 'activity';

export interface SyncResult {
  runId: string;
  kind: SyncKind;
  status: 'completed' | 'partial' | 'failed';
  pages: number;
  created: number;
  updated: number;
  unchanged: number;
  error: string | null;
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Only these member fields are ever persisted (no e-mail, phone, salary, ...). */
const minimalMember = (m: ErpTeamMember) => ({ id: m.id, displayName: m.displayName, role: m.role });

export class SyncEngine {
  constructor(
    private readonly store: Store,
    private readonly opts: { maxPagesPerRun?: number; pageSize?: number } = {},
  ) {}

  private get db() {
    return this.store.db;
  }

  private cursorKey(kind: SyncKind, scope: string) {
    return `erp:${kind}:${scope}`;
  }
  getCursor(kind: SyncKind, scope = '*'): string | null {
    const r = this.db
      .prepare('SELECT cursor FROM sync_cursors WHERE key = ?')
      .get(this.cursorKey(kind, scope)) as { cursor: string | null } | undefined;
    return r?.cursor ?? null;
  }
  private setCursor(kind: SyncKind, scope: string, cursor: string | null) {
    this.db
      .prepare(
        'INSERT INTO sync_cursors(key, cursor, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at',
      )
      .run(this.cursorKey(kind, scope), cursor, this.store.clock.now());
  }

  /** Upsert one record; returns what happened. */
  private upsert(
    kind: SyncKind,
    externalId: string,
    data: Record<string, unknown>,
    runId: string,
  ): 'created' | 'updated' | 'unchanged' {
    const h = hash(data);
    const now = this.store.clock.now();
    const row = this.db
      .prepare('SELECT content_hash FROM external_records WHERE system = ? AND kind = ? AND external_id = ?')
      .get('erp', kind, externalId) as { content_hash: string } | undefined;
    if (row?.content_hash === h) {
      this.db
        .prepare(
          'UPDATE external_records SET last_seen_at = ?, last_run_id = ? WHERE system = ? AND kind = ? AND external_id = ?',
        )
        .run(now, runId, 'erp', kind, externalId);
      return 'unchanged';
    }
    this.db
      .prepare(
        `INSERT INTO external_records(system,kind,external_id,content_hash,data,first_seen_at,last_seen_at,last_changed_at,last_run_id) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(system,kind,external_id) DO UPDATE SET content_hash=excluded.content_hash, data=excluded.data, last_seen_at=excluded.last_seen_at, last_changed_at=excluded.last_changed_at, last_run_id=excluded.last_run_id`,
      )
      .run('erp', kind, externalId, h, JSON.stringify(data), now, now, now, runId);
    return row ? 'updated' : 'created';
  }

  private async run<T>(
    kind: SyncKind,
    scope: string,
    fetchPage: (cursor: string | null) => Promise<Page<T>>,
    toRecord: (item: T) => { id: string; data: Record<string, unknown> },
  ): Promise<SyncResult> {
    const runId = newId('syn');
    const now = this.store.clock.now();
    this.db
      .prepare('INSERT INTO sync_runs(id,system,kind,scope,status,started_at) VALUES (?,?,?,?,?,?)')
      .run(runId, 'erp', kind, scope, 'running', now);
    const r: SyncResult = {
      runId,
      kind,
      status: 'completed',
      pages: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      error: null,
    };
    let cursor = this.getCursor(kind, scope);
    const maxPages = this.opts.maxPagesPerRun ?? 50;
    try {
      for (;;) {
        if (r.pages >= maxPages) {
          r.status = 'partial'; // bounded run; the persisted cursor continues next time
          break;
        }
        const page = await fetchPage(cursor);
        this.db
          .transaction(() => {
            for (const item of page.items) {
              const rec = toRecord(item);
              r[this.upsert(kind, rec.id, rec.data, runId)]++;
            }
            // cursor saved in the same transaction as the page's records: exactly-once per page
            this.setCursor(kind, scope, page.nextCursor);
          })
          .immediate();
        r.pages++;
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch (err) {
      r.status = 'failed';
      r.error = err instanceof IntegrationError ? `${err.code}: ${err.message}` : String(err);
    }
    this.db
      .prepare(
        'UPDATE sync_runs SET status=?, finished_at=?, pages=?, created=?, updated=?, unchanged=?, error=? WHERE id=?',
      )
      .run(r.status, this.store.clock.now(), r.pages, r.created, r.updated, r.unchanged, r.error, runId);
    this.store.recordEvent({
      type: r.status === 'failed' ? 'integration.sync_failed' : 'integration.synced',
      severity: r.status === 'failed' ? 'warn' : 'info',
      payload: {
        system: 'erp',
        kind,
        scope,
        runId,
        pages: r.pages,
        created: r.created,
        updated: r.updated,
        unchanged: r.unchanged,
        error: r.error,
      },
    });
    return r;
  }

  syncProjects(src: ErpSyncSource): Promise<SyncResult> {
    return this.run(
      'project',
      '*',
      (c) => src.listProjects({ cursor: c, limit: this.opts.pageSize ?? 50 }),
      (p) => ({ id: p.id, data: { ...p } }),
    );
  }
  syncTasks(src: ErpSyncSource, projectId: string): Promise<SyncResult> {
    return this.run(
      'task',
      projectId,
      (c) => src.listTasks(projectId, { cursor: c, limit: this.opts.pageSize ?? 50 }),
      (t) => ({ id: t.id, data: { ...t } }),
    );
  }
  syncMembers(src: ErpSyncSource): Promise<SyncResult> {
    return this.run(
      'member',
      '*',
      (c) => src.listTeamMembers({ cursor: c, limit: this.opts.pageSize ?? 50 }),
      (m) => ({ id: m.id, data: minimalMember(m) }),
    );
  }
  syncActivity(src: ErpSyncSource, projectId: string): Promise<SyncResult> {
    return this.run(
      'activity',
      projectId,
      (c) => src.listActivity(projectId, { cursor: c, limit: this.opts.pageSize ?? 50 }),
      (a) => ({ id: a.id, data: { ...a } }),
    );
  }

  records(kind: SyncKind): { externalId: string; data: Record<string, unknown>; lastChangedAt: number }[] {
    return (
      this.db
        .prepare(
          'SELECT external_id, data, last_changed_at FROM external_records WHERE system = ? AND kind = ? ORDER BY external_id',
        )
        .all('erp', kind) as { external_id: string; data: string; last_changed_at: number }[]
    ).map((r) => ({
      externalId: r.external_id,
      data: JSON.parse(r.data) as Record<string, unknown>,
      lastChangedAt: r.last_changed_at,
    }));
  }

  runs(): {
    id: string;
    kind: string;
    scope: string;
    status: string;
    pages: number;
    created: number;
    updated: number;
    unchanged: number;
    error: string | null;
  }[] {
    return this.db
      .prepare(
        'SELECT id, kind, scope, status, pages, created, updated, unchanged, error FROM sync_runs ORDER BY started_at, rowid',
      )
      .all() as never;
  }
}

/**
 * ERP project -> DRAFT agent assignment. It is never registered automatically: the owner reviews the draft (it
 * becomes an `erp_project_import` approval) because the ERP record does not contain verified requirements.
 * `source.externalId` makes registration idempotent (assignments/register.ts findByExternalId).
 */
export function erpProjectToAssignmentDraft(p: ErpProjectDetails): ProjectAssignmentInput {
  return {
    title: p.name.slice(0, 200),
    description: (p.description || `Project imported from ELEVARIQ ERP (${p.id}).`).padEnd(10, '.'),
    businessObjectives: [`Deliver ERP project ${p.id}: ${p.name}`],
    functionalRequirements: p.milestones.length
      ? p.milestones.map((m, i) => ({
          id: `FR-${i + 1}`,
          text: `Milestone: ${m.name}${m.dueDate ? ` (due ${m.dueDate.slice(0, 10)})` : ''}`,
          priority: 'must' as const,
        }))
      : [
          {
            id: 'FR-1',
            text: `Requirements to be confirmed with the owner for ${p.name}`,
            priority: 'must' as const,
          },
        ],
    expectedDeliverables: ['To be confirmed by the owner'],
    acceptanceCriteria: [
      { id: 'AC-1', text: 'Owner confirms the delivered scope', verifiedBy: 'manual' as const },
    ],
    source: { system: 'erp', externalId: p.id },
  };
}

/** Employee assignment mapping: ERP member -> agent role suggestion (owner-editable; nothing personal beyond name/role). */
export function suggestAgentRole(role: string): string | null {
  const r = role.toLowerCase();
  if (/architect/.test(r)) return 'principal_architect';
  if (/front/.test(r)) return 'frontend_engineer';
  if (/back|api|server/.test(r)) return 'backend_engineer';
  if (/data|dba|database/.test(r)) return 'database_engineer';
  if (/qa|test/.test(r)) return 'qa_engineer';
  if (/devops|sre|infra/.test(r)) return 'devops_engineer';
  if (/design|ux|ui/.test(r)) return 'uiux_engineer';
  if (/security/.test(r)) return 'security_engineer';
  if (/manager|lead|pm/.test(r)) return 'technical_project_manager';
  return null;
}
