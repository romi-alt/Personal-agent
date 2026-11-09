import { afterEach, describe, expect, it } from 'vitest';
import { qaEvidenceKind } from '../../src/verification/types.js';
import { manualTaskPolicy } from '../../src/verification/task-policy.js';
import { makeEnv, settle, type TestEnv } from '../helpers/env.js';
import { reply } from '../helpers/plan-fixtures.js';

/** Owner decisions 2026-11-09 (Part 3 A and C) end to end through the real QA engine. */
let env: TestEnv;
afterEach(() => env?.cleanup());

const review = (defects: unknown[]) =>
  reply(
    JSON.stringify({
      criteria: [{ id: 'AC1', met: true, evidence: [{ file: 'src/fix.ts', line: 2 }], note: 'ok' }],
      defects,
      testsAssessment: 'ok',
    }),
  );
const unverified = { severity: 'high', description: 'possible auth bypass somewhere' };

async function run(reviews: unknown[]) {
  env = await makeEnv({
    env: { INDEPENDENT_REVIEW: 'true' },
    mock: {
      scenario: {
        tasks: {
          Correction: [{ type: 'success', writes: [{ file: 'src/fix.ts', content: '// a\n// b\n// c\n' }] }],
          ...Object.fromEntries(
            reviews.map((r, i) => [`Review: Correction${i ? ` (repair ${i})` : ''}`, [r]]),
          ),
        } as never,
      },
    },
  });
  const policy = manualTaskPolicy({ independentReview: true, criteria: 'the fix is applied', commands: {} });
  if (!policy.ok) throw new Error(policy.error);
  const t = env.store.enqueueTask({
    projectId: env.project.id,
    title: 'Correction',
    instructions: 'fix',
    acceptanceCriteria: 'the fix is applied',
    maxRetries: 2,
    verificationRequired: policy.verificationRequired,
  }).task;
  await settle(env);
  return t;
}

describe('NEEDS_EVIDENCE (A): an unverifiable high-severity finding never becomes a pass', () => {
  it('persisting without evidence -> escalated to the owner, never PASSED, no correction task', async () => {
    const t = await run([
      review([unverified]),
      review([unverified]),
      review([unverified]),
      review([unverified]),
    ]);
    const ev = env.store.listEvidence({ taskId: t.id, level: 'REQUIREMENTS_SATISFIED' });
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.status === 'NEEDS_EVIDENCE')).toBe(true);
    expect(env.qa.rows(t.id).map((r) => r.status)).toEqual(['ESCALATED']);
    const pending = env.store.listApprovals('PENDING').filter((a) => a.actionType === 'qa_escalation');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.description).toMatch(/without verifiable evidence \(NEEDS_EVIDENCE\)/);
    expect(env.store.listTasks({}).some((x) => x.title.startsWith('Fix: Correction'))).toBe(false);
    expect(env.store.listEvents({ taskId: t.id }).filter((e) => e.type === 'qa.needs_evidence').length).toBe(
      ev.length,
    );

    // C: if the owner accepts, it is recorded as OWNER_ACCEPTED - accepted, not verified.
    env.store.decideApproval(pending[0]!.id, 'APPROVED', 'owner');
    await settle(env);
    const last = env.store.listEvidence({ taskId: t.id, level: 'REQUIREMENTS_SATISFIED' }).at(-1)!;
    expect(last.status).toBe('OWNER_ACCEPTED');
    expect(qaEvidenceKind(last)).toBe('owner_accepted');
  });

  it('evidence supplied on request -> a confirmed defect FAILS the review and creates a correction', async () => {
    const confirmed = {
      ...unverified,
      reproduction: 'ran `npm test -- auth`: "expired token" case returned 200, expected 401',
    };
    const t = await run([review([unverified]), review([confirmed]), review([])]);
    const statuses = env.store
      .listEvidence({ taskId: t.id, level: 'REQUIREMENTS_SATISFIED' })
      .map((e) => e.status);
    expect(statuses.slice(0, 2)).toEqual(['NEEDS_EVIDENCE', 'FAILED']);
    expect(env.store.listTasks({}).some((x) => x.title === 'Fix: Correction (QA round 1)')).toBe(true);
  });

  it('legacy (v1) owner overrides recorded as PASSED+ownerOverride are read as owner-accepted, not verified', () => {
    expect(qaEvidenceKind({ status: 'PASSED', evidence: '{"ownerOverride":true}' })).toBe('owner_accepted');
    expect(qaEvidenceKind({ status: 'PASSED', evidence: { criteria: [] } })).toBe('verified');
    expect(qaEvidenceKind({ status: 'NEEDS_EVIDENCE', evidence: {} })).toBe('other');
  });
});
