import type { Analysis, Architecture, Plan, Research } from './schemas.js';

/**
 * Deterministic validators. Every property a plan must have is checked HERE, in code - never by asking the model
 * whether its own plan is good. Each function returns human-readable errors that are fed back to the model on repair.
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const result = (errors: string[]): ValidationResult => ({ ok: errors.length === 0, errors });

export interface PlanLimits {
  maxTasks: number;
}

/** Analysis must keep every assignment requirement (it may refine text/priority, not drop or invent non-"DR-" ids). */
export function validateAnalysis(a: Analysis, assignmentReqIds: string[]): ValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const r of a.requirements) {
    if (seen.has(r.id)) errors.push(`duplicate requirement id "${r.id}"`);
    seen.add(r.id);
    if (!assignmentReqIds.includes(r.id) && !r.id.startsWith('DR-')) {
      errors.push(
        `unknown requirement id "${r.id}": new requirements must be derived and use an id starting with "DR-"`,
      );
    }
  }
  for (const id of assignmentReqIds) {
    if (!seen.has(id))
      errors.push(
        `assignment requirement "${id}" is missing from the analysis (requirements may not be dropped)`,
      );
  }
  const qids = new Set<string>();
  for (const q of a.questions) {
    if (qids.has(q.id)) errors.push(`duplicate question id "${q.id}"`);
    qids.add(q.id);
  }
  return result(errors);
}

/** Every requirement must be owned by at least one component; components may only reference known requirements. */
export function validateArchitecture(a: Architecture, requirementIds: string[]): ValidationResult {
  const errors: string[] = [];
  const known = new Set(requirementIds);
  const covered = new Set<string>();
  for (const c of a.components) {
    for (const id of c.requirementIds) {
      if (!known.has(id)) errors.push(`component "${c.name}" references unknown requirement "${id}"`);
      covered.add(id);
    }
  }
  for (const id of requirementIds) {
    if (!covered.has(id)) errors.push(`requirement "${id}" is not covered by any architecture component`);
  }
  const dec = new Set<string>();
  for (const d of a.decisions) {
    if (dec.has(d.id)) errors.push(`duplicate decision id "${d.id}"`);
    dec.add(d.id);
  }
  for (const g of a.diagrams ?? []) {
    if (
      !/^\s*(graph|flowchart|sequenceDiagram|classDiagram|erDiagram|stateDiagram|C4Context|journey|gantt)/.test(
        g.mermaid,
      )
    )
      errors.push(
        `diagram "${g.title}" is not a Mermaid diagram (must start with e.g. "flowchart", "erDiagram", "sequenceDiagram")`,
      );
  }
  return result(errors);
}

/**
 * Research citation check. A finding may only stay "verified" if the research session demonstrably retrieved every
 * cited URL (it appears in the web tool evidence recorded from the provider stream). Otherwise it is downgraded to an
 * assumption, never silently trusted. Pure and deterministic.
 */
export function checkCitations(
  r: Research,
  evidenceUrls: string[],
  webAllowed: boolean,
): { findings: (Research['findings'][number] & { claimedKind: string; citationCheck: string })[] } {
  const norm = (u: string) => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  const seen = new Set(evidenceUrls.map(norm));
  return {
    findings: r.findings.map((f) => {
      if (f.kind !== 'verified')
        return { ...f, claimedKind: f.kind, citationCheck: f.sources.length ? 'not_required' : 'none' };
      if (!webAllowed)
        return { ...f, claimedKind: 'verified', kind: 'assumption' as const, citationCheck: 'no_web_access' };
      const ok = f.sources.length > 0 && f.sources.every((s) => seen.has(norm(s.url)));
      return ok
        ? { ...f, claimedKind: 'verified', citationCheck: 'observed' }
        : { ...f, claimedKind: 'verified', kind: 'assumption' as const, citationCheck: 'not_observed' };
    }),
  };
}

/** Topological order of task keys (Kahn). Returns null if the dependency graph has a cycle. */
export function topologicalOrder(tasks: { key: string; dependsOn: string[] }[]): string[] | null {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.key, 0);
    out.set(t.key, []);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!indeg.has(d)) continue; // unknown deps are reported separately
      indeg.set(t.key, indeg.get(t.key)! + 1);
      out.get(d)!.push(t.key);
    }
  }
  const queue = [...indeg.entries()]
    .filter(([, n]) => n === 0)
    .map(([k]) => k)
    .sort();
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    for (const next of out.get(k)!) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return order.length === tasks.length ? order : null;
}

export interface PlanCoverage {
  /** requirement id -> task keys that implement it */
  byRequirement: Record<string, string[]>;
  uncovered: string[];
}

export function validatePlan(
  plan: Plan,
  requirementIds: string[],
  limits: PlanLimits,
): ValidationResult & { coverage: PlanCoverage; order: string[] | null } {
  const errors: string[] = [];
  const known = new Set(requirementIds);
  const keys = new Set<string>();
  const milestoneKeys = new Set<string>();

  for (const m of plan.milestones) {
    if (milestoneKeys.has(m.key)) errors.push(`duplicate milestone key "${m.key}"`);
    milestoneKeys.add(m.key);
    for (const id of m.requirementIds)
      if (!known.has(id)) errors.push(`milestone "${m.key}" references unknown requirement "${id}"`);
  }
  if (plan.tasks.length > limits.maxTasks) {
    errors.push(`plan has ${plan.tasks.length} tasks; the limit is ${limits.maxTasks}. Merge or defer work.`);
  }
  for (const t of plan.tasks) {
    if (keys.has(t.key)) errors.push(`duplicate task key "${t.key}"`);
    keys.add(t.key);
  }
  const milestoneUse = new Map<string, number>();
  const byRequirement: Record<string, string[]> = Object.fromEntries(requirementIds.map((id) => [id, []]));
  for (const t of plan.tasks) {
    if (!milestoneKeys.has(t.milestone))
      errors.push(`task "${t.key}" uses unknown milestone "${t.milestone}"`);
    milestoneUse.set(t.milestone, (milestoneUse.get(t.milestone) ?? 0) + 1);
    if (t.size === 'L') errors.push(`task "${t.key}" is size L; split it into S/M tasks`);
    for (const d of t.dependsOn) {
      if (!keys.has(d)) errors.push(`task "${t.key}" depends on unknown task "${d}"`);
      if (d === t.key) errors.push(`task "${t.key}" depends on itself`);
    }
    for (const id of t.requirementIds) {
      if (!known.has(id)) errors.push(`task "${t.key}" references unknown requirement "${id}"`);
      else byRequirement[id]!.push(t.key);
    }
    if (!t.verify.includes('CHANGES_EXIST')) {
      errors.push(
        `task "${t.key}" must require CHANGES_EXIST verification (every planned task changes the repository)`,
      );
    }
  }
  for (const m of plan.milestones) {
    if (!milestoneUse.get(m.key)) errors.push(`milestone "${m.key}" has no tasks`);
  }
  const epicKeys = new Set<string>();
  for (const e of plan.epics ?? []) {
    if (epicKeys.has(e.key)) errors.push(`duplicate epic key "${e.key}"`);
    epicKeys.add(e.key);
  }
  for (const t of plan.tasks) {
    if (t.epic && !epicKeys.has(t.epic)) errors.push(`task "${t.key}" uses unknown epic "${t.epic}"`);
  }
  const uncovered = requirementIds.filter((id) => byRequirement[id]!.length === 0);
  for (const id of uncovered) errors.push(`requirement "${id}" is not implemented by any task`);

  const order = topologicalOrder(plan.tasks);
  if (order === null) errors.push('the task dependency graph contains a cycle');
  // A task may not depend on a task from a LATER milestone (milestones are delivery checkpoints in order).
  const mIndex = new Map(plan.milestones.map((m, i) => [m.key, i]));
  const taskMilestone = new Map(plan.tasks.map((t) => [t.key, t.milestone]));
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      const dm = taskMilestone.get(d);
      if (dm !== undefined && (mIndex.get(dm) ?? 0) > (mIndex.get(t.milestone) ?? 0)) {
        errors.push(
          `task "${t.key}" (milestone ${t.milestone}) depends on "${d}" from the later milestone ${dm}`,
        );
      }
    }
  }
  return { ...result(errors), coverage: { byRequirement, uncovered }, order };
}
