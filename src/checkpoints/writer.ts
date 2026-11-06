import type { Store } from '../queue/store.js';
import type { Checkpoint, Project, Task } from '../types/index.js';
import { gitState } from '../workspaces/git.js';

export interface CheckpointInput {
  task: Task;
  project: Project;
  executionId: string | null;
  sessionRef: string | null;
  completedSummary: string;
  outstandingSummary: string;
  nextAction: string;
  testResults?: string | null;
}

/**
 * Persist a checkpoint that pairs the conversation reference (session id) with the actual
 * working state (git HEAD + dirtiness). A saved conversation is not a saved filesystem: both are recorded.
 */
export async function writeCheckpoint(store: Store, input: CheckpointInput): Promise<Checkpoint> {
  const git = await gitState(input.project.repoPath);
  const changes = git.dirty
    ? `\nUncommitted changes (${git.changes.length}${git.changes.length >= 50 ? '+' : ''}):\n${git.changes.slice(0, 20).join('\n')}`
    : '';
  return store.addCheckpoint({
    projectId: input.project.id,
    taskId: input.task.id,
    executionId: input.executionId,
    sessionRef: input.sessionRef,
    repoRef: git.head ? `${git.branch ?? 'detached'}@${git.head}` : null,
    gitDirty: git.isRepo ? git.dirty : null,
    completedSummary: input.completedSummary,
    outstandingSummary: input.outstandingSummary + changes,
    testResults: input.testResults ?? null,
    nextAction: input.nextAction,
  });
}
