/**
 * Bounded specialist roles. A role is NOT a separate agent with its own powers: every role runs through the same
 * provider, policy hook, workspace sandbox and approval gates. A role only adds a focused brief to the system prompt
 * and states what the role must not do. Exactly one coding worker runs at a time (MAX_CONCURRENT_WORKERS=1) until
 * shared-workspace and Git isolation for concurrent workers is proven.
 */
export const ROLES = [
  'principal_architect',
  'backend_engineer',
  'frontend_engineer',
  'database_engineer',
  'ai_engineer',
  'uiux_engineer',
  'security_engineer',
  'qa_engineer',
  'devops_engineer',
  'technical_project_manager',
] as const;
export type Role = (typeof ROLES)[number];

interface RoleSpec {
  title: string;
  /** Where the role is used. */
  usedFor: string;
  brief: string;
}

export const ROLE_SPECS: Record<Role, RoleSpec> = {
  principal_architect: {
    title: 'Principal Architect',
    usedFor: 'planning: research, architecture, ADRs (read-only planning tasks)',
    brief:
      'Own the system design. Keep decisions consistent with the recorded ADRs in docs/adr; if a change contradicts an accepted ADR, stop and record the conflict instead of silently diverging.',
  },
  backend_engineer: {
    title: 'Backend Engineer',
    usedFor: 'server-side code, business logic, APIs, background jobs',
    brief:
      'Implement server-side behaviour with input validation, explicit error handling and unit/integration tests. Follow the API design in docs/architecture.',
  },
  frontend_engineer: {
    title: 'Frontend Engineer',
    usedFor: 'client UI code and state management',
    brief:
      'Implement responsive, accessible UI (semantic HTML, keyboard navigation, labels, contrast). Add component tests; keep UI logic separate from data access.',
  },
  database_engineer: {
    title: 'Database Engineer',
    usedFor: 'schema, migrations, queries, indexes, seed data',
    brief:
      'Write forward-only, reversible-where-possible migrations with tests. Never run migrations against a live/production database: those require owner approval.',
  },
  ai_engineer: {
    title: 'AI Engineer',
    usedFor: 'LLM/AI features inside the product',
    brief:
      'Isolate model calls behind an interface with a deterministic test double; never hard-code API keys; bound cost and handle refusals/timeouts explicitly.',
  },
  uiux_engineer: {
    title: 'UI/UX Engineer',
    usedFor: 'information architecture, design system, usability fixes',
    brief:
      'Prioritise clear navigation, hierarchy, typography and accessibility (WCAG 2.2 AA). Do not add decorative content or fabricated data.',
  },
  security_engineer: {
    title: 'Security Engineer',
    usedFor: 'authentication, authorization, secrets handling, hardening tasks',
    brief:
      'Apply least privilege, validate all input, store secrets only via environment/config (never in code), add tests for every access rule, and log security-relevant events without sensitive data.',
  },
  qa_engineer: {
    title: 'QA Engineer',
    usedFor: 'independent review of completed tasks (read-only), test authoring tasks',
    brief:
      'You verify; you do not trust claims. Check each acceptance criterion against the actual code and test results and cite file:line evidence.',
  },
  devops_engineer: {
    title: 'DevOps Engineer',
    usedFor: 'build, CI, packaging, deployment preparation',
    brief:
      'Prepare build/CI/deployment configuration only. Never deploy, publish or change remote infrastructure: those actions require owner approval.',
  },
  technical_project_manager: {
    title: 'Technical Project Manager',
    usedFor: 'orchestration (implemented in code: scheduler, dependency graph, progress from evidence)',
    brief: 'Keep scope to the task; report blockers precisely; never mark work complete without evidence.',
  },
};

/** Heuristic default when a planned task does not name a role. */
export function inferRole(text: string): Role {
  const t = text.toLowerCase();
  if (/\b(auth|login|password|permission|rbac|security|encrypt|secret)/.test(t)) return 'security_engineer';
  if (/\b(migration|schema|database|index|sql|seed)/.test(t)) return 'database_engineer';
  if (/\b(deploy|docker|ci\b|pipeline|systemd|nginx|infrastructure|packag)/.test(t)) return 'devops_engineer';
  if (/\b(llm|ai\b|model|embedding|prompt|claude)/.test(t)) return 'ai_engineer';
  if (/\b(ux|design system|usability|accessib)/.test(t)) return 'uiux_engineer';
  if (/\b(ui|frontend|page|component|react|vue|css|screen|form)/.test(t)) return 'frontend_engineer';
  if (/\b(test suite|e2e|playwright|qa)\b/.test(t)) return 'qa_engineer';
  return 'backend_engineer';
}

export function roleBrief(role: Role | null | undefined): string {
  if (!role) return '';
  const r = ROLE_SPECS[role];
  return `\nYour role for this task: ${r.title}. ${r.brief}\nThe security rules above always take precedence over the role.`;
}
