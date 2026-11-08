import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Logger } from '../logging/logger.js';
import { extractJson } from '../planning/extract-json.js';
import type { Store } from '../queue/store.js';
import type { Task } from '../types/index.js';
import { requirementOwnership } from '../planning/ownership.js';
import { TASK_VERIFIABLE_LEVELS } from '../verification/types.js';
import { isPathInside } from '../workspaces/paths.js';

const execFileP = promisify(execFile);

/**
 * Independent quality assurance (Phase 3.4). The coding worker never approves its own work:
 *   1. When a planned coding task COMPLETES (its own build/test evidence passed), a READ-ONLY review task is queued.
 *      It runs in a fresh provider session that sees the acceptance criteria, the requirements, the actual diff and the
 *      recorded test evidence - never the implementer's reasoning.
 *   2. The reviewer returns a verdict per criterion with file:line citations. Code, not the model, decides the result:
 *      a criterion only counts as met if its citations point at real lines in the repository.
 *   3. PASS -> REQUIREMENTS_SATISFIED evidence on the task; dependants become claimable (see Store.claimNext).
 *      FAIL -> a correction task (bounded rounds), then a new review. Exhausted -> owner escalation (approval inbox).
 */
export interface QaConfig {
  enabled: boolean;
  /** Correction rounds per task before escalating to the owner. */
  maxCorrectionRounds: number;
  /** Re-dispatches of a review whose reply was unusable. */
  maxReviewRepairs: number;
  defaultMaxRetries: number;
}

const QA_PRIORITY = 2000; // reviews run right after the reviewed task, before other coding work
const CORRECTION_PRIORITY = 1500;

const reviewReplySchema = z.object({
  criteria: z
    .array(
      z.object({
        id: z.string().min(1),
        met: z.boolean(),
        evidence: z
          .array(z.object({ file: z.string().min(1), line: z.number().int().positive() }))
          .default([]),
        note: z.string().default(''),
        /** Reviewer's claim that the gap belongs to another task (only meaningful for other tasks' requirements). */
        coveredBy: z.string().optional(),
      }),
    )
    .min(1),
  defects: z
    .array(
      z.object({
        severity: z.enum(['low', 'medium', 'high']),
        description: z.string().min(3),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        /** The criterion (AC id or owned requirement id) the defect violates. */
        criterionId: z.string().optional(),
      }),
    )
    .default([]),
  /** Informational remarks on project requirements owned by OTHER tasks. Never fail the review. */
  observations: z
    .array(
      z.object({ id: z.string().min(1), note: z.string().default(''), coveredBy: z.string().optional() }),
    )
    .default([]),
  testsAssessment: z.string().default(''),
});
export type ReviewReply = z.infer<typeof reviewReplySchema>;

export interface Criterion {
  id: string;
  text: string;
  /** 'acceptance' = the task's own acceptance criterion; 'owned' = a project requirement this task owns. */
  scope?: 'acceptance' | 'owned';
}

/** A project requirement linked to the task but OWNED by another task: informational for this review. */
export interface ContributedRequirement {
  id: string;
  text: string;
  ownerTaskId: string | null;
  ownerTitle: string | null;
}

/** Informational finding: recorded with the review, never a reason to fail it. */
export interface ReviewNote {
  id: string;
  kind: 'other_task_requirement' | 'uncited_defect' | 'observation';
  note: string;
  coveredBy: string | null;
}

/**
 * The task's MUST-PASS criteria: its own acceptance criteria plus the project requirements it OWNS (deterministic).
 * Requirements owned by other tasks are not criteria (A1); pass them to checkReview/reviewTaskPrompt separately.
 */
export function criteriaFor(task: Task, ownedRequirements: { id: string; text: string }[]): Criterion[] {
  const items = task.acceptanceCriteria
    .split(/\r?\n|;(?=\s)/)
    .map((s) => s.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter((s) => s.length >= 3);
  return [
    ...items.map((text, i) => ({ id: `AC${i + 1}`, text, scope: 'acceptance' as const })),
    ...ownedRequirements.map((r) => ({ id: r.id, text: r.text, scope: 'owned' as const })),
  ];
}

/**
 * Check a review reply. Code, not the model, decides:
 *   - a must-pass criterion counts as met only with valid file:line citations inside the repository;
 *   - verdicts on requirements owned by OTHER tasks are informational notes ("covered by <task>"), never failures;
 *   - a high-severity defect blocks only when it is about this task: it names one of this task's criteria, or it
 *     names no criterion but cites a real file:line. A defect that names another task's requirement, or cites
 *     nothing, becomes a note.
 * A FAIL therefore always cites at least one of the task's own criteria or a concrete defect in its code; anything
 * else that the reviewer flagged is normalized to PASS-with-notes (`normalized: true`), so mis-mapped findings can
 * never create correction tasks.
 */
export function checkReview(
  reply: ReviewReply,
  criteria: Criterion[],
  repoPath: string,
  contributed: ContributedRequirement[] = [],
): {
  passed: boolean;
  unmet: { id: string; text: string; reason: string }[];
  defects: ReviewReply['defects'];
  /** High-severity defects that fail the review. */
  blockingDefects: ReviewReply['defects'];
  notes: ReviewNote[];
  /** The reviewer flagged something that did not count against this task (passed => PASS-with-notes). */
  normalized: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const notes: ReviewNote[] = [];
  const ids = new Set(criteria.map((c) => c.id));
  const others = new Map(contributed.map((c) => [c.id, c]));
  const ownerOf = (id: string) => others.get(id)?.ownerTaskId ?? null;
  // Did the reviewer flag anything that, before ownership existed, would have failed the review?
  let flagged = reply.observations.length > 0;
  for (const c of reply.criteria) {
    if (ids.has(c.id)) continue;
    if (others.has(c.id)) {
      // Not this task's scope: a verdict here (met or not) is informational only.
      if (!c.met) flagged = true;
      notes.push({
        id: c.id,
        kind: 'other_task_requirement',
        note: `${c.met ? 'met' : 'not met'} here; owned by ${ownerOf(c.id) ?? 'another task'}${c.note ? ` - ${c.note}` : ''}`,
        coveredBy: c.coveredBy ?? ownerOf(c.id),
      });
    } else errors.push(`unknown criterion id "${c.id}"`);
  }
  for (const o of reply.observations)
    notes.push({ id: o.id, kind: 'observation', note: o.note, coveredBy: o.coveredBy ?? ownerOf(o.id) });
  for (const c of criteria)
    if (!reply.criteria.some((r) => r.id === c.id)) errors.push(`criterion "${c.id}" has no verdict`);
  const lineCount = new Map<string, number | null>();
  const validCite = (file: string, line: number) => {
    const abs = path.resolve(repoPath, file);
    if (!isPathInside(abs, repoPath)) return false;
    if (!lineCount.has(abs)) {
      try {
        lineCount.set(abs, existsSync(abs) ? readFileSync(abs, 'utf8').split('\n').length : null);
      } catch {
        lineCount.set(abs, null);
      }
    }
    const n = lineCount.get(abs);
    return n !== null && n !== undefined && line <= n;
  };
  const unmet: { id: string; text: string; reason: string }[] = [];
  for (const c of criteria) {
    const v = reply.criteria.find((r) => r.id === c.id);
    if (!v) continue;
    if (!v.met) unmet.push({ id: c.id, text: c.text, reason: v.note || 'reviewer: not met' });
    else if (!v.evidence.length || !v.evidence.every((e) => validCite(e.file, e.line)))
      unmet.push({
        id: c.id,
        text: c.text,
        reason: 'claimed met without a valid file:line citation in the repository',
      });
  }
  const blockingDefects: ReviewReply['defects'] = [];
  for (const d of reply.defects.filter((x) => x.severity === 'high')) {
    const cited = !!d.file && !!d.line && validCite(d.file, d.line);
    const otherTask = !!d.criterionId && others.has(d.criterionId);
    const own = d.criterionId && ids.has(d.criterionId) ? true : otherTask ? false : cited;
    if (own) blockingDefects.push(d);
    else {
      flagged = true;
      notes.push({
        id: d.criterionId ?? '(none)',
        kind: otherTask ? 'other_task_requirement' : 'uncited_defect',
        note: `high-severity defect not attributable to this task: ${d.description}`,
        coveredBy: otherTask ? ownerOf(d.criterionId!) : null,
      });
    }
  }
  const passed = errors.length === 0 && unmet.length === 0 && blockingDefects.length === 0;
  return {
    passed,
    unmet,
    defects: reply.defects,
    blockingDefects,
    notes,
    normalized: flagged,
    errors,
  };
}

interface QaRow {
  taskId: string;
  round: number;
  reviewTaskId: string | null;
  correctionTaskId: string | null;
  status: string;
  repairs: number;
  approvalId: string | null;
}

export class QaEngine {
  constructor(
    private readonly store: Store,
    private readonly cfg: QaConfig,
    private readonly log?: Logger,
  ) {}

  private get db() {
    return this.store.db;
  }

  rows(taskId?: string): QaRow[] {
    const rows = (
      taskId
        ? this.db.prepare('SELECT * FROM qa_reviews WHERE task_id = ? ORDER BY round').all(taskId)
        : this.db.prepare('SELECT * FROM qa_reviews ORDER BY created_at, rowid').all()
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      taskId: r['task_id'] as string,
      round: r['round'] as number,
      reviewTaskId: (r['review_task_id'] as string | null) ?? null,
      correctionTaskId: (r['correction_task_id'] as string | null) ?? null,
      status: r['status'] as string,
      repairs: r['repairs'] as number,
      approvalId: (r['approval_id'] as string | null) ?? null,
    }));
  }

  /** Every review task of a task's QA rounds, including repair re-dispatches that a later repair superseded. */
  reviewTasks(taskId: string): { reviewTaskId: string; round: number; repair: number }[] {
    return (
      this.db
        .prepare(
          'SELECT review_task_id, round, repair FROM qa_review_tasks WHERE task_id = ? ORDER BY round, repair',
        )
        .all(taskId) as { review_task_id: string; round: number; repair: number }[]
    ).map((r) => ({ reviewTaskId: r.review_task_id, round: r.round, repair: r.repair }));
  }

  /** Review tasks (dedupe key "qa:...") that are linked to no QA round. Empty unless the database is inconsistent. */
  orphanReviewTasks(): string[] {
    return (
      this.db
        .prepare(
          `SELECT t.id FROM tasks t WHERE t.dedupe_key LIKE 'qa:%'
             AND NOT EXISTS (SELECT 1 FROM qa_review_tasks l WHERE l.review_task_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM qa_reviews q WHERE q.review_task_id = t.id) ORDER BY t.rowid`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
  }

  result(taskId: string, round: number): Record<string, unknown> | null {
    const r = this.db
      .prepare('SELECT result FROM qa_reviews WHERE task_id = ? AND round = ?')
      .get(taskId, round) as { result: string | null } | undefined;
    return r?.result ? (JSON.parse(r.result) as Record<string, unknown>) : null;
  }

  private update(
    taskId: string,
    round: number,
    patch: Partial<{
      status: string;
      reviewTaskId: string;
      correctionTaskId: string;
      repairs: number;
      result: unknown;
      approvalId: string;
    }>,
  ): void {
    const sets = ['updated_at = @now'];
    const args: Record<string, unknown> = { taskId, round, now: this.store.clock.now() };
    const map: Record<string, string> = {
      status: 'status',
      reviewTaskId: 'review_task_id',
      correctionTaskId: 'correction_task_id',
      repairs: 'repairs',
      approvalId: 'approval_id',
    };
    for (const [k, col] of Object.entries(map))
      if (patch[k as keyof typeof patch] !== undefined) {
        sets.push(`${col} = @${k}`);
        args[k] = patch[k as keyof typeof patch];
      }
    if (patch.result !== undefined) {
      sets.push('result = @result');
      args['result'] = JSON.stringify(patch.result);
    }
    this.db
      .prepare(`UPDATE qa_reviews SET ${sets.join(', ')} WHERE task_id = @taskId AND round = @round`)
      .run(args);
  }

  /** One pass over QA state. Cheap when idle; safe to call on every supervisor tick and after any crash. */
  async tick(): Promise<number> {
    if (!this.cfg.enabled) return 0;
    let changed = 0;
    // 1. newly completed tasks that need a review
    const pending = this.db
      .prepare(
        `SELECT t.id FROM tasks t WHERE t.kind = 'CODING' AND t.status = 'COMPLETED' AND t.verification_required LIKE '%REQUIREMENTS_SATISFIED%'
           AND NOT EXISTS (SELECT 1 FROM qa_reviews q WHERE q.task_id = t.id) ORDER BY t.rowid`,
      )
      .all() as { id: string }[];
    for (const { id } of pending) {
      await this.startReview(this.store.requireTask(id), 1);
      changed++;
    }
    // 2. advance open rounds
    for (const row of this.rows().filter((r) =>
      ['REVIEWING', 'CORRECTING', 'ESCALATED'].includes(r.status),
    )) {
      try {
        if (await this.advance(row)) changed++;
      } catch (err) {
        this.log?.error('qa.advance_error', { taskId: row.taskId, round: row.round, error: err });
      }
    }
    return changed;
  }

  private async startReview(
    task: Task,
    round: number,
    repairOf?: { errors: string[]; repairs: number },
  ): Promise<void> {
    const project = this.store.getProject(task.projectId)!;
    const scope = this.reviewScope(task);
    const criteria = criteriaFor(task, scope.owned);
    const diff = await this.diffFor(task, project.repoPath);
    const evidence = this.store
      .listEvidence({ taskId: task.id })
      .filter((e) => (TASK_VERIFIABLE_LEVELS as readonly string[]).includes(e.level))
      .map((e) => `- ${e.level}: ${e.status} - ${e.summary}`)
      .join('\n');
    const prompt = reviewTaskPrompt(task, criteria, diff, evidence, repairOf?.errors, {
      contributes: scope.contributes,
      ownershipMap: scope.map,
    });
    const repairs = repairOf?.repairs ?? 0;
    const title = `Review: ${task.title}${round > 1 ? ` (round ${round})` : ''}${repairs ? ` (repair ${repairs})` : ''}`;
    // A3: the review task, its qa_reviews round and its qa_review_tasks link are written in ONE immediate
    // transaction; a failure anywhere rolls all of them back (no review task without a QA round). A repair
    // re-dispatch supersedes the round's review_task_id, but the superseded review stays linked through
    // qa_review_tasks (the pilot's "orphan" review tsk_mw6qev54ed00819a0c was such a superseded repair-0 review).
    this.db
      .transaction(() => {
        const now = this.store.clock.now();
        const { task: review } = this.store.enqueueTask({
          projectId: task.projectId,
          kind: 'PLANNING', // read-only tools; fresh session
          title,
          instructions: prompt,
          priority: QA_PRIORITY,
          maxRetries: this.cfg.defaultMaxRetries,
          dedupeKey: `qa:${task.id}:${round}:${repairs}`,
        });
        if (!this.rows(task.id).some((r) => r.round === round)) {
          this.db
            .prepare(
              'INSERT INTO qa_reviews(task_id,round,review_task_id,status,repairs,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
            )
            .run(task.id, round, review.id, 'REVIEWING', repairs, now, now);
        } else this.update(task.id, round, { reviewTaskId: review.id, status: 'REVIEWING', repairs });
        this.db
          .prepare(
            'INSERT OR IGNORE INTO qa_review_tasks(review_task_id,task_id,round,repair,created_at) VALUES (?,?,?,?,?)',
          )
          .run(review.id, task.id, round, repairs, now);
        this.store.recordEvent({
          type: 'qa.review_queued',
          projectId: task.projectId,
          taskId: task.id,
          payload: { round, reviewTaskId: review.id, criteria: criteria.length },
        });
      })
      .immediate();
  }

  private async advance(row: QaRow): Promise<boolean> {
    const task = this.store.requireTask(row.taskId);
    if (row.status === 'REVIEWING') {
      const review = row.reviewTaskId ? this.store.getTask(row.reviewTaskId) : null;
      if (!review) return false;
      if (review.status === 'FAILED' || review.status === 'CANCELLED')
        return this.escalate(task, row, `review task ${review.status}: ${review.lastErrorMessage ?? ''}`);
      if (review.status !== 'COMPLETED') return false;
      const project = this.store.getProject(task.projectId)!;
      const scope = this.reviewScope(task);
      const criteria = criteriaFor(task, scope.owned);
      const raw = this.store.getTaskOutput(review.id) ?? '';
      const ex = extractJson(raw);
      const parsed = ex.ok ? reviewReplySchema.safeParse(ex.value) : null;
      const errors = !ex.ok
        ? [ex.error]
        : parsed && !parsed.success
          ? parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          : [];
      const check = parsed?.success
        ? checkReview(parsed.data, criteria, project.repoPath, scope.contributes)
        : null;
      if (!check || check.errors.length) {
        const all = [...errors, ...(check?.errors ?? [])];
        if (row.repairs >= this.cfg.maxReviewRepairs)
          return this.escalate(task, row, `review output unusable: ${all.slice(0, 3).join('; ')}`);
        await this.startReview(task, row.round, { errors: all, repairs: row.repairs + 1 });
        return true;
      }
      const passedWithNotes = check.passed && check.normalized;
      const ownIds = new Set(criteria.map((c) => c.id));
      const result = {
        // Only the task's own criteria are verdicts; other tasks' requirements are kept as notes.
        criteria: parsed!.data!.criteria.filter((c) => ownIds.has(c.id)),
        defects: check.defects,
        blockingDefects: check.blockingDefects,
        unmet: check.unmet,
        notes: check.notes,
        passedWithNotes,
        scope: {
          criteria: criteria.map((c) => ({ id: c.id, scope: c.scope ?? 'acceptance' })),
          contributes: scope.contributes.map((c) => ({ id: c.id, ownerTaskId: c.ownerTaskId })),
        },
        testsAssessment: parsed!.data!.testsAssessment,
        reviewTaskId: review.id,
      };
      this.db
        .transaction(() => {
          this.update(task.id, row.round, { status: check.passed ? 'PASSED' : 'FAILED', result });
          this.store.addEvidence({
            projectId: task.projectId,
            taskId: task.id,
            level: 'REQUIREMENTS_SATISFIED',
            status: check.passed ? 'PASSED' : 'FAILED',
            summary: check.passed
              ? passedWithNotes
                ? `independent review round ${row.round}: passed with notes - all ${criteria.length} own criteria met with cited evidence; ${check.notes.length} finding(s) outside this task's scope recorded as informational`
                : `independent review round ${row.round}: all ${criteria.length} criteria met with cited evidence`
              : `independent review round ${row.round}: ${check.unmet.length} criteria unmet, ${check.blockingDefects.length} high-severity defect(s)`,
            evidence: result,
          });
          this.store.recordEvent({
            type: check.passed ? 'qa.passed' : 'qa.failed',
            projectId: task.projectId,
            taskId: task.id,
            severity: check.passed ? 'info' : 'warn',
            payload: {
              round: row.round,
              unmet: check.unmet.map((u) => u.id),
              ...(passedWithNotes ? { passedWithNotes: true, notes: check.notes.map((n) => n.id) } : {}),
            },
          });
          if (check.passed) this.store.advanceProjectAfterTerminalTask(task.projectId);
        })
        .immediate();
      if (!check.passed) {
        if (row.round > this.cfg.maxCorrectionRounds)
          return this.escalate(
            task,
            row,
            `still failing after ${this.cfg.maxCorrectionRounds} correction round(s)`,
          );
        this.createCorrection(task, row.round, check.unmet, [
          ...check.blockingDefects,
          ...check.defects.filter((d) => d.severity !== 'high'),
        ]);
      }
      return true;
    }
    if (row.status === 'CORRECTING') {
      const fix = row.correctionTaskId ? this.store.getTask(row.correctionTaskId) : null;
      if (!fix) return false;
      if (fix.status === 'FAILED' || fix.status === 'CANCELLED')
        return this.escalate(task, row, `correction task ${fix.status}`);
      if (fix.status !== 'COMPLETED') return false;
      this.update(task.id, row.round, { status: 'FAILED' });
      await this.startReview(task, row.round + 1);
      return true;
    }
    if (row.status === 'ESCALATED' && row.approvalId) {
      const a = this.store.getApproval(row.approvalId);
      if (a?.status === 'APPROVED') {
        this.db
          .transaction(() => {
            this.update(task.id, row.round, { status: 'OWNER_ACCEPTED' });
            this.store.addEvidence({
              projectId: task.projectId,
              taskId: task.id,
              level: 'REQUIREMENTS_SATISFIED',
              status: 'PASSED',
              summary: `owner ${a.decidedBy ?? 'owner'} accepted the task despite the failed independent review`,
              evidence: { ownerOverride: true, approvalId: a.id },
            });
            this.store.advanceProjectAfterTerminalTask(task.projectId);
          })
          .immediate();
        return true;
      }
      if (a?.status === 'DENIED') {
        this.update(task.id, row.round, { status: 'OWNER_REJECTED' });
        this.store.recordEvent({
          type: 'qa.owner_rejected',
          projectId: task.projectId,
          taskId: task.id,
          severity: 'warn',
          payload: { round: row.round },
        });
        return true;
      }
    }
    return false;
  }

  private createCorrection(
    task: Task,
    round: number,
    unmet: { id: string; text: string; reason: string }[],
    defects: ReviewReply['defects'],
  ): void {
    const instructions = [
      `An independent review of the task "${task.title}" found problems. Fix them in the repository; do not rewrite unrelated working code.`,
      unmet.length
        ? `Unmet acceptance criteria:\n${unmet.map((u) => `- [${u.id}] ${u.text} - ${u.reason}`).join('\n')}`
        : '',
      defects.length
        ? `Defects:\n${defects.map((d) => `- (${d.severity}) ${d.description}${d.file ? ` at ${d.file}${d.line ? `:${d.line}` : ''}` : ''}`).join('\n')}`
        : '',
      `Original task instructions:\n${task.instructions.slice(0, 6000)}`,
      'Add or fix tests that prove each criterion; run them before finishing.',
    ]
      .filter(Boolean)
      .join('\n\n');
    this.db
      .transaction(() => {
        const { task: fix } = this.store.enqueueTask({
          projectId: task.projectId,
          kind: 'CODING',
          title: `Fix: ${task.title} (QA round ${round})`,
          instructions,
          acceptanceCriteria: task.acceptanceCriteria,
          priority: CORRECTION_PRIORITY,
          maxRetries: this.cfg.defaultMaxRetries,
          dedupeKey: `fix:${task.id}:${round}`,
          verificationRequired: task.verificationRequired.filter((l) =>
            (TASK_VERIFIABLE_LEVELS as readonly string[]).includes(l),
          ),
          role: task.role,
        });
        this.update(task.id, round, { status: 'CORRECTING', correctionTaskId: fix.id });
        this.store.recordEvent({
          type: 'qa.correction_created',
          projectId: task.projectId,
          taskId: task.id,
          severity: 'warn',
          payload: { round, correctionTaskId: fix.id, unmet: unmet.map((u) => u.id) },
        });
      })
      .immediate();
  }

  private escalate(task: Task, row: QaRow, reason: string): boolean {
    this.db
      .transaction(() => {
        const approval = this.store.createApproval({
          projectId: task.projectId,
          actionType: 'qa_escalation',
          description: `Independent QA could not confirm "${task.title}" (${reason}). Approve to accept the task anyway, deny to keep its dependants blocked.`,
          payload: { taskId: task.id, round: row.round, reason },
        });
        this.update(task.id, row.round, { status: 'ESCALATED', approvalId: approval.id });
        this.store.recordEvent({
          type: 'qa.escalated',
          projectId: task.projectId,
          taskId: task.id,
          severity: 'error',
          payload: { round: row.round, reason },
        });
      })
      .immediate();
    return true;
  }

  /**
   * What the review judges (A1). Of the requirements linked to the task, the ones it OWNS are must-pass criteria;
   * the ones owned by another task are informational ("contributes"). The whole requirement -> owner map is given
   * to the reviewer so it can attribute a gap to the task that is responsible for it.
   */
  reviewScope(task: Task): {
    owned: { id: string; text: string }[];
    contributes: ContributedRequirement[];
    map: { id: string; ownerTaskId: string | null; ownerTitle: string | null }[];
  } {
    const link = this.db.prepare('SELECT requirement_ids FROM plan_tasks WHERE task_id = ?').get(task.id) as
      { requirement_ids: string } | undefined;
    if (!link) return { owned: [], contributes: [], map: [] };
    const ids = JSON.parse(link.requirement_ids) as string[];
    const own = requirementOwnership(this.db, task.projectId);
    const owned: { id: string; text: string }[] = [];
    const contributes: ContributedRequirement[] = [];
    for (const id of ids) {
      const o = own.get(id);
      // No resolvable owner (unknown requirement, or this task is the only/last link): this task owns it.
      if (!o || !o.ownerTaskId || o.ownerTaskId === task.id) owned.push({ id, text: o?.text ?? id });
      else contributes.push({ id, text: o.text, ownerTaskId: o.ownerTaskId, ownerTitle: o.ownerTitle });
    }
    const map = [...own.values()].map((o) => ({
      id: o.reqId,
      ownerTaskId: o.ownerTaskId,
      ownerTitle: o.ownerTitle,
    }));
    return { owned, contributes, map };
  }

  /** Diff of the task's work: from its recorded baseline commit to the current working tree (bounded). */
  private async diffFor(task: Task, repoPath: string): Promise<string> {
    const base = this.store.taskBaseline(task.id)?.head ?? null;
    const git = async (args: string[]) => {
      try {
        const { stdout } = await execFileP('git', args, {
          cwd: repoPath,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          timeout: 60_000,
        });
        return stdout;
      } catch {
        return '';
      }
    };
    const status = await git(['status', '--porcelain', '--untracked-files=all']);
    const diff = base ? await git(['diff', base, '--', '.']) : await git(['diff', 'HEAD', '--', '.']);
    // New files are not part of `git diff`: show them explicitly (bounded) so the reviewer sees all new code.
    const untracked = status
      .split('\n')
      .filter((l) => l.startsWith('?? '))
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
      .filter((f) => !f.startsWith('.mock-') && !/\.done$/.test(f))
      .slice(0, 25);
    const newFiles = untracked
      .map((f) => {
        const abs = path.join(repoPath, f);
        try {
          const text = readFileSync(abs, 'utf8');
          return `--- new file: ${f}\n${text.length > 4000 ? text.slice(0, 4000) + '\n...[truncated]' : text}`;
        } catch {
          return `--- new file: ${f} (unreadable)`;
        }
      })
      .join('\n');
    const out = `git status --porcelain:\n${status || '(clean)'}\n\ngit diff ${base ? base.slice(0, 12) : 'HEAD'}..working tree:\n${diff || '(no tracked changes)'}${newFiles ? `\n\nNew (untracked) files:\n${newFiles}` : ''}`;
    return out.length > 40_000
      ? out.slice(0, 40_000) + '\n...[diff truncated; read the files directly]'
      : out;
  }
}

export function reviewTaskPrompt(
  task: Task,
  criteria: Criterion[],
  diff: string,
  evidence: string,
  repairErrors?: string[],
  ownership: {
    contributes?: ContributedRequirement[];
    ownershipMap?: { id: string; ownerTaskId: string | null; ownerTitle: string | null }[];
  } = {},
): string {
  const acceptance = criteria.filter((c) => (c.scope ?? 'acceptance') === 'acceptance');
  const owned = criteria.filter((c) => c.scope === 'owned');
  const contributes = ownership.contributes ?? [];
  const map = (ownership.ownershipMap ?? []).slice(0, 120);
  const owner = (id: string | null, title: string | null) =>
    id ? `${id}${title ? ` "${title}"` : ''}` : 'unassigned';
  return [
    'You are an INDEPENDENT QA reviewer. Another worker implemented the task below; you did not. Do not trust its claims.',
    `## Task under review\n${task.id}: ${task.title}\n\n${task.instructions.slice(0, 6000)}`,
    `## Task acceptance criteria (MUST PASS; one verdict per id)\n${acceptance.map((c) => `- [${c.id}] ${c.text}`).join('\n') || '(none)'}`,
    `## Project requirements OWNED by this task (MUST PASS; one verdict per id)\n${owned.map((c) => `- [${c.id}] ${c.text}`).join('\n') || '(none)'}`,
    contributes.length
      ? `## Project requirements this task only CONTRIBUTES to (informational - owned and judged by another task)\nDo NOT give these a verdict in "criteria" and do NOT fail this task on them. If you notice something relevant, add it to "observations" with coveredBy set to the owning task id.\n${contributes.map((c) => `- [${c.id}] ${c.text} - owned by ${owner(c.ownerTaskId, c.ownerTitle)}`).join('\n')}`
      : '',
    map.length
      ? `## Requirement -> owning task map (whole project)\n${map.map((m) => `- ${m.id} -> ${owner(m.ownerTaskId, m.ownerTitle)}`).join('\n')}`
      : '',
    `## Recorded verification evidence\n${evidence || '(none recorded)'}`,
    `## Changes\n${diff}`,
    '## How to review',
    [
      '- Read the actual files in the repository (read-only tools). Check each MUST-PASS criterion against the code and tests.',
      '- A criterion is met only if you can cite the file and line that implements it (relative path from the repository root). Citations are checked automatically; a "met" verdict without a valid citation counts as NOT met.',
      '- Judge this task only against its own acceptance criteria and the requirements it owns. Work that the map assigns to another task is not this task\'s scope: mention it under observations ("covered by <task id>"), never as an unmet criterion or a defect.',
      "- Report defects (bugs, security problems, missing tests) in THIS task's work with severity and the criterion id they violate (criterionId) or a file:line; a high-severity defect in this task's work fails the review.",
    ].join('\n'),
    repairErrors?.length
      ? `## REPAIR REQUIRED\nYour previous reply was rejected:\n${repairErrors.map((e) => `- ${e}`).join('\n')}`
      : '',
    '## Reply schema (JSON object only)',
    JSON.stringify(
      {
        criteria: [
          {
            id: criteria[0]?.id ?? 'AC1',
            met: true,
            evidence: [{ file: 'src/example.ts', line: 12 }],
            note: 'string',
          },
        ],
        defects: [
          {
            severity: 'low|medium|high',
            description: 'string',
            criterionId: 'optional (AC1 or an owned requirement id)',
            file: 'optional',
            line: 1,
          },
        ],
        observations: [{ id: 'requirement id owned by another task', note: 'string', coveredBy: 'tsk_...' }],
        testsAssessment: 'string',
      },
      null,
      2,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}
