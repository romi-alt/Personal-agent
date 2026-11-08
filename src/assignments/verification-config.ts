import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../queue/store.js';
import { parseAssignment, type ProjectAssignment } from './schema.js';

/**
 * Verification commands after intake (A5, A7).
 *
 * v1 could set build/test commands only inside the original assignment; a project registered without them was stuck
 * at BUILD_PASSES/TESTS_PASS = NOT_CONFIGURED forever (the pilot needed `project:accept --acknowledge-unverified`).
 * Here every change is validated against the assignment schema and written in one transaction together with an
 * audit event (who, why, before, after). Only the owner-facing CLI calls this; coding workers are denied any agent
 * CLI invocation by the policy hook (src/security/policy.ts).
 */
export type VerificationCommands = ProjectAssignment['verification'];
export type CommandKey = 'buildCommand' | 'testCommand' | 'browserTestCommand';
export const COMMAND_KEYS: readonly CommandKey[] = ['buildCommand', 'testCommand', 'browserTestCommand'];

export class VerificationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationConfigError';
  }
}

export interface ChangeMeta {
  by: string;
  reason: string;
  source: 'owner' | 'derived';
}

const NPM_DEFAULT_TEST = /no test specified/i;
const BROWSER_SCRIPTS = ['test:browser', 'test:e2e', 'e2e', 'test:playwright'];

/** Commands implied by the project's package.json scripts (A5). Empty when there is no usable script. */
export function deriveVerificationCommands(repoPath: string): Partial<Record<CommandKey, string>> {
  const pkg = path.join(repoPath, 'package.json');
  if (!existsSync(pkg)) return {};
  let scripts: Record<string, unknown> = {};
  try {
    const j = JSON.parse(readFileSync(pkg, 'utf8').replace(/^\uFEFF/, '')) as {
      scripts?: Record<string, unknown>;
    };
    scripts = j.scripts ?? {};
  } catch {
    return {};
  }
  const has = (k: string) => typeof scripts[k] === 'string' && (scripts[k] as string).trim() !== '';
  const out: Partial<Record<CommandKey, string>> = {};
  if (has('build')) out.buildCommand = 'npm run build';
  if (has('test') && !NPM_DEFAULT_TEST.test(scripts['test'] as string)) out.testCommand = 'npm test';
  const browser = BROWSER_SCRIPTS.find(has);
  if (browser) out.browserTestCommand = `npm run ${browser}`;
  return out;
}

/**
 * Set (string) or clear (null) verification commands. Throws when the project has no assignment, nothing changes,
 * or the result does not validate. Returns the before/after commands.
 */
export function setVerificationCommands(
  store: Store,
  projectId: string,
  changes: Partial<Record<CommandKey, string | null>>,
  meta: ChangeMeta,
): { before: VerificationCommands; after: VerificationCommands } {
  if (!meta.by.trim()) throw new VerificationConfigError('--by is required (who authorised the change)');
  if (!meta.reason.trim())
    throw new VerificationConfigError('--reason is required (recorded in the audit log)');
  return store.db
    .transaction(() => {
      const data = store.getAssignmentData(projectId);
      if (!data)
        throw new VerificationConfigError(
          `project ${projectId} has no registered assignment; register one (intake / assignment:add) first`,
        );
      const current = parseAssignment(data);
      const before = { ...current.verification };
      const after: Record<string, string> = { ...before } as Record<string, string>;
      for (const k of COMMAND_KEYS) {
        const v = changes[k];
        if (v === undefined) continue;
        if (v === null || v.trim() === '') delete after[k];
        else after[k] = v.trim();
      }
      if (COMMAND_KEYS.every((k) => (before[k] ?? null) === (after[k] ?? null)))
        throw new VerificationConfigError(
          'no change: the verification commands are already set to these values',
        );
      const next = parseAssignment({ ...(data as Record<string, unknown>), verification: after });
      const version = (
        store.db
          .prepare('SELECT schema_version AS v FROM assignments WHERE project_id = ?')
          .get(projectId) as { v: number } | undefined
      )?.v;
      store.saveAssignment(projectId, version ?? 1, next as unknown as Record<string, unknown>);
      store.recordEvent({
        type: 'assignment.verification_changed',
        projectId,
        severity: 'info',
        payload: { by: meta.by, reason: meta.reason, source: meta.source, before, after: next.verification },
      });
      return { before, after: next.verification };
    })
    .immediate();
}

/**
 * If the assignment configures no command at all, derive them from package.json and persist them (audited,
 * source "derived"). Returns the derived commands, or null when nothing was derived.
 */
export function ensureDerivedCommands(
  store: Store,
  projectId: string,
  repoPath: string,
  by: string,
): Partial<Record<CommandKey, string>> | null {
  const data = store.getAssignmentData(projectId);
  if (!data) return null;
  const v = parseAssignment(data).verification;
  if (COMMAND_KEYS.some((k) => v[k])) return null;
  // An owner decision (including clearing every command) is never overridden by derivation (v2 review).
  const ownerDecided = store
    .listEvents({ projectId })
    .some((e) => e.type === 'assignment.verification_changed' && e.payload['source'] === 'owner');
  if (ownerDecided) return null;
  const derived = deriveVerificationCommands(repoPath);
  if (!Object.keys(derived).length) return null;
  setVerificationCommands(store, projectId, derived, {
    by,
    reason: 'no verification commands configured; derived from package.json scripts',
    source: 'derived',
  });
  return derived;
}
