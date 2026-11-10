/**
 * Task capability model (V2.1 trusted-execution). A capability grant is the full set of authority a single task's
 * worker has. It is DEFAULT-DENY: anything not listed is refused. It is task-scoped and non-inheritable: each task
 * gets a fresh grant derived from its assignment, never from another task.
 *
 * SCOPE: application-level. The broker consults a grant before authorizing an action; the OS worker identity (admin
 * scripts) is what stops a worker from reaching beyond the grant by running its own code.
 */

export type FileOp = 'read' | 'write' | 'delete';

export interface NetworkCapability {
  /** Outbound hosts the worker's documented tools may reach. Empty => no network. */
  allowedHosts: string[];
  /** Loopback (127.0.0.1/::1) allowed. Default false. */
  loopback: boolean;
}

export interface ResourceLimits {
  maxProcesses: number;
  maxMemoryMb: number;
  maxWallSeconds: number;
}

export interface Capability {
  /** The one project this grant authorizes. */
  projectId: string;
  taskId: string;
  /** Logical worker identity (OS SID once separation exists). */
  workerId: string;
  /** Directories the worker may touch, with the operations allowed in each (default-deny outside these). */
  directories: { path: string; ops: FileOp[] }[];
  /** Executable base names the worker may launch (lower-case, no extension). Empty => none beyond the provider. */
  executables: string[];
  network: NetworkCapability;
  limits: ResourceLimits;
  /** Integration systems (e.g. 'erp') the task may read. */
  integrations: string[];
  /** Approval categories pre-authorized for this task (still require a bound, single-use approval to execute). */
  approvalCategories: string[];
  /** Absolute expiry (epoch ms). After this, the grant authorizes nothing. */
  expiresAt: number;
  /** Policy version the grant was derived under. */
  policyVersion: string;
}

export interface CapabilityDecision {
  allow: boolean;
  reason: string;
}

const DENY = (reason: string): CapabilityDecision => ({ allow: false, reason });
const ALLOW = (reason: string): CapabilityDecision => ({ allow: true, reason });

/** Lexical containment without touching the filesystem (the OS ACL is the real check; this is the model's view). */
function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Is a file operation within this grant? `resolvedPath` must already be the real, canonical path (symlinks/junctions
 * resolved) so a link cannot smuggle access past the lexical check.
 */
export function canAccessPath(
  cap: Capability,
  resolvedPath: string,
  op: FileOp,
  now: number,
): CapabilityDecision {
  if (now >= cap.expiresAt) return DENY('capability grant has expired');
  for (const d of cap.directories)
    if (isInside(resolvedPath, d.path))
      return d.ops.includes(op)
        ? ALLOW(`${op} permitted in ${d.path}`)
        : DENY(`${op} not permitted in ${d.path} (allowed: ${d.ops.join(',') || 'none'})`);
  return DENY(`path is outside every permitted directory`);
}

export function canRunExecutable(cap: Capability, exe: string, now: number): CapabilityDecision {
  if (now >= cap.expiresAt) return DENY('capability grant has expired');
  const base = (exe.split(/[\\/]/).pop() ?? exe).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
  return cap.executables.includes(base)
    ? ALLOW(`executable ${base} permitted`)
    : DENY(`executable ${base} not in the task's allow-list`);
}

export function canReachHost(cap: Capability, host: string, now: number): CapabilityDecision {
  if (now >= cap.expiresAt) return DENY('capability grant has expired');
  const h = host.toLowerCase();
  if (h === '127.0.0.1' || h === '::1' || h === 'localhost')
    return cap.network.loopback ? ALLOW('loopback permitted') : DENY('loopback not permitted');
  return cap.network.allowedHosts.map((x) => x.toLowerCase()).includes(h)
    ? ALLOW(`host ${h} permitted`)
    : DENY(`host ${h} not in the task's allow-list`);
}

export function requiresApproval(cap: Capability, category: string): CapabilityDecision {
  return cap.approvalCategories.includes(category)
    ? ALLOW(`category ${category} is pre-authorized for this task (bound approval still required)`)
    : DENY(`category ${category} is not permitted for this task`);
}

/**
 * Build a fresh grant for a task. Non-inheritable by construction: the inputs are the task's own project, workspace
 * and assignment; nothing from another task is read. Conservative defaults: one workspace dir, no network beyond
 * loopback-off, one process class, short expiry.
 */
export function deriveCapability(input: {
  projectId: string;
  taskId: string;
  workerId: string;
  workspaceDir: string;
  tempDir: string;
  readOnlyRefs?: string[];
  executables?: string[];
  allowedHosts?: string[];
  loopback?: boolean;
  integrations?: string[];
  approvalCategories?: string[];
  policyVersion: string;
  now: number;
  ttlMs?: number;
  limits?: Partial<ResourceLimits>;
}): Capability {
  return {
    projectId: input.projectId,
    taskId: input.taskId,
    workerId: input.workerId,
    directories: [
      { path: input.workspaceDir, ops: ['read', 'write', 'delete'] },
      { path: input.tempDir, ops: ['read', 'write', 'delete'] },
      ...(input.readOnlyRefs ?? []).map((p) => ({ path: p, ops: ['read'] as FileOp[] })),
    ],
    executables: input.executables ?? [],
    network: { allowedHosts: input.allowedHosts ?? [], loopback: input.loopback ?? false },
    limits: {
      maxProcesses: input.limits?.maxProcesses ?? 32,
      maxMemoryMb: input.limits?.maxMemoryMb ?? 2048,
      maxWallSeconds: input.limits?.maxWallSeconds ?? 1800,
    },
    integrations: input.integrations ?? [],
    approvalCategories: input.approvalCategories ?? [],
    expiresAt: input.now + (input.ttlMs ?? 60 * 60 * 1000),
    policyVersion: input.policyVersion,
  };
}
