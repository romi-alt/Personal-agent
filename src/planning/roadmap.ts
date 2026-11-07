/**
 * Roadmap analytics over the dependency-aware task graph. Pure functions; inputs come from the database.
 *
 * Progress is counted ONLY from verified deliverables: a task counts as delivered when it is COMPLETED and every
 * verification level it requires has PASSED evidence. Model claims and task status alone never raise progress.
 */
export const SIZE_WEIGHT: Record<string, number> = { S: 1, M: 2, L: 4 };

export interface GraphTask {
  key: string;
  dependsOn: string[];
  size: string;
}

/** Longest weighted path through the DAG (the chain that bounds delivery time). Returns [] for a cyclic graph. */
export function criticalPath(tasks: GraphTask[]): { path: string[]; weight: number } {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const memo = new Map<string, { path: string[]; weight: number }>();
  const visiting = new Set<string>();
  const longest = (key: string): { path: string[]; weight: number } | null => {
    const hit = memo.get(key);
    if (hit) return hit;
    if (visiting.has(key)) return null; // cycle
    visiting.add(key);
    const t = byKey.get(key)!;
    let best = { path: [] as string[], weight: 0 };
    for (const d of t.dependsOn) {
      if (!byKey.has(d)) continue;
      const sub = longest(d);
      if (!sub) return null;
      if (sub.weight > best.weight) best = sub;
    }
    visiting.delete(key);
    const r = { path: [...best.path, key], weight: best.weight + (SIZE_WEIGHT[t.size] ?? 2) };
    memo.set(key, r);
    return r;
  };
  let best = { path: [] as string[], weight: 0 };
  for (const t of tasks) {
    const r = longest(t.key);
    if (!r) return { path: [], weight: 0 };
    if (r.weight > best.weight || (r.weight === best.weight && r.path.length > best.path.length)) best = r;
  }
  return best;
}

export interface ProgressTask {
  key: string;
  milestone: string;
  epic: string | null;
  size: string;
  status: string;
  /** Verification levels the task requires. */
  required: string[];
  /** Levels with PASSED evidence. */
  passed: string[];
}

export const isDelivered = (t: ProgressTask) =>
  t.status === 'COMPLETED' && t.required.every((l) => t.passed.includes(l));

export interface ProgressGroup {
  key: string;
  delivered: number;
  total: number;
  /** Delivered weight / total weight (size-weighted), 0..1. */
  ratio: number;
}

function group(tasks: ProgressTask[], by: (t: ProgressTask) => string | null): ProgressGroup[] {
  const m = new Map<string, ProgressTask[]>();
  for (const t of tasks) {
    const k = by(t);
    if (k) m.set(k, [...(m.get(k) ?? []), t]);
  }
  return [...m.entries()].map(([key, ts]) => {
    const total = ts.reduce((s, t) => s + (SIZE_WEIGHT[t.size] ?? 2), 0);
    const done = ts.filter(isDelivered).reduce((s, t) => s + (SIZE_WEIGHT[t.size] ?? 2), 0);
    return {
      key,
      delivered: ts.filter(isDelivered).length,
      total: ts.length,
      ratio: total ? done / total : 0,
    };
  });
}

export function progress(tasks: ProgressTask[]): {
  overall: ProgressGroup;
  milestones: ProgressGroup[];
  epics: ProgressGroup[];
} {
  return {
    overall: group(tasks, () => 'overall')[0] ?? { key: 'overall', delivered: 0, total: 0, ratio: 0 },
    milestones: group(tasks, (t) => t.milestone),
    epics: group(tasks, (t) => t.epic),
  };
}
