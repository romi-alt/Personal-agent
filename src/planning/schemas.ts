import { z } from 'zod';

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

// -------------------------------------------------------------- architecture
export const architectureSchema = z.object({
  decisions: z
    .array(
      z.object({
        id: key,
        title: z.string().min(3),
        decision: z.string().min(3),
        rationale: z.string().min(3),
        alternatives: z.array(z.string()).default([]),
      }),
    )
    .min(1),
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
  dependsOn: z.array(key).default([]),
  requirementIds: z.array(key).min(1),
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
  tasks: z.array(planTaskSchema).min(1),
});
export type Plan = z.infer<typeof planSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;
