import type { TaskStatus } from '../types/index.js';

/**
 * Central definition of legal task transitions. Every status change in the system
 * goes through Store.transition(), which consults this table; nothing else may
 * write tasks.status.
 *
 * ANALYZING / PLANNING / READY exist in the durable model now; the autonomous
 * analysis and planning stages that use them are Phase 2. In Phase 1 tasks are
 * enqueued as QUEUED and can be claimed directly from QUEUED or READY.
 */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  QUEUED: ['ANALYZING', 'READY', 'RUNNING', 'PAUSED', 'BLOCKED', 'CANCELLED', 'WAITING_FOR_AUTHENTICATION'],
  ANALYZING: ['PLANNING', 'READY', 'BLOCKED', 'FAILED', 'PAUSED', 'CANCELLED', 'WAITING_FOR_APPROVAL'],
  PLANNING: ['READY', 'BLOCKED', 'FAILED', 'PAUSED', 'CANCELLED', 'WAITING_FOR_APPROVAL'],
  READY: ['RUNNING', 'PAUSED', 'BLOCKED', 'CANCELLED', 'WAITING_FOR_AUTHENTICATION'],
  RUNNING: ['CHECKPOINTING', 'RETRY_SCHEDULED', 'READY', 'CANCELLED'],
  CHECKPOINTING: [
    'COMPLETED',
    'READY',
    'RETRY_SCHEDULED',
    'WAITING_FOR_CAPACITY',
    'WAITING_FOR_AUTHENTICATION',
    'WAITING_FOR_APPROVAL',
    'BLOCKED',
    'FAILED',
    'PAUSED',
    'CANCELLED',
  ],
  PAUSED: ['QUEUED', 'READY', 'CANCELLED'],
  WAITING_FOR_CAPACITY: ['RUNNING', 'PAUSED', 'BLOCKED', 'CANCELLED', 'READY', 'WAITING_FOR_AUTHENTICATION'],
  WAITING_FOR_AUTHENTICATION: ['RUNNING', 'PAUSED', 'BLOCKED', 'CANCELLED', 'READY'],
  WAITING_FOR_APPROVAL: ['READY', 'BLOCKED', 'PAUSED', 'CANCELLED'],
  RETRY_SCHEDULED: [
    'RUNNING',
    'PAUSED',
    'BLOCKED',
    'FAILED',
    'CANCELLED',
    'READY',
    'WAITING_FOR_AUTHENTICATION',
  ],
  BLOCKED: ['QUEUED', 'READY', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'CANCELLED'];
/** Statuses from which the supervisor may claim a task for execution. */
export const CLAIMABLE_STATUSES: readonly TaskStatus[] = [
  'QUEUED',
  'READY',
  'RETRY_SCHEDULED',
  'WAITING_FOR_CAPACITY',
  'WAITING_FOR_AUTHENTICATION',
];
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['RUNNING', 'CHECKPOINTING'];

export class InvalidTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Invalid task transition ${from} -> ${to} for ${taskId}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
