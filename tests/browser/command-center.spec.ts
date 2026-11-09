import { expect, test, type Page } from '@playwright/test';
import { LIVE_TASK, startHarness, until, type Harness } from './harness.js';

/**
 * Command center in a real browser (installed Microsoft Edge). Every test performs the owner's action through the UI
 * and then asserts the BACKEND state (SQLite store / audit events), not only what the page shows.
 * One backend for the whole file; tests run in order and build on each other.
 */
test.describe.configure({ mode: 'serial' });

let h: Harness;
let page: Page;
const pageErrors: string[] = [];
let projectId = '';

test.beforeAll(async ({ browser }) => {
  h = await startHarness();
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  // HTTP failures are judged by URL (below); the browser's generic "Failed to load resource" console line is not.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text()))
      pageErrors.push(`console: ${m.text()}`);
  });
  // Expected error responses produced deliberately by the tests; anything else >= 400 is a defect.
  const expected = [
    /\/login$/, // wrong token -> 401
    /\/api\/projects\/prj_doesnotexist$/, // unknown project -> 404
    /\/api\/approvals\/apr_[a-z0-9]+\/approve$/, // stale approval -> 422
    /\/api\/(approvals|overview|session|system)$/, // after the session was cleared -> 401
  ];
  page.on('response', (r) => {
    if (r.status() >= 400 && !expected.some((x) => x.test(new URL(r.url()).pathname)))
      pageErrors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
});
test.afterAll(async () => {
  await page?.close();
  await h?.close();
});

const store = () => h.app.store;
const events = (type: string) => store().listEvents({ type, limit: 100 });
async function go(hash: string) {
  // String expressions run in the page; the project's TS config has no DOM lib.
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
}
async function signIn() {
  await page.goto(h.base);
  await page.locator('#t').fill(h.token);
  await page.locator('form button[type=submit], form input[type=submit]').first().click();
  await expect(page.locator('nav.side')).toBeVisible();
}

test('login: a wrong token is refused and audited; the right token opens a hardened session', async () => {
  await page.goto(h.base);
  await expect(page.getByText('Owner token', { exact: true })).toBeVisible();
  await page.locator('#t').fill('not-the-owner-token');
  await page.locator('form button[type=submit], form input[type=submit]').first().click();
  await expect(page.locator('#t')).toBeVisible(); // still on the login page
  expect(await page.context().cookies()).toHaveLength(0);
  await until(() => events('dashboard.login_failed').length === 1, 'login_failed event');

  await signIn();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const [c] = await page.context().cookies();
  expect(c).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  expect(events('dashboard.login')).toHaveLength(1);
  // The overview shows the live supervisor that the backend reports.
  await expect(page.locator('.health')).toContainText('live');
});

test('project creation and assignment in plain language starts planning', async () => {
  await page.getByRole('link', { name: 'Assign a project' }).click();
  await page.getByLabel('project name').fill('Browser QA Project');
  await page.getByLabel('assignment').fill('Build a small school system with enrollment and attendance.');
  await page.getByRole('button', { name: 'Submit assignment' }).click();
  await expect(page).toHaveURL(/#\/p\/prj_[a-z0-9]+\/overview$/);
  projectId = /#\/p\/(prj_[a-z0-9]+)\//.exec(page.url())![1]!;

  const p = store().getProject(projectId)!;
  expect(p.name).toBe('Browser QA Project');
  const assigned = events('owner.project_assigned').find((e) => e.projectId === projectId)!;
  expect(assigned.payload).toMatchObject({ by: 'owner', channel: 'dashboard' });
  await expect(page.getByRole('heading', { name: 'Browser QA Project' })).toBeVisible();
});

test('approval workflow: the plan approval appears in the inbox and is approved with an audit note', async () => {
  const pending = await until(
    () =>
      store()
        .listApprovals('PENDING')
        .find((a) => a.projectId === projectId && a.actionType === 'plan_approval'),
    'plan approval request',
    60_000,
  );
  await go('#/approvals');
  await expect(page.locator('nav.side a[href="#/approvals"] .count')).toHaveText(/[1-9]/);
  const item = page
    .locator('main div')
    .filter({ hasText: pending.description })
    .filter({
      has: page.getByRole('button', { name: 'Approve' }),
    });
  await item.last().getByLabel('note').fill('approved in the browser test');
  await item.last().getByRole('button', { name: 'Approve' }).click();

  await until(
    () =>
      store()
        .listApprovals()
        .find((a) => a.id === pending.id)?.status === 'APPROVED',
    'APPROVED',
  );
  const audit = events('owner.approval_decided').find((e) => e.payload['approvalId'] === pending.id)!;
  expect(audit.payload).toMatchObject({
    decision: 'APPROVED',
    channel: 'dashboard',
    note: 'approved in the browser test',
  });
  await expect(page.locator('main')).toContainText('approved in the browser test'); // audit trail row
  // Approving the plan materialises coding tasks in the backend.
  await until(
    () =>
      store()
        .listTasks({ projectId })
        .some((t) => t.kind === 'CODING'),
    'coding tasks',
    60_000,
  );
});

test('approval workflow: a production deploy request is denied through the UI', async () => {
  const a = store().createApproval({
    projectId,
    actionType: 'production_deploy',
    description: 'Deploy release 1.0 to production (browser test)',
    payload: { target: 'production' },
  });
  await go('#/projects');
  await go('#/approvals');
  const item = page
    .locator('main div')
    .filter({ hasText: 'Deploy release 1.0 to production (browser test)' })
    .filter({ has: page.getByRole('button', { name: 'Deny' }) })
    .last();
  await item.getByRole('button', { name: 'Deny' }).click();
  await until(
    () =>
      store()
        .listApprovals()
        .find((x) => x.id === a.id)?.status === 'DENIED',
    'DENIED',
  );
  expect(
    store()
      .listApprovals()
      .find((x) => x.id === a.id)!.decidedBy,
  ).toBe('owner');
});

test('task monitoring with pause and resume of a task and of the project', async () => {
  const { task } = store().enqueueTask({
    projectId,
    title: 'Scheduled follow-up (browser test)',
    instructions: 'x',
    maxRetries: 1,
    scheduledStart: Date.now() + 3_600_000, // not eligible yet, so it stays QUEUED while we act on it
  });
  await go(`#/p/${projectId}/tasks`);
  const row = page.locator('tr').filter({ hasText: task.id });
  await expect(row).toContainText('QUEUED');

  await row.getByRole('button', { name: 'Pause' }).click();
  await until(() => store().getTask(task.id)!.status === 'PAUSED', 'task PAUSED');
  await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();
  await row.getByRole('button', { name: 'Resume' }).click();
  await until(() => store().getTask(task.id)!.status !== 'PAUSED', 'task resumed');
  const actions = events('owner.task_action')
    .filter((e) => e.taskId === task.id)
    .map((e) => e.payload['action']);
  expect(actions).toEqual(['pause', 'resume']);

  await page.getByRole('button', { name: 'Pause project' }).click();
  await until(() => store().getProject(projectId)!.status === 'PAUSED', 'project PAUSED');
  await page.getByRole('button', { name: 'Resume project' }).click();
  await until(() => store().getProject(projectId)!.status === 'ACTIVE', 'project ACTIVE');
});

test('live execution status: a worker waiting for a usage reset is shown, then its completion', async () => {
  const { task } = store().enqueueTask({ projectId, title: LIVE_TASK, instructions: 'x', maxRetries: 1 });
  await until(() => store().getTask(task.id)!.status === 'RUNNING', 'live task RUNNING', 60_000);
  await go('#/workers');
  const current = page.locator('.card').filter({ hasText: 'Current worker' });
  await expect(current).toContainText(LIVE_TASK, { timeout: 20_000 });
  await expect(current).toContainText('Waiting reason');
  await expect(current).not.toContainText('no execution in progress');

  h.releaseCapacity();
  await until(() => store().getTask(task.id)!.status === 'COMPLETED', 'live task COMPLETED', 60_000);
  await go(`#/p/${projectId}/tasks`);
  await expect(page.locator('tr').filter({ hasText: task.id })).toContainText('COMPLETED');
});

test('error states: stale approval action, unknown project, missing CSRF, sign-out', async () => {
  const a = store().createApproval({
    projectId,
    actionType: 'publish_release',
    description: 'Publish package (stale-action browser test)',
    payload: {},
  });
  await go('#/projects');
  await go('#/approvals');
  const item = page
    .locator('main div')
    .filter({ hasText: 'Publish package (stale-action browser test)' })
    .filter({ has: page.getByRole('button', { name: 'Approve' }) })
    .last();
  await expect(item).toBeVisible();
  // Decided elsewhere (e.g. the CLI) while the page was open:
  store().decideApproval(a.id, 'DENIED', 'owner-cli');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/already decided/)).toBeVisible();
  expect(
    store()
      .listApprovals()
      .find((x) => x.id === a.id),
  ).toMatchObject({ status: 'DENIED', decidedBy: 'owner-cli' });

  await go('#/p/prj_doesnotexist/overview');
  await expect(page.locator('main')).toContainText('Error: unknown project');
  await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible(); // navigation survives the error
  await go('#/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  const noCsrf = await page.request.post(`${h.base}api/projects/${projectId}/pause`, { data: {} });
  expect(noCsrf.status()).toBe(403);
  expect(store().getProject(projectId)!.status).toBe('ACTIVE');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#t')).toBeVisible();
  expect((await page.request.get(`${h.base}api/overview`)).status()).toBe(401);

  // A session that disappears server-side (expiry/restart) sends the open page back to the login form.
  await signIn();
  await page.context().clearCookies();
  await go('#/approvals');
  await expect(page.locator('#t')).toBeVisible();
});

test('responsive: phone and tablet widths have no horizontal overflow and stay operable', async () => {
  for (const size of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(h.base);
    await expect(page.locator('#t')).toBeVisible();
    expect(
      await page.evaluate<boolean>(`document.documentElement.scrollWidth <= window.innerWidth + 1`),
    ).toBe(true);
    await signIn();
    for (const hash of ['#/', '#/approvals', `#/p/${projectId}/tasks`, '#/workers']) {
      await go(hash);
      await expect(page.locator('main h1')).toBeVisible();
      const overflow = await page.evaluate<number>(
        `document.documentElement.scrollWidth - window.innerWidth`,
      );
      expect(overflow, `${size.width}px ${hash}`).toBeLessThanOrEqual(1);
    }
    await page.getByRole('link', { name: 'Approvals' }).click();
    await expect(page.getByRole('heading', { name: 'Approval center' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
  }
});

test('no JavaScript errors in any of the above', () => {
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
