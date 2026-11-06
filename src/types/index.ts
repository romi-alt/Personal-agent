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

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  repoPath: string;
  priority: number;
  status: ProjectStatus;
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
