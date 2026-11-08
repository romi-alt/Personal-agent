import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReview, type Criterion, type ReviewReply } from '../../src/engineering/qa.js';
import { resolvePlanOwners } from '../../src/planning/ownership.js';
import { planSchema } from '../../src/planning/schemas.js';
import { validatePlan } from '../../src/planning/validate-plan.js';
import { planObject } from '../helpers/plan-fixtures.js';

const repo = mkdtempSync(path.join(tmpdir(), 'qa-own-'));
writeFileSync(path.join(repo, 'a.ts'), 'one\ntwo\nthree\n');

const criteria: Criterion[] = [
  { id: 'AC1', text: 'endpoint works', scope: 'acceptance' },
  { id: 'FR-1', text: 'enrollment', scope: 'owned' },
];
const contributed = [{ id: 'NFR-4', text: 'UI states', ownerTaskId: 'tsk_web', ownerTitle: 'Web UI' }];
const reply = (over: Partial<ReviewReply> = {}): ReviewReply => ({
  criteria: [
    { id: 'AC1', met: true, evidence: [{ file: 'a.ts', line: 1 }], note: '' },
    { id: 'FR-1', met: true, evidence: [{ file: 'a.ts', line: 2 }], note: '' },
  ],
  defects: [],
  observations: [],
  testsAssessment: '',
  ...over,
});

describe('A1: checkReview distinguishes own criteria from requirements owned by other tasks', () => {
  it("normalizes a failure that cites only another task's requirement to PASS-with-notes", () => {
    const r = checkReview(
      reply({
        criteria: [
          ...reply().criteria,
          { id: 'NFR-4', met: false, evidence: [], note: 'no UI here', coveredBy: 'tsk_web' },
        ],
        defects: [{ severity: 'high', description: 'no loading states', criterionId: 'NFR-4' }],
      }),
      criteria,
      repo,
      contributed,
    );
    expect(r).toMatchObject({ passed: true, normalized: true, errors: [], unmet: [], blockingDefects: [] });
    expect(r.notes.map((n) => `${n.kind}:${n.id}:${n.coveredBy}`)).toEqual([
      'other_task_requirement:NFR-4:tsk_web',
      'other_task_requirement:NFR-4:tsk_web',
    ]);
  });

  it('still fails on an own acceptance criterion, an owned requirement, or a cited high-severity defect', () => {
    const unmetAc = checkReview(
      reply({ criteria: [{ ...reply().criteria[0]!, met: false }, reply().criteria[1]!] }),
      criteria,
      repo,
      contributed,
    );
    expect(unmetAc.passed).toBe(false);
    expect(unmetAc.unmet.map((u) => u.id)).toEqual(['AC1']);
    const missingOwned = checkReview(
      reply({ criteria: [reply().criteria[0]!, { ...reply().criteria[1]!, evidence: [] }] }),
      criteria,
      repo,
    );
    expect(missingOwned.unmet.map((u) => u.id)).toEqual(['FR-1']);
    for (const d of [
      { severity: 'high' as const, description: 'sql injection', criterionId: 'FR-1' },
      { severity: 'high' as const, description: 'sql injection', file: 'a.ts', line: 3 },
    ]) {
      const r = checkReview(reply({ defects: [d] }), criteria, repo, contributed);
      expect(r.passed, JSON.stringify(d)).toBe(false);
      expect(r.blockingDefects).toEqual([d]);
    }
  });

  it('a high-severity defect with neither an own criterion nor a valid citation is a note, not a failure', () => {
    const r = checkReview(
      reply({ defects: [{ severity: 'high', description: 'something somewhere' }] }),
      criteria,
      repo,
    );
    expect(r).toMatchObject({ passed: true, normalized: true });
    expect(r.notes[0]).toMatchObject({ kind: 'uncited_defect' });
  });

  it('unknown criterion ids are still reply errors (repair), and a clean pass is not "with notes"', () => {
    expect(
      checkReview(
        reply({ criteria: [...reply().criteria, { id: 'X-9', met: true, evidence: [], note: '' }] }),
        criteria,
        repo,
      ).errors,
    ).toEqual(['unknown criterion id "X-9"']);
    expect(checkReview(reply(), criteria, repo, contributed)).toMatchObject({
      passed: true,
      normalized: false,
      notes: [],
    });
  });
});

describe('A1: one owner task per requirement in the plan', () => {
  it('defaults the owner to the last linked task in order; an explicit ownsRequirementIds wins', () => {
    const tasks = [
      { key: 'T1', requirementIds: ['NFR-1', 'FR-1'] },
      { key: 'T2', requirementIds: ['NFR-1'] },
      { key: 'T3', requirementIds: ['NFR-1', 'FR-2'] },
    ];
    expect(Object.fromEntries(resolvePlanOwners(tasks))).toEqual({
      'NFR-1': 'T3',
      'FR-1': 'T1',
      'FR-2': 'T3',
    });
    tasks[1] = { ...tasks[1]!, ownsRequirementIds: ['NFR-1'] } as never;
    expect(resolvePlanOwners(tasks).get('NFR-1')).toBe('T2');
  });

  it('rejects an owner that does not link the requirement, and two owners for one requirement', () => {
    const p = planSchema.parse(planObject());
    p.tasks[0]!.ownsRequirementIds = ['FR-1'];
    p.tasks[1]!.ownsRequirementIds = ['FR-1'];
    const v = validatePlan(p, ['FR-1', 'FR-2', 'NFR-1', 'DR-1'], { maxTasks: 10 });
    expect(v.errors).toContain('task "T1" owns requirement "FR-1" but does not list it in requirementIds');
    expect(v.errors).toContain('requirement "FR-1" has more than one owner task ("T1", "T2")');
  });
});
