// Phase I: production DB metadata through a READ-ONLY connection (SQLITE_OPEN_READONLY). Prints metadata only:
// no payloads, no descriptions, no instructions. Run with the staging clone's node_modules:
//   node prod-readonly-check.cjs <path-to-agent.db>
'use strict';
const path = require('path');
const Database = require(path.join('E:/Agent/v2-staging/hardening/repo/node_modules/better-sqlite3'));
const file = process.argv[2];
const db = new Database(file, { readonly: true, fileMustExist: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const now = Date.now();
const out = {};
out.openedReadonly = db.readonly;
out.journalMode = db.pragma('journal_mode', { simple: true });
out.userVersion = db.pragma('user_version', { simple: true });
out.migrations = q('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').map(
  (r) => `${r.version}:${r.name}@${new Date(r.applied_at).toISOString()}`,
);
const sup = q('SELECT instance_id, pid, host, started_at, heartbeat_at, status, current_task_id, stop_requested FROM supervisor_state');
out.supervisor = sup.map((s) => ({
  pid: s.pid,
  status: s.status,
  startedAt: new Date(s.started_at).toISOString(),
  heartbeatAt: new Date(s.heartbeat_at).toISOString(),
  heartbeatAgeSec: Math.round((now - s.heartbeat_at) / 1000),
  currentTask: s.current_task_id,
  stopRequested: !!s.stop_requested,
}));
out.tasksByStatus = Object.fromEntries(q('SELECT status, COUNT(*) n FROM tasks GROUP BY status').map((r) => [r.status, r.n]));
out.approvalsByStatus = Object.fromEntries(q('SELECT status, COUNT(*) n FROM approvals GROUP BY status').map((r) => [r.status, r.n]));
out.executionsLast24h = q('SELECT outcome, COUNT(*) n FROM executions WHERE started_at > ? GROUP BY outcome', now - 864e5);
out.lastEvents = q('SELECT type, severity, at FROM activity_events ORDER BY at DESC LIMIT 12').map(
  (e) => `${new Date(e.at).toISOString()} ${e.severity} ${e.type}`,
);
out.errorEventsLast24h = q(
  "SELECT type, COUNT(*) n FROM activity_events WHERE at > ? AND severity = 'error' GROUP BY type",
  now - 864e5,
);
out.supervisorEventsSinceDeploy = q(
  "SELECT type, COUNT(*) n FROM activity_events WHERE at > ? AND type LIKE 'supervisor.%' GROUP BY type",
  Date.parse('2026-11-09T13:07:00Z'),
);
db.close();
console.log(JSON.stringify(out, null, 2));
