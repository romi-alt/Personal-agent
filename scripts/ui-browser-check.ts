/**
 * Real-browser check of the command center without extra dependencies: headless Microsoft Edge (or Chrome) driven over
 * the DevTools protocol with Node's built-in WebSocket. Seeds an isolated agent home through the real planning/QA
 * pipeline on the deterministic mock provider, starts the dashboard, signs in with the owner token, renders every
 * view, captures screenshots and fails on any JavaScript exception, console error or empty view.
 *
 *   npx tsx scripts/ui-browser-check.ts [--out <dir>] [--browser <path>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerAssignment } from '../src/assignments/register.js';
import { createApp } from '../src/core/app.js';
import { tokenFile } from '../src/dashboard/auth.js';
import { startDashboard } from '../src/dashboard/server.js';
import { MockProvider } from '../src/providers/mock/mock-provider.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { assignmentExample } from '../tests/helpers/assignment.js';
import { happyPlanning } from '../tests/helpers/plan-fixtures.js';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = path.resolve(arg('--out') ?? path.join(tmpdir(), 'elevariq-ui-check'));
mkdirSync(out, { recursive: true });
const browser =
  arg('--browser') ??
  [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].find((p) => existsSync(p));
if (!browser) throw new Error('no Edge/Chrome found; pass --browser <path>');

// ---------------------------------------------------------------- seed real data (mock provider, real pipeline)
const home = mkdtempSync(path.join(tmpdir(), 'elevariq-ui-home-'));
const provider = new MockProvider({ scenario: { tasks: happyPlanning() as never } });
const app = createApp({
  noEnvFile: true,
  provider,
  env: {
    AGENT_HOME: home,
    LOG_TO_CONSOLE: 'false',
    PLAN_APPROVAL: 'required',
    INDEPENDENT_REVIEW: 'false',
    BACKUP_INTERVAL_HOURS: '0',
    POLL_INTERVAL_MS: '100',
  },
});
const { project } = await registerAssignment(app.store, app.registry, 'mock', assignmentExample());
app.workflows.startPlanning(project.id);
const sup = new Supervisor({
  config: app.config,
  store: app.store,
  provider,
  registry: app.registry,
  log: app.log,
  workflows: app.workflows,
  qa: app.qa,
});
const tickUntil = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) {
    await sup.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
};
await tickUntil(() => app.store.listApprovals('PENDING').length > 0);
const planApproval = app.store.listApprovals('PENDING')[0]!;
app.store.decideApproval(planApproval.id, 'APPROVED', 'owner');
await tickUntil(() => app.store.getProject(project.id)!.lifecycle === 'VERIFYING');
app.store.createApproval({
  projectId: project.id,
  actionType: 'production_deploy',
  description: 'Deploy release 1.0 to the production server',
  payload: { target: 'production' },
});
app.store.enqueueTask({
  projectId: project.id,
  title: 'Follow-up: export attendance as CSV',
  instructions: 'x',
  maxRetries: 1,
});

// ---------------------------------------------------------------- dashboard + browser
const port = 42000 + Math.floor(Math.random() * 1000);
const server = await startDashboard(app, { host: '127.0.0.1', port });
const token = readFileSync(tokenFile(home), 'utf8').trim();
const dport = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(path.join(tmpdir(), 'elevariq-ui-profile-'));
const br = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${dport}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
for (let i = 0; i < 60 && !targets.some((t) => t.type === 'page'); i++) {
  await sleep(250);
  try {
    targets = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()) as typeof targets;
  } catch {
    /* not up yet */
  }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
const problems: string[] = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data)) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: unknown;
  };
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m.result ?? { error: m.error });
    pending.delete(m.id);
  }
  if (m.method === 'Runtime.exceptionThrown')
    problems.push(
      `JS exception: ${JSON.stringify((m.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } }).exceptionDetails?.exception?.description ?? m.params).slice(0, 300)}`,
    );
  if (m.method === 'Runtime.consoleAPICalled' && (m.params as { type?: string }).type === 'error')
    problems.push(`console.error: ${JSON.stringify((m.params as { args?: unknown }).args).slice(0, 300)}`);
  if (m.method === 'Log.entryAdded') {
    const e = (m.params as { entry: { level: string; text: string; url?: string } }).entry;
    if (e.level === 'error' && !/favicon/.test(e.url ?? ''))
      problems.push(`log error: ${e.text} ${e.url ?? ''}`.slice(0, 300));
  }
});
const cdp = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression: string) =>
  (
    (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: unknown };
    }
  ).result?.value;
await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Log.enable');

const base = `http://127.0.0.1:${port}/`;
await cdp('Page.navigate', { url: base });
await sleep(800);
const results: { view: string; ok: boolean; chars: number; screenshot: string; note: string }[] = [];
const shot = async (name: string) => {
  const r = (await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })) as {
    data?: string;
  };
  const file = path.join(out, `${name}.png`);
  if (r.data) writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
};
results.push({
  view: 'login',
  ok: String(await evaluate('document.body.innerText')).includes('Owner token'),
  chars: 0,
  screenshot: await shot('00-login'),
  note: '',
});
await evaluate(
  `document.querySelector('#t').value = ${JSON.stringify(token)}; document.querySelector('form').submit(); true`,
);
await sleep(1500);

const views: [string, string][] = [
  ['01-overview', '#/'],
  ['02-projects', '#/projects'],
  ['03-project-overview', `#/p/${project.id}/overview`],
  ['04-requirements', `#/p/${project.id}/requirements`],
  ['05-research', `#/p/${project.id}/research`],
  ['06-architecture', `#/p/${project.id}/architecture`],
  ['07-adrs', `#/p/${project.id}/adrs`],
  ['08-roadmap', `#/p/${project.id}/roadmap`],
  ['09-tasks', `#/p/${project.id}/tasks`],
  ['10-executions', `#/p/${project.id}/executions`],
  ['11-checkpoints', `#/p/${project.id}/checkpoints`],
  ['12-git', `#/p/${project.id}/git`],
  ['13-tests', `#/p/${project.id}/tests`],
  ['14-qa', `#/p/${project.id}/qa`],
  ['15-issues', `#/p/${project.id}/issues`],
  ['16-report', `#/p/${project.id}/report`],
  ['17-workers', '#/workers'],
  ['18-approvals', '#/approvals'],
  ['19-activity', '#/activity'],
  ['20-assign', '#/assign'],
];
for (const [name, hash] of views) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}; true`);
  await sleep(1200);
  const text = String((await evaluate(`(document.querySelector('main') || document.body).innerText`)) ?? '');
  const ok = text.length > 40 && !/^Error:/m.test(text) && !text.includes('Loading live agent data');
  results.push({
    view: name,
    ok,
    chars: text.length,
    screenshot: await shot(name),
    note: ok ? '' : text.slice(0, 160),
  });
}
// one owner action through the real UI: approve the pending deploy request from the inbox
await evaluate(`location.hash = '#/approvals'; true`);
await sleep(1200);
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Deny').click(); true`);
await sleep(1500);
const denied =
  app.store.listApprovals().find((a) => a.actionType === 'production_deploy')!.status === 'DENIED';
results.push({
  view: 'action: deny approval via UI',
  ok: denied,
  chars: 0,
  screenshot: await shot('21-approval-denied'),
  note: denied ? '' : 'approval not denied',
});

ws.close();
br.kill();
server.close();
app.close();
for (const r of results)
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${r.view}${r.chars ? `  (${r.chars} chars)` : ''}${r.note ? `  -- ${r.note}` : ''}`,
  );
for (const p of problems) console.log(`FAIL  ${p}`);
console.log(`screenshots: ${out}`);
process.exit(results.every((r) => r.ok) && problems.length === 0 ? 0 : 1);
