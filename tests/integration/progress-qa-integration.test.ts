import { afterEach, describe, expect, it } from 'vitest';
import { computeProgress } from '../../src/progress/model.js';
import { drain, makeEnv, type TestEnv } from '../helpers/env.js';

/**
 * v2/main integration: stage 5's evidence-based progress must honour the v2 QA rules (owner decision C).
 * A task that requires the independent review is VERIFIED only after an independent PASS; owner acceptance
 * (OWNER_ACCEPTED, or legacy PASSED + ownerOverride) and NEEDS_EVIDENCE are "not proven"; a FAILED review fails.
 */
let env: TestEnv;
afterEach(() => env?.cleanup());

async function completedTask() {
  env = await makeEnv();
  const t = env.store.enqueueTask({
    projectId: env.project.id,
    kind: 'CODING',
    title: 'build',
    instructions: 'b',
    acceptanceCriteria: 'x',
    maxRetries: 1,
    verificationRequired: ['CHANGES_EXIST', 'REQUIREMENTS_SATISFIED'],
  }).task;
  await drain(env);
  expect(env.store.getTask(t.id)!.status).toBe('COMPLETED');
  return t;
}
const qa = (taskId: string, status: string, evidence: Record<string, unknown> = {}) =>
  env.store.addEvidence({
    projectId: env.project.id,
    taskId,
    level: 'REQUIREMENTS_SATISFIED',
    status: status as never,
    summary: 'review',
    evidence,
  });
const state = (taskId: string) =>
  computeProgress(env.store, env.workflows.repo, env.project.id).tasks.find((x) => x.taskId === taskId)!;

describe('progress x independent QA (integration of stage 5 with v2)', () => {
  it('no review yet: CLAIMED, not VERIFIED (CHANGES_EXIST alone is not enough)', async () => {
    const t = await completedTask();
    expect(state(t.id).verification).toBe('CLAIMED');
    expect(state(t.id).note).toMatch(/REQUIREMENTS_SATISFIED=MISSING/);
  });

  it('independent PASS: VERIFIED', async () => {
    const t = await completedTask();
    qa(t.id, 'PASSED');
    expect(state(t.id).verification).toBe('VERIFIED');
  });

  it('owner acceptance (v2 and legacy) and NEEDS_EVIDENCE are never VERIFIED', async () => {
    const t = await completedTask();
    qa(t.id, 'OWNER_ACCEPTED', { ownerOverride: true });
    expect(state(t.id)).toMatchObject({ verification: 'CLAIMED' });
    expect(state(t.id).note).toMatch(/REQUIREMENTS_SATISFIED=OWNER_ACCEPTED/);
    qa(t.id, 'PASSED', { ownerOverride: true }); // v1-era row shape
    expect(state(t.id).verification).toBe('CLAIMED');
    qa(t.id, 'NEEDS_EVIDENCE');
    expect(state(t.id).verification).toBe('CLAIMED');
  });

  it('a FAILED review is FAILED_VERIFICATION', async () => {
    const t = await completedTask();
    qa(t.id, 'FAILED');
    expect(state(t.id).verification).toBe('FAILED_VERIFICATION');
  });
});
