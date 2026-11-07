import type { Store } from '../queue/store.js';
import type { Checkpoint, Project, Task } from '../types/index.js';
import type { GitState } from '../workspaces/git.js';

/** Sections of persistent project memory (Phase 1: storage + checkpoint reader/writer only; no retrieval). */
export const MEMORY_SECTIONS = [
  'assignment',
  'requirements',
  'architecture_decisions',
  'technology_decisions',
  'roadmap',
  'milestones',
  'completed_features',
  'known_defects',
  'test_results',
  'dependencies',
  'important_decisions',
  'pending_approvals',
  'blockers',
  'next_actions',
] as const;

export const SYSTEM_APPEND = `
You are an autonomous coding worker operating under the ELEVARIQ Personal Agent supervisor.
Rules you must follow:
- Work only inside the current working directory (the project workspace). Never read or modify files outside it.
- Do not deploy, publish packages/releases, push to remotes, delete large amounts of data, run live-database migrations,
  change credentials or access permissions, contact customers, or move money. Those need owner approval; if you need one,
  say so plainly and continue with other work.
- Before changing anything on a continued task, inspect the existing artifacts (git status, git diff, existing files, tests)
  and continue from them. Do not redo work that already exists.
- Commit meaningful progress to the current local branch with clear messages (no pushing).
- Run the relevant tests before finishing. End with a short report: what is done, what remains, test results.
`.trim();

/** System instructions for read-only planning workers (Phase 2 workflows). */
export const PLANNING_APPEND = `
You are a read-only planning worker in the ELEVARIQ Personal Agent pipeline.
- You may only read files in the current working directory. Do NOT create, edit or delete anything and do not run commands.
- Your ENTIRE final reply must be one JSON object that matches the schema in the task, with no prose before or after it.
- Use only the identifiers given in the task (requirement ids etc.). Do not invent requirements; record uncertainty as questions or risks.
`.trim();

export interface PromptInput {
  task: Task;
  project: Project;
  checkpoint: Checkpoint | null;
  git: GitState;
  memory: { section: string; content: string }[];
  mode: 'fresh' | 'resume' | 'recovery';
  /** Why the stored session could not be used (recovery mode). */
  sessionLossReason?: string | null;
  /** Rendered structured project context (assignment contract + progress). */
  projectContext?: string;
  /** Integrity problems found while restoring state (corrupt checkpoint, missing commit...). */
  integrityNotes?: string[];
}

function fmtGit(git: GitState): string {
  if (!git.isRepo) return 'Workspace is not a git repository.';
  return [
    `Branch: ${git.branch ?? '(unknown)'}  HEAD: ${git.head ?? '(no commits)'}  Dirty: ${git.dirty}`,
    ...git.changes.slice(0, 20),
  ].join('\n');
}

function taskBlock(task: Task): string {
  return [
    `# Task: ${task.title}`,
    task.instructions,
    task.acceptanceCriteria ? `\n## Acceptance criteria\n${task.acceptanceCriteria}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Build the prompt for a fresh start, a session resume, or a new session reconstructed from persisted records. */
export function buildPrompt(input: PromptInput): string {
  const { task, project, checkpoint, git, memory, mode } = input;
  if (mode === 'fresh') {
    return [input.projectContext ?? `Project: ${project.name}\n${project.description}`, taskBlock(task)]
      .filter(Boolean)
      .join('\n\n');
  }
  const cp = checkpoint
    ? [
        '## Last checkpoint',
        `Completed: ${checkpoint.completedSummary}`,
        `Outstanding: ${checkpoint.outstandingSummary}`,
        checkpoint.testResults ? `Tests: ${checkpoint.testResults}` : '',
        `Intended next action: ${checkpoint.nextAction}`,
        checkpoint.repoRef ? `Repo ref at checkpoint: ${checkpoint.repoRef}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '## Last checkpoint\n(none recorded)';
  const mem = memory.length
    ? '## Project memory\n' + memory.map((m) => `### ${m.section}\n${m.content}`).join('\n')
    : '';
  const head =
    mode === 'resume'
      ? 'You are resuming an interrupted session for this task. Continue; do not start over.'
      : `A previous session for this task could not be restored${input.sessionLossReason ? ` (${input.sessionLossReason})` : ''}. This is a NEW session reconstructed from persisted records.`;
  return [
    head,
    input.projectContext ?? `Project: ${project.name}`,
    taskBlock(task),
    cp,
    `## Current working-tree state\n${fmtGit(git)}`,
    input.integrityNotes?.length
      ? `## Recovery warnings\n${input.integrityNotes.map((n) => `- ${n}`).join('\n')}`
      : '',
    mem,
    'Files may be partially written if the previous run was interrupted mid-tool-call: verify them before building on them.',
    'First inspect the existing files, `git status` and `git log` to confirm what already exists, then continue only the unfinished work. Avoid duplicating completed steps.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function loadMemory(store: Store, projectId: string): { section: string; content: string }[] {
  return store.listMemory(projectId).map((m) => ({ section: m.section, content: m.content }));
}
