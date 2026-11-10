// READ-ONLY inspection of the live agent DB + consistent snapshot via the SQLite online backup API.
// Usage: node inspect-live-db.cjs <liveDbPath> <snapshotOutPath> <jsonOut>
// Opens the source with readonly:true, fileMustExist:true. Never writes to the source.
const { createRequire } = require('node:module');
const req = createRequire('E:/Agent/pa-v2-integrate/package.json'); // use the integration tree's modules, not production's
const Database = req('better-sqlite3');
const fs = require('node:fs');
const crypto = require('node:crypto');

const [src, snap, out] = process.argv.slice(2);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const before = { mtime: fs.statSync(src).mtimeMs, size: fs.statSync(src).size };

const db = new Database(src, { readonly: true, fileMustExist: true });
const q = (s) => db.prepare(s).all();
const one = (s) => db.prepare(s).get();
const tables = q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
const has = (t) => tables.includes(t);
const r = {
  at: new Date().toISOString(),
  source: src,
  readonly: db.readonly,
  journal_mode: one('PRAGMA journal_mode').journal_mode,
  quick_check: q('PRAGMA quick_check').map((x) => x.quick_check),
  foreign_key_violations: q('PRAGMA foreign_key_check').length,
  migrations: q('SELECT version,name,applied_at FROM schema_migrations ORDER BY version'),
  tables,
  counts: Object.fromEntries(tables.filter((t) => !t.startsWith('sqlite_')).map((t) => [t, one(`SELECT count(*) c FROM "${t}"`).c])),
  taskStatus: q('SELECT status, count(*) n FROM tasks GROUP BY status'),
  approvalStatus: q('SELECT status, action_type, count(*) n FROM approvals GROUP BY status, action_type'),
  pendingApprovals: q("SELECT id, action_type, requested_at FROM approvals WHERE status='PENDING'"),
  openExecutions: q('SELECT id, task_id, started_at, heartbeat_at FROM executions WHERE ended_at IS NULL'),
  leasedTasks: q('SELECT id, status, assigned_worker, lease_expires_at FROM tasks WHERE lease_expires_at IS NOT NULL'),
  qaStatus: has('qa_reviews') ? q('SELECT status, count(*) n FROM qa_reviews GROUP BY status') : null,
  projects: q('SELECT id, name, lifecycle, status, current_milestone, progress_summary FROM projects'),
  milestoneStatus: q('SELECT status, count(*) n FROM milestones GROUP BY status'),
  requirementStatus: q('SELECT status, count(*) n FROM requirements GROUP BY status'),
  supervisor: one('SELECT instance_id, pid, host, started_at, heartbeat_at, status, stop_requested, current_task_id, last_error FROM supervisor_state'),
  providerState: q('SELECT provider, status, blocked_until, reason, error_class, consecutive_failures, (credential_fingerprint IS NOT NULL) AS has_fingerprint, updated_at FROM provider_state'),
  lastCheckpoint: one('SELECT id, task_id, repo_ref, created_at FROM checkpoints ORDER BY created_at DESC LIMIT 1'),
  workflowRuns: q('SELECT id, kind, status, current_step FROM workflow_runs'),
  recentWarnErrors: q("SELECT type, severity, at FROM activity_events WHERE severity IN ('warn','error') ORDER BY at DESC LIMIT 15"),
  recentEvents: q('SELECT type, severity, at FROM activity_events ORDER BY at DESC LIMIT 15'),
};
r.supervisor && (r.supervisorHeartbeatAgeS = Math.round((Date.now() - r.supervisor.heartbeat_at) / 1000));

let snapshot = null;
if (snap) {
  const t0 = Date.now();
  db.backup(snap).then(() => {
    const ms = Date.now() - t0;
    const s = new Database(snap, { readonly: true });
    snapshot = {
      path: snap, ms, bytes: fs.statSync(snap).size, sha256: sha(snap),
      integrity_check: s.prepare('PRAGMA integrity_check').all().map((x) => x.integrity_check),
      migrations: s.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((x) => x.version),
      tasks: s.prepare('SELECT count(*) c FROM tasks').get().c,
    };
    s.close();
    finish();
  }).catch((e) => { snapshot = { error: String(e) }; finish(); });
} else finish();

function finish() {
  db.close();
  r.snapshot = snapshot;
  const after = { mtime: fs.statSync(src).mtimeMs, size: fs.statSync(src).size };
  r.sourceFileUnchangedByUs = { before, after, note: 'main-file mtime may still change from the live supervisor checkpointing its WAL; we opened readonly' };
  const txt = JSON.stringify(r, null, 1);
  if (out) fs.writeFileSync(out, txt);
  console.log(txt);
}
