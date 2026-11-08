import type Database from 'better-sqlite3';

/**
 * Milestone and requirement status reconciliation (A4).
 *
 * The statuses are DERIVED from verified task state; nothing else writes them. The function is idempotent (it only
 * writes rows whose derived status differs) and works on any existing database, so it can run after every task/QA
 * change and once at start-up to repair databases written before it existed.
 *
 * Task delivery (plan tasks only; CANCELLED tasks are ignored) - see TaskDelivery: a task is delivered when it is
 * COMPLETED, no required check's LATEST evidence FAILED and its independent review (if required) PASSED or was
 * owner-accepted. Its checks are confirmed only when every required check's latest evidence PASSED
 * (NOT_CONFIGURED / missing evidence is unknown - never a pass).
 *
 * Requirement status:
 *   VERIFIED     every linked task delivered with confirmed checks AND a PASSED independent review judged this
 *                requirement met with cited evidence (it was one of that review's must-pass criteria).
 *   REVIEWED     as VERIFIED, but some linked task's build/test checks were not machine-confirmed (not configured).
 *   ACCEPTED     every linked task delivered, no passing review judged the requirement, and the owner accepted a
 *                linked task whose review covered it (owner override - NOT verified).
 *   IMPLEMENTED  every linked task delivered but no independent review judged the requirement (e.g. QA disabled).
 *   IN_PROGRESS  some linked task started or delivered.
 *   OPEN         otherwise (also: no linked task).
 *
 * Milestone status:
 *   VERIFIED     every task delivered with confirmed checks, none owner-accepted, every milestone requirement VERIFIED.
 *   ACCEPTED     every task delivered, requirements VERIFIED/REVIEWED/ACCEPTED, and an owner acceptance was involved.
 *   REVIEWED     every task delivered, requirements VERIFIED/REVIEWED, some checks not machine-confirmed.
 *   COMPLETED    every task delivered, but some milestone requirement lacks independent review.
 *   IN_PROGRESS  some task started or delivered.
 *   PLANNED      otherwise.
 */
export interface TaskDelivery {
  /** Ran at least once (or completed). */
  started: boolean;
  /** COMPLETED, no required check's latest evidence FAILED, and the independent review (if required) passed or was
   *  owner-accepted. */
  delivered: boolean;
  /** Every required machine check (build/tests/changes) has PASSED as its latest evidence. False when a check was
   *  NOT_CONFIGURED / not evaluated: unknown, never counted as a pass. */
  checksConfirmed: boolean;
  /** Outcome of the independent review. */
  qa: 'passed' | 'accepted' | 'none';
}

export interface StatusChange {
  kind: 'requirement' | 'milestone';
  projectId: string;
  id: string;
  from: string;
  to: string;
}

export interface ReconcileResult {
  changes: StatusChange[];
  requirements: Record<string, number>;
  milestones: Record<string, number>;
}

const QA_LEVEL = 'REQUIREMENTS_SATISFIED';

export function taskDelivery(db: Database.Database, taskId: string): TaskDelivery {
  const t = db.prepare('SELECT status, verification_required FROM tasks WHERE id = ?').get(taskId) as
    { status: string; verification_required: string } | undefined;
  const none: TaskDelivery = { started: false, delivered: false, checksConfirmed: false, qa: 'none' };
  if (!t) return none;
  const started =
    t.status === 'COMPLETED' ||
    !!db
      .prepare("SELECT 1 FROM task_transitions WHERE task_id = ? AND to_status = 'RUNNING' LIMIT 1")
      .get(taskId);
  if (t.status !== 'COMPLETED') return { ...none, started };
  const required = JSON.parse(t.verification_required) as string[];
  const evidence = db
    .prepare(
      'SELECT level, status, evidence FROM verification_evidence WHERE task_id = ? ORDER BY created_at, rowid',
    )
    .all(taskId) as { level: string; status: string; evidence: string }[];
  const latest = new Map<string, { status: string; evidence: string }>();
  for (const e of evidence) latest.set(e.level, e);
  const checks = required.filter((l) => l !== QA_LEVEL).map((l) => latest.get(l)?.status);
  const failed = checks.some((s) => s === 'FAILED');
  const checksConfirmed = checks.every((s) => s === 'PASSED');
  let qa: TaskDelivery['qa'] = 'none';
  let qaOk = !required.includes(QA_LEVEL);
  if (!qaOk) {
    const row = db
      .prepare('SELECT status FROM qa_reviews WHERE task_id = ? ORDER BY round DESC LIMIT 1')
      .get(taskId) as { status: string } | undefined;
    if (row) {
      if (row.status === 'PASSED') qa = 'passed';
      else if (row.status === 'OWNER_ACCEPTED') qa = 'accepted';
    } else if (latest.get(QA_LEVEL)?.status === 'PASSED') {
      let override = false;
      try {
        override = !!(JSON.parse(latest.get(QA_LEVEL)!.evidence) as { ownerOverride?: boolean })
          .ownerOverride;
      } catch {
        /* malformed evidence JSON: a regular pass record */
      }
      qa = override ? 'accepted' : 'passed';
    }
    qaOk = qa !== 'none';
  }
  return { started: true, delivered: !failed && qaOk, checksConfirmed, qa };
}

/**
 * Criterion ids judged by the reviews of the given tasks. `mode: 'passed'` - ids a PASSED round judged met with
 * cited evidence (not in its unmet list). `mode: 'any'` - ids that were criteria of any round (used for tasks the
 * owner accepted: the review judged them, but they were not verified).
 */
function reviewedCriteria(db: Database.Database, taskIds: string[], mode: 'passed' | 'any'): Set<string> {
  const out = new Set<string>();
  const st = db.prepare('SELECT status, result FROM qa_reviews WHERE task_id = ? ORDER BY round');
  for (const id of taskIds)
    for (const r of st.all(id) as { status: string; result: string | null }[]) {
      if (!r.result || (mode === 'passed' && r.status !== 'PASSED')) continue;
      let res: { criteria?: { id: string; met: boolean }[]; unmet?: { id: string }[] };
      try {
        res = JSON.parse(r.result) as typeof res;
      } catch {
        continue;
      }
      const unmet = new Set((res.unmet ?? []).map((u) => u.id));
      for (const c of res.criteria ?? []) if (mode === 'any' || (c.met && !unmet.has(c.id))) out.add(c.id);
    }
  return out;
}

/** Derive (and unless dryRun, persist) requirement and milestone statuses for one project. */
export function reconcileProjectStatus(
  db: Database.Database,
  projectId: string,
  opts: { dryRun?: boolean } = {},
): ReconcileResult {
  const links = db
    .prepare(
      `SELECT p.task_id, p.milestone_key, p.requirement_ids FROM plan_tasks p JOIN tasks t ON t.id = p.task_id
        WHERE t.project_id = ? AND t.status != 'CANCELLED' ORDER BY t.rowid`,
    )
    .all(projectId) as { task_id: string; milestone_key: string; requirement_ids: string }[];
  const delivery = new Map(links.map((l) => [l.task_id, taskDelivery(db, l.task_id)]));
  const d = (id: string) => delivery.get(id)!;
  const delivered = (id: string) => d(id).delivered;
  const active = (id: string) => d(id).started;
  const deliveredWith = (qa: TaskDelivery['qa']) =>
    links.filter((l) => d(l.task_id).delivered && d(l.task_id).qa === qa).map((l) => l.task_id);
  // Judged met by a passing independent review / covered only by a review the owner overrode.
  const reviewedReqs = reviewedCriteria(db, deliveredWith('passed'), 'passed');
  const acceptedReqs = reviewedCriteria(db, deliveredWith('accepted'), 'any');

  const linkedTasks = new Map<string, string[]>();
  for (const l of links)
    for (const r of JSON.parse(l.requirement_ids) as string[])
      linkedTasks.set(r, [...(linkedTasks.get(r) ?? []), l.task_id]);

  const reqs = db
    .prepare('SELECT req_id, status FROM requirements WHERE project_id = ? ORDER BY rowid')
    .all(projectId) as { req_id: string; status: string }[];
  const reqStatus = new Map<string, string>();
  for (const r of reqs) {
    const tasks = linkedTasks.get(r.req_id) ?? [];
    let s = 'OPEN';
    if (tasks.length && tasks.every(delivered)) {
      if (reviewedReqs.has(r.req_id)) s = tasks.every((t) => d(t).checksConfirmed) ? 'VERIFIED' : 'REVIEWED';
      else if (acceptedReqs.has(r.req_id)) s = 'ACCEPTED';
      else s = 'IMPLEMENTED';
    } else if (tasks.some(active)) s = 'IN_PROGRESS';
    reqStatus.set(r.req_id, s);
  }

  const milestones = db
    .prepare('SELECT key, status, requirement_ids FROM milestones WHERE project_id = ? ORDER BY position')
    .all(projectId) as { key: string; status: string; requirement_ids: string }[];
  const msStatus = new Map<string, string>();
  for (const m of milestones) {
    const tasks = links.filter((l) => l.milestone_key === m.key).map((l) => l.task_id);
    const mreqs = (JSON.parse(m.requirement_ids) as string[]).map((id) => reqStatus.get(id) ?? 'OPEN');
    let s = 'PLANNED';
    if (tasks.length && tasks.every(delivered)) {
      const anyAccepted = tasks.some((t) => d(t).qa === 'accepted') || mreqs.includes('ACCEPTED');
      const allConfirmed = tasks.every((t) => d(t).checksConfirmed && d(t).qa !== 'accepted');
      if (allConfirmed && mreqs.every((x) => x === 'VERIFIED')) s = 'VERIFIED';
      else if (mreqs.every((x) => ['VERIFIED', 'REVIEWED', 'ACCEPTED'].includes(x)))
        s = anyAccepted ? 'ACCEPTED' : 'REVIEWED';
      else s = 'COMPLETED';
    } else if (tasks.some(active)) s = 'IN_PROGRESS';
    msStatus.set(m.key, s);
  }

  const changes: StatusChange[] = [];
  for (const r of reqs) {
    const to = reqStatus.get(r.req_id)!;
    if (to !== r.status) changes.push({ kind: 'requirement', projectId, id: r.req_id, from: r.status, to });
  }
  for (const m of milestones) {
    const to = msStatus.get(m.key)!;
    if (to !== m.status) changes.push({ kind: 'milestone', projectId, id: m.key, from: m.status, to });
  }
  if (!opts.dryRun && changes.length) {
    const ur = db.prepare('UPDATE requirements SET status = ? WHERE project_id = ? AND req_id = ?');
    const um = db.prepare('UPDATE milestones SET status = ? WHERE project_id = ? AND key = ?');
    db.transaction(() => {
      for (const c of changes) (c.kind === 'requirement' ? ur : um).run(c.to, projectId, c.id);
    })();
  }
  const count = (m: Map<string, string>) => {
    const o: Record<string, number> = {};
    for (const v of m.values()) o[v] = (o[v] ?? 0) + 1;
    return o;
  };
  return { changes, requirements: count(reqStatus), milestones: count(msStatus) };
}

/** Reconcile every project that has a plan. */
export function reconcileAllProjects(
  db: Database.Database,
  opts: { dryRun?: boolean } = {},
): ReconcileResult {
  const ids = (
    db
      .prepare(
        'SELECT DISTINCT t.project_id AS id FROM plan_tasks p JOIN tasks t ON t.id = p.task_id ORDER BY t.project_id',
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
  const out: ReconcileResult = { changes: [], requirements: {}, milestones: {} };
  for (const id of ids) {
    const r = reconcileProjectStatus(db, id, opts);
    out.changes.push(...r.changes);
    for (const [k, v] of Object.entries(r.requirements)) out.requirements[k] = (out.requirements[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.milestones)) out.milestones[k] = (out.milestones[k] ?? 0) + v;
  }
  return out;
}
