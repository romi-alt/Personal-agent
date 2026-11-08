import { z } from 'zod';

export const ASSIGNMENT_SCHEMA_VERSION = 1;

/**
 * Approval categories an assignment may PRE-approve. Production-facing categories (deploys, publishing, pushes,
 * live migrations, credentials, customer messages, money, access control) can NEVER be pre-approved: each
 * instance needs a fresh owner decision.
 */
export const PRE_APPROVABLE = ['destructive_delete', 'system_modification', 'external_tool'] as const;
/** Categories an assignment can additionally force to require approval. */
export const ALSO_REQUIRE = ['web_access', 'external_tool'] as const;

const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, 'id must be 1-40 chars: letters, digits, . _ -');
const requirement = z.object({
  id,
  text: z.string().min(3),
  priority: z.enum(['must', 'should', 'could']).default('must'),
});
const criterion = z.object({
  id,
  text: z.string().min(3),
  verifiedBy: z.enum(['build', 'tests', 'review', 'manual']).default('manual'),
});

const uniqueIds = (items: { id: string }[]) => new Set(items.map((i) => i.id)).size === items.length;

export const assignmentSchema = z
  .object({
    title: z.string().min(3).max(200),
    description: z.string().min(10),
    businessObjectives: z.array(z.string().min(3)).min(1),
    functionalRequirements: z
      .array(requirement)
      .min(1)
      .refine(uniqueIds, 'duplicate functional requirement id'),
    nonFunctionalRequirements: z
      .array(requirement)
      .default([])
      .refine(uniqueIds, 'duplicate non-functional requirement id'),
    technicalConstraints: z.array(z.string().min(3)).default([]),
    /** Who will use the system (roles / audiences). */
    targetUsers: z.array(z.string().min(2)).default([]),
    /** Owner technology preferences (softer than technicalConstraints; deviations need an ADR). */
    preferredTechnology: z.array(z.string().min(2)).default([]),
    /** Security requirements; planned and verified like other requirements (kind non_functional). */
    securityRequirements: z
      .array(requirement)
      .default([])
      .refine(uniqueIds, 'duplicate security requirement id'),
    /** Points where the owner wants to review/approve, in their own words (recorded; enforced approvals are fixed in code). */
    ownerApprovalRequirements: z.array(z.string().min(3)).default([]),
    workspace: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('managed') }),
        z.object({
          type: z.literal('existing'),
          path: z.string().min(1),
          allowDirty: z.boolean().default(false),
        }),
      ])
      .default({ type: 'managed' }),
    expectedDeliverables: z.array(z.string().min(3)).min(1),
    acceptanceCriteria: z.array(criterion).min(1).refine(uniqueIds, 'duplicate acceptance criterion id'),
    priority: z.number().int().min(-100).max(100).default(0),
    budget: z
      .object({
        maxUsdTotal: z.number().positive().optional(),
        maxUsdPerExecution: z.number().positive().optional(),
        maxExecutions: z.number().int().positive().optional(),
      })
      .default({}),
    approvalPolicy: z
      .object({
        preApproved: z.array(z.enum(PRE_APPROVABLE)).default([]),
        alsoRequire: z.array(z.enum(ALSO_REQUIRE)).default([]),
        /** Fixed: delivery always needs the owner. Present so the contract states it explicitly. */
        deliveryRequiresOwnerApproval: z.literal(true).default(true),
      })
      .default({ preApproved: [], alsoRequire: [], deliveryRequiresOwnerApproval: true }),
    requiredIntegrations: z
      .array(
        z.object({
          system: z.enum(['erp', 'crm', 'github', 'other']),
          /** Phase 1.5 integrations are read-only; write access cannot be requested here. */
          access: z.enum(['none', 'read']).default('read'),
          purpose: z.string().min(3),
        }),
      )
      .default([]),
    verification: z
      .object({
        buildCommand: z.string().min(1).optional(),
        testCommand: z.string().min(1).optional(),
        /** Browser/end-to-end suite; part of TESTS_PASS when configured (v2). */
        browserTestCommand: z.string().min(1).optional(),
      })
      .default({}),
    source: z
      .object({
        system: z.enum(['manual', 'erp', 'crm']).default('manual'),
        /** Stable id in the source system; used to prevent duplicate registration on re-sync. */
        externalId: z.string().min(1).optional(),
      })
      .default({ system: 'manual' }),
  })
  .strict()
  .superRefine((a, ctx) => {
    const ids = [...a.functionalRequirements, ...a.nonFunctionalRequirements, ...a.securityRequirements].map(
      (r) => r.id,
    );
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length)
      ctx.addIssue({
        code: 'custom',
        message: `requirement ids must be unique across all lists: ${[...new Set(dup)].join(', ')}`,
      });
  });

/** All requirement ids of an assignment (functional, non-functional, security). */
export const allRequirements = (a: ProjectAssignment) => [
  ...a.functionalRequirements.map((r) => ({ ...r, kind: 'functional' as const })),
  ...a.nonFunctionalRequirements.map((r) => ({ ...r, kind: 'non_functional' as const })),
  ...a.securityRequirements.map((r) => ({ ...r, kind: 'non_functional' as const })),
];

export type ProjectAssignment = z.infer<typeof assignmentSchema>;
export type ProjectAssignmentInput = z.input<typeof assignmentSchema>;

export class AssignmentValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid project assignment:\n  - ${issues.join('\n  - ')}`);
    this.name = 'AssignmentValidationError';
  }
}

export function parseAssignment(input: unknown): ProjectAssignment {
  const r = assignmentSchema.safeParse(input);
  if (!r.success)
    throw new AssignmentValidationError(
      r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  return r.data;
}
