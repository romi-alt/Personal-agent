import { afterEach, describe, expect, it } from 'vitest';
import { registerAssignment } from '../../src/assignments/register.js';
import { reconcileProjectStatus } from '../../src/planning/status-reconcile.js';
import { assignmentExample } from '../helpers/assignment.js';
import { makeEnv, settle, type TestEnv } from '../helpers/env.js';
import { happyPlanning, planJson, reply } from '../helpers/plan-fixtures.js';

/**
 * A1: the independent reviewer must not fail a task on a cross-cutting requirement that another task owns.
 * NFR-1 (role based access) is linked to T1 AND T2 here; T2 (the last linked task) owns it, T1 only contributes.
 */
let env: TestEnv;
afterEach(() => env?.cleanup());

const QA = { PLAN_APPROVAL: 'auto', INDEPENDENT_REVIEW: 'true' };
const code = (file: string, lines = 6) => ({
  type: 'success' as const,
  writes: [{ file, content: Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join('\n') + '\n' }],
});
const verdict = (criteria: [string, boolean, string?, number?][], defects: unknown[] = []) =>
  reply(
    JSON.stringify({
      criteria: criteria.map(([id, met, file, line]) => ({
        id,
        met,
        evidence: file ? [{ file, line: line ?? 1 }] : [],
        note: met ? 'ok' : 'not implemented by this task',
      })),
      defects,
      testsAssessment: 'tests reviewed',
    }),
  );
const crossCuttingPlan = () =>
  reply(
    planJson((p) => {
      p.tasks[1]!.requirementIds = ['FR-1', 'DR-1', 'NFR-1'];
    }),
  );

describe('A1: QA judges a task only on its own criteria and the requirements it owns', () => {
  it('a review whose failures cite only requirements owned by another task creates no correction task; a genuine failure of an own criterion still does', async () => {
    env = await makeEnv({
      env: QA,
      mock: {
        scenario: {
          tasks: {
            ...happyPlanning(),
            'Plan: decompose': [crossCuttingPlan()],
            'Scaffold project and auth': [code('src/auth.ts')],
            // Mis-mapped failure: NFR-1 is owned by "Enrollment module"; plus a high defect attributed to it.
            'Review: Scaffold project and auth': [
              verdict(
                [
                  ['AC1', true, 'src/auth.ts', 2],
                  ['AC2', true, 'src/auth.ts', 3],
                  ['NFR-1', false],
                ],
                [{ severity: 'high', description: 'no RBAC on enrollment routes yet', criterionId: 'NFR-1' }],
              ),
            ],
            // v2 NEEDS_EVIDENCE: the uncited high finding is sent back for evidence; the reviewer withdraws it.
            'Review: Scaffold project and auth (repair 1)': [
              verdict([
                ['AC1', true, 'src/auth.ts', 2],
                ['AC2', true, 'src/auth.ts', 3],
                ['NFR-1', false],
              ]),
            ],
            'Enrollment module': [code('src/enroll.ts')],
            'Review: Enrollment module': [
              verdict([
                ['AC1', true, 'src/enroll.ts', 1],
                ['FR-1', true, 'src/enroll.ts', 2],
                ['DR-1', true, 'src/enroll.ts', 3],
                ['NFR-1', true, 'src/enroll.ts', 4],
              ]),
            ],
            'Attendance module': [code('src/attendance.ts')],
            // Genuine failure of the task's own acceptance criterion.
            'Review: Attendance module': [
              verdict([
                ['AC1', false],
                ['FR-2', true, 'src/attendance.ts', 1],
              ]),
            ],
            'Fix: Attendance module (QA round 1)': [code('src/attendance-fix.ts')],
            'Review: Attendance module (round 2)': [
              verdict([
                ['AC1', true, 'src/attendance-fix.ts', 1],
                ['FR-2', true, 'src/attendance.ts', 1],
              ]),
            ],
          } as never,
        },
      },
    });
    const { project } = await registerAssignment(env.store, env.registry, 'mock', assignmentExample());
    env.workflows.startPlanning(project.id);
    await settle(env);

    const tasks = env.store.listTasks({ projectId: project.id });
    const scaffold = tasks.find((t) => t.title === 'Scaffold project and auth')!;
    const enroll = tasks.find((t) => t.title === 'Enrollment module')!;
    const attendance = tasks.find((t) => t.title === 'Attendance module')!;

    // Ownership persisted at materialisation: the last linked task owns the cross-cutting requirement.
    const owner = env.store.db
      .prepare("SELECT owner_task_id FROM requirements WHERE project_id = ? AND req_id = 'NFR-1'")
      .get(project.id) as { owner_task_id: string };
    expect(owner.owner_task_id).toBe(enroll.id);

    // The reviewer got the ownership map and NFR-1 only as an informational, contributed requirement.
    const rp = env.mock!.runs.find((r) => r.taskTitle === 'Review: Scaffold project and auth')!.prompt;
    expect(rp).toContain('Project requirements this task only CONTRIBUTES to');
    expect(rp).toMatch(/\[NFR-1\] Role based access - owned by tsk_\w+ "Enrollment module"/);
    const mustPass = rp.slice(rp.indexOf('MUST PASS'), rp.indexOf('only CONTRIBUTES'));
    expect(mustPass).not.toContain('[NFR-1]');
    // ...while the owner's review must judge it.
    const ep = env.mock!.runs.find((r) => r.taskTitle === 'Review: Enrollment module')!.prompt;
    expect(ep.slice(ep.indexOf('OWNED by this task'), ep.indexOf('## Requirement -> owning'))).toContain(
      '[NFR-1]',
    );

    // Mis-mapped failure: PASSED with notes, no correction, no escalation.
    expect(tasks.some((t) => t.title.startsWith('Fix: Scaffold project and auth'))).toBe(false);
    expect(env.qa.rows(scaffold.id).map((r) => r.status)).toEqual(['PASSED']);
    const r1 = env.qa.result(scaffold.id, 1)!;
    expect(r1['passedWithNotes']).toBe(true);
    expect(r1['unmet']).toEqual([]);
    expect(
      (r1['notes'] as { id: string; coveredBy: string | null }[]).map((n) => `${n.id}:${n.coveredBy}`),
    ).toEqual([`NFR-1:${enroll.id}`]);
    // v2: the uncited high finding was NEEDS_EVIDENCE first (never a pass), the reviewer was asked for evidence and
    // withdrew it; only then did the round pass (with notes).
    const ev = env.store.listEvidence({ taskId: scaffold.id, level: 'REQUIREMENTS_SATISFIED' });
    expect(ev.map((e) => e.status)).toEqual(['NEEDS_EVIDENCE', 'PASSED']);
    expect(ev.at(-1)!.summary).toMatch(/passed with notes/);
    const repairPrompt = env.mock!.runs.find(
      (r) => r.taskTitle === 'Review: Scaffold project and auth (repair 1)',
    )!.prompt;
    expect(repairPrompt).toMatch(/without verifiable evidence: "no RBAC on enrollment routes yet"/);
    expect(env.store.listApprovals('PENDING').filter((a) => a.actionType === 'qa_escalation')).toEqual([]);

    // Genuine failure of the task's own criterion: a correction task, then a passing round 2.
    expect(tasks.some((t) => t.title === 'Fix: Attendance module (QA round 1)')).toBe(true);
    expect(env.qa.rows(attendance.id).map((r) => `${r.round}:${r.status}`)).toEqual(['1:FAILED', '2:PASSED']);
    expect((env.qa.result(attendance.id, 1)!['unmet'] as { id: string }[]).map((u) => u.id)).toEqual(['AC1']);

    // A4 wiring: statuses were maintained as tasks/reviews changed (no manual reconcile call). "Enrollment module"
    // requires TESTS_PASS, which this project has no command for (NOT_CONFIGURED): its requirements are REVIEWED
    // (independent review passed) but not VERIFIED. "Attendance module" only requires CHANGES_EXIST: VERIFIED.
    expect(env.store.listEvidence({ taskId: enroll.id, level: 'TESTS_PASS' }).at(-1)?.status).toBe(
      'NOT_CONFIGURED',
    );
    expect(env.workflows.repo.listRequirements(project.id).map((r) => `${r.id}:${r.status}`)).toEqual([
      'FR-1:REVIEWED',
      'FR-2:VERIFIED',
      'NFR-1:REVIEWED',
      'DR-1:REVIEWED',
    ]);
    expect(env.workflows.repo.listMilestones(project.id).map((m) => `${m.key}:${m.status}`)).toEqual([
      'M1:REVIEWED',
      'M2:REVIEWED',
    ]);
    // Reconciling again changes nothing (idempotent).
    expect(reconcileProjectStatus(env.store.db, project.id).changes).toEqual([]);
  });
});
