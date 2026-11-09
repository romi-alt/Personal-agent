/**
 * Canonical serialization and action binding for the trusted approval broker (V2.1 trusted-execution).
 *
 * The point of this module: two descriptions of "the same action" must produce the SAME fingerprint, and any
 * meaningful change (argument, target, worker, policy version) must produce a DIFFERENT one. An approval is then
 * bound to a fingerprint, so a worker cannot get one action approved and run another.
 *
 * SCOPE: this is an application-level control. It binds an approval to an action description that the SUPERVISOR
 * computed from the worker's request; it does not, by itself, stop a worker that runs code under the owner's Windows
 * identity from editing the broker's state. OS identity separation (design + admin scripts) is what makes it a
 * boundary. See docs TRUSTED_APPROVAL_BROKER.md.
 */
import { createHash } from 'node:crypto';

/** A JSON value with object keys in a stable order; the basis for a reproducible hash. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort())
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  return out;
}

/** Deterministic JSON string: sorted keys, no incidental whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The action an approval authorizes. Every field is part of the binding: change any of them and the fingerprint
 * changes, which invalidates a previously granted approval.
 */
export interface BoundAction {
  /** Approval category (policy.ts), e.g. 'protected_branch_push'. */
  category: string;
  /** Tool the action runs through, e.g. 'Bash'. */
  tool: string;
  /** Canonical arguments the supervisor derived from the request (e.g. the normalized command). */
  canonicalArgs: Record<string, unknown>;
  /** Target resource when applicable (a repo+branch, a URL host, a file path), else null. */
  target: string | null;
  /** The worker's identity (OS SID once separation exists; a logical id meanwhile). */
  workerId: string;
  /** Task, project and execution the action belongs to. */
  taskId: string;
  projectId: string;
  executionId: string;
  /** Working directory the action runs in. */
  cwd: string;
  /** Policy version in force; a policy change invalidates in-flight approvals. */
  policyVersion: string;
}

/** The stable fingerprint of a bound action. Two equal actions hash equally; any change diverges. */
export function actionFingerprint(a: BoundAction): string {
  // canonicalArgs is canonicalized recursively; the rest are scalars pinned in a fixed shape.
  return sha256Hex(
    canonicalJson({
      category: a.category,
      tool: a.tool,
      canonicalArgs: a.canonicalArgs,
      target: a.target,
      workerId: a.workerId,
      taskId: a.taskId,
      projectId: a.projectId,
      executionId: a.executionId,
      cwd: a.cwd,
      policyVersion: a.policyVersion,
    }),
  );
}

/**
 * Derive the canonical arguments for a tool request. Keeps only what defines the action's effect, so cosmetic
 * differences (extra whitespace) do not force re-approval while meaningful ones do. The command is normalized through
 * the same shell analyzer the policy uses, so `git  push   origin main` and `git push origin main` bind equally, but
 * `git push origin main` and `git push --force origin main` do not.
 */
export function canonicalArgsFor(
  tool: string,
  input: Record<string, unknown>,
  normalize: (command: string) => string,
): Record<string, unknown> {
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input['command'] === 'string')
    return { command: normalize(input['command'] as string) };
  // File tools: the path is the effect-defining argument.
  for (const key of ['file_path', 'notebook_path', 'path'])
    if (typeof input[key] === 'string') return { [key]: input[key] };
  // Fallback: the whole input, canonicalized.
  return canonicalize(input) as Record<string, unknown>;
}
