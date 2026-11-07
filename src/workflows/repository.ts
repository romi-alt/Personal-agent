import { newId } from '../core/ids.js';
import type { AdrRecord, FindingRecord } from '../planning/documents.js';
import type { ReviewIssue } from '../planning/schemas.js';
import type { Store } from '../queue/store.js';

export type RunStatus = 'RUNNING' | 'WAITING_FOR_OWNER' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type StepStatus = 'PENDING' | 'DISPATCHED' | 'COMPLETED' | 'INVALID' | 'ERRORED';
export type Phase =
  'intake' | 'analyze' | 'clarify' | 'research' | 'architect' | 'decompose' | 'review' | 'approval' | 'done';

export interface RunContext {
  phase: Phase;
  /** Repair rounds used per planning step. */
  repairs: Record<string, number>;
  questions: { id: string; text: string; blocking: boolean }[];
  answers: Record<string, string>;
  /** Owner chose to continue without answering blocking questions (assumptions are used instead). */
  assume: boolean;
  approvalId?: string;
  /** Planning-review rounds used (each "revise" sends the plan back to decompose, bounded by maxPlanRepairs). */
  reviewRounds?: number;
  /** Review issues the plan is being revised for (fed into the decompose prompt). */
  reviewIssues?: ReviewIssue[];
  /** Intake runs: the workspace chosen by the owner (the model never chooses it). */
  workspace?: unknown;
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
    link: {
      runId: string;
      planKey: string;
      milestoneKey: string;
      requirementIds: string[];
      size: string;
      epicKey?: string | null;
      subtasks?: string[];
      testing?: string;
    },
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO plan_tasks(task_id,run_id,plan_key,milestone_key,requirement_ids,size,epic_key,subtasks,testing) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        taskId,
        link.runId,
        link.planKey,
        link.milestoneKey,
        JSON.stringify(link.requirementIds),
        link.size,
        link.epicKey ?? null,
        JSON.stringify(link.subtasks ?? []),
        link.testing ?? '',
      );
  }

  upsertEpic(projectId: string, e: { key: string; title: string; goal: string; position: number }): void {
    this.db
      .prepare(
        `INSERT INTO epics(project_id,key,title,goal,position) VALUES (?,?,?,?,?)
         ON CONFLICT(project_id,key) DO UPDATE SET title=excluded.title, goal=excluded.goal, position=excluded.position`,
      )
      .run(projectId, e.key, e.title, e.goal, e.position);
  }

  listEpics(projectId: string): { key: string; title: string; goal: string; position: number }[] {
    return (
      this.db.prepare('SELECT * FROM epics WHERE project_id = ? ORDER BY position').all(projectId) as Row[]
    ).map((r) => ({
      key: r['key'] as string,
      title: r['title'] as string,
      goal: r['goal'] as string,
      position: r['position'] as number,
    }));
  }

  // ------------------------------------------------------------ documents
  /** Persist an original owner document verbatim (deduplicated by content hash). */
  addDocument(projectId: string, d: { kind: string; name: string; content: string; sha256: string }): string {
    const existing = this.db
      .prepare('SELECT id FROM project_documents WHERE project_id = ? AND sha256 = ?')
      .get(projectId, d.sha256) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = newId('doc');
    this.db
      .prepare(
        'INSERT INTO project_documents(id,project_id,kind,name,content,sha256,bytes,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, projectId, d.kind, d.name, d.content, d.sha256, Buffer.byteLength(d.content), this.now());
    return id;
  }

  listDocuments(
    projectId: string,
  ): { id: string; kind: string; name: string; content: string; bytes: number; createdAt: number }[] {
    return (
      this.db
        .prepare('SELECT * FROM project_documents WHERE project_id = ? ORDER BY created_at, rowid')
        .all(projectId) as Row[]
    ).map((r) => ({
      id: r['id'] as string,
      kind: r['kind'] as string,
      name: r['name'] as string,
      content: r['content'] as string,
      bytes: r['bytes'] as number,
      createdAt: r['created_at'] as number,
    }));
  }

  // ------------------------------------------------------------- research
  saveFindings(runId: string, projectId: string, findings: FindingRecord[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO research_findings(run_id,finding_id,project_id,area,statement,kind,claimed_kind,confidence,sources,citation_check,researched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const f of findings)
      st.run(
        runId,
        f.findingId,
        projectId,
        f.area,
        f.statement,
        f.kind,
        f.claimedKind,
        f.confidence,
        JSON.stringify(f.sources),
        f.citationCheck,
        f.researchedAt,
      );
  }

  listFindings(projectId: string): FindingRecord[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM research_findings WHERE project_id = ? AND run_id = (SELECT run_id FROM research_findings WHERE project_id = ? ORDER BY researched_at DESC LIMIT 1) ORDER BY rowid',
        )
        .all(projectId, projectId) as Row[]
    ).map((r) => ({
      findingId: r['finding_id'] as string,
      area: r['area'] as string,
      statement: r['statement'] as string,
      kind: r['kind'] as string,
      claimedKind: r['claimed_kind'] as string,
      confidence: r['confidence'] as string,
      sources: JSON.parse(r['sources'] as string) as { title: string; url: string }[],
      citationCheck: r['citation_check'] as string,
      researchedAt: r['researched_at'] as number,
    }));
  }

  // ------------------------------------------------------------------ ADRs
  saveAdrs(projectId: string, runId: string, adrs: AdrRecord[], filePath: (a: AdrRecord) => string): void {
    const st = this.db.prepare(
      `INSERT INTO adrs(project_id,adr_id,number,title,status,context,decision,alternatives,rationale,consequences,significant,decided_at,run_id,file_path)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id,adr_id) DO UPDATE SET title=excluded.title, status=excluded.status, context=excluded.context,
         decision=excluded.decision, alternatives=excluded.alternatives, rationale=excluded.rationale,
         consequences=excluded.consequences, significant=excluded.significant, decided_at=excluded.decided_at,
         run_id=excluded.run_id, file_path=excluded.file_path`,
    );
    for (const a of adrs)
      st.run(
        projectId,
        a.adrId,
        a.number,
        a.title,
        a.status,
        a.context,
        a.decision,
        JSON.stringify(a.alternatives),
        a.rationale,
        a.consequences,
        a.significant ? 1 : 0,
        a.decidedAt,
        runId,
        filePath(a),
      );
  }

  listAdrs(projectId: string): (AdrRecord & { filePath: string | null; runId: string })[] {
    return (
      this.db.prepare('SELECT * FROM adrs WHERE project_id = ? ORDER BY number').all(projectId) as Row[]
    ).map((r) => ({
      adrId: r['adr_id'] as string,
      number: r['number'] as number,
      title: r['title'] as string,
      status: r['status'] as string,
      context: r['context'] as string,
      decision: r['decision'] as string,
      alternatives: JSON.parse(r['alternatives'] as string) as string[],
      rationale: r['rationale'] as string,
      consequences: r['consequences'] as string,
      significant: !!r['significant'],
      decidedAt: r['decided_at'] as number,
      filePath: (r['file_path'] as string | null) ?? null,
      runId: r['run_id'] as string,
    }));
  }

  setAdrStatus(projectId: string, runId: string, status: string): void {
    this.db
      .prepare('UPDATE adrs SET status = ? WHERE project_id = ? AND run_id = ?')
      .run(status, projectId, runId);
  }

  saveSpec(runId: string, projectId: string, sections: unknown, diagrams: unknown): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO architecture_specs(run_id,project_id,sections,diagrams,created_at) VALUES (?,?,?,?,?)',
      )
      .run(runId, projectId, JSON.stringify(sections), JSON.stringify(diagrams), this.now());
  }

  latestSpec(
    projectId: string,
  ): { sections: Record<string, string>; diagrams: { title: string; mermaid: string }[] } | null {
    const r = this.db
      .prepare(
        'SELECT * FROM architecture_specs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(projectId) as Row | undefined;
    return r
      ? {
          sections: JSON.parse(r['sections'] as string) as Record<string, string>,
          diagrams: JSON.parse(r['diagrams'] as string) as { title: string; mermaid: string }[],
        }
      : null;
  }

  // ------------------------------------------------------------ reviews
  saveReview(
    runId: string,
    projectId: string,
    round: number,
    source: string,
    verdict: string,
    issues: ReviewIssue[],
  ): void {
    this.db
      .prepare(
        'INSERT INTO plan_reviews(id,run_id,project_id,round,source,verdict,issues,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(newId('rev'), runId, projectId, round, source, verdict, JSON.stringify(issues), this.now());
  }

  listReviews(
    runId: string,
  ): { round: number; source: string; verdict: string; issues: ReviewIssue[]; createdAt: number }[] {
    return (
      this.db
        .prepare('SELECT * FROM plan_reviews WHERE run_id = ? ORDER BY created_at, rowid')
        .all(runId) as Row[]
    ).map((r) => ({
      round: r['round'] as number,
      source: r['source'] as string,
      verdict: r['verdict'] as string,
      issues: JSON.parse(r['issues'] as string) as ReviewIssue[],
      createdAt: r['created_at'] as number,
    }));
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
