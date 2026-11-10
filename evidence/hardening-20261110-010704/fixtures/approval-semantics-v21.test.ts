/**
 * V2.1 Phase E: approval lifecycle through the real supervisor/runner (mock-free provider that records what the
 * runner grants). Characterizes CURRENT behaviour, including the documented gaps (no expiry, no argument binding).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { drain, makeEnv, type TestEnv } from '../helpers/env.js';
import { decideApproval } from '../../src/control/owner-actions.js';
import type {
  ExecutionProvider,
  PermissionDenial,
  RunOutcome,
  RunRequest,
} from '../../src/providers/types.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

/** Each run: record the granted categories; deny with `denial` until it has been granted, then complete. */
function recordingProvider(denials: Record<string, PermissionDenial[]>) {
  const seen: { title: string; approved: string[] }[] = [];
  const provider: ExecutionProvider = {
    name: 'mock',
    preflight: async () => ({ ready: true, detail: 'synthetic', missing: [], local: true }),
    run: async (req: RunRequest): Promise<RunOutcome> => {
      seen.push({ title: req.taskTitle, approved: [...req.approvedActionTypes].sort() });
      const wanted = (denials[req.taskTitle] ?? []).filter(
        (d) => !d.approvalType || !req.approvedActionTypes.includes(d.approvalType),
      );
      if (wanted.length)
        return {
          kind: 'failed',
          failure: { errorClass: 'PERMISSION_DENIED', message: 'tool call denied by policy' },
          denials: wanted,
        };
      return { kind: 'completed', summary: 'done' };
    },
  };
  return { provider, seen };
}
const owner = { by: 'owner-test', channel: 'cli' as const };
const push: PermissionDenial = {
  tool: 'Bash',
  reason: 'Pushing to a remote / protected branch requires owner approval',
  approvalType: 'protected_branch_push',
  input: { command: 'git push origin feature/x' },
};
const del: PermissionDenial = {
  tool: 'Bash',
  reason: 'Deleting substantial data requires owner approval',
  approvalType: 'destructive_delete',
  input: { command: 'rm -rf build' },
};

describe('V2.1 Phase E: approval lifecycle', () => {
  it('two categories in one run => two approvals; approving only one keeps the task waiting', async () => {
    const { provider, seen } = recordingProvider({ A: [push, del] });
    env = await makeEnv({ provider });
    const a = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'A',
      instructions: 'x',
      maxRetries: 3,
    }).task;
    await drain(env);
    expect(env.store.requireTask(a.id).status).toBe('WAITING_FOR_APPROVAL');
    const pending = env.store.listApprovals('PENDING');
    expect(pending.map((p) => p.actionType).sort()).toEqual(['destructive_delete', 'protected_branch_push']);
    decideApproval(
      env.store,
      pending.find((p) => p.actionType === 'protected_branch_push')!.id,
      'APPROVED',
      owner,
    );
    expect(env.store.requireTask(a.id).status).toBe('WAITING_FOR_APPROVAL'); // one still open
    decideApproval(
      env.store,
      pending.find((p) => p.actionType === 'destructive_delete')!.id,
      'APPROVED',
      owner,
    );
    expect(env.store.requireTask(a.id).status).toBe('READY');
    await drain(env);
    expect(seen.at(-1)!.approved).toEqual(['destructive_delete', 'protected_branch_push']);
  });

  it('a denial blocks the task; a decided approval cannot be decided again (no replay of the decision)', async () => {
    const { provider } = recordingProvider({ A: [push] });
    env = await makeEnv({ provider });
    const a = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'A',
      instructions: 'x',
      maxRetries: 3,
    }).task;
    await drain(env);
    const [p] = env.store.listApprovals('PENDING');
    decideApproval(env.store, p!.id, 'DENIED', owner);
    expect(env.store.requireTask(a.id).status).toBe('BLOCKED');
    expect(() => decideApproval(env!.store, p!.id, 'APPROVED', owner)).toThrow(/already decided/);
  });

  it('approvals are task-scoped: an approval for task A is not granted to task B', async () => {
    const { provider, seen } = recordingProvider({ A: [push], B: [] });
    env = await makeEnv({ provider });
    env.store.enqueueTask({ projectId: env.project.id, title: 'A', instructions: 'x', maxRetries: 3 });
    await drain(env);
    decideApproval(env.store, env.store.listApprovals('PENDING')[0]!.id, 'APPROVED', owner);
    env.store.enqueueTask({ projectId: env.project.id, title: 'B', instructions: 'y', maxRetries: 3 });
    await drain(env);
    expect(seen.filter((s) => s.title === 'B').every((s) => s.approved.length === 0)).toBe(true);
    expect(seen.filter((s) => s.title === 'A').at(-1)!.approved).toEqual(['protected_branch_push']);
  });

  it('GAP (documented): an approval never expires and is re-granted to every later execution of the task', async () => {
    const { provider, seen } = recordingProvider({ A: [push] });
    env = await makeEnv({ provider });
    const a = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'A',
      instructions: 'x',
      maxRetries: 3,
    }).task;
    await drain(env);
    decideApproval(env.store, env.store.listApprovals('PENDING')[0]!.id, 'APPROVED', owner);
    env.clock.advance(30 * 24 * 3600 * 1000); // 30 days later
    await drain(env);
    expect(env.store.requireTask(a.id).status).not.toBe('WAITING_FOR_APPROVAL');
    expect(seen.at(-1)!.approved).toEqual(['protected_branch_push']);
  });

  it('a hard-denied call (no category) becomes a tool:<name> approval that unlocks nothing', async () => {
    const hard: PermissionDenial = {
      tool: 'Bash',
      reason: 'credential read (class K)',
      input: { command: 'printenv' },
    };
    const { provider, seen } = recordingProvider({ A: [hard] });
    env = await makeEnv({ provider });
    env.store.enqueueTask({ projectId: env.project.id, title: 'A', instructions: 'x', maxRetries: 3 });
    await drain(env);
    const [p] = env.store.listApprovals('PENDING');
    expect(p!.actionType).toBe('tool:Bash');
    decideApproval(env.store, p!.id, 'APPROVED', owner);
    await drain(env);
    // The granted string is not a policy category: evaluateToolUse still hard-denies (tests/unit/phase-bde-v21).
    expect(seen.at(-1)!.approved).toEqual(['tool:Bash']);
  });
});
