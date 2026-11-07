import type { ProjectAssignment } from '../assignments/schema.js';
import type { Architecture, Plan, ReviewIssue } from './schemas.js';

/**
 * Deterministic planning review: checks a validated architecture + plan for gaps that schema validation cannot see.
 * Runs before (and independently of) the model review; its findings are facts computed from the documents, not opinions.
 * Severity "high" means the plan should be revised before the owner is asked to approve it.
 */
export function reviewPlan(input: {
  assignment: ProjectAssignment;
  requirements: { id: string; text: string; kind: string; priority: string }[];
  architecture: Architecture;
  plan: Plan;
}): ReviewIssue[] {
  const { assignment: a, requirements, architecture: arch, plan } = input;
  const issues: ReviewIssue[] = [];
  const add = (
    category: ReviewIssue['category'],
    severity: ReviewIssue['severity'],
    description: string,
    recommendation: string,
  ) => issues.push({ id: `DET-${issues.length + 1}`, category, severity, description, recommendation });
  const s = arch.sections ?? ({} as Architecture['sections']);
  const text = (x: string | undefined) => (x ?? '').trim();
  const allReqText = requirements.map((r) => r.text).join('\n') + '\n' + a.description;

  // ---- security
  const needsAuth = /\b(log ?in|sign[ -]?in|auth|password|role|permission|account|user)s?\b/i.test(
    allReqText,
  );
  if (needsAuth && !text(s.authentication))
    add(
      'security_gap',
      'high',
      'Requirements involve users/login but the architecture has no authentication design.',
      'Fill sections.authentication (identity source, session/token model, password policy, MFA).',
    );
  if (needsAuth && !text(s.authorization))
    add(
      'security_gap',
      'high',
      'Requirements involve roles/permissions but the architecture has no authorization model.',
      'Fill sections.authorization (roles, permission matrix, enforcement point).',
    );
  if (!text(s.security))
    add(
      'security_gap',
      'medium',
      'The architecture has no security design section.',
      'Describe threat model, data protection, secrets handling, input validation and audit logging.',
    );
  const secIds = new Set(a.securityRequirements.map((r) => r.id));
  for (const id of secIds) {
    const tasks = plan.tasks.filter((t) => t.requirementIds.includes(id));
    if (tasks.length && !tasks.some((t) => t.verify.includes('TESTS_PASS')))
      add(
        'security_gap',
        'medium',
        `Security requirement ${id} is implemented but no implementing task requires TESTS_PASS.`,
        `Add TESTS_PASS verification and security tests to a task implementing ${id}.`,
      );
  }

  // ---- data model / APIs
  const persistent =
    /\b(store|record|database|persist|history|report|enrol|attendance|invoice|fee|ledger)/i.test(allReqText);
  if ((text(s.database) || persistent) && !text(arch.dataModel))
    add(
      'data_model',
      'high',
      'The system stores data but the architecture has no data model.',
      'Describe the main entities, their relations and key constraints in dataModel (an erDiagram is recommended).',
    );
  if (text(s.database) && !arch.diagrams.some((d) => /erDiagram|classDiagram/.test(d.mermaid)))
    add(
      'data_model',
      'low',
      'No entity-relationship diagram for the database design.',
      'Add a Mermaid erDiagram.',
    );
  if (text(s.frontend) && text(s.backend) && !text(s.api))
    add(
      'missing_api',
      'high',
      'There is a frontend and a backend but no API design between them.',
      'Fill sections.api (resources/endpoints, request/response shapes, error model, versioning).',
    );
  if (a.requiredIntegrations.length && !text(s.integration))
    add(
      'missing_api',
      'medium',
      `The assignment requires integrations (${a.requiredIntegrations.map((i) => i.system).join(', ')}) but there is no integration design.`,
      'Fill sections.integration; note that endpoints of unprovided systems must not be assumed.',
    );

  // ---- decisions (ADR quality)
  for (const d of arch.decisions) {
    if (!text(d.context) || !text(d.consequences))
      add(
        'other',
        'low',
        `Decision ${d.id} ("${d.title}") lacks ${!text(d.context) ? 'context' : 'consequences'}.`,
        'Every ADR records context, alternatives, rationale and consequences.',
      );
    if (d.significant && d.alternatives.length === 0)
      add(
        'other',
        'medium',
        `Significant decision ${d.id} lists no alternatives.`,
        'List the alternatives that were considered.',
      );
  }

  // ---- contradictions with owner preferences / constraints
  const techText = [
    ...arch.technology.map((t) => `${t.area} ${t.choice}`),
    ...arch.decisions.map((d) => `${d.decision} ${d.alternatives.join(' ')}`),
  ]
    .join('\n')
    .toLowerCase();
  for (const pref of a.preferredTechnology) {
    const word =
      pref
        .toLowerCase()
        .split(/[\s,/(]+/)
        .find((w) => w.length >= 2) ?? pref.toLowerCase();
    if (!techText.includes(word))
      add(
        'contradiction',
        'medium',
        `Owner-preferred technology "${pref}" is neither used nor discussed as an alternative.`,
        'Use it, or record an ADR explaining why not.',
      );
  }

  // ---- unrealistic / incomplete plan
  for (const t of plan.tasks) {
    if (t.requirementIds.length > 5)
      add(
        'unrealistic',
        'medium',
        `Task ${t.key} implements ${t.requirementIds.length} requirements at once.`,
        'Split it into smaller tasks.',
      );
  }
  if (a.budget.maxExecutions !== undefined && plan.tasks.length > a.budget.maxExecutions)
    add(
      'unrealistic',
      'high',
      `The plan has ${plan.tasks.length} tasks but the budget allows only ${a.budget.maxExecutions} executions.`,
      'Reduce scope, or ask the owner to raise the execution budget.',
    );
  const testCriteria = a.acceptanceCriteria.filter(
    (c) => c.verifiedBy === 'tests' || c.verifiedBy === 'build',
  );
  if (
    testCriteria.length &&
    !plan.tasks.some((t) => t.verify.includes('TESTS_PASS') || t.verify.includes('BUILD_PASSES'))
  )
    add(
      'missing_requirement',
      'high',
      `Acceptance criteria ${testCriteria.map((c) => c.id).join(', ')} are verified by build/tests, but no task requires BUILD_PASSES or TESTS_PASS.`,
      'Add build/test verification to the relevant tasks.',
    );
  if (
    !text(s.deployment) &&
    a.expectedDeliverables.some((d) => /deploy|hosting|production|server|install/i.test(d))
  )
    add(
      'missing_requirement',
      'medium',
      'A deliverable mentions deployment but there is no deployment design.',
      'Fill sections.deployment.',
    );
  if (!text(s.monitoring))
    add(
      'other',
      'low',
      'No monitoring/observability strategy.',
      'Describe logging, metrics, health checks and alerting.',
    );
  return issues;
}

export const hasBlockingIssues = (issues: ReviewIssue[]) => issues.some((i) => i.severity === 'high');
