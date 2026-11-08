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
  {
    version: 2,
    name: 'phase_1_5_fencing_lifecycle_assignments_verification',
    sql: `
-- Execution fencing + escalation counters
ALTER TABLE tasks ADD COLUMN lease_execution_id TEXT;
ALTER TABLE tasks ADD COLUMN interruption_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN provider_failure_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN verification_required TEXT NOT NULL DEFAULT '[]';
ALTER TABLE executions ADD COLUMN start_ref TEXT;
ALTER TABLE executions ADD COLUMN start_status_hash TEXT;
-- Checkpoint integrity (NULL = written before integrity hashing existed)
ALTER TABLE checkpoints ADD COLUMN integrity TEXT;

-- Project lifecycle, separate from the task lifecycle and from projects.status (operational switch)
ALTER TABLE projects ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'REGISTERED';
CREATE TABLE project_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  from_lifecycle TEXT,
  to_lifecycle TEXT NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_ptrans_project ON project_transitions(project_id, id);

-- Project assignment contract (validated JSON, schema_version tracked)
CREATE TABLE assignments (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  schema_version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Independent completion-verification evidence (append-only)
CREATE TABLE verification_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT,
  level TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_evidence_project ON verification_evidence(project_id, created_at);
CREATE INDEX idx_evidence_task ON verification_evidence(task_id, created_at);

-- Provider readiness evidence: levels only become VERIFIED through explicit verification commands
CREATE TABLE provider_verification (
  provider TEXT NOT NULL,
  level TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  sdk_version TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (provider, level)
);
`,
  },
  {
    version: 3,
    name: 'phase_2_planning_workflows',
    sql: `
-- Task kinds: CODING tasks change the repository; PLANNING tasks are read-only model calls whose output feeds a workflow
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'CODING';
ALTER TABLE tasks ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;

-- Full final output of a completed execution (the summary column on executions is truncated)
CREATE TABLE task_outputs (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  execution_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, execution_id)
);

-- Durable workflows (Phase 2 planning pipeline)
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step TEXT,
  context TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_wfruns_status ON workflow_runs(status);
CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  name TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  output TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (run_id, name, attempt)
);

-- Requirements model (seeded from the assignment by code; refined by analysis)
CREATE TABLE requirements (
  project_id TEXT NOT NULL REFERENCES projects(id),
  req_id TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  PRIMARY KEY (project_id, req_id)
);

-- Milestones and the link from tasks back to the plan that created them
CREATE TABLE milestones (
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  position INTEGER NOT NULL,
  requirement_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'PLANNED',
  PRIMARY KEY (project_id, key)
);
CREATE TABLE plan_tasks (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  run_id TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  milestone_key TEXT NOT NULL,
  requirement_ids TEXT NOT NULL DEFAULT '[]',
  size TEXT NOT NULL
);
`,
  },
  {
    version: 4,
    name: 'phase_1_5_cli_worker_supervision',
    sql: `
-- Official retry-watchdog capacity wait observed inside a live provider process (NULL = not waiting)
ALTER TABLE executions ADD COLUMN capacity_wait_since INTEGER;
ALTER TABLE executions ADD COLUMN capacity_wait_reason TEXT;
ALTER TABLE executions ADD COLUMN capacity_wait_resets_at INTEGER;
ALTER TABLE executions ADD COLUMN capacity_wait_recheck_at INTEGER;
-- OS process id of the provider child (native CLI worker) so recovery can stop an orphan before replacing it
ALTER TABLE executions ADD COLUMN worker_pid INTEGER;
-- Last time the provider produced any output (model text, tool event, retry/wait notice)
ALTER TABLE executions ADD COLUMN last_activity_at INTEGER;
`,
  },
  {
    version: 5,
    name: 'worker_process_identity',
    sql: `
-- JSON {pid,image,startedAtMs}: OS identity of the provider child recorded at spawn; recovery stops an orphan only
-- if the live process still has this identity (pid reuse safe)
ALTER TABLE executions ADD COLUMN worker_identity TEXT;
`,
  },
  {
    version: 6,
    name: 'phase_2_project_intelligence',
    sql: `
-- Research tasks may use read-only web tools (still subject to the project's web_access approval policy)
ALTER TABLE tasks ADD COLUMN allow_web INTEGER NOT NULL DEFAULT 0;

-- Original owner input: free-text assignment and attached specifications, kept verbatim
CREATE TABLE project_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- assignment_text | attachment
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, sha256)
);

CREATE TABLE research_findings (
  run_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  area TEXT NOT NULL,
  statement TEXT NOT NULL,
  kind TEXT NOT NULL,            -- verified | assumption (after the citation check)
  claimed_kind TEXT NOT NULL,    -- what the model claimed
  confidence TEXT NOT NULL,
  sources TEXT NOT NULL,         -- JSON [{title,url}]
  citation_check TEXT NOT NULL,  -- observed | not_observed | no_web_access | none
  researched_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, finding_id)
);
CREATE INDEX idx_research_project ON research_findings(project_id);

CREATE TABLE adrs (
  project_id TEXT NOT NULL,
  adr_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,          -- proposed | accepted | rejected | superseded
  context TEXT NOT NULL,
  decision TEXT NOT NULL,
  alternatives TEXT NOT NULL,    -- JSON string[]
  rationale TEXT NOT NULL,
  consequences TEXT NOT NULL,
  significant INTEGER NOT NULL,
  decided_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  file_path TEXT,
  PRIMARY KEY(project_id, adr_id)
);

CREATE TABLE architecture_specs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sections TEXT NOT NULL,        -- JSON {system,database,...}
  diagrams TEXT NOT NULL,        -- JSON [{title,mermaid}]
  created_at INTEGER NOT NULL
);

CREATE TABLE plan_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  source TEXT NOT NULL,          -- deterministic | model
  verdict TEXT NOT NULL,         -- approve | revise
  issues TEXT NOT NULL,          -- JSON [{id,category,severity,description,recommendation}]
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_plan_reviews_run ON plan_reviews(run_id);

CREATE TABLE epics (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(project_id, key)
);
ALTER TABLE plan_tasks ADD COLUMN epic_key TEXT;
ALTER TABLE plan_tasks ADD COLUMN subtasks TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plan_tasks ADD COLUMN testing TEXT NOT NULL DEFAULT '';
`,
  },
  {
    version: 7,
    name: 'phase_3_engineering',
    sql: `
-- Bounded specialist role a coding task runs under (adds a brief; never adds permissions)
ALTER TABLE tasks ADD COLUMN role TEXT;

-- Independent QA per coding task: review rounds, correction tasks, escalation
CREATE TABLE qa_reviews (
  task_id TEXT NOT NULL,           -- the reviewed (original) coding task
  round INTEGER NOT NULL,
  review_task_id TEXT,
  correction_task_id TEXT,
  status TEXT NOT NULL,            -- REVIEWING | PASSED | FAILED | CORRECTING | ESCALATED | OWNER_ACCEPTED | OWNER_REJECTED
  repairs INTEGER NOT NULL DEFAULT 0,
  result TEXT,                     -- JSON: criteria verdicts, defects, citation check
  approval_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(task_id, round)
);
CREATE INDEX idx_qa_status ON qa_reviews(status);
`,
  },
  {
    version: 8,
    name: 'phase_4_integration_sync',
    sql: `
-- Read-only ERP/CRM sync audit, resumable cursors, idempotent external records (no live adapter yet)
CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  system TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,            -- running | completed | partial | failed
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  pages INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE sync_cursors (
  key TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE external_records (
  system TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  data TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  last_run_id TEXT NOT NULL,
  PRIMARY KEY(system, kind, external_id)
);
`,
  },
  // v9 is reserved for a concurrent change set; versions are applied in order of what is missing, so a later v9
  // still applies on a database that already has v10 (the two touch different tables).
  {
    version: 10,
    name: 'qa_requirement_ownership_and_review_links',
    sql: `
-- A1: the single plan task that OWNS a requirement (the independent review judges the requirement only there;
-- every other linked task merely contributes). NULL = not yet resolved: code falls back to the last linked task in
-- plan (topological) order.
ALTER TABLE requirements ADD COLUMN owner_task_id TEXT;

-- A3: every review task (including repair re-dispatches that supersede an earlier review of the same round) is
-- linked to its QA round. qa_reviews.review_task_id keeps pointing at the latest one.
CREATE TABLE qa_review_tasks (
  review_task_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,           -- the reviewed (original) coding task
  round INTEGER NOT NULL,
  repair INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_qa_review_tasks_task ON qa_review_tasks(task_id, round);
-- Backfill from the review dedupe key "qa:<taskId>:<round>:<repair>" (existing review tasks become linked).
INSERT OR IGNORE INTO qa_review_tasks(review_task_id, task_id, round, repair, created_at)
SELECT id,
       substr(k, 1, instr(k, ':') - 1),
       CAST(substr(r, 1, instr(r, ':') - 1) AS INTEGER),
       CAST(substr(r, instr(r, ':') + 1) AS INTEGER),
       created_at
FROM (
  SELECT id, created_at, k, substr(k, instr(k, ':') + 1) AS r
  FROM (SELECT id, created_at, substr(dedupe_key, 4) AS k FROM tasks WHERE dedupe_key LIKE 'qa:%:%:%')
)
WHERE instr(k, ':') > 0 AND instr(r, ':') > 0;
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
