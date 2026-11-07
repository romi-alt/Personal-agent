import type { Project } from '../types/index.js';
import type { Store } from '../queue/store.js';
import type { WorkspaceRegistry } from '../workspaces/registry.js';
import { ASSIGNMENT_SCHEMA_VERSION, parseAssignment, type ProjectAssignment } from './schema.js';

export interface RegisterResult {
  project: Project;
  assignment: ProjectAssignment;
  created: boolean;
}

export function getAssignment(store: Store, projectId: string): ProjectAssignment | null {
  const data = store.getAssignmentData(projectId);
  return data ? parseAssignment(data) : null;
}

/** Find a project already registered from the same external source id (prevents duplicate sync). */
export function findByExternalId(store: Store, system: string, externalId: string): Project | null {
  const row = store.db
    .prepare(
      `SELECT project_id FROM assignments WHERE json_extract(data,'$.source.system') = ? AND json_extract(data,'$.source.externalId') = ?`,
    )
    .get(system, externalId) as { project_id: string } | undefined;
  return row ? store.getProject(row.project_id) : null;
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

/**
 * Validate and register an assignment: creates (or attaches) the project workspace, persists the full
 * contract, and seeds the durable project memory so context survives restarts. It does NOT plan or
 * create tasks (Phase 2) and never marks anything complete.
 */
export async function registerAssignment(
  store: Store,
  registry: WorkspaceRegistry,
  providerName: string,
  raw: unknown,
): Promise<RegisterResult> {
  const a = parseAssignment(raw);

  if (a.source.externalId) {
    const existing = findByExternalId(store, a.source.system, a.source.externalId);
    if (existing)
      return { project: existing, assignment: getAssignment(store, existing.id)!, created: false };
  }

  const base = { name: a.title, description: a.description, priority: a.priority, provider: providerName };
  const project =
    a.workspace.type === 'existing'
      ? await registry.registerExistingProject(store, {
          ...base,
          repoPath: a.workspace.path,
          allowDirty: a.workspace.allowDirty,
        })
      : await registry.createManagedProject(store, base);

  store.db.transaction(() => {
    store.saveAssignment(project.id, ASSIGNMENT_SCHEMA_VERSION, a as unknown as Record<string, unknown>);
    store.setMemory(
      project.id,
      'assignment',
      [
        `# ${a.title}`,
        a.description,
        `\n## Business objectives\n${bullets(a.businessObjectives)}`,
        `\n## Expected deliverables\n${bullets(a.expectedDeliverables)}`,
        `\n## Acceptance criteria\n${bullets(a.acceptanceCriteria.map((c) => `[${c.id}] ${c.text} (verified by: ${c.verifiedBy})`))}`,
      ].join('\n'),
    );
    store.setMemory(
      project.id,
      'requirements',
      [
        `## Functional\n${bullets(a.functionalRequirements.map((r) => `[${r.id}] (${r.priority}) ${r.text}`))}`,
        a.nonFunctionalRequirements.length
          ? `\n## Non-functional\n${bullets(a.nonFunctionalRequirements.map((r) => `[${r.id}] (${r.priority}) ${r.text}`))}`
          : '',
      ].join('\n'),
    );
    if (a.technicalConstraints.length)
      store.setMemory(
        project.id,
        'important_decisions',
        `## Owner-provided technical constraints\n${bullets(a.technicalConstraints)}`,
      );
    store.recordEvent({
      type: 'assignment.registered',
      projectId: project.id,
      payload: {
        title: a.title,
        source: a.source,
        requirements: a.functionalRequirements.length,
        criteria: a.acceptanceCriteria.length,
      },
    });
  })();
  return { project: store.getProject(project.id)!, assignment: a, created: true };
}
