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
    sections: {
      system: 'Single Node.js service with a server-rendered UI',
      database: 'PostgreSQL; one schema per school',
      backend: 'Express + TypeScript modules per bounded context',
      frontend: 'Server-rendered pages',
      api: 'REST JSON under /api/v1',
      authentication: 'Email + password, argon2id hashes, session cookies',
      authorization: 'RBAC: admin, teacher, guardian; checked in middleware',
      integration: '',
      deployment: 'Single VPS, systemd service',
      security: 'OWASP ASVS L1; input validation; audit log',
      monitoring: 'Structured logs and a health endpoint',
    },
    diagrams: [
      { title: 'Components', mermaid: 'flowchart LR\n  UI-->API\n  API-->DB' },
      { title: 'Data model', mermaid: 'erDiagram\n  STUDENT ||--o{ GUARDIAN : has' },
    ],
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

export const researchJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    findings: [
      {
        id: 'F-1',
        area: 'domain',
        statement: 'Schools track daily attendance per class session',
        kind: 'assumption',
        confidence: 'medium',
        sources: [],
      },
      {
        id: 'F-2',
        area: 'technical_standards',
        statement: 'OWASP ASVS defines verification requirements for authentication',
        kind: 'verified',
        confidence: 'high',
        sources: [
          {
            title: 'OWASP ASVS',
            url: 'https://owasp.org/www-project-application-security-verification-standard/',
          },
        ],
      },
    ],
    openQuestions: ['Which national student-id format applies?'],
    ...over,
  });

export const reviewJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ verdict: 'approve', issues: [], ...over });

/** Mock scenario step whose final reply is the given text. */
export const reply = (text: string, extra: Partial<MockStep> = {}): MockStep => ({
  type: 'success',
  summary: text,
  ...extra,
});

/** Scenario for a fully successful planning run. */
export const happyPlanning = () => ({
  'Plan: analyze': [reply(analysisJson())],
  'Plan: research': [reply(researchJson())],
  'Plan: architect': [reply(architectureJson())],
  'Plan: decompose': [reply(planJson())],
  'Plan: review': [reply(reviewJson())],
});
