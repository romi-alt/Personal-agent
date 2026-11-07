import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { renderRepoProfile, type RepoProfile, scanRepository } from '../engineering/repo-scan.js';
import { inferRole } from '../engineering/roles.js';
import { getAssignment, persistAssignment } from '../assignments/register.js';
import {
  allRequirements,
  AssignmentValidationError,
  parseAssignment,
  type ProjectAssignment,
} from '../assignments/schema.js';
import type { Logger } from '../logging/logger.js';
import {
  type AdrRecord,
  adrFileName,
  type FindingRecord,
  renderAdr,
  renderArchitecture,
  renderResearch,
  renderReview,
  writeProjectDocs,
} from '../planning/documents.js';
import { extractJson } from '../planning/extract-json.js';
import {
  analyzePrompt,
  architectPrompt,
  decomposePrompt,
  intakePrompt,
  researchPrompt,
  reviewPrompt,
} from '../planning/prompts.js';
import { hasBlockingIssues, reviewPlan } from '../planning/review.js';
import {
  type Analysis,
  type Architecture,
  INTAKE_OMITTED_FIELDS,
  type Plan,
  type ReviewIssue,
  analysisSchema,
  architectureSchema,
  planSchema,
  researchSchema,
  reviewSchema,
} from '../planning/schemas.js';
import {
  checkCitations,
  validateAnalysis,
  validateArchitecture,
  validatePlan,
} from '../planning/validate-plan.js';
import type { Store } from '../queue/store.js';
import { type RunContext, type WorkflowRun, type WorkflowStep, WorkflowRepository } from './repository.js';

export interface EngineConfig {
  /** 'required': the owner must approve the plan before any coding task is created. */
  planApproval: 'required' | 'auto';
  maxPlanTasks: number;
  /** How many times an invalid planning reply is sent back to the model with the validator's errors. */
  maxPlanRepairs: number;
  defaultMaxRetries: number;
  /** Research tasks get read-only WebSearch/WebFetch (unless the project's approval policy requires web approval). */
  researchWeb?: boolean;
  /** Write ADR / specification / research documents into the project repository. */
  writeDocs?: boolean;
  /** Planned coding tasks require an independent review (REQUIREMENTS_SATISFIED evidence) before dependents run. */
  independentReview?: boolean;
}

export const PLAN_KIND = 'plan_project';
const PLANNING_PRIORITY = 1000; // planning runs before coding work

type Phase = 'intake' | 'analyze' | 'research' | 'architect' | 'decompose' | 'review';
const MODEL_PHASES: Phase[] = ['intake', 'analyze', 'research', 'architect', 'decompose', 'review'];
/** Review categories that need an architecture revision (decompose alone cannot fix them). */
const ARCHITECTURE_ISSUES: string[] = ['security_gap', 'data_model', 'missing_api', 'contradiction'];
type Handled = { ok: true; normalized: string; apply: () => void } | { ok: false; errors: string[] };

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');
const zodErrors = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
  e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);

/**
 * Deterministic orchestrator for the planning pipeline:
 *   [intake] -> analyse -> (clarify) -> research -> architect -> decompose -> review (-> revise, bounded) -> (approve) -> materialise.
 *
 * Every model call is an ordinary read-only PLANNING task in the durable queue, so claims, leases, retries, rate-limit
 * waiting, checkpoints, session resume and restart recovery are inherited unchanged. The engine itself holds no state in
 * memory: `advance()` is a pure function of the database, so it is safe to call repeatedly and after any crash.
 * Model output is parsed with zod and checked by deterministic validators; invalid output is sent back for a bounded
 * number of repairs, never accepted.
 */
export class WorkflowEngine {
  readonly repo: WorkflowRepository;

  constructor(
    private readonly store: Store,
    private readonly cfg: EngineConfig,
    private readonly log?: Logger,
  ) {
    this.repo = new WorkflowRepository(store);
  }

  // ------------------------------------------------------------ public API
  /** Start (or return the already-active) planning workflow for a project that has a registered assignment. */
  startPlanning(projectId: string): WorkflowRun {
    return this.store.db
      .transaction(() => {
        const project = this.store.getProject(projectId);
        if (!project) throw new Error(`Unknown project ${projectId}`);
        const assignment = getAssignment(this.store, projectId);
        if (!assignment) throw new Error('Register an assignment first (assignment:add)');
        const active = this.activeRun(projectId);
        if (active) return active;
        if (['BLOCKED', 'PAUSED'].includes(project.lifecycle)) {
          this.store.transitionProject(projectId, 'REGISTERED', 'planning restarted by the owner');
        } else if (!['REGISTERED', 'ANALYZING', 'PLANNING'].includes(project.lifecycle)) {
          throw new Error(
            `Project is ${project.lifecycle}; planning can only start from REGISTERED, ANALYZING or PLANNING`,
          );
        }
        this.seedRequirements(projectId, assignment);
        return this.createPlanRun(projectId, 'analyze');
      })
      .immediate();
  }

  /**
   * Natural-language intake: the project exists (workspace prepared) and its original documents are stored; the first
   * model step converts them into a validated assignment contract, then planning continues in the same run.
   */
  startIntake(projectId: string, workspace: ProjectAssignment['workspace']): WorkflowRun {
    return this.store.db
      .transaction(() => {
        const project = this.store.getProject(projectId);
        if (!project) throw new Error(`Unknown project ${projectId}`);
        if (getAssignment(this.store, projectId))
          throw new Error('Project already has an assignment; use plan:start');
        if (!this.repo.listDocuments(projectId).length)
          throw new Error('No assignment text/documents stored for intake');
        const active = this.activeRun(projectId);
        if (active) return active;
        return this.createPlanRun(projectId, 'intake', { workspace });
      })
      .immediate();
  }

  answerQuestion(runId: string, questionId: string, text: string): void {
    const run = this.requireRun(runId);
    if (run.status !== 'WAITING_FOR_OWNER' || run.context.phase !== 'clarify')
      throw new Error('Run is not waiting for clarification answers');
    if (!run.context.questions.some((q) => q.id === questionId))
      throw new Error(`Unknown question ${questionId}`);
    this.repo.updateRun(runId, {
      context: { ...run.context, answers: { ...run.context.answers, [questionId]: text } },
    });
    this.store.recordEvent({
      type: 'workflow.answered',
      projectId: run.projectId,
      payload: { runId, questionId },
    });
  }

  /** Continue without answering blocking questions; the analysis' stated assumptions are used instead. */
  resumeWithAssumptions(runId: string): void {
    const run = this.requireRun(runId);
    if (run.status !== 'WAITING_FOR_OWNER' || run.context.phase !== 'clarify')
      throw new Error('Run is not waiting for clarification answers');
    this.repo.updateRun(runId, { context: { ...run.context, assume: true } });
    this.store.recordEvent({
      type: 'workflow.assumptions_accepted',
      projectId: run.projectId,
      payload: { runId },
    });
  }

  cancel(runId: string, reason: string): void {
    const run = this.requireRun(runId);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) return;
    this.store.db
      .transaction(() => {
        this.repo.updateRun(runId, { status: 'CANCELLED', error: reason });
        for (const step of this.repo.listSteps(runId)) {
          if (step.status === 'DISPATCHED' && step.taskId)
            this.cancelTaskIfOpen(step.taskId, `workflow ${runId} cancelled`);
        }
        this.store.recordEvent({
          type: 'workflow.cancelled',
          projectId: run.projectId,
          payload: { runId, reason },
        });
      })
      .immediate();
  }

  /** Advance every active run. Cheap (local SQL only); called on each supervisor tick. Returns how many runs changed. */
  advanceAll(): number {
    let changed = 0;
    for (const run of this.repo.listRuns({ statuses: ['RUNNING', 'WAITING_FOR_OWNER'] })) {
      try {
        if (this.advance(run.id)) changed++;
      } catch (err) {
        this.log?.error('workflow.advance_error', { runId: run.id, error: err });
      }
    }
    return changed;
  }

  advance(runId: string): boolean {
    return this.store.db
      .transaction(() => {
        const run = this.requireRun(runId);
        if (run.status === 'WAITING_FOR_OWNER') return this.advanceWaiting(run);
        if (run.status === 'RUNNING') return this.advanceRunning(run);
        return false;
      })
      .immediate();
  }

  // ----------------------------------------------------------------- waiting
  private advanceWaiting(run: WorkflowRun): boolean {
    const ctx = run.context;
    if (ctx.phase === 'clarify') {
      const unanswered = ctx.questions.filter((q) => q.blocking && !ctx.answers[q.id]);
      if (unanswered.length === 0 || ctx.assume) {
        this.repo.updateRun(run.id, { status: 'RUNNING', context: { ...ctx, phase: 'research' } });
        return true;
      }
      return false;
    }
    if (ctx.phase === 'approval' && ctx.approvalId) {
      const approval = this.store.getApproval(ctx.approvalId);
      if (approval?.status === 'APPROVED') {
        const planJson = this.repo.completedOutput(run.id, 'decompose');
        if (!planJson) return this.failRun(run, 'approved plan output is missing');
        this.repo.setAdrStatus(run.projectId, run.id, 'accepted');
        this.writeAdrDocs(run, `docs: architecture decisions accepted by the owner (${run.id})`);
        const created = this.materialize(run, JSON.parse(planJson) as Plan);
        this.repo.updateRun(run.id, { status: 'COMPLETED', context: { ...ctx, phase: 'done' } });
        this.store.recordEvent({
          type: 'workflow.completed',
          projectId: run.projectId,
          payload: { runId: run.id, tasksCreated: created },
        });
        return true;
      }
      if (approval?.status === 'DENIED') {
        this.repo.setAdrStatus(run.projectId, run.id, 'rejected');
        this.writeAdrDocs(run, `docs: architecture decisions rejected by the owner (${run.id})`);
        this.repo.updateRun(run.id, { status: 'CANCELLED', error: 'plan rejected by the owner' });
        this.store.recordEvent({
          type: 'workflow.plan_rejected',
          projectId: run.projectId,
          severity: 'warn',
          payload: { runId: run.id },
        });
        return true;
      }
    }
    return false;
  }

  // ----------------------------------------------------------------- running
  private advanceRunning(run: WorkflowRun): boolean {
    const phase = run.context.phase as Phase;
    if (!MODEL_PHASES.includes(phase)) return false;
    const step = this.repo.latestStep(run.id, phase);
    if (!step || step.status === 'COMPLETED') {
      // COMPLETED here means the phase is being re-entered (review sent the plan back to decompose).
      const attempt = step ? step.attempt + 1 : 0;
      this.dispatch(run, phase, attempt, step ? this.repo.createStep(run.id, phase, attempt) : undefined);
      return true;
    }
    if (step.status === 'PENDING') {
      this.dispatch(run, phase, step.attempt, step);
      return true;
    }
    if (step.status !== 'DISPATCHED' || !step.taskId) return false;
    const task = this.store.getTask(step.taskId);
    if (!task) return this.failRun(run, `planning task ${step.taskId} disappeared`);
    switch (task.status) {
      case 'COMPLETED':
        return this.consume(run, phase, step);
      case 'FAILED':
      case 'CANCELLED':
        this.repo.updateStep(step.id, {
          status: 'ERRORED',
          error: `task ${task.status}: ${task.lastErrorMessage ?? ''}`,
        });
        return this.failRun(
          run,
          `planning step "${phase}" ${task.status}: ${task.lastErrorMessage ?? 'no detail'}`,
        );
      default:
        return false; // queued / running / waiting for capacity|auth|approval / blocked: the queue's own recovery handles it
    }
  }

  private webAllowed(a: ProjectAssignment | null): boolean {
    return !!this.cfg.researchWeb && !!a && !a.approvalPolicy.alsoRequire.includes('web_access');
  }

  private dispatch(
    run: WorkflowRun,
    phase: Phase,
    attempt: number,
    existing?: WorkflowStep,
    repair?: { errors: string[]; previous?: string },
  ): void {
    const assignment = getAssignment(this.store, run.projectId);
    const prompt = this.promptFor(run, phase, assignment, repair);
    const step = existing ?? this.repo.createStep(run.id, phase, attempt);
    const label = (run.context.reviewRounds ?? 0) > 0 && !repair ? 'revision' : 'repair';
    const { task } = this.store.enqueueTask({
      projectId: run.projectId,
      kind: 'PLANNING',
      title: attempt === 0 ? `Plan: ${phase}` : `Plan: ${phase} (${label} ${attempt})`,
      instructions: prompt,
      priority: PLANNING_PRIORITY,
      maxRetries: this.cfg.defaultMaxRetries,
      dedupeKey: `wf:${run.id}:${phase}:${attempt}`,
      allowWeb: phase === 'research' && this.webAllowed(assignment),
    });
    this.repo.updateStep(step.id, { status: 'DISPATCHED', taskId: task.id });
    this.store.recordEvent({
      type: 'workflow.step_dispatched',
      projectId: run.projectId,
      taskId: task.id,
      payload: { runId: run.id, phase, attempt },
    });
  }

  private promptFor(
    run: WorkflowRun,
    phase: Phase,
    a: ProjectAssignment | null,
    repair?: { errors: string[]; previous?: string },
  ): string {
    if (phase === 'intake')
      return intakePrompt(
        this.repo.listDocuments(run.projectId).filter((d) => d.kind !== 'repo_profile'),
        repair,
      );
    if (!a) throw new Error('assignment missing for planning step');
    const reqs = this.repo
      .listRequirements(run.projectId)
      .map((r) => ({ id: r.id, text: r.text, priority: r.priority }));
    const profile = this.repoProfileText(run.projectId);
    const withProfile = (s: string) => (profile ? `${s}\n\n${profile}` : s);
    if (phase === 'analyze') return withProfile(analyzePrompt(a, repair));
    if (phase === 'research') return researchPrompt(a, reqs, this.webAllowed(a), repair);
    const analysis = JSON.parse(
      this.repo.completedOutput(run.id, 'analyze') ?? '{"assumptions":[]}',
    ) as Analysis;
    if (phase === 'architect')
      return withProfile(
        architectPrompt(
          a,
          reqs,
          analysis,
          run.context.answers,
          repair,
          this.repo
            .listFindings(run.projectId)
            .map((f) => ({ id: f.findingId, area: f.area, kind: f.kind, statement: f.statement })),
          run.context.reviewIssues,
        ),
      );
    const architecture = JSON.parse(this.repo.completedOutput(run.id, 'architect')!) as Architecture;
    if (phase === 'decompose')
      return withProfile(
        decomposePrompt(
          a,
          reqs,
          architecture,
          { maxTasks: this.cfg.maxPlanTasks },
          repair,
          run.context.reviewIssues,
        ),
      );
    const plan = JSON.parse(this.repo.completedOutput(run.id, 'decompose')!) as Plan;
    return reviewPrompt(
      a,
      reqs,
      architecture,
      plan,
      this.deterministicReview(run, a, architecture, plan),
      repair,
    );
  }

  /** Latest deterministic repository profile (existing repositories), rendered for prompts. */
  private repoProfileText(projectId: string): string | null {
    const doc = this.repo
      .listDocuments(projectId)
      .filter((d) => d.kind === 'repo_profile')
      .at(-1);
    if (!doc) return null;
    try {
      return renderRepoProfile(JSON.parse(doc.content) as RepoProfile);
    } catch {
      return null;
    }
  }

  /** Scan the workspace before planning so existing work is inspected, not overwritten. Read-only, bounded. */
  private scanWorkspace(projectId: string): void {
    const project = this.store.getProject(projectId)!;
    try {
      const profile = scanRepository(project.repoPath);
      if (profile.files === 0) return;
      const content = JSON.stringify(profile);
      this.repo.addDocument(projectId, {
        kind: 'repo_profile',
        name: 'repo-profile.json',
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
      this.store.recordEvent({
        type: 'repo.scanned',
        projectId,
        payload: { files: profile.files, frameworks: profile.frameworks, languages: profile.languages },
      });
    } catch (err) {
      this.log?.warn('repo.scan_failed', { projectId, error: err });
    }
  }

  // ---------------------------------------------------------------- consume
  private consume(run: WorkflowRun, phase: Phase, step: WorkflowStep): boolean {
    const raw = this.store.getTaskOutput(step.taskId!) ?? '';
    const handled = this.handle(run, phase, raw, step);
    if (handled.ok) {
      this.repo.updateStep(step.id, { status: 'COMPLETED', output: handled.normalized, error: null });
      handled.apply();
      this.store.recordEvent({
        type: 'workflow.step_completed',
        projectId: run.projectId,
        payload: { runId: run.id, phase, attempt: step.attempt },
      });
      return true;
    }
    // Invalid reply: record it, then repair (bounded) or fail the run.
    this.repo.updateStep(step.id, {
      status: 'INVALID',
      output: raw.slice(0, 20_000),
      error: handled.errors.join('\n').slice(0, 4000),
    });
    this.store.recordEvent({
      type: 'workflow.step_invalid',
      projectId: run.projectId,
      severity: 'warn',
      payload: { runId: run.id, phase, attempt: step.attempt, errors: handled.errors.slice(0, 10) },
    });
    const used = run.context.repairs[phase] ?? 0;
    if (used >= this.cfg.maxPlanRepairs) {
      return this.failRun(
        run,
        `planning step "${phase}" produced invalid output ${used + 1} times: ${handled.errors.slice(0, 5).join('; ')}`,
      );
    }
    const ctx: RunContext = { ...run.context, repairs: { ...run.context.repairs, [phase]: used + 1 } };
    this.repo.updateRun(run.id, { context: ctx });
    const next = this.repo.createStep(run.id, phase, step.attempt + 1);
    this.dispatch({ ...run, context: ctx }, phase, next.attempt, next, {
      errors: handled.errors,
      previous: raw,
    });
    return true;
  }

  private handle(run: WorkflowRun, phase: Phase, raw: string, step: WorkflowStep): Handled {
    const extracted = extractJson(raw);
    if (!extracted.ok) return { ok: false, errors: [extracted.error] };
    if (phase === 'intake') return this.handleIntake(run, extracted.value);
    const assignment = getAssignment(this.store, run.projectId)!;
    const reqIds = this.repo.listRequirements(run.projectId).map((r) => r.id);

    if (phase === 'analyze') {
      const parsed = analysisSchema.safeParse(extracted.value);
      if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
      const a = parsed.data;
      const v = validateAnalysis(
        a,
        allRequirements(assignment).map((r) => r.id),
      );
      if (!v.ok) return { ok: false, errors: v.errors };
      return {
        ok: true,
        normalized: JSON.stringify(a),
        apply: () => {
          for (const r of a.requirements) {
            this.repo.upsertRequirement(run.projectId, {
              id: r.id,
              text: r.text,
              kind: r.kind,
              priority: r.priority,
              source: r.id.startsWith('DR-') ? 'analysis' : 'assignment',
            });
          }
          this.store.setMemory(
            run.projectId,
            'requirements',
            [
              `## Refined requirements\n${bullets(a.requirements.map((r) => `[${r.id}] (${r.priority}) ${r.text}${r.acceptance.length ? ` - acceptance: ${r.acceptance.join('; ')}` : ''}`))}`,
              a.assumptions.length ? `\n## Assumptions\n${bullets(a.assumptions)}` : '',
              a.risks.length
                ? `\n## Risks\n${bullets(a.risks.map((r) => `[${r.id}] (${r.severity}) ${r.text}`))}`
                : '',
              a.questions.length
                ? `\n## Open questions\n${bullets(a.questions.map((q) => `[${q.id}]${q.blocking ? ' (blocking)' : ''} ${q.text}`))}`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
          const blocking = a.questions.filter((q) => q.blocking);
          const ctx: RunContext = {
            ...run.context,
            questions: a.questions,
            phase: blocking.length ? 'clarify' : 'research',
          };
          this.repo.updateRun(run.id, {
            status: blocking.length ? 'WAITING_FOR_OWNER' : 'RUNNING',
            context: ctx,
          });
          if (blocking.length) {
            this.store.recordEvent({
              type: 'workflow.questions',
              projectId: run.projectId,
              severity: 'warn',
              payload: { runId: run.id, blocking: blocking.map((q) => `${q.id}: ${q.text}`) },
            });
          }
        },
      };
    }

    if (phase === 'research') {
      const parsed = researchSchema.safeParse(extracted.value);
      if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
      const ids = parsed.data.findings.map((f) => f.id);
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dup.length)
        return { ok: false, errors: [`duplicate finding id(s): ${[...new Set(dup)].join(', ')}`] };
      const webAllowed = !!this.store.getTask(step.taskId!)?.allowWeb;
      const checked = checkCitations(parsed.data, this.webEvidence(step.taskId!), webAllowed);
      const now = this.store.clock.now();
      const records: FindingRecord[] = checked.findings.map((f) => ({
        findingId: f.id,
        area: f.area,
        statement: f.statement,
        kind: f.kind,
        claimedKind: f.claimedKind,
        confidence: f.confidence,
        sources: f.sources,
        citationCheck: f.citationCheck,
        researchedAt: now,
      }));
      return {
        ok: true,
        normalized: JSON.stringify({ ...parsed.data, findings: checked.findings }),
        apply: () => {
          this.repo.saveFindings(run.id, run.projectId, records);
          const downgraded = records.filter((r) => r.kind !== r.claimedKind).length;
          this.store.setMemory(
            run.projectId,
            'dependencies',
            `## Research (${records.filter((r) => r.kind === 'verified').length} verified, ${records.filter((r) => r.kind === 'assumption').length} assumptions)\n${bullets(records.map((r) => `[${r.findingId}] (${r.area}, ${r.kind}) ${r.statement}`))}`,
          );
          this.docs(
            run,
            {
              'docs/research/RESEARCH.md': renderResearch(
                assignment.title,
                records,
                parsed.data.openQuestions,
              ),
            },
            `docs: research findings (${run.id})`,
          );
          this.store.recordEvent({
            type: 'research.completed',
            projectId: run.projectId,
            severity: downgraded ? 'warn' : 'info',
            payload: {
              runId: run.id,
              findings: records.length,
              verified: records.filter((r) => r.kind === 'verified').length,
              downgraded,
              webAllowed,
            },
          });
          this.repo.updateRun(run.id, { context: { ...run.context, phase: 'architect' } });
        },
      };
    }

    if (phase === 'architect') {
      const parsed = architectureSchema.safeParse(extracted.value);
      if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
      const arch = parsed.data;
      const v = validateArchitecture(arch, reqIds);
      if (!v.ok) return { ok: false, errors: v.errors };
      return {
        ok: true,
        normalized: JSON.stringify(arch),
        apply: () => {
          this.store.setMemory(
            run.projectId,
            'architecture_decisions',
            [
              `## Decisions\n${bullets(arch.decisions.map((d) => `[${d.id}] ${d.title}: ${d.decision} (why: ${d.rationale})`))}`,
              `\n## Components\n${bullets(arch.components.map((c) => `${c.name}: ${c.responsibility} [${c.requirementIds.join(', ')}]`))}`,
              arch.dataModel ? `\n## Data model\n${arch.dataModel}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
          if (arch.technology.length) {
            this.store.setMemory(
              run.projectId,
              'technology_decisions',
              bullets(arch.technology.map((t) => `${t.area}: ${t.choice} (${t.rationale})`)),
            );
          }
          this.recordAdrs(run, arch);
          this.repo.saveSpec(run.id, run.projectId, arch.sections, arch.diagrams);
          this.writeAdrDocs(run, `docs: architecture specification and ADRs (${run.id})`, arch);
          if (this.store.getProject(run.projectId)!.lifecycle === 'ANALYZING') {
            this.store.transitionProject(run.projectId, 'PLANNING', 'analysis and architecture accepted');
          }
          this.repo.updateRun(run.id, { context: { ...run.context, phase: 'decompose' } });
        },
      };
    }

    if (phase === 'decompose') {
      const parsed = planSchema.safeParse(extracted.value);
      if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
      const plan = parsed.data;
      const v = validatePlan(plan, reqIds, { maxTasks: this.cfg.maxPlanTasks });
      if (!v.ok) return { ok: false, errors: v.errors };
      return {
        ok: true,
        normalized: JSON.stringify(plan),
        apply: () => this.repo.updateRun(run.id, { context: { ...run.context, phase: 'review' } }),
      };
    }

    // review
    const parsed = reviewSchema.safeParse(extracted.value);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const model = parsed.data;
    return {
      ok: true,
      normalized: JSON.stringify(model),
      apply: () => this.applyReview(run, assignment, model.verdict, model.issues),
    };
  }

  private handleIntake(run: WorkflowRun, value: unknown): Handled {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { ok: false, errors: ['reply must be a JSON object'] };
    const obj = { ...(value as Record<string, unknown>) };
    const ignored = INTAKE_OMITTED_FIELDS.filter((k) => k in obj);
    for (const k of INTAKE_OMITTED_FIELDS) delete obj[k];
    // System-controlled fields: the workspace chosen at intake, manual source, the default (most restrictive) approval policy.
    obj['workspace'] = (run.context as RunContext & { workspace?: unknown }).workspace ?? { type: 'managed' };
    obj['source'] = { system: 'manual' };
    let a: ProjectAssignment;
    try {
      a = parseAssignment(obj);
    } catch (e) {
      if (e instanceof AssignmentValidationError) return { ok: false, errors: e.issues };
      throw e;
    }
    return {
      ok: true,
      normalized: JSON.stringify(a),
      apply: () => {
        persistAssignment(this.store, run.projectId, a);
        this.seedRequirements(run.projectId, a);
        this.store.recordEvent({
          type: 'intake.completed',
          projectId: run.projectId,
          payload: {
            runId: run.id,
            title: a.title,
            requirements: allRequirements(a).length,
            ignoredModelFields: ignored,
          },
        });
        this.repo.updateRun(run.id, { context: { ...run.context, phase: 'analyze' } });
      },
    };
  }

  // ------------------------------------------------------------ review
  private deterministicReview(
    run: WorkflowRun,
    a: ProjectAssignment,
    arch: Architecture,
    plan: Plan,
  ): ReviewIssue[] {
    return reviewPlan({
      assignment: a,
      requirements: this.repo.listRequirements(run.projectId),
      architecture: arch,
      plan,
    });
  }

  private applyReview(
    run: WorkflowRun,
    a: ProjectAssignment,
    verdict: 'approve' | 'revise',
    modelIssues: ReviewIssue[],
  ): void {
    const arch = JSON.parse(this.repo.completedOutput(run.id, 'architect')!) as Architecture;
    const plan = JSON.parse(this.repo.completedOutput(run.id, 'decompose')!) as Plan;
    const det = this.deterministicReview(run, a, arch, plan);
    const round = (run.context.reviewRounds ?? 0) + 1;
    this.repo.saveReview(
      run.id,
      run.projectId,
      round,
      'deterministic',
      hasBlockingIssues(det) ? 'revise' : 'approve',
      det,
    );
    this.repo.saveReview(run.id, run.projectId, round, 'model', verdict, modelIssues);
    this.docs(
      run,
      { 'docs/planning/PLAN-REVIEW.md': renderReview(this.repo.listReviews(run.id)) },
      `docs: planning review round ${round} (${run.id})`,
    );
    const blocking = [...det, ...modelIssues].filter((i) => i.severity === 'high');
    const wantsRevision = blocking.length > 0 && (verdict === 'revise' || hasBlockingIssues(det));
    this.store.recordEvent({
      type: 'plan.reviewed',
      projectId: run.projectId,
      severity: blocking.length ? 'warn' : 'info',
      payload: {
        runId: run.id,
        round,
        verdict,
        deterministic: det.length,
        model: modelIssues.length,
        high: blocking.length,
      },
    });
    if (wantsRevision && round <= this.cfg.maxPlanRepairs) {
      // Send the work back to the stage that can fix it: architecture gaps to architect (which then re-plans), plan
      // gaps to decompose. The review issues become part of that stage's next prompt.
      const back = blocking.some((i) => ARCHITECTURE_ISSUES.includes(i.category)) ? 'architect' : 'decompose';
      this.repo.updateRun(run.id, {
        context: { ...run.context, phase: back, reviewRounds: round, reviewIssues: blocking },
      });
      this.store.recordEvent({
        type: 'plan.revision_requested',
        projectId: run.projectId,
        severity: 'warn',
        payload: {
          runId: run.id,
          round,
          stage: back,
          issues: blocking.map((i) => `${i.category}: ${i.description}`),
        },
      });
      return;
    }
    this.requestApprovalOrMaterialize(
      { ...run, context: { ...run.context, reviewRounds: round } },
      plan,
      wantsRevision ? blocking : [],
    );
  }

  private requestApprovalOrMaterialize(run: WorkflowRun, plan: Plan, unresolved: ReviewIssue[]): void {
    const reqIds = this.repo.listRequirements(run.projectId).map((r) => r.id);
    const significant = this.repo.listAdrs(run.projectId).filter((d) => d.runId === run.id && d.significant);
    if (this.cfg.planApproval === 'auto' && significant.length === 0 && unresolved.length === 0) {
      this.repo.setAdrStatus(run.projectId, run.id, 'accepted');
      this.writeAdrDocs(run, `docs: architecture decisions accepted (auto approval) (${run.id})`);
      const created = this.materialize(run, plan);
      this.repo.updateRun(run.id, { status: 'COMPLETED', context: { ...run.context, phase: 'done' } });
      this.store.recordEvent({
        type: 'workflow.completed',
        projectId: run.projectId,
        payload: { runId: run.id, tasksCreated: created, approval: 'auto' },
      });
      return;
    }
    const approval = this.store.createApproval({
      projectId: run.projectId,
      actionType: 'plan_approval',
      description: [
        `Approve the execution plan: ${plan.milestones.length} milestone(s), ${plan.tasks.length} task(s), all ${reqIds.length} requirement(s) covered`,
        significant.length ? `; ${significant.length} significant architecture decision(s) to review` : '',
        unresolved.length ? `; ${unresolved.length} unresolved high-severity review issue(s)` : '',
      ].join(''),
      payload: {
        runId: run.id,
        milestones: plan.milestones.map((m) => m.title),
        tasks: plan.tasks.map((t) => t.title),
        significantDecisions: significant.map((d) => `ADR ${String(d.number).padStart(4, '0')}: ${d.title}`),
        unresolvedIssues: unresolved.map((i) => `[${i.severity}] ${i.category}: ${i.description}`),
      },
    });
    this.repo.updateRun(run.id, {
      status: 'WAITING_FOR_OWNER',
      context: { ...run.context, phase: 'approval', approvalId: approval.id },
    });
  }

  // ------------------------------------------------------------ ADRs / docs
  private recordAdrs(run: WorkflowRun, arch: Architecture): void {
    const existing = this.repo.listAdrs(run.projectId);
    let next = existing.reduce((m, a) => Math.max(m, a.number), 0) + 1;
    const now = this.store.clock.now();
    const records: AdrRecord[] = arch.decisions.map((d) => {
      const prior = existing.find((e) => e.adrId === d.id);
      return {
        adrId: d.id,
        number: prior?.number ?? next++,
        title: d.title,
        status: 'proposed',
        context: d.context,
        decision: d.decision,
        alternatives: d.alternatives,
        rationale: d.rationale,
        consequences: d.consequences,
        significant: d.significant,
        decidedAt: now,
      };
    });
    this.repo.saveAdrs(run.projectId, run.id, records, (a) => `docs/adr/${adrFileName(a)}`);
    this.store.recordEvent({
      type: 'adr.recorded',
      projectId: run.projectId,
      payload: {
        runId: run.id,
        count: records.length,
        significant: records.filter((r) => r.significant).length,
      },
    });
  }

  private writeAdrDocs(run: WorkflowRun, message: string, arch?: Architecture): void {
    const archJson =
      arch ?? (JSON.parse(this.repo.completedOutput(run.id, 'architect') ?? 'null') as Architecture | null);
    const adrs = this.repo.listAdrs(run.projectId);
    const files: Record<string, string> = {};
    for (const a of adrs) if (a.filePath) files[a.filePath] = renderAdr(a);
    if (archJson)
      files['docs/architecture/ARCHITECTURE.md'] = renderArchitecture(
        getAssignment(this.store, run.projectId)?.title ?? run.projectId,
        archJson,
        adrs,
      );
    this.docs(run, files, message);
  }

  /** Best effort: documents are a view of the database (the source of truth); a write failure never fails planning. */
  private docs(run: WorkflowRun, files: Record<string, string>, message: string): void {
    if (this.cfg.writeDocs === false || !Object.keys(files).length) return;
    const project = this.store.getProject(run.projectId)!;
    try {
      const managed = getAssignment(this.store, run.projectId)?.workspace.type !== 'existing';
      const r = writeProjectDocs(project.repoPath, files, { commit: managed, message });
      this.store.recordEvent({
        type: 'docs.written',
        projectId: run.projectId,
        payload: { runId: run.id, files: r.written, committed: r.committed },
      });
    } catch (err) {
      this.log?.warn('docs.write_failed', { runId: run.id, error: err });
      this.store.recordEvent({
        type: 'docs.write_failed',
        projectId: run.projectId,
        severity: 'warn',
        payload: { runId: run.id, error: String(err) },
      });
    }
  }

  /** URLs the research task's web tools were called with or returned, from the recorded execution transcripts. */
  private webEvidence(taskId: string): string[] {
    const urls: string[] = [];
    for (const e of this.store.listExecutions(taskId)) {
      if (!e.logRef || !existsSync(e.logRef)) continue;
      for (const line of readFileSync(e.logRef, 'utf8').split('\n')) {
        if (!line.includes('"web_evidence"')) continue;
        try {
          const rec = JSON.parse(line) as { kind?: string; urls?: unknown };
          if (rec.kind === 'web_evidence' && Array.isArray(rec.urls)) urls.push(...rec.urls.map(String));
        } catch {
          /* partial line */
        }
      }
    }
    return urls;
  }

  // ------------------------------------------------------------ materialise
  /**
   * Turn the validated plan into milestones, epics and coding tasks. Idempotent: task dedupe keys are
   * `plan:<run>:<key>`, so running it twice (crash/replay) creates nothing new. Earlier milestones get higher priority.
   */
  materialize(run: WorkflowRun, plan: Plan): number {
    const reqIds = this.repo.listRequirements(run.projectId).map((r) => r.id);
    const v = validatePlan(plan, reqIds, { maxTasks: Number.MAX_SAFE_INTEGER });
    if (!v.ok || !v.order) throw new Error(`refusing to materialise an invalid plan: ${v.errors.join('; ')}`);
    let created = 0;
    const idByKey = new Map<string, string>();
    plan.milestones.forEach((m, i) =>
      this.repo.upsertMilestone(run.projectId, {
        key: m.key,
        title: m.title,
        goal: m.goal,
        position: i,
        requirementIds: m.requirementIds,
      }),
    );
    (plan.epics ?? []).forEach((e, i) => this.repo.upsertEpic(run.projectId, { ...e, position: i }));
    const position = new Map(plan.milestones.map((m, i) => [m.key, i]));
    const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
    for (const key of v.order) {
      const t = byKey.get(key)!;
      const instructions = [
        t.instructions,
        t.subtasks?.length ? `\nSubtasks:\n${t.subtasks.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
        t.testing ? `\nTesting requirements:\n${t.testing}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const { task, created: isNew } = this.store.enqueueTask({
        projectId: run.projectId,
        kind: 'CODING',
        title: t.title,
        instructions,
        acceptanceCriteria: t.acceptanceCriteria,
        dependsOn: t.dependsOn.map((d) => idByKey.get(d)!),
        priority: t.priority + (plan.milestones.length - (position.get(t.milestone) ?? 0)) * 10,
        maxRetries: this.cfg.defaultMaxRetries,
        dedupeKey: `plan:${run.id}:${t.key}`,
        // Independent QA: downstream tasks wait until a separate review session confirms this task (src/engineering/qa.ts).
        verificationRequired: this.cfg.independentReview ? [...t.verify, 'REQUIREMENTS_SATISFIED'] : t.verify,
        role: t.role ?? inferRole(`${t.title}\n${t.instructions}`),
      });
      idByKey.set(key, task.id);
      if (isNew) created++;
      this.repo.linkPlanTask(task.id, {
        runId: run.id,
        planKey: t.key,
        milestoneKey: t.milestone,
        requirementIds: t.requirementIds,
        size: t.size,
        epicKey: t.epic ?? null,
        subtasks: t.subtasks,
        testing: t.testing,
      });
    }
    this.store.setMemory(
      run.projectId,
      'roadmap',
      plan.milestones
        .map(
          (m, i) =>
            `${i + 1}. ${m.title} (${m.key}): ${m.goal}\n${plan.tasks
              .filter((t) => t.milestone === m.key)
              .map((t) => `   - [${t.key}] ${t.title} (${t.size})`)
              .join('\n')}`,
        )
        .join('\n'),
    );
    this.store.recordEvent({
      type: 'plan.materialized',
      projectId: run.projectId,
      payload: { runId: run.id, tasks: plan.tasks.length, created, milestones: plan.milestones.length },
    });
    return created;
  }

  // ------------------------------------------------------------------ utils
  private activeRun(projectId: string): WorkflowRun | undefined {
    return this.repo
      .listRuns({ projectId, statuses: ['RUNNING', 'WAITING_FOR_OWNER'] })
      .find((r) => r.kind === PLAN_KIND);
  }

  private createPlanRun(
    projectId: string,
    phase: 'intake' | 'analyze',
    extra: Record<string, unknown> = {},
  ): WorkflowRun {
    const run = this.repo.createRun(projectId, PLAN_KIND, {
      phase,
      repairs: {},
      questions: [],
      answers: {},
      assume: false,
      ...extra,
    } as RunContext);
    this.scanWorkspace(projectId);
    if (this.store.getProject(projectId)!.lifecycle === 'REGISTERED') {
      this.store.transitionProject(projectId, 'ANALYZING', `planning workflow ${run.id} started`);
    }
    this.store.recordEvent({
      type: 'workflow.started',
      projectId,
      payload: { runId: run.id, kind: PLAN_KIND, phase },
    });
    return run;
  }

  private seedRequirements(projectId: string, a: ProjectAssignment): void {
    for (const r of allRequirements(a)) {
      this.repo.upsertRequirement(projectId, {
        id: r.id,
        text: r.text,
        kind: r.kind,
        priority: r.priority,
        source: 'assignment',
      });
    }
  }

  private failRun(run: WorkflowRun, error: string): boolean {
    this.repo.updateRun(run.id, { status: 'FAILED', error });
    this.store.recordEvent({
      type: 'workflow.failed',
      projectId: run.projectId,
      severity: 'error',
      payload: { runId: run.id, error },
    });
    // The pipeline could not produce a trustworthy plan: escalate to the owner instead of guessing.
    const lifecycle = this.store.getProject(run.projectId)!.lifecycle;
    if (['ANALYZING', 'PLANNING', 'REGISTERED'].includes(lifecycle))
      this.store.transitionProject(
        run.projectId,
        'BLOCKED',
        `planning workflow failed: ${error.slice(0, 200)}`,
      );
    return true;
  }

  private cancelTaskIfOpen(taskId: string, reason: string): void {
    const t = this.store.getTask(taskId);
    if (!t) return;
    try {
      this.store.transition(taskId, 'CANCELLED', { reason });
    } catch {
      /* already terminal or in a state without a direct cancel path */
    }
  }

  private requireRun(id: string): WorkflowRun {
    const r = this.repo.getRun(id);
    if (!r) throw new Error(`Unknown workflow run ${id}`);
    return r;
  }
}
