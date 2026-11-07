import { afterEach, describe, expect, it } from 'vitest';
import { registerAssignment } from '../../src/assignments/register.js';
import { verifyProject } from '../../src/verification/service.js';
import { assignmentExample } from '../helpers/assignment.js';
import { makeEnv, settle, type TestEnv } from '../helpers/env.js';
import { happyPlanning, reply } from '../helpers/plan-fixtures.js';

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
        note: met ? 'ok' : 'missing',
      })),
      defects,
      testsAssessment: 'tests reviewed',
    }),
  );

const coding = (projectId: string) => env.store.listTasks({ projectId }).filter((t) => t.kind === 'CODING');

describe('Phase 3: independent QA of completed tasks', () => {
  it('reviews every task in a separate read-only session, corrects failures, and gates dependants on the review', async () => {
    env = await makeEnv({
      env: QA,
      mock: {
        scenario: {
          tasks: {
            ...happyPlanning(),
            'Scaffold project and auth': [code('src/auth.ts')],
            'Enrollment module': [code('src/enroll.ts')],
            'Fix: Enrollment module (QA round 1)': [code('src/enroll-validation.ts', 3)],
            'Attendance module': [code('src/attendance.ts')],
            'Review: Scaffold project and auth': [
              verdict([
                ['AC1', true, 'src/auth.ts', 2],
                ['AC2', true, 'src/auth.ts', 3],
                ['NFR-1', true, 'src/auth.ts', 5],
              ]),
            ],
            'Review: Enrollment module': [
              verdict(
                [
                  ['AC1', false],
                  ['FR-1', true, 'src/enroll.ts', 1],
                  ['DR-1', true, 'src/enroll.ts', 2],
                ],
                [{ severity: 'medium', description: 'no input validation', file: 'src/enroll.ts', line: 4 }],
              ),
            ],
            'Review: Enrollment module (round 2)': [
              verdict([
                ['AC1', true, 'src/enroll-validation.ts', 2],
                ['FR-1', true, 'src/enroll.ts', 1],
                ['DR-1', true, 'src/enroll.ts', 2],
              ]),
            ],
            // Claims "met" but cites a file that does not exist: code rejects it, a correction follows.
            'Review: Attendance module': [
              verdict([
                ['AC1', true, 'src/does-not-exist.ts', 1],
                ['FR-2', true, 'src/attendance.ts', 99],
              ]),
            ],
            'Fix: Attendance module (QA round 1)': [code('src/attendance-report.ts')],
            'Review: Attendance module (round 2)': [
              verdict([
                ['AC1', true, 'src/attendance-report.ts', 2],
                ['FR-2', true, 'src/attendance.ts', 3],
              ]),
            ],
          } as never,
        },
      },
    });
    const { project } = await registerAssignment(env.store, env.registry, 'mock', assignmentExample());
    env.workflows.startPlanning(project.id);
    await settle(env);

    const order = env
      .mock!.runs.filter((r) => !r.taskTitle.startsWith('Plan:'))
      .map((r) => `${r.taskTitle}${r.readOnly ? ' [ro]' : ''}`);
    expect(order).toEqual([
      'Scaffold project and auth',
      'Review: Scaffold project and auth [ro]',
      'Enrollment module',
      'Review: Enrollment module [ro]',
      'Fix: Enrollment module (QA round 1)',
      'Review: Enrollment module (round 2) [ro]',
      'Attendance module', // depends on Enrollment: only claimable once its review PASSED
      'Review: Attendance module [ro]',
      'Fix: Attendance module (QA round 1)',
      'Review: Attendance module (round 2) [ro]',
    ]);
    // The review prompt contained the actual diff and the criteria, never the implementer's reasoning
    const rp = env.mock!.runs.find((r) => r.taskTitle === 'Review: Enrollment module')!.prompt;
    expect(rp).toContain('INDEPENDENT QA reviewer');
    expect(rp).toContain('[AC1] enroll endpoint works');
    expect(rp).toContain('src/enroll.ts');
    // Correction prompt carries the unmet criterion and the defect location
    const fp = env.mock!.runs.find((r) => r.taskTitle === 'Fix: Enrollment module (QA round 1)')!.prompt;
    expect(fp).toContain('[AC1] enroll endpoint works');
    expect(fp).toContain('no input validation at src/enroll.ts:4');
    // Fabricated citation was not accepted
    const attendance = coding(project.id).find((t) => t.title === 'Attendance module')!;
    const r1 = env.qa.result(attendance.id, 1)!;
    expect((r1['unmet'] as { id: string; reason: string }[]).map((u) => `${u.id}:${u.reason}`)).toEqual([
      'AC1:claimed met without a valid file:line citation in the repository',
      'FR-2:claimed met without a valid file:line citation in the repository',
    ]);
    // Evidence: every original task ends with a PASSED independent review; history kept
    for (const t of coding(project.id).filter((t) => !t.title.startsWith('Fix:'))) {
      const ev = env.store.listEvidence({ taskId: t.id, level: 'REQUIREMENTS_SATISFIED' });
      expect(ev.at(-1)!.status, t.title).toBe('PASSED');
    }
    expect(
      env.store.listEvidence({ taskId: attendance.id, level: 'REQUIREMENTS_SATISFIED' }).map((e) => e.status),
    ).toEqual(['FAILED', 'PASSED']);
    expect(env.qa.rows().map((r) => `${r.round}:${r.status}`)).toEqual([
      '1:PASSED',
      '1:FAILED',
      '2:PASSED',
      '1:FAILED',
      '2:PASSED',
    ]);
    // Project reaches VERIFYING only after the last review passed
    expect(env.store.getProject(project.id)!.lifecycle).toBe('VERIFYING');
    // Project-level REQUIREMENTS_SATISFIED aggregates the independent reviews (every requirement covered)
    const v = await verifyProject(
      { store: env.store, timeoutMs: 60_000 },
      env.store.getProject(project.id)!,
      project.repoPath,
    );
    expect(v.evidence.find((e) => e.level === 'REQUIREMENTS_SATISFIED')).toMatchObject({
      status: 'PASSED',
      summary: 'all 4 requirement(s) implemented by independently reviewed tasks',
    });
  });

  it('escalates to the owner when corrections are exhausted; dependants stay blocked until the owner decides', async () => {
    env = await makeEnv({
      env: { ...QA, MAX_CORRECTION_ROUNDS: '0' },
      mock: {
        scenario: {
          tasks: {
            ...happyPlanning(),
            'Scaffold project and auth': [code('src/auth.ts')],
            'Review: Scaffold project and auth': [
              verdict([
                ['AC1', false],
                ['AC2', true, 'src/auth.ts', 1],
                ['NFR-1', true, 'src/auth.ts', 1],
              ]),
            ],
            'Review: Enrollment module': [
              verdict([
                ['AC1', true, 'src/x.ts', 1],
                ['FR-1', true, 'src/x.ts', 1],
                ['DR-1', true, 'src/x.ts', 1],
              ]),
            ],
            'Enrollment module': [code('src/x.ts')],
            'Attendance module': [code('src/y.ts')],
            'Review: Attendance module': [
              verdict([
                ['AC1', true, 'src/y.ts', 1],
                ['FR-2', true, 'src/y.ts', 1],
              ]),
            ],
          } as never,
        },
      },
    });
    const { project } = await registerAssignment(env.store, env.registry, 'mock', assignmentExample());
    env.workflows.startPlanning(project.id);
    await settle(env);
    const approval = env.store.listApprovals('PENDING').find((a) => a.actionType === 'qa_escalation')!;
    expect(approval.description).toMatch(/Independent QA could not confirm "Scaffold project and auth"/);
    expect(env.mock!.runs.some((r) => r.taskTitle === 'Enrollment module')).toBe(false); // gated
    expect(env.store.getProject(project.id)!.lifecycle).toBe('IN_DEVELOPMENT');

    env.store.decideApproval(approval.id, 'APPROVED', 'owner');
    await settle(env);
    const t1 = coding(project.id).find((t) => t.title === 'Scaffold project and auth')!;
    expect(env.store.listEvidence({ taskId: t1.id, level: 'REQUIREMENTS_SATISFIED' }).at(-1)).toMatchObject({
      status: 'PASSED',
      evidence: { ownerOverride: true },
    });
    expect(env.mock!.runs.some((r) => r.taskTitle === 'Attendance module')).toBe(true);
    expect(env.store.getProject(project.id)!.lifecycle).toBe('VERIFYING');
  });

  it('assigns a bounded specialist role to every planned task and puts its brief in the worker prompt', async () => {
    env = await makeEnv({
      env: { PLAN_APPROVAL: 'auto' },
      mock: { scenario: { tasks: happyPlanning() as never } },
    });
    const { project } = await registerAssignment(env.store, env.registry, 'mock', assignmentExample());
    env.workflows.startPlanning(project.id);
    await settle(env);
    const roles = Object.fromEntries(coding(project.id).map((t) => [t.title, t.role]));
    expect(roles).toEqual({
      'Scaffold project and auth': 'security_engineer',
      'Enrollment module': 'backend_engineer',
      'Attendance module': 'backend_engineer',
    });
  });
});
