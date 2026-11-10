// Phase G evidence: read-only inspection of the STAGING agent DB after the real Claude Code run.
'use strict';
const path = require('path');
const Database = require(path.join('E:/Agent/v2-staging/hardening/repo/node_modules/better-sqlite3'));
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const iso = (t) => (t ? new Date(t).toISOString() : null);
const out = {};
out.tasks = db
  .prepare('SELECT id, title, kind, status, attempt_count, verification_required, session_id IS NOT NULL AS hasSession FROM tasks ORDER BY rowid')
  .all();
out.executions = db
  .prepare('SELECT id, task_id, provider, provider_session_id IS NOT NULL AS hasSession, started_at, ended_at, outcome, error_class, usage_json, worker_pid, log_ref FROM executions ORDER BY started_at')
  .all()
  .map((e) => ({ ...e, started_at: iso(e.started_at), ended_at: iso(e.ended_at), secs: (e.ended_at - e.started_at) / 1000 }));
out.transitions = db.prepare('SELECT task_id, from_status, to_status, reason, at FROM task_transitions ORDER BY at, rowid').all().map((t) => ({ ...t, at: iso(t.at) }));
out.evidence = db.prepare('SELECT task_id, level, status, summary FROM verification_evidence ORDER BY created_at').all();
out.qa = db.prepare('SELECT * FROM qa_reviews').all();
out.approvals = db.prepare('SELECT action_type, status, description FROM approvals').all();
out.eventTypes = db.prepare('SELECT type, COUNT(*) n FROM activity_events GROUP BY type ORDER BY n DESC').all();
out.toolUse = db
  .prepare("SELECT execution_id, payload FROM activity_events WHERE type = 'execution.tool_use' OR type LIKE '%tool%' ORDER BY at")
  .all()
  .slice(0, 80);
out.permissionDenied = db.prepare("SELECT type, payload FROM activity_events WHERE type LIKE '%denied%' OR type LIKE '%permission%'").all();
db.close();
console.log(JSON.stringify(out, null, 2));
