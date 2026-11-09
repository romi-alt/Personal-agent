import { z } from 'zod';
import { ROLES } from '../engineering/roles.js';

/**
 * Structured outputs of the planning workflows. Model output is DATA: it is parsed with these schemas and then
 * checked by deterministic code (validate-plan.ts); nothing the model says controls state transitions directly.
 */

const key = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, 'identifier: 1-40 chars, letters/digits/._-');

// ------------------------------------------------------------------ analysis
export const analysisSchema = z.object({
  /** Requirement refinements. Ids must be assignment requirement ids or new derived ids starting with "DR-". */
  requirements: z
    .array(
      z.object({
        id: key,
        text: z.string().min(3),
        priority: z.enum(['must', 'should', 'could']).default('must'),
        kind: z.enum(['functional', 'non_functional']).default('functional'),
        acceptance: z.array(z.string().min(3)).default([]),
      }),
    )
    .min(1),
  assumptions: z.array(z.string().min(3)).default([]),
  risks: z
    .array(
      z.object({
        id: key,
        text: z.string().min(3),
        severity: z.enum(['low', 'medium', 'high']).default('medium'),
      }),
    )
    .default([]),
  /** Blocking questions pause the workflow for the owner; non-blocking ones are recorded as open questions. */
  questions: z
    .array(z.object({ id: key, text: z.string().min(3), blocking: z.boolean().default(false) }))
    .default([]),
});
export type Analysis = z.infer<typeof analysisSchema>;

// ------------------------------------------------------------------ research
export const RESEARCH_AREAS = [
  'domain',
  'industry_requirements',
  'existing_solutions',
  'technical_standards',
  'security',
  'apis',
  'integrations',
  'performance',
  'risks',
] as const;
export const researchSchema = z.object({
  findings: z
    .array(
      z.object({
        id: key,
        area: z.enum(RESEARCH_AREAS),
        statement: z.string().min(5),
        /** 'verified' requires sources the research session actually retrieved; anything else is an assumption. */
        kind: z.enum(['verified', 'assumption']),
        confidence: z.enum(['high', 'medium', 'low']).default('medium'),
        sources: z.array(z.object({ title: z.string().min(1), url: z.string().url() })).default([]),
      }),
    )
    .min(1),
  /** Research questions that could not be answered (shown to the owner; never silently filled in). */
  openQuestions: z.array(z.string().min(3)).default([]),
});
export type Research = z.infer<typeof researchSchema>;

// -------------------------------------------------------------- architecture
export const ARCHITECTURE_SECTIONS = [
  'system',
  'database',
  'backend',
  'frontend',
  'api',
  'authentication',
  'authorization',
  'integration',
  'deployment',
  'security',
  'monitoring',
] as const;
export type ArchitectureSection = (typeof ARCHITECTURE_SECTIONS)[number];
export const architectureSchema = z.object({
  decisions: z
    .array(
      z.object({
        id: key,
        title: z.string().min(3),
        /** ADR fields. `context`/`consequences` default to empty for backwards compatibility; the review flags them. */
        context: z.string().default(''),
        decision: z.string().min(3),
        rationale: z.string().min(3),
        alternatives: z.array(z.string()).default([]),
        consequences: z.string().default(''),
        /** Significant decisions (stack, data store, auth model, hosting, integrations) need owner review. */
        significant: z.boolean().default(false),
      }),
    )
    .min(1),
  /** Technical specification per area (markdown). */
  sections: z
    .object(
      Object.fromEntries(ARCHITECTURE_SECTIONS.map((s) => [s, z.string().default('')])) as {
        [K in ArchitectureSection]: z.ZodDefault<z.ZodString>;
      },
    )
    .default(
      Object.fromEntries(ARCHITECTURE_SECTIONS.map((s) => [s, ''])) as Record<ArchitectureSection, string>,
    ),
  /** Mermaid diagrams (system context, components, data model, deployment, ...). */
  diagrams: z.array(z.object({ title: z.string().min(3), mermaid: z.string().min(10) })).default([]),
  technology: z
    .array(z.object({ area: z.string().min(2), choice: z.string().min(1), rationale: z.string().min(3) }))
    .default([]),
  components: z
    .array(
      z.object({
        name: z.string().min(2),
        responsibility: z.string().min(3),
        requirementIds: z.array(key).min(1),
      }),
    )
    .min(1),
  dataModel: z.string().default(''),
});
export type Architecture = z.infer<typeof architectureSchema>;

// -------------------------------------------------------------------- plan
export const TASK_SIZES = ['S', 'M'] as const; // "L" is rejected: oversized tasks must be split
export const planTaskSchema = z.object({
  key,
  title: z.string().min(3).max(200),
  instructions: z.string().min(10),
  acceptanceCriteria: z.string().default(''),
  milestone: key,
  /** Optional epic grouping (cross-milestone feature area). */
  epic: key.optional(),
  /** Ordered checklist inside the task. */
  subtasks: z.array(z.string().min(3)).default([]),
  /** Tests the task must add or run. */
  testing: z.string().default(''),
  /** Specialist role (bounded brief; see src/engineering/roles.ts). Inferred when absent. */
  role: z.enum(ROLES).optional(),
  dependsOn: z.array(key).default([]),
  requirementIds: z.array(key).min(1),
  /**
   * Requirements (subset of requirementIds) this task OWNS: its independent review judges them. Other linked tasks
   * only contribute. Unowned requirements default to the last linked task in dependency order.
   */
  ownsRequirementIds: z.array(key).optional(),
  priority: z.number().int().min(-100).max(100).default(0),
  size: z.enum(['S', 'M', 'L']).default('M'),
  /** Verification levels required before the task may complete. */
  verify: z.array(z.enum(['CHANGES_EXIST', 'BUILD_PASSES', 'TESTS_PASS'])).default(['CHANGES_EXIST']),
});
export const planSchema = z.object({
  milestones: z
    .array(
      z.object({
        key,
        title: z.string().min(3),
        goal: z.string().min(3),
        requirementIds: z.array(key).default([]),
      }),
    )
    .min(1),
  epics: z.array(z.object({ key, title: z.string().min(3), goal: z.string().min(3) })).default([]),
  tasks: z.array(planTaskSchema).min(1),
});
export type Plan = z.infer<typeof planSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;

// -------------------------------------------------------------- plan review
export const REVIEW_CATEGORIES = [
  'missing_requirement',
  'contradiction',
  'security_gap',
  'data_model',
  'missing_api',
  'dependency',
  'unrealistic',
  'other',
] as const;
export const reviewIssueSchema = z.object({
  id: key,
  category: z.enum(REVIEW_CATEGORIES),
  severity: z.enum(['low', 'medium', 'high']),
  description: z.string().min(5),
  recommendation: z.string().default(''),
});
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;
export const reviewSchema = z.object({
  verdict: z.enum(['approve', 'revise']),
  issues: z.array(reviewIssueSchema).default([]),
});
export type PlanReview = z.infer<typeof reviewSchema>;

// -------------------------------------------------------------------- intake
/**
 * Free-text assignment -> structured contract. Workspace, source and the approval policy are set by the system, never
 * by the model: text in an attachment must not be able to pre-approve anything.
 */
export const INTAKE_OMITTED_FIELDS = ['workspace', 'source', 'approvalPolicy'] as const;
