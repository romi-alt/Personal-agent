import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { readTextFile } from '../core/text.js';
import type { Store } from '../queue/store.js';
import type { Project } from '../types/index.js';
import type { WorkflowEngine } from '../workflows/engine.js';
import type { WorkflowRun } from '../workflows/repository.js';
import type { WorkspaceRegistry } from '../workspaces/registry.js';

/** Per-document limit: intake documents are prompt input, so they are bounded. */
export const MAX_DOCUMENT_BYTES = 512 * 1024;
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|html?|xml|rst|adoc|sql|ts|js|py|ini|toml)$/i;

export interface IntakeInput {
  /** The owner's assignment in their own words, e.g. "Build a complete educational ERP for Pakistani institutions." */
  text: string;
  /** Project name; defaults to the first words of the text (the structured title comes from intake). */
  name?: string;
  /** Attached specifications (text formats). Stored verbatim; treated as untrusted data in prompts. */
  attachments?: { name: string; content: string }[];
  /** Attach an existing repository instead of a managed workspace. */
  existing?: { path: string; allowDirty?: boolean };
  priority?: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Read attachment files for intake (text formats only, size-bounded). */
export function readAttachments(files: string[]): { name: string; content: string }[] {
  return files.map((f) => {
    if (!TEXT_EXT.test(f))
      throw new Error(
        `unsupported attachment type: ${path.basename(f)} (text formats only: md, txt, json, yaml, csv, html, ...)`,
      );
    const size = statSync(f).size;
    if (size > MAX_DOCUMENT_BYTES)
      throw new Error(`attachment ${path.basename(f)} is ${size} bytes; the limit is ${MAX_DOCUMENT_BYTES}`);
    return { name: path.basename(f), content: readTextFile(f) };
  });
}

/**
 * Natural-language project assignment: create the project workspace, persist the original text and attachments
 * verbatim, and start the planning workflow at its intake step (text -> validated assignment contract -> analysis ...).
 */
export async function submitIntake(
  store: Store,
  registry: WorkspaceRegistry,
  engine: WorkflowEngine,
  providerName: string,
  input: IntakeInput,
): Promise<{ project: Project; run: WorkflowRun }> {
  const text = input.text.trim();
  if (text.length < 10) throw new Error('assignment text is too short (at least 10 characters)');
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new Error('assignment text is too long');
  const name =
    input.name?.trim() ||
    text
      .replace(/\s+/g, ' ')
      .split(' ')
      .slice(0, 8)
      .join(' ')
      .replace(/[.,;:!?]+$/, '')
      .slice(0, 80);
  const base = {
    name,
    description: text.slice(0, 2000),
    priority: input.priority ?? 0,
    provider: providerName,
  };
  const project = input.existing
    ? await registry.registerExistingProject(store, {
        ...base,
        repoPath: input.existing.path,
        allowDirty: !!input.existing.allowDirty,
      })
    : await registry.createManagedProject(store, base);
  const workspace = input.existing
    ? { type: 'existing' as const, path: project.repoPath, allowDirty: !!input.existing.allowDirty }
    : { type: 'managed' as const };
  const run = store.db
    .transaction(() => {
      engine.repo.addDocument(project.id, {
        kind: 'assignment_text',
        name: 'assignment.txt',
        content: text,
        sha256: sha(text),
      });
      for (const a of input.attachments ?? [])
        engine.repo.addDocument(project.id, {
          kind: 'attachment',
          name: a.name,
          content: a.content,
          sha256: sha(a.content),
        });
      store.recordEvent({
        type: 'intake.submitted',
        projectId: project.id,
        payload: { chars: text.length, attachments: (input.attachments ?? []).map((a) => a.name) },
      });
      return engine.startIntake(project.id, workspace);
    })
    .immediate();
  return { project, run };
}
