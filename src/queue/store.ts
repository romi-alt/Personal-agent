import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import {
  EXECUTABLE_LIFECYCLES,
  InvalidProjectTransitionError,
  canProjectTransition,
  type ProjectLifecycle,
} from '../projects/lifecycle.js';
import type { EvidenceRecord, EvidenceStatus, VerificationLevel } from '../verification/types.js';
import type { Db } from '../database/connection.js';
import { newId } from '../core/ids.js';
import type { Logger } from '../logging/logger.js';
import { redactNullable, redactString, redactValue } from '../security/redact.js';
import { reconcileProjectStatus } from '../planning/status-reconcile.js';
import {
  type ActivityEvent,
  type Approval,
  type CapacityWait,
  type Checkpoint,
  type Clock,
  type ErrorClass,
  type ExecutionRecord,
  type WorkerIdentity,
  type Project,
  type ProjectStatus,
  type ProviderState,
  type Severity,
  type Task,
  type TaskStatus,
  systemClock,
} from '../types/index.js';
import {
  ACTIVE_STATUSES,
  CLAIMABLE_STATUSES,
  InvalidTransitionError,
  canTransition,
} from './state-machine.js';

type Row = Record<string, unknown>;

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';

function mapProject(r: Row): Project {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    slug: r['slug'] as string,
    description: r['description'] as string,
    repoPath: r['repo_path'] as string,
    priority: r['priority'] as number,
    status: r['status'] as ProjectStatus,
    lifecycle: r['lifecycle'] as ProjectLifecycle,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
    lastActivityAt: r['last_activity_at'] as number,
    provider: r['provider'] as string,
    currentMilestone: (r['current_milestone'] as string | null) ?? null,
    progressSummary: (r['progress_summary'] as string | null) ?? null,
    allowDirty: !!r['allow_dirty'],
  };
}

function mapTask(r: Row): Task {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    title: r['title'] as string,
    instructions: r['instructions'] as string,
    acceptanceCriteria: r['acceptance_criteria'] as string,
    dependsOn: JSON.parse(r['depends_on'] as string) as string[],
    priority: r['priority'] as number,
    status: r['status'] as TaskStatus,
    attemptCount: r['attempt_count'] as number,
    maxRetries: r['max_retries'] as number,
    continuationCount: r['continuation_count'] as number,
    scheduledStart: (r['scheduled_start'] as number | null) ?? null,
    nextEligibleAt: (r['next_eligible_at'] as number | null) ?? null,
    lastErrorClass: (r['last_error_class'] as ErrorClass | null) ?? null,
    lastErrorMessage: (r['last_error_message'] as string | null) ?? null,
    lastCheckpointId: (r['last_checkpoint_id'] as string | null) ?? null,
    assignedWorker: (r['assigned_worker'] as string | null) ?? null,
    leaseExpiresAt: (r['lease_expires_at'] as number | null) ?? null,
    completionEvidence: (r['completion_evidence'] as string | null) ?? null,
    sessionId: (r['session_id'] as string | null) ?? null,
    dedupeKey: r['dedupe_key'] as string,
    leaseExecutionId: (r['lease_execution_id'] as string | null) ?? null,
    interruptionCount: r['interruption_count'] as number,
    providerFailureStreak: r['provider_failure_streak'] as number,
    verificationRequired: JSON.parse(r['verification_required'] as string) as string[],
    kind: (r['kind'] as 'CODING' | 'PLANNING') ?? 'CODING',
    readOnly: !!r['read_only'],
    allowWeb: !!r['allow_web'],
    role: (r['role'] as string | null) ?? null,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
    completedAt: (r['completed_at'] as number | null) ?? null,
  };
}

function mapExecution(r: Row): ExecutionRecord {
  return {
    id: r['id'] as string,
    taskId: r['task_id'] as string,
    provider: r['provider'] as string,
    providerSessionId: (r['provider_session_id'] as string | null) ?? null,
    resumedFromSessionId: (r['resumed_from_session_id'] as string | null) ?? null,
    startedAt: r['started_at'] as number,
    endedAt: (r['ended_at'] as number | null) ?? null,
    heartbeatAt: r['heartbeat_at'] as number,
    pid: (r['pid'] as number | null) ?? null,
    host: (r['host'] as string | null) ?? null,
    outcome: (r['outcome'] as string | null) ?? null,
    errorClass: (r['error_class'] as ErrorClass | null) ?? null,
    retryReason: (r['retry_reason'] as string | null) ?? null,
    usage: r['usage_json'] ? (JSON.parse(r['usage_json'] as string) as Record<string, unknown>) : null,
    costUsdEstimate: (r['cost_usd_estimate'] as number | null) ?? null,
    costUsdBilled: (r['cost_usd_billed'] as number | null) ?? null,
    logRef: (r['log_ref'] as string | null) ?? null,
    summary: (r['summary'] as string | null) ?? null,
    startRef: (r['start_ref'] as string | null) ?? null,
    startStatusHash: (r['start_status_hash'] as string | null) ?? null,
    capacityWait:
      r['capacity_wait_since'] != null
        ? {
            since: r['capacity_wait_since'] as number,
            reason: (r['capacity_wait_reason'] as string | null) ?? 'usage limit',
            resetsAt: (r['capacity_wait_resets_at'] as number | null) ?? null,
            recheckAt: (r['capacity_wait_recheck_at'] as number | null) ?? null,
          }
        : null,
    workerPid: (r['worker_pid'] as number | null) ?? null,
    workerIdentity: r['worker_identity']
      ? (JSON.parse(r['worker_identity'] as string) as WorkerIdentity)
      : null,
    lastActivityAt: (r['last_activity_at'] as number | null) ?? null,
  };
}

/** Canonical hash over every semantic field of a checkpoint; detects tampering/corruption on read. */
export function checkpointIntegrity(c: Omit<Checkpoint, 'integrity'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        c.id,
        c.projectId,
        c.taskId,
        c.executionId,
        c.sessionRef,
        c.repoRef,
        c.gitDirty,
        c.completedSummary,
        c.outstandingSummary,
        c.testResults,
        c.nextAction,
        c.createdAt,
      ]),
    )
    .digest('hex');
}

function mapCheckpoint(r: Row): Checkpoint {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    taskId: r['task_id'] as string,
    executionId: (r['execution_id'] as string | null) ?? null,
    sessionRef: (r['session_ref'] as string | null) ?? null,
    repoRef: (r['repo_ref'] as string | null) ?? null,
    gitDirty: r['git_dirty'] === null || r['git_dirty'] === undefined ? null : !!r['git_dirty'],
    completedSummary: r['completed_summary'] as string,
    outstandingSummary: r['outstanding_summary'] as string,
    testResults: (r['test_results'] as string | null) ?? null,
    nextAction: r['next_action'] as string,
    createdAt: r['created_at'] as number,
    integrity: (r['integrity'] as string | null) ?? null,
  };
}

function mapEvent(r: Row): ActivityEvent {
  return {
    id: r['id'] as string,
    projectId: (r['project_id'] as string | null) ?? null,
    taskId: (r['task_id'] as string | null) ?? null,
    executionId: (r['execution_id'] as string | null) ?? null,
    type: r['type'] as string,
    at: r['at'] as number,
    payload: JSON.parse(r['payload'] as string) as Record<string, unknown>,
    severity: r['severity'] as Severity,
    correlationId: (r['correlation_id'] as string | null) ?? null,
  };
}

function mapApproval(r: Row): Approval {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    taskId: (r['task_id'] as string | null) ?? null,
    actionType: r['action_type'] as string,
    description: r['description'] as string,
    status: r['status'] as Approval['status'],
    requestedAt: r['requested_at'] as number,
    decidedAt: (r['decided_at'] as number | null) ?? null,
    decidedBy: (r['decided_by'] as string | null) ?? null,
    payload: JSON.parse(r['payload'] as string) as Record<string, unknown>,
  };
}

function mapProviderState(r: Row): ProviderState {
  return {
    provider: r['provider'] as string,
    status: r['status'] as ProviderState['status'],
    blockedUntil: (r['blocked_until'] as number | null) ?? null,
    reason: (r['reason'] as string | null) ?? null,
    errorClass: (r['error_class'] as ErrorClass | null) ?? null,
    consecutiveFailures: r['consecutive_failures'] as number,
    credentialFingerprint: (r['credential_fingerprint'] as string | null) ?? null,
    updatedAt: r['updated_at'] as number,
  };
}

export interface TaskPatch {
  nextEligibleAt?: number | null;
  lastErrorClass?: ErrorClass | null;
  lastErrorMessage?: string | null;
  lastCheckpointId?: string | null;
  completionEvidence?: string | null;
  sessionId?: string | null;
  scheduledStart?: number | null;
  incrementAttempt?: boolean;
  incrementContinuation?: boolean;
  resetAttempts?: boolean;
  incrementInterruption?: boolean;
  resetInterruptions?: boolean;
  providerFailureStreak?: number;
  verificationRequired?: string[];
}

export interface TransitionOptions {
  reason: string;
  executionId?: string | null;
  patch?: TaskPatch;
  /** Fail (instead of overwrite) if the task is not currently in this status. */
  expectedFrom?: TaskStatus;
  /**
   * Fencing token: the transition only applies if this execution still owns the task's lease.
   * Prevents a stale worker (whose lease was reclaimed) from overwriting a newer execution's state.
   */
  fenceExecutionId?: string;
}

export class StaleLeaseError extends Error {
  constructor(
    readonly taskId: string,
    readonly executionId: string,
  ) {
    super(`Execution ${executionId} no longer owns task ${taskId}`);
    this.name = 'StaleLeaseError';
  }
}

export interface SupervisorState {
  instanceId: string;
  pid: number;
  host: string;
  startedAt: number;
  heartbeatAt: number;
  status: string;
  stopRequested: boolean;
  currentTaskId: string | null;
  lastError: string | null;
}

export class DuplicateSupervisorError extends Error {
  constructor(readonly holder: SupervisorState) {
    super(
      `Another supervisor (pid ${holder.pid} on ${holder.host}) is active; last heartbeat ${new Date(holder.heartbeatAt).toISOString()}`,
    );
    this.name = 'DuplicateSupervisorError';
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class Store {
  constructor(
    readonly db: Db,
    readonly clock: Clock = systemClock,
    readonly log?: Logger,
  ) {}

  // ---------------------------------------------------------------- events
  recordEvent(input: {
    type: string;
    projectId?: string | null;
    taskId?: string | null;
    executionId?: string | null;
    payload?: Record<string, unknown>;
    severity?: Severity;
    correlationId?: string | null;
  }): ActivityEvent {
    const ev: ActivityEvent = {
      id: newId('evt'),
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      executionId: input.executionId ?? null,
      type: input.type,
      at: this.clock.now(),
      payload: (redactValue(input.payload ?? {}) as Record<string, unknown>) ?? {},
      severity: input.severity ?? 'info',
      correlationId: input.correlationId ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO activity_events(id,project_id,task_id,execution_id,type,at,payload,severity,correlation_id) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ev.id,
        ev.projectId,
        ev.taskId,
        ev.executionId,
        ev.type,
        ev.at,
        JSON.stringify(ev.payload),
        ev.severity,
        ev.correlationId,
      );
    this.log?.[ev.severity](ev.type, {
      projectId: ev.projectId,
      taskId: ev.taskId,
      executionId: ev.executionId,
      ...ev.payload,
    });
    return ev;
  }

  listEvents(
    filter: { taskId?: string; projectId?: string; type?: string; limit?: number } = {},
  ): ActivityEvent[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.taskId) {
      where.push('task_id = ?');
      args.push(filter.taskId);
    }
    if (filter.projectId) {
      where.push('project_id = ?');
      args.push(filter.projectId);
    }
    if (filter.type) {
      where.push('type = ?');
      args.push(filter.type);
    }
    const sql = `SELECT * FROM (SELECT rowid AS rid, * FROM activity_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rid DESC LIMIT ?) ORDER BY rid ASC`;
    return (this.db.prepare(sql).all(...args, filter.limit ?? 200) as Row[]).map(mapEvent);
  }

  // -------------------------------------------------------------- projects
  createProject(input: {
    name: string;
    description?: string;
    repoPath: string;
    priority?: number;
    provider: string;
    allowDirty?: boolean;
  }): Project {
    const now = this.clock.now();
    const id = newId('prj');
    let slug = slugify(input.name);
    if (this.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)) slug = `${slug}-${id.slice(-4)}`;
    this.db
      .prepare(
        `INSERT INTO projects(id,name,slug,description,repo_path,priority,status,created_at,updated_at,last_activity_at,provider,allow_dirty)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.name,
        slug,
        input.description ?? '',
        input.repoPath,
        input.priority ?? 0,
        'ACTIVE',
        now,
        now,
        now,
        input.provider,
        input.allowDirty ? 1 : 0,
      );
    const project = this.getProject(id)!;
    this.recordEvent({
      type: 'project.created',
      projectId: id,
      payload: { name: input.name, repoPath: input.repoPath },
    });
    return project;
  }

  getProject(idOrSlug: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ? OR slug = ?').get(idOrSlug, idOrSlug) as
      Row | undefined;
    return r ? mapProject(r) : null;
  }

  listProjects(): Project[] {
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY priority DESC, created_at ASC').all() as Row[]
    ).map(mapProject);
  }

  updateProject(
    id: string,
    patch: Partial<Pick<Project, 'status' | 'currentMilestone' | 'progressSummary' | 'priority'>>,
  ): void {
    const sets: string[] = ['updated_at = @now'];
    const args: Row = { id, now: this.clock.now() };
    if (patch.status !== undefined) {
      sets.push('status = @status');
      args['status'] = patch.status;
    }
    if (patch.currentMilestone !== undefined) {
      sets.push('current_milestone = @ms');
      args['ms'] = patch.currentMilestone;
    }
    if (patch.progressSummary !== undefined) {
      sets.push('progress_summary = @ps');
      args['ps'] = patch.progressSummary;
    }
    if (patch.priority !== undefined) {
      sets.push('priority = @pr');
      args['pr'] = patch.priority;
    }
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`).run(args);
  }

  // ----------------------------------------------------------------- tasks
  /** Idempotent enqueue: the same (project, dedupeKey) never creates a second task. */
  enqueueTask(input: {
    projectId: string;
    title: string;
    instructions: string;
    acceptanceCriteria?: string;
    dependsOn?: string[];
    priority?: number;
    maxRetries: number;
    scheduledStart?: number | null;
    dedupeKey?: string;
    verificationRequired?: string[];
    kind?: 'CODING' | 'PLANNING';
    /** PLANNING tasks only: also allow read-only web tools (research). */
    allowWeb?: boolean;
    /** Specialist role brief for coding tasks (src/engineering/roles.ts). */
    role?: string | null;
  }): { task: Task; created: boolean } {
    const dedupeKey =
      input.dedupeKey ??
      createHash('sha256').update(`${input.title}\n${input.instructions}`).digest('hex').slice(0, 16);
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare('SELECT * FROM tasks WHERE project_id = ? AND dedupe_key = ?')
          .get(input.projectId, dedupeKey) as Row | undefined;
        if (existing) {
          this.recordEvent({
            type: 'task.enqueue_duplicate',
            projectId: input.projectId,
            taskId: existing['id'] as string,
            severity: 'warn',
          });
          return { task: mapTask(existing), created: false };
        }
        if (!this.getProject(input.projectId)) throw new Error(`Unknown project ${input.projectId}`);
        for (const dep of input.dependsOn ?? []) {
          if (!this.getTask(dep)) throw new Error(`Unknown dependency task ${dep}`);
        }
        const now = this.clock.now();
        const id = newId('tsk');
        this.db
          .prepare(
            `INSERT INTO tasks(id,project_id,title,instructions,acceptance_criteria,depends_on,priority,status,max_retries,scheduled_start,dedupe_key,verification_required,kind,read_only,allow_web,role,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.projectId,
            input.title,
            input.instructions,
            input.acceptanceCriteria ?? '',
            JSON.stringify(input.dependsOn ?? []),
            input.priority ?? 0,
            'QUEUED',
            input.maxRetries,
            input.scheduledStart ?? null,
            dedupeKey,
            JSON.stringify(input.verificationRequired ?? []),
            input.kind ?? 'CODING',
            input.kind === 'PLANNING' ? 1 : 0,
            input.kind === 'PLANNING' && input.allowWeb ? 1 : 0,
            input.role ?? null,
            now,
            now,
          );
        this.db
          .prepare(
            'INSERT INTO task_transitions(task_id,from_status,to_status,reason,execution_id,at) VALUES (?,?,?,?,?,?)',
          )
          .run(id, null, 'QUEUED', 'enqueued', null, now);
        this.recordEvent({
          type: 'task.enqueued',
          projectId: input.projectId,
          taskId: id,
          payload: { title: input.title, dedupeKey },
        });
        // New work re-opens a project that was waiting on verification/approval/delivery.
        const lc = this.getProject(input.projectId)!.lifecycle;
        if (
          (input.kind ?? 'CODING') === 'CODING' &&
          [
            'REGISTERED',
            'ANALYZING',
            'PLANNING',
            'VERIFYING',
            'AWAITING_OWNER_APPROVAL',
            'READY_FOR_DELIVERY',
          ].includes(lc)
        ) {
          this.transitionProject(input.projectId, 'IN_DEVELOPMENT', `task added: ${input.title}`);
        }
        return { task: this.getTask(id)!, created: true };
      })
      .immediate();
  }

  getTask(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? mapTask(r) : null;
  }

  requireTask(id: string): Task {
    const t = this.getTask(id);
    if (!t) throw new Error(`Unknown task ${id}`);
    return t;
  }

  listTasks(filter: { projectId?: string; statuses?: readonly TaskStatus[] } = {}): Task[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      args.push(filter.projectId);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      args.push(...filter.statuses);
    }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid ASC`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(mapTask);
  }

  listTransitions(
    taskId: string,
  ): { from: TaskStatus | null; to: TaskStatus; reason: string; executionId: string | null; at: number }[] {
    return (
      this.db.prepare('SELECT * FROM task_transitions WHERE task_id = ? ORDER BY id ASC').all(taskId) as Row[]
    ).map((r) => ({
      from: (r['from_status'] as TaskStatus | null) ?? null,
      to: r['to_status'] as TaskStatus,
      reason: r['reason'] as string,
      executionId: (r['execution_id'] as string | null) ?? null,
      at: r['at'] as number,
    }));
  }

  /** The only code path that changes tasks.status. Validates, persists history, and updates bookkeeping atomically. */
  transition(taskId: string, to: TaskStatus, opts: TransitionOptions): Task {
    return this.db.transaction(() => this.applyTransition(taskId, to, opts)).immediate();
  }

  private applyTransition(taskId: string, to: TaskStatus, opts: TransitionOptions): Task {
    const current = this.requireTask(taskId);
    if (opts.expectedFrom && current.status !== opts.expectedFrom) {
      throw new Error(`Task ${taskId} is ${current.status}, expected ${opts.expectedFrom}`);
    }
    if (opts.fenceExecutionId && current.leaseExecutionId !== opts.fenceExecutionId) {
      throw new StaleLeaseError(taskId, opts.fenceExecutionId);
    }
    if (!canTransition(current.status, to)) throw new InvalidTransitionError(taskId, current.status, to);
    const now = this.clock.now();
    const p = opts.patch ?? {};
    const sets: string[] = ['status = @to', 'updated_at = @now'];
    const args: Row = { id: taskId, to, now };
    const set = (col: string, key: string, val: unknown) => (
      sets.push(`${col} = @${key}`),
      (args[key] = val)
    );
    if (p.nextEligibleAt !== undefined) set('next_eligible_at', 'nea', p.nextEligibleAt);
    if (p.scheduledStart !== undefined) set('scheduled_start', 'ss', p.scheduledStart);
    if (p.lastErrorClass !== undefined) set('last_error_class', 'lec', p.lastErrorClass);
    // V2.1 Phase C: free-text columns are redacted at the persistence boundary (provider errors, worker claims).
    if (p.lastErrorMessage !== undefined)
      set('last_error_message', 'lem', redactNullable(p.lastErrorMessage));
    if (p.lastCheckpointId !== undefined) set('last_checkpoint_id', 'lcp', p.lastCheckpointId);
    if (p.completionEvidence !== undefined)
      set('completion_evidence', 'ce', redactNullable(p.completionEvidence));
    if (p.sessionId !== undefined) set('session_id', 'sid', p.sessionId);
    if (p.incrementAttempt) sets.push('attempt_count = attempt_count + 1');
    if (p.incrementContinuation) sets.push('continuation_count = continuation_count + 1');
    if (p.resetAttempts)
      sets.push(
        'attempt_count = 0',
        'continuation_count = 0',
        'interruption_count = 0',
        'provider_failure_streak = 0',
      );
    if (p.incrementInterruption) sets.push('interruption_count = interruption_count + 1');
    if (p.resetInterruptions) sets.push('interruption_count = 0');
    if (p.providerFailureStreak !== undefined) set('provider_failure_streak', 'pfs', p.providerFailureStreak);
    if (p.verificationRequired !== undefined)
      set('verification_required', 'vr', JSON.stringify(p.verificationRequired));
    // Leaving the active set releases the lease. RUNNING -> CHECKPOINTING keeps it.
    if (!ACTIVE_STATUSES.includes(to))
      sets.push('assigned_worker = NULL', 'lease_expires_at = NULL', 'lease_execution_id = NULL');
    if (to === 'COMPLETED') sets.push('completed_at = @now');
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(args);
    this.db
      .prepare(
        'INSERT INTO task_transitions(task_id,from_status,to_status,reason,execution_id,at) VALUES (?,?,?,?,?,?)',
      )
      .run(taskId, current.status, to, redactString(opts.reason), opts.executionId ?? null, now);
    this.db
      .prepare('UPDATE projects SET last_activity_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, current.projectId);
    this.recordEvent({
      type: 'task.transition',
      projectId: current.projectId,
      taskId,
      executionId: opts.executionId ?? null,
      payload: { from: current.status, to, reason: opts.reason },
    });
    if (to === 'COMPLETED' || to === 'CANCELLED') this.advanceProjectAfterTerminalTask(current.projectId);
    this.reconcileRoadmapStatus(current.projectId, taskId);
    return this.requireTask(taskId);
  }

  // ------------------------------------------------------------ claim/lease
  /**
   * Atomically choose the next eligible task and lease it to `workerId`.
   * A single IMMEDIATE transaction means two supervisors (or two loops) can never claim the same task.
   */
  claimNext(input: {
    workerId: string;
    leaseTtlMs: number;
    maxConcurrent: number;
    provider: string;
    pid: number;
    logRef?: (executionId: string) => string | null;
  }): { task: Task; execution: ExecutionRecord } | null {
    return this.db
      .transaction(() => {
        const now = this.clock.now();
        const active = (
          this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('RUNNING','CHECKPOINTING') AND lease_expires_at > ?`,
            )
            .get(now) as { n: number }
        ).n;
        if (active >= input.maxConcurrent) return null;
        const placeholders = CLAIMABLE_STATUSES.map(() => '?').join(',');
        const lifecyclePlaceholders = EXECUTABLE_LIFECYCLES.map(() => '?').join(',');
        const candidates = (
          this.db
            .prepare(
              `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
               WHERE p.status = 'ACTIVE' AND p.lifecycle IN (${lifecyclePlaceholders}) AND t.status IN (${placeholders})
                 AND (t.scheduled_start IS NULL OR t.scheduled_start <= ?)
                 AND (t.next_eligible_at IS NULL OR t.next_eligible_at <= ?)
               ORDER BY p.priority DESC, t.priority DESC, t.rowid ASC LIMIT 100`,
            )
            .all(...EXECUTABLE_LIFECYCLES, ...CLAIMABLE_STATUSES, now, now) as Row[]
        ).map(mapTask);
        const statusOf = this.db.prepare('SELECT status, verification_required FROM tasks WHERE id = ?');
        const reviewPassed = this.db.prepare(
          // Owner acceptance (v2: OWNER_ACCEPTED, not PASSED) also releases dependants: the owner decided so.
          `SELECT 1 FROM verification_evidence WHERE task_id = ? AND level = 'REQUIREMENTS_SATISFIED' AND status IN ('PASSED','OWNER_ACCEPTED') LIMIT 1`,
        );
        const overBudget = new Map<string, boolean>();
        const chosen = candidates.find((t) => {
          // A dependency is done only when COMPLETED and, if it requires independent review, that review PASSED:
          // the coding worker cannot approve its own work for downstream tasks.
          const depsDone = t.dependsOn.every((d) => {
            const r = statusOf.get(d) as { status: string; verification_required: string } | undefined;
            if (r?.status !== 'COMPLETED') return false;
            return !r.verification_required.includes('REQUIREMENTS_SATISFIED') || !!reviewPassed.get(d);
          });
          if (!depsDone) return false;
          if (!this.milestoneGateOpen(t.id, t.projectId)) return false;
          if (!overBudget.has(t.projectId)) overBudget.set(t.projectId, this.projectOverBudget(t.projectId));
          return !overBudget.get(t.projectId);
        });
        if (!chosen) return null;
        const executionId = newId('exe');
        this.db
          .prepare(
            `INSERT INTO executions(id,task_id,provider,resumed_from_session_id,started_at,heartbeat_at,pid,host,log_ref)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            executionId,
            chosen.id,
            input.provider,
            chosen.sessionId,
            now,
            now,
            input.pid,
            hostname(),
            input.logRef?.(executionId) ?? null,
          );
        this.applyTransition(chosen.id, 'RUNNING', {
          reason: chosen.sessionId ? 'claimed (resuming existing session)' : 'claimed',
          executionId,
          expectedFrom: chosen.status,
        });
        this.db
          .prepare(
            'UPDATE tasks SET assigned_worker = ?, lease_expires_at = ?, lease_execution_id = ? WHERE id = ?',
          )
          .run(input.workerId, now + input.leaseTtlMs, executionId, chosen.id);
        return { task: this.requireTask(chosen.id), execution: this.getExecution(executionId)! };
      })
      .immediate();
  }

  /** Extend the lease. Returns false when the lease is no longer ours (task reclaimed/cancelled). */
  heartbeat(executionId: string, taskId: string, workerId: string, leaseTtlMs: number): boolean {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET lease_expires_at = ? WHERE id = ? AND assigned_worker = ? AND lease_execution_id = ? AND status IN ('RUNNING','CHECKPOINTING')`,
      )
      .run(now + leaseTtlMs, taskId, workerId, executionId);
    if (res.changes === 0) return false;
    this.db.prepare('UPDATE executions SET heartbeat_at = ? WHERE id = ?').run(now, executionId);
    return true;
  }

  listActiveTasks(): Task[] {
    return this.listTasks({ statuses: ACTIVE_STATUSES });
  }

  /** Mark tasks BLOCKED when a dependency can never complete. */
  sweepDependencyBlocks(): number {
    let n = 0;
    for (const t of this.listTasks({ statuses: ['QUEUED', 'READY'] })) {
      for (const dep of t.dependsOn) {
        const d = this.getTask(dep);
        if (d && (d.status === 'FAILED' || d.status === 'CANCELLED')) {
          this.transition(t.id, 'BLOCKED', {
            reason: `dependency ${dep} is ${d.status}`,
            patch: { lastErrorMessage: `dependency ${dep} ${d.status}` },
          });
          n++;
          break;
        }
      }
    }
    return n;
  }

  /** Earliest time any waiting task becomes eligible (for idle sleep). */
  nextWakeAt(): number | null {
    const r = this.db
      .prepare(
        `SELECT MIN(COALESCE(MAX(IFNULL(next_eligible_at,0), IFNULL(scheduled_start,0)),0)) AS t FROM tasks
         WHERE status IN ('QUEUED','READY','RETRY_SCHEDULED','WAITING_FOR_CAPACITY') AND (next_eligible_at IS NOT NULL OR scheduled_start IS NOT NULL)`,
      )
      .get() as { t: number | null };
    return r.t && r.t > 0 ? r.t : null;
  }

  // ------------------------------------------------------------ executions
  getExecution(id: string): ExecutionRecord | null {
    const r = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as Row | undefined;
    return r ? mapExecution(r) : null;
  }

  listExecutions(taskId: string): ExecutionRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY started_at ASC, rowid ASC')
        .all(taskId) as Row[]
    ).map(mapExecution);
  }

  latestExecution(taskId: string): ExecutionRecord | null {
    const r = this.db
      .prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(taskId) as Row | undefined;
    return r ? mapExecution(r) : null;
  }

  /** Record (or clear, with null) an official capacity wait inside the live provider process. */
  setExecutionCapacityWait(executionId: string, wait: CapacityWait | null): void {
    this.db
      .prepare(
        `UPDATE executions SET capacity_wait_since = ?, capacity_wait_reason = ?, capacity_wait_resets_at = ?,
           capacity_wait_recheck_at = ?, last_activity_at = ? WHERE id = ?`,
      )
      .run(
        wait?.since ?? null,
        wait?.reason ?? null,
        wait?.resetsAt ?? null,
        wait?.recheckAt ?? null,
        this.clock.now(),
        executionId,
      );
  }

  /** Record the OS pid of the provider child process (null once it has exited). */
  setExecutionWorkerPid(executionId: string, pid: number | null): void {
    if (pid === null)
      this.db
        .prepare('UPDATE executions SET worker_pid = NULL, worker_identity = NULL WHERE id = ?')
        .run(executionId);
    else this.db.prepare('UPDATE executions SET worker_pid = ? WHERE id = ?').run(pid, executionId);
  }

  /** Records the OS identity of the worker, only if that pid is still the execution's current worker. */
  setExecutionWorkerIdentity(executionId: string, identity: WorkerIdentity): void {
    this.db
      .prepare('UPDATE executions SET worker_identity = ? WHERE id = ? AND worker_pid = ?')
      .run(JSON.stringify(identity), executionId, identity.pid);
  }

  /** Cheap liveness marker for provider output; used for stall detection and the command center. */
  touchExecutionActivity(executionId: string): void {
    this.db
      .prepare('UPDATE executions SET last_activity_at = ? WHERE id = ?')
      .run(this.clock.now(), executionId);
  }

  /** Persist the provider session id immediately so a crash still leaves a resumable reference. */
  recordSession(executionId: string, taskId: string, sessionId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE executions SET provider_session_id = ? WHERE id = ?')
        .run(sessionId, executionId);
      this.db
        .prepare('UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?')
        .run(sessionId, this.clock.now(), taskId);
    })();
  }

  endExecution(
    id: string,
    patch: {
      outcome: string;
      errorClass?: ErrorClass | null;
      retryReason?: string | null;
      usage?: Record<string, unknown> | null;
      costUsdEstimate?: number | null;
      costUsdBilled?: number | null;
      summary?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE executions SET ended_at = ?, outcome = ?, error_class = ?, retry_reason = ?, usage_json = ?, cost_usd_estimate = ?, cost_usd_billed = ?, summary = ? WHERE id = ?`,
      )
      .run(
        this.clock.now(),
        patch.outcome,
        patch.errorClass ?? null,
        redactNullable(patch.retryReason ?? null),
        patch.usage ? JSON.stringify(redactValue(patch.usage)) : null,
        patch.costUsdEstimate ?? null,
        patch.costUsdBilled ?? null,
        redactNullable(patch.summary ?? null),
        id,
      );
  }

  /** Client-side *estimated* spend (SDK total_cost_usd) in the rolling window. Not a billing statement. */
  estimatedSpendSince(since: number): number {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd_estimate),0) AS s FROM executions WHERE started_at >= ?')
      .get(since) as { s: number };
    return r.s;
  }

  // ----------------------------------------------------------- checkpoints
  addCheckpoint(raw: Omit<Checkpoint, 'id' | 'createdAt' | 'integrity'>): Checkpoint {
    // V2.1 Phase C: redact BEFORE the integrity hash, so stored text and hash agree.
    const input = {
      ...raw,
      completedSummary: redactNullable(raw.completedSummary),
      outstandingSummary: redactNullable(raw.outstandingSummary),
      testResults: redactNullable(raw.testResults),
      nextAction: redactNullable(raw.nextAction),
    };
    const id = newId('chk');
    const now = this.clock.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO checkpoints(id,project_id,task_id,execution_id,session_ref,repo_ref,git_dirty,completed_summary,outstanding_summary,test_results,next_action,created_at,integrity)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.projectId,
          input.taskId,
          input.executionId,
          input.sessionRef,
          input.repoRef,
          input.gitDirty === null ? null : input.gitDirty ? 1 : 0,
          input.completedSummary,
          input.outstandingSummary,
          input.testResults,
          input.nextAction,
          now,
          checkpointIntegrity({ ...input, id, createdAt: now }),
        );
      this.db
        .prepare('UPDATE tasks SET last_checkpoint_id = ?, updated_at = ? WHERE id = ?')
        .run(id, now, input.taskId);
    })();
    this.recordEvent({
      type: 'checkpoint.created',
      projectId: input.projectId,
      taskId: input.taskId,
      executionId: input.executionId,
      payload: { checkpointId: id, repoRef: input.repoRef, sessionRef: input.sessionRef },
    });
    return this.getCheckpoint(id)!;
  }

  getCheckpoint(id: string): Checkpoint | null {
    const r = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as Row | undefined;
    return r ? mapCheckpoint(r) : null;
  }

  latestCheckpoint(taskId: string): Checkpoint | null {
    const r = this.db
      .prepare('SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(taskId) as Row | undefined;
    return r ? mapCheckpoint(r) : null;
  }

  latestProjectCheckpoint(): Checkpoint | null {
    const r = this.db
      .prepare('SELECT * FROM checkpoints ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get() as Row | undefined;
    return r ? mapCheckpoint(r) : null;
  }

  listCheckpoints(taskId: string): Checkpoint[] {
    return (
      this.db
        .prepare('SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(taskId) as Row[]
    ).map(mapCheckpoint);
  }

  /** True when the stored hash matches the content (legacy rows without a hash are accepted as unchecked). */
  checkpointIsIntact(c: Checkpoint): boolean {
    if (c.integrity === null) return true;
    return c.integrity === checkpointIntegrity(c);
  }

  /**
   * Newest checkpoint whose integrity hash verifies. Corrupted ones are skipped and reported as events,
   * so recovery degrades to an older good checkpoint (or none) instead of trusting damaged data.
   */
  latestValidCheckpoint(taskId: string): { checkpoint: Checkpoint | null; skippedCorrupt: string[] } {
    const skipped: string[] = [];
    const all = this.listCheckpoints(taskId).reverse();
    for (const c of all) {
      if (this.checkpointIsIntact(c)) return { checkpoint: c, skippedCorrupt: skipped };
      skipped.push(c.id);
      this.recordEvent({
        type: 'checkpoint.corrupt',
        taskId,
        projectId: c.projectId,
        severity: 'error',
        payload: { checkpointId: c.id },
      });
    }
    return { checkpoint: null, skippedCorrupt: skipped };
  }

  // -------------------------------------------------------- provider state
  getProviderState(provider: string): ProviderState {
    const r = this.db.prepare('SELECT * FROM provider_state WHERE provider = ?').get(provider) as
      Row | undefined;
    return r
      ? mapProviderState(r)
      : {
          provider,
          status: 'OK',
          blockedUntil: null,
          reason: null,
          errorClass: null,
          consecutiveFailures: 0,
          credentialFingerprint: null,
          updatedAt: this.clock.now(),
        };
  }

  setProviderState(s: Omit<ProviderState, 'updatedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO provider_state(provider,status,blocked_until,reason,error_class,consecutive_failures,credential_fingerprint,updated_at)
         VALUES (@provider,@status,@blockedUntil,@reason,@errorClass,@consecutiveFailures,@credentialFingerprint,@now)
         ON CONFLICT(provider) DO UPDATE SET status=@status, blocked_until=@blockedUntil, reason=@reason, error_class=@errorClass,
           consecutive_failures=@consecutiveFailures, credential_fingerprint=@credentialFingerprint, updated_at=@now`,
      )
      .run({ ...s, reason: redactNullable(s.reason), now: this.clock.now() });
  }

  // ------------------------------------------------------------ supervisor
  getSupervisorState(): SupervisorState | null {
    const r = this.db.prepare('SELECT * FROM supervisor_state WHERE id = 1').get() as Row | undefined;
    if (!r) return null;
    return {
      instanceId: r['instance_id'] as string,
      pid: r['pid'] as number,
      host: r['host'] as string,
      startedAt: r['started_at'] as number,
      heartbeatAt: r['heartbeat_at'] as number,
      status: r['status'] as string,
      stopRequested: !!r['stop_requested'],
      currentTaskId: (r['current_task_id'] as string | null) ?? null,
      lastError: (r['last_error'] as string | null) ?? null,
    };
  }

  /** A supervisor is live iff its heartbeat is fresh; a dead local pid short-circuits the wait. */
  supervisorIsLive(s: SupervisorState, leaseTtlMs: number): boolean {
    if (s.status === 'STOPPED') return false;
    if (this.clock.now() - s.heartbeatAt > leaseTtlMs) return false;
    if (s.host === hostname() && !pidAlive(s.pid)) return false;
    return true;
  }

  acquireSupervisorLock(instanceId: string, leaseTtlMs: number): { previous: SupervisorState | null } {
    return this.db
      .transaction(() => {
        const cur = this.getSupervisorState();
        if (cur && cur.instanceId !== instanceId && this.supervisorIsLive(cur, leaseTtlMs))
          throw new DuplicateSupervisorError(cur);
        const now = this.clock.now();
        this.db.prepare('DELETE FROM supervisor_state').run();
        this.db
          .prepare(
            `INSERT INTO supervisor_state(id,instance_id,pid,host,started_at,heartbeat_at,status,stop_requested) VALUES (1,?,?,?,?,?,'STARTING',0)`,
          )
          .run(instanceId, process.pid, hostname(), now, now);
        return { previous: cur };
      })
      .immediate();
  }

  heartbeatSupervisor(
    instanceId: string,
    status: string,
    currentTaskId: string | null,
    lastError?: string | null,
  ): { stopRequested: boolean } {
    this.db
      .prepare(
        `UPDATE supervisor_state SET heartbeat_at = ?, status = ?, current_task_id = ?, last_error = COALESCE(?, last_error) WHERE id = 1 AND instance_id = ?`,
      )
      .run(this.clock.now(), status, currentTaskId, redactNullable(lastError ?? null), instanceId);
    const r = this.db
      .prepare('SELECT stop_requested, instance_id FROM supervisor_state WHERE id = 1')
      .get() as Row | undefined;
    return { stopRequested: !!r && !!r['stop_requested'] };
  }

  requestStop(): boolean {
    return this.db.prepare('UPDATE supervisor_state SET stop_requested = 1 WHERE id = 1').run().changes > 0;
  }

  releaseSupervisor(instanceId: string): void {
    this.db
      .prepare(
        `UPDATE supervisor_state SET status = 'STOPPED', heartbeat_at = ?, current_task_id = NULL WHERE id = 1 AND instance_id = ?`,
      )
      .run(this.clock.now(), instanceId);
  }

  // ------------------------------------------------------------- approvals
  createApproval(input: {
    projectId: string;
    taskId?: string | null;
    actionType: string;
    description: string;
    payload?: Record<string, unknown>;
  }): Approval {
    const id = newId('apr');
    input = { ...input, description: redactString(input.description) };
    this.db
      .prepare(
        `INSERT INTO approvals(id,project_id,task_id,action_type,description,status,requested_at,payload) VALUES (?,?,?,?,?,'PENDING',?,?)`,
      )
      .run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.actionType,
        input.description,
        this.clock.now(),
        JSON.stringify(redactValue(input.payload ?? {})),
      );
    this.recordEvent({
      type: 'approval.required',
      projectId: input.projectId,
      taskId: input.taskId,
      severity: 'warn',
      payload: { approvalId: id, actionType: input.actionType, description: input.description },
    });
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | null {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return r ? mapApproval(r) : null;
  }

  listApprovals(status?: Approval['status']): Approval[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY requested_at').all(status)
      : this.db.prepare('SELECT * FROM approvals ORDER BY requested_at').all();
    return (rows as Row[]).map(mapApproval);
  }

  decideApproval(id: string, decision: 'APPROVED' | 'DENIED', decidedBy: string): Approval {
    const res = this.db
      .prepare(
        `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'PENDING'`,
      )
      .run(decision, this.clock.now(), decidedBy, id);
    if (res.changes === 0) throw new Error(`Approval ${id} not found or already decided`);
    const a = this.getApproval(id)!;
    this.recordEvent({
      type: 'approval.decided',
      projectId: a.projectId,
      taskId: a.taskId,
      payload: { approvalId: id, decision, decidedBy },
    });
    return a;
  }

  // ---------------------------------------------------------------- memory
  setMemory(projectId: string, section: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO project_memory(project_id,section,content,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(project_id,section) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
      )
      .run(projectId, section, content, this.clock.now());
  }

  getMemory(projectId: string, section: string): string | null {
    const r = this.db
      .prepare('SELECT content FROM project_memory WHERE project_id = ? AND section = ?')
      .get(projectId, section) as { content: string } | undefined;
    return r?.content ?? null;
  }

  listMemory(projectId: string): { section: string; content: string; updatedAt: number }[] {
    return (
      this.db
        .prepare(
          'SELECT section, content, updated_at FROM project_memory WHERE project_id = ? ORDER BY section',
        )
        .all(projectId) as Row[]
    ).map((r) => ({
      section: r['section'] as string,
      content: r['content'] as string,
      updatedAt: r['updated_at'] as number,
    }));
  }

  // ------------------------------------------------- execution start state
  recordExecutionStart(executionId: string, start: { head: string | null; statusHash: string | null }): void {
    this.db
      .prepare('UPDATE executions SET start_ref = ?, start_status_hash = ? WHERE id = ?')
      .run(start.head, start.statusHash, executionId);
  }

  /** Baseline captured by the task's FIRST execution (used by CHANGES_EXIST). */
  taskBaseline(taskId: string): { head: string | null; statusHash: string | null } | null {
    const r = this.db
      .prepare(
        'SELECT start_ref, start_status_hash FROM executions WHERE task_id = ? ORDER BY started_at ASC, rowid ASC LIMIT 1',
      )
      .get(taskId) as Row | undefined;
    if (!r || (r['start_ref'] === null && r['start_status_hash'] === null)) return null;
    return {
      head: (r['start_ref'] as string | null) ?? null,
      statusHash: (r['start_status_hash'] as string | null) ?? null,
    };
  }

  // ------------------------------------------------------- milestone gating
  /**
   * Strict milestone gating: a planned task may start only when every task of an earlier milestone of the same
   * project is terminal (COMPLETED/CANCELLED). Tasks with no plan link, and projects with gating 'off', are not gated.
   */
  milestoneGateOpen(taskId: string, projectId: string): boolean {
    const link = this.db
      .prepare(
        `SELECT m.position AS pos FROM plan_tasks pt JOIN milestones m ON m.project_id = ? AND m.key = pt.milestone_key WHERE pt.task_id = ?`,
      )
      .get(projectId, taskId) as { pos: number } | undefined;
    if (!link || link.pos === 0) return true;
    const gating = (
      this.getAssignmentData(projectId)?.['execution'] as { milestoneGating?: string } | undefined
    )?.milestoneGating;
    if (gating === 'off') return true;
    const open = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM plan_tasks pt
         JOIN milestones m ON m.project_id = ? AND m.key = pt.milestone_key
         JOIN tasks t ON t.id = pt.task_id
         WHERE t.project_id = ? AND m.position < ? AND t.status NOT IN ('COMPLETED','CANCELLED')`,
      )
      .get(projectId, projectId, link.pos) as { n: number };
    return open.n === 0;
  }

  // --------------------------------------------------------- project spend
  projectSpend(projectId: string): number {
    const r = this.db
      .prepare(
        'SELECT COALESCE(SUM(e.cost_usd_estimate),0) AS s FROM executions e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ?',
      )
      .get(projectId) as { s: number };
    return r.s;
  }

  /** True when the project's assignment sets maxUsdTotal and estimated spend has reached it. */
  projectOverBudget(projectId: string): boolean {
    const a = this.getAssignmentData(projectId);
    const b = a?.['budget'] as { maxUsdTotal?: number; maxExecutions?: number } | undefined;
    if (b?.maxUsdTotal !== undefined && b.maxUsdTotal > 0 && this.projectSpend(projectId) >= b.maxUsdTotal)
      return true;
    if (b?.maxExecutions !== undefined) {
      const n = (
        this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM executions e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ?',
          )
          .get(projectId) as { n: number }
      ).n;
      if (n >= b.maxExecutions) return true;
    }
    return false;
  }

  // ------------------------------------------------------ project lifecycle
  transitionProject(projectId: string, to: ProjectLifecycle, reason: string): Project {
    return this.db
      .transaction(() => {
        const p = this.getProject(projectId);
        if (!p) throw new Error(`Unknown project ${projectId}`);
        if (p.lifecycle === to) return p;
        if (!canProjectTransition(p.lifecycle, to))
          throw new InvalidProjectTransitionError(projectId, p.lifecycle, to);
        const now = this.clock.now();
        this.db
          .prepare('UPDATE projects SET lifecycle = ?, updated_at = ?, last_activity_at = ? WHERE id = ?')
          .run(to, now, now, projectId);
        this.db
          .prepare(
            'INSERT INTO project_transitions(project_id,from_lifecycle,to_lifecycle,reason,at) VALUES (?,?,?,?,?)',
          )
          .run(projectId, p.lifecycle, to, redactString(reason), now);
        this.recordEvent({
          type: 'project.lifecycle',
          projectId,
          payload: { from: p.lifecycle, to, reason },
        });
        return this.getProject(projectId)!;
      })
      .immediate();
  }

  listProjectTransitions(
    projectId: string,
  ): { from: ProjectLifecycle | null; to: ProjectLifecycle; reason: string; at: number }[] {
    return (
      this.db
        .prepare('SELECT * FROM project_transitions WHERE project_id = ? ORDER BY id')
        .all(projectId) as Row[]
    ).map((r) => ({
      from: (r['from_lifecycle'] as ProjectLifecycle | null) ?? null,
      to: r['to_lifecycle'] as ProjectLifecycle,
      reason: r['reason'] as string,
      at: r['at'] as number,
    }));
  }

  /**
   * When every task is terminal (COMPLETED/CANCELLED) the project moves to VERIFYING - never to a
   * delivery state. A single provider success cannot declare a project finished.
   */
  /**
   * A4: re-derive requirement and milestone statuses from verified task state (src/planning/status-reconcile.ts).
   * With `taskId`, only when that task belongs to a plan. Never throws: a reconciliation problem must not undo the
   * task/QA change that triggered it (it is re-derived on the next change or at supervisor start).
   */
  reconcileRoadmapStatus(projectId: string, taskId?: string): void {
    try {
      if (taskId && !this.db.prepare('SELECT 1 FROM plan_tasks WHERE task_id = ?').get(taskId)) return;
      const { changes } = reconcileProjectStatus(this.db, projectId);
      if (changes.length)
        this.recordEvent({
          type: 'roadmap.status_reconciled',
          projectId,
          taskId: taskId ?? null,
          payload: { changes: changes.map((c) => `${c.kind}:${c.id}:${c.from}->${c.to}`) },
        });
    } catch (err) {
      this.recordEvent({
        type: 'roadmap.reconcile_error',
        projectId,
        severity: 'warn',
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  advanceProjectAfterTerminalTask(projectId: string): void {
    const p = this.getProject(projectId);
    if (!p || p.lifecycle !== 'IN_DEVELOPMENT') return;
    const counts = this.db
      .prepare(
        `SELECT SUM(CASE WHEN status NOT IN ('COMPLETED','CANCELLED') THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS done FROM tasks WHERE project_id = ? AND kind = 'CODING'`,
      )
      .get(projectId) as { open: number | null; done: number | null };
    // Completed tasks that require an independent review count as open until that review passed.
    const unreviewed = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND t.kind = 'CODING' AND t.status = 'COMPLETED'
             AND t.verification_required LIKE '%REQUIREMENTS_SATISFIED%'
             AND NOT EXISTS (SELECT 1 FROM verification_evidence e WHERE e.task_id = t.id AND e.level = 'REQUIREMENTS_SATISFIED' AND e.status IN ('PASSED','OWNER_ACCEPTED'))`,
        )
        .get(projectId) as { n: number }
    ).n;
    if ((counts.open ?? 0) === 0 && unreviewed === 0 && (counts.done ?? 0) > 0) {
      this.transitionProject(
        projectId,
        'VERIFYING',
        'all tasks terminal; independent verification and owner approval required',
      );
    }
  }

  // ----------------------------------------------------------- assignments
  saveAssignment(projectId: string, schemaVersion: number, data: Record<string, unknown>): void {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO assignments(project_id,schema_version,data,created_at,updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET schema_version=excluded.schema_version, data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(projectId, schemaVersion, JSON.stringify(data), now, now);
  }

  getAssignmentData(projectId: string): Record<string, unknown> | null {
    const r = this.db.prepare('SELECT data FROM assignments WHERE project_id = ?').get(projectId) as
      { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Record<string, unknown>) : null;
  }

  // ------------------------------------------------- verification evidence
  addEvidence(input: {
    projectId: string;
    taskId?: string | null;
    level: VerificationLevel;
    status: EvidenceStatus;
    summary: string;
    evidence?: Record<string, unknown>;
  }): EvidenceRecord {
    const id = newId('evd');
    const now = this.clock.now();
    this.db
      .prepare(
        'INSERT INTO verification_evidence(id,project_id,task_id,level,status,summary,evidence,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.level,
        input.status,
        redactString(input.summary).slice(0, 2000),
        JSON.stringify(redactValue(input.evidence ?? {})),
        now,
      );
    this.recordEvent({
      type: 'verification.evidence',
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      severity: input.status === 'FAILED' ? 'warn' : 'info',
      payload: { level: input.level, status: input.status, summary: input.summary.slice(0, 300) },
    });
    return {
      id,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      level: input.level,
      status: input.status,
      summary: input.summary,
      evidence: input.evidence ?? {},
      createdAt: now,
    };
  }

  listEvidence(filter: { projectId?: string; taskId?: string; level?: VerificationLevel }): EvidenceRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      args.push(filter.projectId);
    }
    if (filter.taskId) {
      where.push('task_id = ?');
      args.push(filter.taskId);
    }
    if (filter.level) {
      where.push('level = ?');
      args.push(filter.level);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM verification_evidence ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...args) as Row[];
    return rows.map((r) => ({
      id: r['id'] as string,
      projectId: r['project_id'] as string,
      taskId: (r['task_id'] as string | null) ?? null,
      level: r['level'] as VerificationLevel,
      status: r['status'] as EvidenceStatus,
      summary: r['summary'] as string,
      evidence: JSON.parse(r['evidence'] as string) as Record<string, unknown>,
      createdAt: r['created_at'] as number,
    }));
  }

  // ------------------------------------------------ provider verification
  setProviderVerification(
    provider: string,
    level: string,
    sdkVersion: string | null,
    detail: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO provider_verification(provider,level,verified_at,sdk_version,detail) VALUES (?,?,?,?,?)
         ON CONFLICT(provider,level) DO UPDATE SET verified_at=excluded.verified_at, sdk_version=excluded.sdk_version, detail=excluded.detail`,
      )
      .run(provider, level, this.clock.now(), sdkVersion, JSON.stringify(redactValue(detail)));
    this.recordEvent({ type: 'provider.verified', payload: { provider, level, sdkVersion } });
  }

  getProviderVerifications(
    provider: string,
  ): Record<string, { verifiedAt: number; sdkVersion: string | null; detail: Record<string, unknown> }> {
    const out: Record<
      string,
      { verifiedAt: number; sdkVersion: string | null; detail: Record<string, unknown> }
    > = {};
    for (const r of this.db
      .prepare('SELECT * FROM provider_verification WHERE provider = ?')
      .all(provider) as Row[]) {
      out[r['level'] as string] = {
        verifiedAt: r['verified_at'] as number,
        sdkVersion: (r['sdk_version'] as string | null) ?? null,
        detail: JSON.parse(r['detail'] as string) as Record<string, unknown>,
      };
    }
    return out;
  }

  // --------------------------------------------------------- task outputs
  /** Persist the FULL final output of an execution (executions.summary is truncated). Capped at 512 KiB. */
  saveTaskOutput(taskId: string, executionId: string, content: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO task_outputs(task_id,execution_id,content,created_at) VALUES (?,?,?,?)',
      )
      .run(taskId, executionId, redactString(content).slice(0, 512 * 1024), this.clock.now());
  }

  /** Latest stored output of a task, or null. */
  getTaskOutput(taskId: string): string | null {
    const r = this.db
      .prepare(
        'SELECT content FROM task_outputs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(taskId) as { content: string } | undefined;
    return r?.content ?? null;
  }

  // ----------------------------------------------------------- maintenance
  /** Delete old low-value activity events and checkpoint the WAL so it cannot grow without bound. */
  runMaintenance(eventRetentionDays: number): { eventsDeleted: number } {
    const cutoff = this.clock.now() - eventRetentionDays * 86_400_000;
    const res = this.db
      .prepare(`DELETE FROM activity_events WHERE at < ? AND severity IN ('debug','info')`)
      .run(cutoff);
    try {
      this.db.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      /* a concurrent reader may hold the WAL; PASSIVE is best effort */
    }
    return { eventsDeleted: res.changes };
  }
}
