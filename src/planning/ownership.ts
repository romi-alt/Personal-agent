import type Database from 'better-sqlite3';

/**
 * Requirement ownership (A1). A planner often links a cross-cutting requirement (responsive UI, audit logging,
 * an evidence package, ...) to many tasks. Exactly ONE task owns each requirement: the independent review checks
 * the requirement there. Every other linked task only CONTRIBUTES to it, and its review must not fail on it.
 *
 * Owner resolution, in order:
 *   1. an explicit owner from the plan (`ownsRequirementIds`), persisted in requirements.owner_task_id;
 *   2. otherwise the LAST linked task in plan (topological) order - the task that completes the requirement.
 */
export interface PlanOwnershipTask {
  key: string;
  requirementIds: string[];
  ownsRequirementIds?: string[];
}

/** requirement id -> owner task key, for a plan whose tasks are given in topological order. */
export function resolvePlanOwners(orderedTasks: PlanOwnershipTask[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const t of orderedTasks) for (const id of t.requirementIds) owners.set(id, t.key); // last linked wins
  for (const t of orderedTasks)
    for (const id of t.ownsRequirementIds ?? []) if (t.requirementIds.includes(id)) owners.set(id, t.key);
  return owners;
}

export interface RequirementOwnership {
  reqId: string;
  text: string;
  ownerTaskId: string | null;
  ownerTitle: string | null;
  /** Linked tasks other than the owner. */
  contributorTaskIds: string[];
  /** Every non-cancelled plan task linked to the requirement, in plan order. */
  linkedTaskIds: string[];
}

/** Ownership map for a project, from the database (works on databases planned before ownership existed). */
export function requirementOwnership(
  db: Database.Database,
  projectId: string,
): Map<string, RequirementOwnership> {
  const reqs = db
    .prepare('SELECT req_id, text, owner_task_id FROM requirements WHERE project_id = ? ORDER BY rowid')
    .all(projectId) as { req_id: string; text: string; owner_task_id: string | null }[];
  const links = db
    .prepare(
      `SELECT p.task_id, p.requirement_ids, t.title FROM plan_tasks p JOIN tasks t ON t.id = p.task_id
        WHERE t.project_id = ? AND t.status != 'CANCELLED' ORDER BY t.rowid`,
    )
    .all(projectId) as { task_id: string; requirement_ids: string; title: string }[];
  const titles = new Map(links.map((l) => [l.task_id, l.title]));
  const linked = new Map<string, string[]>();
  for (const l of links)
    for (const id of JSON.parse(l.requirement_ids) as string[])
      linked.set(id, [...(linked.get(id) ?? []), l.task_id]);
  const out = new Map<string, RequirementOwnership>();
  const ids = new Set([...reqs.map((r) => r.req_id), ...linked.keys()]);
  for (const id of ids) {
    const r = reqs.find((x) => x.req_id === id);
    const tasks = linked.get(id) ?? [];
    const explicit = r?.owner_task_id && tasks.includes(r.owner_task_id) ? r.owner_task_id : null;
    const owner = explicit ?? tasks.at(-1) ?? null;
    out.set(id, {
      reqId: id,
      text: r?.text ?? id,
      ownerTaskId: owner,
      ownerTitle: owner ? (titles.get(owner) ?? null) : null,
      contributorTaskIds: tasks.filter((t) => t !== owner),
      linkedTaskIds: tasks,
    });
  }
  return out;
}
