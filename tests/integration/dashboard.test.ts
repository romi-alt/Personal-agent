import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { App } from '../../src/core/app.js';
import { tokenFile } from '../../src/dashboard/auth.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { makeEnv, type TestEnv } from '../helpers/env.js';

let env: TestEnv;
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await env?.cleanup();
});

const port = () => 41000 + Math.floor(Math.random() * 2000);
async function boot(opts: Partial<Parameters<typeof startDashboard>[1]> = {}) {
  env = await makeEnv();
  const app = {
    config: env.config,
    db: env.store.db,
    store: env.store,
    log: env.log,
    registry: env.registry,
    provider: env.provider,
    workflows: env.workflows,
    qa: env.qa,
    close() {},
  } as unknown as App;
  const p = port();
  server = await startDashboard(app, { host: '127.0.0.1', port: p, ...opts });
  const base = `http://127.0.0.1:${p}`;
  const token = readFileSync(tokenFile(env.config.agentHome), 'utf8').trim();
  return { app, base, token, p };
}
async function login(base: string, token: string) {
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ token }),
    redirect: 'manual',
  });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  const s = (await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()) as { csrf: string };
  return { status: r.status, cookie, csrf: s.csrf };
}
const post = (
  base: string,
  path: string,
  auth: { cookie: string; csrf?: string },
  body: unknown = {},
  extra: Record<string, string> = {},
) =>
  fetch(`${base}/api/${path}`, {
    method: 'POST',
    headers: {
      cookie: auth.cookie,
      'content-type': 'application/json',
      ...(auth.csrf ? { 'x-csrf-token': auth.csrf } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });

describe('Phase 5: owner command center', () => {
  it('requires the owner token, uses HttpOnly SameSite sessions, and locks out brute force', async () => {
    const { base, token } = await boot();
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    expect(await (await fetch(`${base}/`)).text()).toContain('Owner token');
    expect(
      (
        await fetch(`${base}/login`, {
          method: 'POST',
          body: new URLSearchParams({ token: 'wrong' }),
          redirect: 'manual',
        })
      ).status,
    ).toBe(401);
    const ok = await fetch(`${base}/login`, {
      method: 'POST',
      body: new URLSearchParams({ token }),
      redirect: 'manual',
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    for (let i = 0; i < 5; i++)
      await fetch(`${base}/login`, {
        method: 'POST',
        body: new URLSearchParams({ token: 'bad' + i }),
        redirect: 'manual',
      });
    const locked = await fetch(`${base}/login`, {
      method: 'POST',
      body: new URLSearchParams({ token }),
      redirect: 'manual',
    });
    expect(await locked.text()).toContain('too many failed attempts');
    expect(env.store.listEvents({ type: 'dashboard.login_failed' }).length).toBeGreaterThanOrEqual(6);
  });

  it('rejects unexpected Host headers (DNS rebinding), cross-origin and CSRF-less mutations', async () => {
    const { base, token, p } = await boot();
    const status = await new Promise<number>((resolve) => {
      const r = httpRequest(
        { host: '127.0.0.1', port: p, path: '/', headers: { host: `evil.example:${p}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      r.end();
    });
    expect(status).toBe(421);
    const auth = await login(base, token);
    expect((await post(base, `projects/${env.project.id}/pause`, { cookie: auth.cookie })).status).toBe(403); // no CSRF header
    expect(
      (await post(base, `projects/${env.project.id}/pause`, auth, {}, { origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
    expect(env.store.getProject(env.project.id)!.status).toBe('ACTIVE');
  });

  it('serves real data and applies owner controls with an audit trail', async () => {
    const { base, token } = await boot();
    const auth = await login(base, token);
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'Owner-controlled task',
      instructions: 'x',
      maxRetries: 1,
    }).task;
    const o = (await (await fetch(`${base}/api/overview`, { headers: { cookie: auth.cookie } })).json()) as {
      totals: { queued: number };
      projects: { id: string }[];
      system: { workerState: string };
    };
    expect(o.totals.queued).toBe(1);
    expect(o.projects.map((x) => x.id)).toContain(env.project.id);
    expect(o.system.workerState).toBeTruthy();

    expect((await post(base, `projects/${env.project.id}/pause`, auth)).status).toBe(200);
    expect(env.store.getProject(env.project.id)!.status).toBe('PAUSED');
    expect((await post(base, `tasks/${t.id}/priority`, auth, { priority: 7 })).status).toBe(200);
    expect(env.store.getTask(t.id)!.priority).toBe(7);
    expect((await post(base, `tasks/${t.id}/cancel`, auth)).status).toBe(200);
    expect(env.store.getTask(t.id)!.status).toBe('CANCELLED');
    const audit = env.store.listEvents().filter((e) => e.type.startsWith('owner.'));
    expect(audit.map((e) => e.type)).toEqual([
      'owner.project_paused',
      'owner.task_priority',
      'owner.task_action',
    ]);
    expect(
      audit.every(
        (e) => e.payload['channel'] === 'dashboard' && e.payload['by'] === 'owner' && !!e.payload['address'],
      ),
    ).toBe(true);

    const d = (await (
      await fetch(`${base}/api/projects/${env.project.id}`, { headers: { cookie: auth.cookie } })
    ).json()) as { tasks: { id: string }[]; readiness: { ready: boolean } };
    expect(d.tasks.map((x) => x.id)).toEqual([t.id]);
    expect(d.readiness.ready).toBe(false);
  });

  it('approval inbox: decisions are recorded with note, actor and address', async () => {
    const { base, token } = await boot();
    const auth = await login(base, token);
    const a = env.store.createApproval({
      projectId: env.project.id,
      actionType: 'production_deploy',
      description: 'Deploy release 1.0 to production',
      payload: { target: 'prod' },
    });
    const list = (await (
      await fetch(`${base}/api/approvals`, { headers: { cookie: auth.cookie } })
    ).json()) as { approvals: { id: string; status: string }[] };
    expect(list.approvals.find((x) => x.id === a.id)!.status).toBe('PENDING');
    expect((await post(base, `approvals/${a.id}/deny`, auth, { note: 'not before the audit' })).status).toBe(
      200,
    );
    expect(env.store.getApproval(a.id)!.status).toBe('DENIED');
    const after = (await (
      await fetch(`${base}/api/approvals`, { headers: { cookie: auth.cookie } })
    ).json()) as { audit: { payload: Record<string, unknown> }[] };
    expect(after.audit[0]!.payload).toMatchObject({
      approvalId: a.id,
      decision: 'DENIED',
      note: 'not before the audit',
      channel: 'dashboard',
    });
    // deciding twice is refused
    expect((await post(base, `approvals/${a.id}/approve`, auth)).status).toBe(422);
  });

  it('assigns a project from natural language', async () => {
    const { base, token } = await boot();
    const auth = await login(base, token);
    const r = await post(base, 'intake', auth, {
      text: 'Build a complete educational ERP for Pakistani institutions.',
    });
    expect(r.status).toBe(201);
    const { projectId, runId } = (await r.json()) as { projectId: string; runId: string };
    expect(env.workflows.repo.getRun(runId)!.context.phase).toBe('intake');
    expect(env.workflows.repo.listDocuments(projectId)[0]!.content).toContain('Pakistani institutions');
    expect(env.store.listEvents({ type: 'owner.project_assigned' })).toHaveLength(1);
  });

  it('sends strict security headers and a self-contained page', async () => {
    const { base, token } = await boot();
    const auth = await login(base, token);
    const r = await fetch(`${base}/`, { headers: { cookie: auth.cookie } });
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toMatch(/default-src 'none'; script-src 'nonce-[^']+'/);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    const html = await r.text();
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toMatch(/<script[^>]+src=/); // no external scripts
    expect(html).not.toMatch(/innerHTML/);
    // The client script is syntactically valid JavaScript (it is not compiled by tsc).
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();
  });

  it('refuses to bind to a non-loopback interface unless explicitly allowed', async () => {
    env = await makeEnv();
    const app = { config: env.config, store: env.store, log: env.log } as unknown as App;
    expect(() => startDashboard(app, { host: '0.0.0.0', port: port() })).toThrow(/refusing to bind/);
  });
});
