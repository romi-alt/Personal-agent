import { getAssignment } from '../assignments/register.js';
import type { ProjectAssignment } from '../assignments/schema.js';
import type { Logger } from '../logging/logger.js';
import { extractJson } from '../planning/extract-json.js';
import { analyzePrompt, architectPrompt, decomposePrompt } from '../planning/prompts.js';
import {
  type Analysis,
  type Architecture,
  type Plan,
  analysisSchema,
  architectureSchema,
  planSchema,
} from '../planning/schemas.js';
import { validateAnalysis, validateArchitecture, validatePlan } from '../planning/validate-plan.js';
import type { Store } from '../queue/store.js';
import { type RunContext, type WorkflowRun, type WorkflowStep, WorkflowRepository } from './repository.js';

export interface EngineConfig {
  /** 'required': the owner must approve the plan before any coding task is created. */
  planApproval: 'required' | 'auto';
  maxPlanTasks: number;
  /** How many times an invalid planning reply is sent back to the model with the validator's errors. */
  maxPlanRepairs: number;
  defaultMaxRetries: number;
}

export const PLAN_KIND = 'plan_project';
const PLANNING_PRIORITY = 1000; // planning runs before coding work

type Phase = 'analyze' | 'architect' | 'decompose';
type Handled = { ok: true; normalized: string; apply: () => void } | { ok: false; errors: string[] };

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

/**
 * Deterministic orchestrator for the planning pipeline: analyse -> (clarify) -> architect -> decompose -> (approve) -> materialise.
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
        const active = this.repo
          .listRuns({ projectId, statuses: ['RUNNING', 'WAITING_FOR_OWNER'] })
          .find((r) => r.kind === PLAN_KIND);
        if (active) return active;
        if (['BLOCKED', 'PAUSED'].includes(project.lifecycle)) {
          this.store.transitionProject(projectId, 'REGISTERED', 'planning restarted by the owner');
        } else if (!['REGISTERED', 'ANALYZING', 'PLANNING'].includes(project.lifecycle)) {
          throw new Error(
            `Project is ${project.lifecycle}; planning can only start from REGISTERED, ANALYZING or PLANNING`,
          );
        }
        for (const r of assignment.functionalRequirements) {
          this.repo.upsertRequirement(projectId, {
            id: r.id,
            text: r.text,
            kind: 'functional',
            priority: r.priority,
            source: 'assignment',
          });
        }
        for (const r of assignment.nonFunctionalRequirements) {
          this.repo.upsertRequirement(projectId, {
            id: r.id,
            text: r.text,
            kind: 'non_functional',
            priority: r.priority,
            source: 'assignment',
          });
        }
        const run = this.repo.createRun(projectId, PLAN_KIND, {
          phase: 'analyze',
          repairs: {},
          questions: [],
          answers: {},
          assume: false,
        });
        if (this.store.getProject(projectId)!.lifecycle === 'REGISTERED') {
          this.store.transitionProject(projectId, 'ANALYZING', `planning workflow ${run.id} started`);
        }
        this.store.recordEvent({
          type: 'workflow.started',
          projectId,
          payload: { runId: run.id, kind: PLAN_KIND },
        });
        return run;
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
        this.repo.updateRun(run.id, { status: 'RUNNING', context: { ...ctx, phase: 'architect' } });
        return true;
      }
      return false;
    }
    if (ctx.phase === 'approval' && ctx.approvalId) {
      const approval = this.store.getApproval(ctx.approvalId);
      if (approval?.status === 'APPROVED') {
        const planJson = this.repo.completedOutput(run.id, 'decompose');
        if (!planJson) return this.failRun(run, 'approved plan output is missing');
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
    if (!['analyze', 'architect', 'decompose'].includes(phase)) return false;
    const step = this.repo.latestStep(run.id, phase);
    if (!step) {
      this.dispatch(run, phase, 0);
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

  private dispatch(
    run: WorkflowRun,
    phase: Phase,
    attempt: number,
    existing?: WorkflowStep,
    repair?: { errors: string[]; previous?: string },
  ): void {
    const assignment = getAssignment(this.store, run.projectId)!;
    const prompt = this.promptFor(run, phase, assignment, repair);
    const step = existing ?? this.repo.createStep(run.id, phase, attempt);
    const { task } = this.store.enqueueTask({
      projectId: run.projectId,
      kind: 'PLANNING',
      title: attempt === 0 ? `Plan: ${phase}` : `Plan: ${phase} (repair ${attempt})`,
      instructions: prompt,
      priority: PLANNING_PRIORITY,
      maxRetries: this.cfg.defaultMaxRetries,
      dedupeKey: `wf:${run.id}:${phase}:${attempt}`,
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
    a: ProjectAssignment,
    repair?: { errors: string[]; previous?: string },
  ): string {
    const reqs = this.repo
      .listRequirements(run.projectId)
      .map((r) => ({ id: r.id, text: r.text, priority: r.priority }));
    if (phase === 'analyze') return analyzePrompt(a, repair);
    const analysis = JSON.parse(
      this.repo.completedOutput(run.id, 'analyze') ?? '{"assumptions":[]}',
    ) as Analysis;
    if (phase === 'architect') return architectPrompt(a, reqs, analysis, run.context.answers, repair);
    const architecture = JSON.parse(this.repo.completedOutput(run.id, 'architect')!) as Architecture;
    return decomposePrompt(a, reqs, architecture, { maxTasks: this.cfg.maxPlanTasks }, repair);
  }

  // ---------------------------------------------------------------- consume
  private consume(run: WorkflowRun, phase: Phase, step: WorkflowStep): boolean {
    const raw = this.store.getTaskOutput(step.taskId!) ?? '';
    const handled = this.handle(run, phase, raw);
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

  private handle(run: WorkflowRun, phase: Phase, raw: string): Handled {
    const extracted = extractJson(raw);
    if (!extracted.ok) return { ok: false, errors: [extracted.error] };
    const assignment = getAssignment(this.store, run.projectId)!;
    const reqIds = this.repo.listRequirements(run.projectId).map((r) => r.id);

    if (phase === 'analyze') {
      const parsed = analysisSchema.safeParse(extracted.value);
      if (!parsed.success)
        return {
          ok: false,
          errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        };
      const a = parsed.data;
      const assignmentIds = [
        ...assignment.functionalRequirements,
        ...assignment.nonFunctionalRequirements,
      ].map((r) => r.id);
      const v = validateAnalysis(a, assignmentIds);
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
            phase: blocking.length ? 'clarify' : 'architect',
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

    if (phase === 'architect') {
      const parsed = architectureSchema.safeParse(extracted.value);
      if (!parsed.success)
        return {
          ok: false,
          errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        };
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
          if (this.store.getProject(run.projectId)!.lifecycle === 'ANALYZING') {
            this.store.transitionProject(run.projectId, 'PLANNING', 'analysis and architecture accepted');
          }
          this.repo.updateRun(run.id, { context: { ...run.context, phase: 'decompose' } });
        },
      };
    }

    // decompose
    const parsed = planSchema.safeParse(extracted.value);
    if (!parsed.success)
      return {
        ok: false,
        errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      };
    const plan = parsed.data;
    const v = validatePlan(plan, reqIds, { maxTasks: this.cfg.maxPlanTasks });
    if (!v.ok) return { ok: false, errors: v.errors };
    return {
      ok: true,
      normalized: JSON.stringify(plan),
      apply: () => {
        if (this.cfg.planApproval === 'auto') {
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
          description: `Approve the execution plan: ${plan.milestones.length} milestone(s), ${plan.tasks.length} task(s), all ${reqIds.length} requirement(s) covered`,
          payload: {
            runId: run.id,
            milestones: plan.milestones.map((m) => m.title),
            tasks: plan.tasks.map((t) => t.title),
          },
        });
        this.repo.updateRun(run.id, {
          status: 'WAITING_FOR_OWNER',
          context: { ...run.context, phase: 'approval', approvalId: approval.id },
        });
      },
    };
  }

  // ------------------------------------------------------------ materialise
  /**
   * Turn the validated plan into milestones and coding tasks. Idempotent: task dedupe keys are `plan:<run>:<key>`,
   * so running it twice (crash/replay) creates nothing new. Earlier milestones get higher priority.
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
    const position = new Map(plan.milestones.map((m, i) => [m.key, i]));
    const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
    for (const key of v.order) {
      const t = byKey.get(key)!;
      const { task, created: isNew } = this.store.enqueueTask({
        projectId: run.projectId,
        kind: 'CODING',
        title: t.title,
        instructions: t.instructions,
        acceptanceCriteria: t.acceptanceCriteria,
        dependsOn: t.dependsOn.map((d) => idByKey.get(d)!),
        priority: t.priority + (plan.milestones.length - (position.get(t.milestone) ?? 0)) * 10,
        maxRetries: this.cfg.defaultMaxRetries,
        dedupeKey: `plan:${run.id}:${t.key}`,
        verificationRequired: t.verify,
      });
      idByKey.set(key, task.id);
      if (isNew) created++;
      this.repo.linkPlanTask(task.id, {
        runId: run.id,
        planKey: t.key,
        milestoneKey: t.milestone,
        requirementIds: t.requirementIds,
        size: t.size,
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
