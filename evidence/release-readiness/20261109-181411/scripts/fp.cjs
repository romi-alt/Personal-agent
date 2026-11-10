// Read-only DB fingerprinting for the migration/rollback rehearsal.
// usage: node fp.cjs <db> [--save-limits <json>] [--limits <json>]
//  --save-limits: record max rowid per history table (baseline) ; --limits: fingerprint only rows with rowid <= baseline max
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const Database = createRequire('E:/Agent/pa-v2-integrate/package.json')('better-sqlite3');
const args = process.argv.slice(2);
const file = args[0];
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const db = new Database(file, { readonly: true, fileMustExist: true });
const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const H = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
// v8 columns only, so additive migrations (new columns) do not change history fingerprints
const v8cols = (t) => {
  const v8 = { requirements: ['project_id', 'req_id', 'text', 'kind', 'priority', 'source'] }; // status is reconciled by V2 (A4) - fingerprinted separately
  if (v8[t]) return v8[t].map((c) => `"${c}"`).join(',');
  return '*';
};
const HIST = ['projects', 'tasks', 'executions', 'checkpoints', 'approvals', 'qa_reviews', 'task_transitions', 'verification_evidence', 'assignments', 'plan_tasks', 'requirements', 'milestones', 'activity_events', 'task_outputs', 'project_documents', 'adrs', 'workflow_runs', 'workflow_steps'];
const limits = opt('--limits') ? JSON.parse(fs.readFileSync(opt('--limits'), 'utf8')) : null;
const out = {
  file,
  integrity: db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check).join(','),
  fkViolations: db.prepare('PRAGMA foreign_key_check').all().length,
  versions: db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map((r) => `${r.version}:${r.name}`),
  duplicateMigrationNames: db.prepare('SELECT name, COUNT(*) n FROM schema_migrations GROUP BY name HAVING n > 1').all(),
  schemaHash: H(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()),
  objects: db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => `${r.type}:${r.name}`),
  counts: {}, fingerprints: {}, maxRowid: {},
};
for (const t of HIST) {
  if (!has(t)) continue;
  out.counts[t] = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
  out.maxRowid[t] = db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM "${t}"`).get().m;
  if (['activity_events', 'milestones'].includes(t) && !limits) continue; // V2 appends events / reconciles milestone status
  const where = limits && limits[t] != null ? ` WHERE rowid <= ${limits[t]}` : '';
  let cols = v8cols(t);
  if (t === 'projects' || t === 'milestones') cols = t === 'projects'
    ? 'id,name,slug,description,repo_path,priority,status,created_at,provider,allow_dirty,lifecycle' // updated_at/current_milestone/progress_summary are recomputed by V2
    : 'project_id,key,title,goal,position,requirement_ids';
  out.fingerprints[t] = H(db.prepare(`SELECT ${cols} FROM "${t}"${where} ORDER BY rowid`).all());
}
out.taskStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all().map((r) => [r.status, r.n]));
out.requirementStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM requirements GROUP BY status').all().map((r) => [r.status, r.n]));
out.milestoneStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM milestones GROUP BY status').all().map((r) => [r.status, r.n]));
out.approvalStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM approvals GROUP BY status').all().map((r) => [r.status, r.n]));
out.running = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('RUNNING','CHECKPOINTING')").get().n;
out.openExecutions = db.prepare('SELECT COUNT(*) n FROM executions WHERE ended_at IS NULL').get().n;
if (has('qa_review_tasks')) out.qaReviewTasks = db.prepare('SELECT COUNT(*) n FROM qa_review_tasks').get().n;
out.projects = db.prepare('SELECT slug, lifecycle, status FROM projects ORDER BY rowid').all();
// staging metrics (newer tasks only, when limits given)
if (limits) {
  out.newTasks = db.prepare(`SELECT t.title, t.status, t.attempt_count a, t.created_at c,
     (SELECT MIN(started_at) FROM executions e WHERE e.task_id=t.id) s,
     (SELECT COUNT(*) FROM executions e WHERE e.task_id=t.id) n,
     (SELECT GROUP_CONCAT(COALESCE(error_class,'ok'),'>') FROM executions e WHERE e.task_id=t.id) classes,
     (SELECT COUNT(DISTINCT provider_session_id) FROM executions e WHERE e.task_id=t.id) sessions
     FROM tasks t WHERE t.rowid > ${limits.tasks} ORDER BY t.rowid`).all().map((r) => ({ ...r, startLatencyMs: r.s ? r.s - r.c : null }));
  out.newQa = db.prepare(`SELECT t.title, r.round, r.status FROM qa_reviews r JOIN tasks t ON t.id=r.task_id WHERE r.rowid > ${limits.qa_reviews} ORDER BY r.rowid`).all();
  out.newApprovals = db.prepare(`SELECT action_type, status, decided_by FROM approvals WHERE rowid > ${limits.approvals} ORDER BY rowid`).all();
  out.newEvents = Object.fromEntries(db.prepare(`SELECT type, COUNT(*) n FROM activity_events WHERE rowid > ${limits.activity_events} GROUP BY type`).all().map((r) => [r.type, r.n]));
  out.overlappingExecutions = db.prepare('SELECT COUNT(*) n FROM executions a JOIN executions b ON a.task_id=b.task_id AND a.id<b.id AND a.ended_at IS NOT NULL AND b.started_at < a.ended_at').get().n;
}
db.close();
if (opt('--save-limits')) fs.writeFileSync(opt('--save-limits'), JSON.stringify(out.maxRowid));
console.log(JSON.stringify(out, null, 1));
