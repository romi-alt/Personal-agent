import type { ProjectAssignmentInput } from '../../src/assignments/schema.js';

/** A valid assignment used across tests; override any field. */
export function assignmentExample(over: Partial<ProjectAssignmentInput> = {}): ProjectAssignmentInput {
  return {
    title: 'School Management ERP',
    description: 'AI-powered school management ERP with enrollment, attendance and reporting.',
    businessObjectives: ['Replace spreadsheet administration'],
    functionalRequirements: [
      { id: 'FR-1', text: 'Student enrollment', priority: 'must' },
      { id: 'FR-2', text: 'Attendance tracking', priority: 'must' },
    ],
    nonFunctionalRequirements: [{ id: 'NFR-1', text: 'Role based access', priority: 'should' }],
    technicalConstraints: ['TypeScript backend'],
    expectedDeliverables: ['Source code', 'Tests'],
    acceptanceCriteria: [
      { id: 'AC-1', text: 'Builds from clean checkout', verifiedBy: 'build' },
      { id: 'AC-2', text: 'Tests pass', verifiedBy: 'tests' },
    ],
    ...over,
  } as ProjectAssignmentInput;
}
