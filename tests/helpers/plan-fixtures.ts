import type { MockStep } from '../../src/providers/mock/mock-provider.js';

/** Canned planning replies for the assignment in tests/helpers/assignment.ts (FR-1, FR-2, NFR-1). */

export const analysisJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    requirements: [
      {
        id: 'FR-1',
        text: 'Student enrollment with guardians',
        priority: 'must',
        kind: 'functional',
        acceptance: ['a student can be enrolled'],
      },
      {
        id: 'FR-2',
        text: 'Attendance tracking per session',
        priority: 'must',
        kind: 'functional',
        acceptance: [],
      },
      { id: 'NFR-1', text: 'Role based access', priority: 'should', kind: 'non_functional', acceptance: [] },
      {
        id: 'DR-1',
        text: 'Audit log of enrollment changes',
        priority: 'could',
        kind: 'functional',
        acceptance: [],
      },
    ],
    assumptions: ['Single school, single timezone'],
    risks: [{ id: 'R-1', text: 'Scope creep in reporting', severity: 'medium' }],
    questions: [],
    ...over,
  });

export const architectureJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    decisions: [
      {
        id: 'D-1',
        title: 'Monolith first',
        decision: 'Single TypeScript service',
        rationale: 'Simplest to deliver',
      },
    ],
    technology: [{ area: 'backend', choice: 'Node.js + TypeScript', rationale: 'Owner constraint' }],
    components: [
      { name: 'Enrollment', responsibility: 'students and guardians', requirementIds: ['FR-1', 'DR-1'] },
      { name: 'Attendance', responsibility: 'sessions and absences', requirementIds: ['FR-2'] },
      { name: 'Auth', responsibility: 'roles and permissions', requirementIds: ['NFR-1'] },
    ],
    dataModel: 'Student, Guardian, Class, Session, AttendanceRecord, User, Role',
    ...over,
  });

export const planObject = () => ({
  milestones: [
    { key: 'M1', title: 'Foundation', goal: 'Project skeleton and auth', requirementIds: ['NFR-1'] },
    {
      key: 'M2',
      title: 'Core features',
      goal: 'Enrollment and attendance',
      requirementIds: ['FR-1', 'FR-2'],
    },
  ],
  tasks: [
    {
      key: 'T1',
      title: 'Scaffold project and auth',
      instructions: 'Create the TypeScript project, test setup and role-based auth middleware.',
      acceptanceCriteria: 'builds; auth tests pass',
      milestone: 'M1',
      dependsOn: [],
      requirementIds: ['NFR-1'],
      priority: 0,
      size: 'M',
      verify: ['CHANGES_EXIST'],
    },
    {
      key: 'T2',
      title: 'Enrollment module',
      instructions: 'Implement student and guardian enrollment with validation and tests.',
      acceptanceCriteria: 'enroll endpoint works',
      milestone: 'M2',
      dependsOn: ['T1'],
      requirementIds: ['FR-1', 'DR-1'],
      priority: 0,
      size: 'M',
      verify: ['CHANGES_EXIST', 'TESTS_PASS'],
    },
    {
      key: 'T3',
      title: 'Attendance module',
      instructions: 'Implement attendance sessions and absence reports with tests.',
      acceptanceCriteria: 'attendance endpoint works',
      milestone: 'M2',
      dependsOn: ['T1', 'T2'],
      requirementIds: ['FR-2'],
      priority: 0,
      size: 'S',
      verify: ['CHANGES_EXIST'],
    },
  ],
});

export const planJson = (mutate?: (p: ReturnType<typeof planObject>) => void) => {
  const p = planObject();
  mutate?.(p);
  return JSON.stringify(p);
};

/** Mock scenario step whose final reply is the given text. */
export const reply = (text: string): MockStep => ({ type: 'success', summary: text });

/** Scenario for a fully successful planning run. */
export const happyPlanning = () => ({
  'Plan: analyze': [reply(analysisJson())],
  'Plan: architect': [reply(architectureJson())],
  'Plan: decompose': [reply(planJson())],
});
