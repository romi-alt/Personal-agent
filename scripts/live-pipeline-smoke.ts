/**
 * Live end-to-end run of the whole pipeline on the REAL Claude Code CLI (subscription login, haiku by default):
 *   natural-language intake -> analysis -> research -> architecture/ADRs -> plan -> planning review -> coding
 *   -> independent QA review -> project verification.
 * One deliberately tiny assignment, auto plan approval, at most 3 planned tasks. Isolated agent home.
 *
 *   npx tsx scripts/live-pipeline-smoke.ts
 *
 * Prints PASS/FAIL per stage with evidence and leaves the agent home for inspection.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { submitIntake } from '../src/assignments/intake.js';
import { getAssignment } from '../src/assignments/register.js';
import { createApp } from '../src/core/app.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { verifyProject } from '../src/verification/service.js';

const home = mkdtempSync(path.join(tmpdir(), 'elevariq-live-pipeline-'));
const app = createApp({
  noEnvFile: true,
  env: {
    ...process.env,
    AGENT_HOME: home,
    EXECUTION_PROVIDER: 'claude-cli',
    CLAUDE_MODEL: process.env['CLAUDE_MODEL'] ?? 'haiku',
    PLAN_APPROVAL: 'auto',
    MAX_PLAN_TASKS: '3',
    MAX_TURNS_PER_EXECUTION: '30',
    INDEPENDENT_REVIEW: 'true',
    RESEARCH_WEB_ACCESS: 'false', // keep the run small and deterministic in cost
    LOG_TO_CONSOLE: 'false',
    POLL_INTERVAL_MS: '1000',
    BACKUP_INTERVAL_HOURS: '0',
  },
});
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const TEXT =
  'Create a tiny Node.js library file sum.js (CommonJS) that exports a function sum(a, b) returning the numeric sum, ' +
  'throwing a TypeError when an argument is not a finite number. Add tests in test/sum.test.js using the built-in node:test ' +
  'and node:assert modules (no dependencies). The tests must pass with the command: node --test. Keep it to at most 2 tasks.';

const sup = new Supervisor({
  config: app.config,
  store: app.store,
  provider: app.provider,
  registry: app.registry,
  log: app.log,
  workflows: app.workflows,
  qa: app.qa,
});
const pre = await app.provider.preflight();
check('provider ready (subscription login)', pre.ready, pre.ready ? pre.detail : pre.missing.join('; '));
if (!pre.ready) finish();

const { project, run } = await submitIntake(app.store, app.registry, app.workflows, app.provider.name, {
  text: TEXT,
  name: 'Live Sum Library',
});
const started = sup.start();
const deadline = Date.now() + 45 * 60_000;
const done = () => {
  const r = app.workflows.repo.getRun(run.id)!;
  if (['FAILED', 'CANCELLED'].includes(r.status)) return true;
  const coding = app.store.listTasks({ projectId: project.id }).filter((t) => t.kind === 'CODING');
  const lc = app.store.getProject(project.id)!.lifecycle;
  return (
    r.status === 'COMPLETED' &&
    coding.length > 0 &&
    (lc === 'VERIFYING' ||
      coding.some((t) => ['FAILED', 'BLOCKED'].includes(t.status)) ||
      app.qa.rows().some((q) => q.status === 'ESCALATED'))
  );
};
while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5000));
sup.requestStop('live pipeline smoke finished');
await started;

const r = app.workflows.repo.getRun(run.id)!;
const a = getAssignment(app.store, project.id);
check(
  'intake produced a valid assignment contract',
  !!a,
  a
    ? `${a.title}; ${a.functionalRequirements.length} FR, ${a.acceptanceCriteria.length} AC`
    : String(r.error),
);
const findings = app.workflows.repo.listFindings(project.id);
check(
  'research recorded findings (no web: all assumptions)',
  findings.length > 0 && findings.every((f) => f.kind === 'assumption'),
  `${findings.length} findings`,
);
const adrs = app.workflows.repo.listAdrs(project.id);
check(
  'architecture + ADRs recorded',
  adrs.length > 0 && !!app.workflows.repo.latestSpec(project.id),
  `${adrs.length} ADR(s)`,
);
check(
  'planning review ran',
  app.workflows.repo.listReviews(run.id).length >= 2,
  app.workflows.repo
    .listReviews(run.id)
    .map((x) => `${x.round}:${x.source}:${x.verdict}`)
    .join(' '),
);
check('planning workflow completed', r.status === 'COMPLETED', `${r.status} ${r.error ?? ''}`);
const coding = app.store.listTasks({ projectId: project.id }).filter((t) => t.kind === 'CODING');
check(
  'coding tasks executed by the real CLI',
  coding.length > 0 && coding.every((t) => t.status === 'COMPLETED'),
  coding.map((t) => `${t.title}=${t.status}`).join('; '),
);
const qa = app.qa.rows();
check(
  'independent QA reviewed every planned task',
  qa.length > 0 &&
    coding
      .filter((t) => !t.title.startsWith('Fix:'))
      .every((t) => qa.some((q) => q.taskId === t.id && ['PASSED', 'OWNER_ACCEPTED'].includes(q.status))),
  qa.map((q) => `${q.round}:${q.status}`).join(' '),
);
const v = await verifyProject(
  { store: app.store, timeoutMs: 120_000 },
  app.store.getProject(project.id)!,
  project.repoPath,
);
const lv = Object.fromEntries(v.evidence.map((e) => [e.level, e.status]));
check(
  'project verification: tests pass (node --test) and requirements independently satisfied',
  lv['TESTS_PASS'] === 'PASSED' && lv['REQUIREMENTS_SATISFIED'] === 'PASSED',
  JSON.stringify(lv),
);
finish();

function finish(): never {
  console.log(`agent home: ${home}`);
  app.close();
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
