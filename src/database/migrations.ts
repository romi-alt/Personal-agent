import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Append-only. Never edit a released migration; add a new one. All timestamps are epoch milliseconds. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  repo_path TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  current_milestone TEXT,
  progress_summary TEXT,
  allow_dirty INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL,
  continuation_count INTEGER NOT NULL DEFAULT 0,
  scheduled_start INTEGER,
  next_eligible_at INTEGER,
  last_error_class TEXT,
  last_error_message TEXT,
  last_checkpoint_id TEXT,
  assigned_worker TEXT,
  lease_expires_at INTEGER,
  completion_evidence TEXT,
  session_id TEXT,
  dedupe_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (project_id, dedupe_key)
);
CREATE INDEX idx_tasks_status ON tasks(status, next_eligible_at);
CREATE INDEX idx_tasks_project ON tasks(project_id);

CREATE TABLE task_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX idx_transitions_task ON task_transitions(task_id, id);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  resumed_from_session_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  heartbeat_at INTEGER NOT NULL,
  pid INTEGER,
  host TEXT,
  outcome TEXT,
  error_class TEXT,
  retry_reason TEXT,
  usage_json TEXT,
  cost_usd_estimate REAL,
  cost_usd_billed REAL,
  log_ref TEXT,
  summary TEXT
);
CREATE INDEX idx_exec_task ON executions(task_id, started_at);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  execution_id TEXT,
  session_ref TEXT,
  repo_ref TEXT,
  git_dirty INTEGER,
  completed_summary TEXT NOT NULL,
  outstanding_summary TEXT NOT NULL,
  test_results TEXT,
  next_action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_chk_task ON checkpoints(task_id, created_at);

CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  execution_id TEXT,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'info',
  correlation_id TEXT
);
CREATE INDEX idx_events_task ON activity_events(task_id, at);
CREATE INDEX idx_events_at ON activity_events(at);

CREATE TABLE provider_state (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  blocked_until INTEGER,
  reason TEXT,
  error_class TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  credential_fingerprint TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE supervisor_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  current_task_id TEXT,
  last_error TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT,
  action_type TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  approved_by TEXT NOT NULL
);

CREATE TABLE project_memory (
  project_id TEXT NOT NULL REFERENCES projects(id),
  section TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, section)
);
`,
  },
];

export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const ran: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    })();
    ran.push(m.version);
  }
  return ran;
}
