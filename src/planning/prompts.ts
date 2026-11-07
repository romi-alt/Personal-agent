import type { ProjectAssignment } from '../assignments/schema.js';
import type { Analysis, Architecture } from './schemas.js';

/**
 * Prompt builders for the planning workflows. Each prompt states the exact JSON shape expected and the rules that
 * deterministic validators will enforce, so a repair round can quote the validator's errors back to the model.
 */

const J = (v: unknown) => JSON.stringify(v, null, 2);
const bounded = (s: string, max = 6000) => (s.length > max ? s.slice(0, max) + '\n…[truncated]' : s);

export function assignmentBlock(a: ProjectAssignment): string {
  return [
    `# Assignment: ${a.title}`,
    a.description,
    `Business objectives:\n${a.businessObjectives.map((o) => `- ${o}`).join('\n')}`,
    `Functional requirements:\n${a.functionalRequirements.map((r) => `- [${r.id}] (${r.priority}) ${r.text}`).join('\n')}`,
    a.nonFunctionalRequirements.length
      ? `Non-functional requirements:\n${a.nonFunctionalRequirements.map((r) => `- [${r.id}] (${r.priority}) ${r.text}`).join('\n')}`
      : '',
    a.technicalConstraints.length
      ? `Technical constraints:\n${a.technicalConstraints.map((c) => `- ${c}`).join('\n')}`
      : '',
    `Expected deliverables:\n${a.expectedDeliverables.map((d) => `- ${d}`).join('\n')}`,
    `Acceptance criteria:\n${a.acceptanceCriteria.map((c) => `- [${c.id}] ${c.text} (verified by ${c.verifiedBy})`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function repairBlock(errors?: string[], previous?: string): string {
  if (!errors?.length) return '';
  return [
    '## REPAIR REQUIRED',
    'Your previous reply was rejected by automatic validation. Fix every problem below and reply with the COMPLETE corrected JSON object.',
    errors.map((e) => `- ${e}`).join('\n'),
    previous ? `Previous reply (truncated):\n${bounded(previous, 2500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function analyzePrompt(
  a: ProjectAssignment,
  repair?: { errors: string[]; previous?: string },
): string {
  return [
    'Analyse the project assignment below. Look at the repository files (read-only) if any exist.',
    assignmentBlock(a),
    '## Task',
    'Refine the requirements, record assumptions and risks, and list questions you cannot answer from the assignment.',
    'Rules: keep EVERY assignment requirement id (you may sharpen its text, priority and acceptance notes); add new requirements only as derived ids starting with "DR-"; mark a question blocking ONLY if work cannot sensibly start without the answer.',
    '## Reply schema (JSON object only)',
    J({
      requirements: [
        {
          id: 'FR-1',
          text: 'string',
          priority: 'must|should|could',
          kind: 'functional|non_functional',
          acceptance: ['string'],
        },
      ],
      assumptions: ['string'],
      risks: [{ id: 'R-1', text: 'string', severity: 'low|medium|high' }],
      questions: [{ id: 'Q-1', text: 'string', blocking: false }],
    }),
    repairBlock(repair?.errors, repair?.previous),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function architectPrompt(
  a: ProjectAssignment,
  requirements: { id: string; text: string; priority: string }[],
  analysis: Analysis,
  answers: Record<string, string>,
  repair?: { errors: string[]; previous?: string },
): string {
  return [
    'Design the architecture for this project. Look at the repository files (read-only) if any exist.',
    assignmentBlock(a),
    `## Refined requirements\n${requirements.map((r) => `- [${r.id}] (${r.priority}) ${r.text}`).join('\n')}`,
    analysis.assumptions.length
      ? `## Assumptions\n${analysis.assumptions.map((x) => `- ${x}`).join('\n')}`
      : '',
    Object.keys(answers).length
      ? `## Owner clarifications\n${Object.entries(answers)
          .map(([q, t]) => `- ${q}: ${t}`)
          .join('\n')}`
      : '',
    '## Task',
    'Choose the technology stack within the technical constraints, define components and key decisions with rationale. EVERY requirement id must be owned by at least one component.',
    '## Reply schema (JSON object only)',
    J({
      decisions: [
        { id: 'D-1', title: 'string', decision: 'string', rationale: 'string', alternatives: ['string'] },
      ],
      technology: [{ area: 'backend', choice: 'string', rationale: 'string' }],
      components: [{ name: 'string', responsibility: 'string', requirementIds: ['FR-1'] }],
      dataModel: 'short description of the main entities',
    }),
    repairBlock(repair?.errors, repair?.previous),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function decomposePrompt(
  a: ProjectAssignment,
  requirements: { id: string; text: string; priority: string }[],
  architecture: Architecture,
  limits: { maxTasks: number },
  repair?: { errors: string[]; previous?: string },
): string {
  return [
    'Break the project into milestones and executable coding tasks. Look at the repository files (read-only) if any exist.',
    assignmentBlock(a),
    `## Requirements\n${requirements.map((r) => `- [${r.id}] (${r.priority}) ${r.text}`).join('\n')}`,
    `## Architecture\nComponents:\n${architecture.components.map((c) => `- ${c.name}: ${c.responsibility} [${c.requirementIds.join(', ')}]`).join('\n')}\nTechnology:\n${architecture.technology.map((t) => `- ${t.area}: ${t.choice}`).join('\n')}`,
    '## Rules (checked automatically)',
    [
      `- At most ${limits.maxTasks} tasks; each task is size S or M (split anything larger).`,
      '- Every requirement id must be implemented by at least one task (requirementIds).',
      '- Every milestone has tasks; a task may only depend on tasks in the same or an EARLIER milestone; no dependency cycles; keys are unique.',
      '- Every task must include "CHANGES_EXIST" in verify; add "BUILD_PASSES"/"TESTS_PASS" where the task is buildable/testable.',
      '- Each task is a self-contained instruction a coding agent can execute in the repository, with concrete acceptance criteria and its own tests.',
    ].join('\n'),
    '## Reply schema (JSON object only)',
    J({
      milestones: [{ key: 'M1', title: 'string', goal: 'string', requirementIds: ['FR-1'] }],
      tasks: [
        {
          key: 'T1',
          title: 'string',
          instructions: 'string (detailed)',
          acceptanceCriteria: 'string',
          milestone: 'M1',
          dependsOn: [],
          requirementIds: ['FR-1'],
          priority: 0,
          size: 'S|M',
          verify: ['CHANGES_EXIST', 'TESTS_PASS'],
        },
      ],
    }),
    repairBlock(repair?.errors, repair?.previous),
  ]
    .filter(Boolean)
    .join('\n\n');
}
