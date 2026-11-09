export const TASK_STATUSES = [
  'QUEUED',
  'ANALYZING',
  'PLANNING',
  'READY',
  'RUNNING',
  'CHECKPOINTING',
  'PAUSED',
  'WAITING_FOR_CAPACITY',
  'WAITING_FOR_AUTHENTICATION',
  'WAITING_FOR_APPROVAL',
  'RETRY_SCHEDULED',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PROJECT_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Distinct failure conditions. Never collapse these into "rate limit". */
export const ERROR_CLASSES = [
  'RATE_LIMIT',
  'QUOTA_EXHAUSTED',
  'AUTHENTICATION',
  'NETWORK',
  'PROCESS_CRASH',
  'PROVIDER_OUTAGE',
  'INVALID_SESSION',
  'TIMEOUT',
  'PERMISSION_DENIED',
  'BUDGET_EXHAUSTED',
  'TASK_FAILURE',
  'INTERRUPTED',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export type Severity = 'debug' | 'info' | 'warn' | 'error';

import type { ProjectLifecycle } from '../projects/lifecycle.js';

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  repoPath: string;
  priority: number;
  status: ProjectStatus;
  /** Project-level lifecycle (separate from the operational `status` switch and from task statuses). */
  lifecycle: ProjectLifecycle;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  provider: string;
  currentMilestone: string | null;
  progressSummary: string | null;
  allowDirty: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string;
  dependsOn: string[];
  priority: number;
  status: TaskStatus;
  attemptCount: number;
  maxRetries: number;
  continuationCount: number;
  scheduledStart: number | null;
  nextEligibleAt: number | null;
  lastErrorClass: ErrorClass | null;
  lastErrorMessage: string | null;
  lastCheckpointId: string | null;
  assignedWorker: string | null;
  leaseExpiresAt: number | null;
  completionEvidence: string | null;
  sessionId: string | null;
  dedupeKey: string;
  /** Execution that currently owns the lease (fencing token). */
  leaseExecutionId: string | null;
  /** Consecutive interruptions (crash/restart) without a completed execution in between. */
  interruptionCount: number;
  /** Consecutive provider-level failures (network/outage) for this task. */
  providerFailureStreak: number;
  /** Verification levels that must not FAIL before the task may become COMPLETED. */
  verificationRequired: string[];
  /** CODING tasks change the repository; PLANNING tasks are read-only model calls feeding a workflow. */
  kind: 'CODING' | 'PLANNING';
  /** Provider must expose read-only tools only. */
  readOnly: boolean;
  /** Read-only research task that may use web tools (WebSearch/WebFetch). */
  allowWeb: boolean;
  /** Specialist role (src/engineering/roles.ts); null = none. */
  role: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ExecutionRecord {
  id: string;
  taskId: string;
  provider: string;
  providerSessionId: string | null;
  resumedFromSessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  heartbeatAt: number;
  pid: number | null;
  host: string | null;
  outcome: string | null;
  errorClass: ErrorClass | null;
  retryReason: string | null;
  usage: Record<string, unknown> | null;
  costUsdEstimate: number | null;
  costUsdBilled: number | null;
  logRef: string | null;
  summary: string | null;
  startRef: string | null;
  startStatusHash: string | null;
  /** Set while the live provider process is waiting for subscription capacity (official retry watchdog). */
  capacityWait: CapacityWait | null;
  /** OS pid of the provider child process (native CLI provider), if any. */
  workerPid: number | null;
  /** OS identity (image + creation time) of `workerPid`, recorded shortly after spawn. */
  workerIdentity: WorkerIdentity | null;
  lastActivityAt: number | null;
}

/** See src/workers/process-tree.ts ProcessIdentity. */
export interface WorkerIdentity {
  pid: number;
  image: string;
  startedAtMs: number;
}

export interface CapacityWait {
  since: number;
  reason: string;
  resetsAt: number | null;
  recheckAt: number | null;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  taskId: string;
  executionId: string | null;
  sessionRef: string | null;
  repoRef: string | null;
  gitDirty: boolean | null;
  completedSummary: string;
  outstandingSummary: string;
  testResults: string | null;
  nextAction: string;
  createdAt: number;
  /** SHA-256 over all fields; null for checkpoints written before integrity hashing. */
  integrity: string | null;
}

export interface ActivityEvent {
  id: string;
  projectId: string | null;
  taskId: string | null;
  executionId: string | null;
  type: string;
  at: number;
  payload: Record<string, unknown>;
  severity: Severity;
  correlationId: string | null;
}

export interface Approval {
  id: string;
  projectId: string;
  taskId: string | null;
  actionType: string;
  description: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  payload: Record<string, unknown>;
}

export interface ProviderState {
  provider: string;
  status: 'OK' | 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'OUTAGE';
  blockedUntil: number | null;
  reason: string | null;
  errorClass: ErrorClass | null;
  consecutiveFailures: number;
  credentialFingerprint: string | null;
  updatedAt: number;
}

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };
