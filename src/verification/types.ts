/**
 * Completion-verification model (Phase 1.5: interfaces + evidence persistence + a few real, basic verifiers).
 *
 * "Claude says it is done" is only the FIRST rung. Every rung is separate evidence, and a project is
 * READY_FOR_DELIVERY only when the ladder is satisfied AND the owner has approved.
 */
export const VERIFICATION_LEVELS = [
  'CLAIMED_COMPLETE', // the provider reported success
  'CHANGES_EXIST', // the working tree/HEAD actually changed
  'BUILD_PASSES', // configured build command exits 0
  'TESTS_PASS', // configured test command exits 0
  'REQUIREMENTS_SATISFIED', // requirement-by-requirement check (Phase 2: NOT implemented)
  'SECURITY_CHECKS_PASS', // security review/scans (Phase 2: NOT implemented)
  'OWNER_APPROVAL', // explicit owner acceptance
] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** Levels that a task may require before it is allowed to become COMPLETED. */
export const TASK_VERIFIABLE_LEVELS: readonly VerificationLevel[] = [
  'CHANGES_EXIST',
  'BUILD_PASSES',
  'TESTS_PASS',
];

export type EvidenceStatus =
  | 'PASSED'
  | 'FAILED'
  | 'NOT_EVALUATED' // the verifier does not exist yet (honest "we do not know")
  | 'NOT_CONFIGURED' // verifier exists but the project has no command/config for it
  | 'PENDING'; // awaiting a human (owner approval)

export interface EvidenceRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  level: VerificationLevel;
  status: EvidenceStatus;
  summary: string;
  evidence: Record<string, unknown>;
  createdAt: number;
}

export interface VerifyContext {
  projectId: string;
  taskId?: string;
  cwd: string;
  /** Working-tree reference captured when the task's first execution started (for CHANGES_EXIST). */
  baseline?: { head: string | null; statusHash: string | null };
  commands: { build?: string; test?: string; browserTest?: string };
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface VerifierResult {
  status: EvidenceStatus;
  summary: string;
  evidence: Record<string, unknown>;
}

/** Implement this interface to add a verifier; the registry maps levels to implementations. */
export interface Verifier {
  readonly level: VerificationLevel;
  verify(ctx: VerifyContext): Promise<VerifierResult>;
}

/** Derived readiness. `ready` is true ONLY when nothing below is missing. */
export interface DeliveryReadiness {
  ready: boolean;
  /** Per-level latest status (absent => never evaluated). */
  levels: Record<VerificationLevel, EvidenceStatus | 'MISSING'>;
  blockers: string[];
}
