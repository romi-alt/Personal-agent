import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import type { Store } from '../queue/store.js';

/**
 * Owner notifications (Phase 6). Errors, escalations and new approval requests are collected from the activity log and
 * delivered to:
 *  - <AGENT_HOME>/notifications.jsonl (always; the command center shows the same events), and
 *  - an OPTIONAL owner-configured webhook (NOTIFY_WEBHOOK_URL, off by default). Webhook payloads carry only the event
 *    type, severity, a short title and ids - never task output, file contents or credentials.
 * A cursor makes delivery exactly-once across restarts (at-least-once for the webhook if the process dies mid-send).
 */
const NOTIFY_TYPES =
  /^(task\.escalated|qa\.escalated|workflow\.failed|workflow\.questions|backup\.failed|recovery\.orphan_worker_unresolved|supervisor\.fatal|provider\.auth_required|approval\.required)$/;

export interface NotifyConfig {
  agentHome: string;
  webhookUrl?: string;
}

export class Notifier {
  private readonly cursorFile: string;
  private readonly outFile: string;

  constructor(
    private readonly store: Store,
    private readonly cfg: NotifyConfig,
    private readonly log?: Logger,
  ) {
    this.cursorFile = path.join(cfg.agentHome, 'notifications.cursor');
    this.outFile = path.join(cfg.agentHome, 'notifications.jsonl');
  }

  private cursor(): number {
    try {
      return Number(readFileSync(this.cursorFile, 'utf8').trim()) || 0;
    } catch {
      return 0;
    }
  }

  async flush(): Promise<number> {
    const from = this.cursor();
    const rows = this.store.db
      .prepare(
        `SELECT rowid AS rid, type, severity, project_id, task_id, payload, at FROM activity_events WHERE rowid > ? AND (severity = 'error' OR type LIKE 'approval.%' OR type LIKE '%.escalated') ORDER BY rowid LIMIT 200`,
      )
      .all(from) as {
      rid: number;
      type: string;
      severity: string;
      project_id: string | null;
      task_id: string | null;
      payload: string;
      at: number;
    }[];
    if (!rows.length) {
      // advance the cursor past unrelated events cheaply
      const max = (
        this.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS m FROM activity_events').get() as {
          m: number;
        }
      ).m;
      if (max > from) this.saveCursor(max);
      return 0;
    }
    let sent = 0;
    for (const r of rows) {
      if (r.severity === 'error' || NOTIFY_TYPES.test(r.type)) {
        const project = r.project_id ? this.store.getProject(r.project_id) : null;
        const n = {
          at: r.at,
          type: r.type,
          severity: r.severity,
          project: project?.name ?? null,
          projectId: r.project_id,
          taskId: r.task_id,
          title: this.title(r.type, r.payload),
        };
        mkdirSync(this.cfg.agentHome, { recursive: true });
        appendFileSync(this.outFile, JSON.stringify(n) + '\n');
        if (this.cfg.webhookUrl) await this.post(n);
        sent++;
      }
      this.saveCursor(r.rid);
    }
    return sent;
  }

  private title(type: string, payload: string): string {
    try {
      const p = JSON.parse(payload) as Record<string, unknown>;
      const s = String(p['reason'] ?? p['error'] ?? p['description'] ?? p['actionType'] ?? '');
      return `${type}${s ? `: ${s}` : ''}`.slice(0, 200);
    } catch {
      return type;
    }
  }

  private async post(n: Record<string, unknown>): Promise<void> {
    try {
      const r = await fetch(this.cfg.webhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `[ELEVARIQ agent] ${String(n['title'])}`, ...n }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) this.log?.warn('notify.webhook_status', { status: r.status });
    } catch (err) {
      this.log?.warn('notify.webhook_failed', { error: err });
    }
  }

  private saveCursor(v: number): void {
    if (!existsSync(this.cfg.agentHome)) mkdirSync(this.cfg.agentHome, { recursive: true });
    writeFileSync(this.cursorFile, String(v));
  }
}
