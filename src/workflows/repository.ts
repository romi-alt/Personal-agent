import { newId } from '../core/ids.js';
import type { Store } from '../queue/store.js';

export type RunStatus = 'RUNNING' | 'WAITING_FOR_OWNER' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type StepStatus = 'PENDING' | 'DISPATCHED' | 'COMPLETED' | 'INVALID' | 'ERRORED';
export type Phase = 'analyze' | 'clarify' | 'architect' | 'decompose' | 'approval' | 'done';

export interface RunContext {
  phase: Phase;
  /** Repair rounds used per planning step. */
  repairs: Record<string, number>;
  questions: { id: string; text: string; blocking: boolean }[];
  answers: Record<string, string>;
  /** Owner chose to continue without answering blocking questions (assumptions are used instead). */
  assume: boolean;
  approvalId?: string;
}

export interface WorkflowRun {
  id: string;
  projectId: string;
  kind: string;
  status: RunStatus;
  currentStep: string | null;
  context: RunContext;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStep {
  id: string;
  runId: string;
  name: string;
  attempt: number;
  status: StepStatus;
  taskId: string | null;
  output: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, unknown>;

const mapRun = (r: Row): WorkflowRun => ({
  id: r['id'] as string,
  projectId: r['project_id'] as string,
  kind: r['kind'] as string,
  status: r['status'] as RunStatus,
  currentStep: (r['current_step'] as string | null) ?? null,
  context: JSON.parse(r['context'] as string) as RunContext,
  error: (r['error'] as string | null) ?? null,
  createdAt: r['created_at'] as number,
  updatedAt: r['updated_at'] as number,
});

const mapStep = (r: Row): WorkflowStep => ({
  id: r['id'] as string,
  runId: r['run_id'] as string,
  name: r['name'] as string,
  attempt: r['attempt'] as number,
  status: r['status'] as StepStatus,
  taskId: (r['task_id'] as string | null) ?? null,
  output: (r['output'] as string | null) ?? null,
  error: (r['error'] as string | null) ?? null,
  createdAt: r['created_at'] as number,
  updatedAt: r['updated_at'] as number,
});

/** Persistence for workflow runs, steps, requirements, milestones and plan links (same SQLite database as the queue). */
export class WorkflowRepository {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }
  private now(): number {
    return this.store.clock.now();
  }

  // ------------------------------------------------------------------ runs
  createRun(projectId: string, kind: string, context: RunContext): WorkflowRun {
    const id = newId('wfr');
    const now = this.now();
    this.db
      .prepare(
        'INSERT INTO workflow_runs(id,project_id,kind,status,current_step,context,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, projectId, kind, 'RUNNING', context.phase, JSON.stringify(context), now, now);
    return this.getRun(id)!;
  }

  getRun(id: string): WorkflowRun | null {
    const r = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as Row | undefined;
    return r ? mapRun(r) : null;
  }

  listRuns(filter: { projectId?: string; statuses?: RunStatus[] } = {}): WorkflowRun[] {
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
    return (
      this.db
        .prepare(
          `SELECT * FROM workflow_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, rowid`,
        )
        .all(...args) as Row[]
    ).map(mapRun);
  }

  updateRun(id: string, patch: { status?: RunStatus; context?: RunContext; error?: string | null }): void {
    const sets: string[] = ['updated_at = @now'];
    const args: Row = { id, now: this.now() };
    if (patch.status) {
      sets.push('status = @status');
      args['status'] = patch.status;
    }
    if (patch.context) {
      sets.push('context = @ctx', 'current_step = @step');
      args['ctx'] = JSON.stringify(patch.context);
      args['step'] = patch.context.phase;
    }
    if (patch.error !== undefined) {
      sets.push('error = @err');
      args['err'] = patch.error;
    }
    this.db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = @id`).run(args);
  }

  // ----------------------------------------------------------------- steps
  createStep(runId: string, name: string, attempt: number): WorkflowStep {
    const id = newId('wfs');
    const now = this.now();
    this.db
      .prepare(
        'INSERT OR IGNORE INTO workflow_steps(id,run_id,name,attempt,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(id, runId, name, attempt, 'PENDING', now, now);
    return this.getStep(runId, name, attempt)!;
  }

  getStep(runId: string, name: string, attempt: number): WorkflowStep | null {
    const r = this.db
      .prepare('SELECT * FROM workflow_steps WHERE run_id = ? AND name = ? AND attempt = ?')
      .get(runId, name, attempt) as Row | undefined;
    return r ? mapStep(r) : null;
  }

  latestStep(runId: string, name: string): WorkflowStep | null {
    const r = this.db
      .prepare('SELECT * FROM workflow_steps WHERE run_id = ? AND name = ? ORDER BY attempt DESC LIMIT 1')
      .get(runId, name) as Row | undefined;
    return r ? mapStep(r) : null;
  }

  /** The most recent COMPLETED step output for a step name (validated JSON text). */
  completedOutput(runId: string, name: string): string | null {
    const r = this.db
      .prepare(
        "SELECT output FROM workflow_steps WHERE run_id = ? AND name = ? AND status = 'COMPLETED' ORDER BY attempt DESC LIMIT 1",
      )
      .get(runId, name) as { output: string } | undefined;
    return r?.output ?? null;
  }

  listSteps(runId: string): WorkflowStep[] {
    return (
      this.db
        .prepare('SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY created_at, rowid')
        .all(runId) as Row[]
    ).map(mapStep);
  }

  updateStep(
    id: string,
    patch: { status?: StepStatus; taskId?: string | null; output?: string | null; error?: string | null },
  ): void {
    const sets: string[] = ['updated_at = @now'];
    const args: Row = { id, now: this.now() };
    if (patch.status) {
      sets.push('status = @status');
      args['status'] = patch.status;
    }
    if (patch.taskId !== undefined) {
      sets.push('task_id = @task');
      args['task'] = patch.taskId;
    }
    if (patch.output !== undefined) {
      sets.push('output = @out');
      args['out'] = patch.output;
    }
    if (patch.error !== undefined) {
      sets.push('error = @err');
      args['err'] = patch.error;
    }
    this.db.prepare(`UPDATE workflow_steps SET ${sets.join(', ')} WHERE id = @id`).run(args);
  }

  // ---------------------------------------------------------- requirements
  upsertRequirement(
    projectId: string,
    r: { id: string; text: string; kind: string; priority: string; source: string },
  ): void {
    this.db
      .prepare(
        `INSERT INTO requirements(project_id,req_id,text,kind,priority,source) VALUES (?,?,?,?,?,?)
         ON CONFLICT(project_id,req_id) DO UPDATE SET text=excluded.text, kind=excluded.kind, priority=excluded.priority`,
      )
      .run(projectId, r.id, r.text, r.kind, r.priority, r.source);
  }

  listRequirements(
    projectId: string,
  ): { id: string; text: string; kind: string; priority: string; source: string; status: string }[] {
    return (
      this.db
        .prepare('SELECT * FROM requirements WHERE project_id = ? ORDER BY rowid')
        .all(projectId) as Row[]
    ).map((r) => ({
      id: r['req_id'] as string,
      text: r['text'] as string,
      kind: r['kind'] as string,
      priority: r['priority'] as string,
      source: r['source'] as string,
      status: r['status'] as string,
    }));
  }

  // ------------------------------------------------------------ plan links
  upsertMilestone(
    projectId: string,
    m: { key: string; title: string; goal: string; position: number; requirementIds: string[] },
  ): void {
    this.db
      .prepare(
        `INSERT INTO milestones(project_id,key,title,goal,position,requirement_ids) VALUES (?,?,?,?,?,?)
         ON CONFLICT(project_id,key) DO UPDATE SET title=excluded.title, goal=excluded.goal, position=excluded.position, requirement_ids=excluded.requirement_ids`,
      )
      .run(projectId, m.key, m.title, m.goal, m.position, JSON.stringify(m.requirementIds));
  }

  listMilestones(projectId: string): {
    key: string;
    title: string;
    goal: string;
    position: number;
    requirementIds: string[];
    status: string;
  }[] {
    return (
      this.db
        .prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY position')
        .all(projectId) as Row[]
    ).map((r) => ({
      key: r['key'] as string,
      title: r['title'] as string,
      goal: r['goal'] as string,
      position: r['position'] as number,
      requirementIds: JSON.parse(r['requirement_ids'] as string) as string[],
      status: r['status'] as string,
    }));
  }

  linkPlanTask(
    taskId: string,
    link: { runId: string; planKey: string; milestoneKey: string; requirementIds: string[]; size: string },
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO plan_tasks(task_id,run_id,plan_key,milestone_key,requirement_ids,size) VALUES (?,?,?,?,?,?)',
      )
      .run(
        taskId,
        link.runId,
        link.planKey,
        link.milestoneKey,
        JSON.stringify(link.requirementIds),
        link.size,
      );
  }

  listPlanTasks(projectId: string): {
    taskId: string;
    planKey: string;
    milestoneKey: string;
    requirementIds: string[];
    size: string;
    status: string;
    title: string;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT p.*, t.status AS tstatus, t.title AS ttitle FROM plan_tasks p JOIN tasks t ON t.id = p.task_id WHERE t.project_id = ? ORDER BY t.rowid`,
        )
        .all(projectId) as Row[]
    ).map((r) => ({
      taskId: r['task_id'] as string,
      planKey: r['plan_key'] as string,
      milestoneKey: r['milestone_key'] as string,
      requirementIds: JSON.parse(r['requirement_ids'] as string) as string[],
      size: r['size'] as string,
      status: r['tstatus'] as string,
      title: r['ttitle'] as string,
    }));
  }
}
