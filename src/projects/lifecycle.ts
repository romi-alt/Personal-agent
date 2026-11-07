/**
 * Project-level lifecycle. It is deliberately separate from the task lifecycle: a project is NOT
 * complete because tasks reported success. Success of individual Claude executions can at most move a
 * project to VERIFYING; reaching READY_FOR_DELIVERY requires recorded verification evidence plus an
 * explicit owner approval (see src/verification).
 *
 * ANALYZING and PLANNING are legal states reserved for the Phase 2 intelligence layer.
 */
export const PROJECT_LIFECYCLES = [
  'REGISTERED',
  'ANALYZING',
  'PLANNING',
  'IN_DEVELOPMENT',
  'VERIFYING',
  'AWAITING_OWNER_APPROVAL',
  'READY_FOR_DELIVERY',
  'DELIVERED',
  'PAUSED',
  'BLOCKED',
  'CANCELLED',
] as const;
export type ProjectLifecycle = (typeof PROJECT_LIFECYCLES)[number];

export const PROJECT_TRANSITIONS: Record<ProjectLifecycle, readonly ProjectLifecycle[]> = {
  REGISTERED: ['ANALYZING', 'PLANNING', 'IN_DEVELOPMENT', 'PAUSED', 'BLOCKED', 'CANCELLED'],
  ANALYZING: ['PLANNING', 'IN_DEVELOPMENT', 'BLOCKED', 'PAUSED', 'CANCELLED'],
  PLANNING: ['IN_DEVELOPMENT', 'BLOCKED', 'PAUSED', 'CANCELLED'],
  IN_DEVELOPMENT: ['VERIFYING', 'BLOCKED', 'PAUSED', 'CANCELLED'],
  VERIFYING: ['IN_DEVELOPMENT', 'AWAITING_OWNER_APPROVAL', 'BLOCKED', 'PAUSED', 'CANCELLED'],
  AWAITING_OWNER_APPROVAL: ['IN_DEVELOPMENT', 'READY_FOR_DELIVERY', 'BLOCKED', 'CANCELLED'],
  READY_FOR_DELIVERY: ['DELIVERED', 'IN_DEVELOPMENT', 'CANCELLED'],
  DELIVERED: [],
  PAUSED: ['REGISTERED', 'IN_DEVELOPMENT', 'CANCELLED'],
  BLOCKED: ['REGISTERED', 'IN_DEVELOPMENT', 'CANCELLED'],
  CANCELLED: [],
};

/** Lifecycles in which the supervisor may start tasks for the project. */
export const EXECUTABLE_LIFECYCLES: readonly ProjectLifecycle[] = [
  'REGISTERED',
  'ANALYZING',
  'PLANNING',
  'IN_DEVELOPMENT',
  'VERIFYING',
  'AWAITING_OWNER_APPROVAL',
  'READY_FOR_DELIVERY',
];

export class InvalidProjectTransitionError extends Error {
  constructor(
    readonly projectId: string,
    readonly from: ProjectLifecycle,
    readonly to: ProjectLifecycle,
  ) {
    super(`Invalid project transition ${from} -> ${to} for ${projectId}`);
    this.name = 'InvalidProjectTransitionError';
  }
}

export const canProjectTransition = (from: ProjectLifecycle, to: ProjectLifecycle): boolean =>
  PROJECT_TRANSITIONS[from].includes(to);
