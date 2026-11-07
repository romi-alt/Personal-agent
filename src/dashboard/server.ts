import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { submitIntake } from '../assignments/intake.js';
import {
  type Actor,
  decideApproval,
  setProjectPriority,
  setProjectState,
  setTaskPriority,
  taskAction,
  type TaskAction,
} from '../control/owner-actions.js';
import type { App } from '../core/app.js';
import { ensureOwnerToken, parseCookies, SESSION_COOKIE, SessionManager } from './auth.js';
import { executionLog, invalidateStatus, overview, projectDetail, systemStatus, taskDetail } from './data.js';
import { loginPage, uiPage } from './ui.js';

export interface DashboardOptions {
  host: string;
  port: number;
  /** Extra Host header values accepted (e.g. a reverse-proxy name). Loopback names are always accepted. */
  allowedHosts?: string[];
  /** Set the Secure cookie flag (when served behind HTTPS). */
  secureCookies?: boolean;
  /** Required to bind to a non-loopback interface. */
  allowRemote?: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Local-only owner command center. Security model:
 *  - binds to 127.0.0.1 by default; any other interface requires an explicit DASHBOARD_ALLOW_REMOTE=true
 *    (use a VPN/SSH tunnel and TLS in front of it - never expose it directly);
 *  - Host header allow-list (defeats DNS rebinding), owner-token login, server-side sessions, CSRF header on every
 *    mutation, strict CSP with a per-response nonce, no third-party resources, no caching of API responses;
 *  - every owner action goes through src/control/owner-actions.ts and is recorded as an audit event.
 */
export function startDashboard(app: App, opts: DashboardOptions): Promise<Server> {
  if (!LOOPBACK.has(opts.host) && !opts.allowRemote)
    throw new Error(
      `refusing to bind the dashboard to ${opts.host}: set DASHBOARD_ALLOW_REMOTE=true only behind a VPN/SSH tunnel with TLS`,
    );
  const token = ensureOwnerToken(app.config.agentHome);
  const sessions = new SessionManager(() => token);
  const allowed = new Set([
    ...['127.0.0.1', 'localhost', '[::1]'].map((h) => `${h}:${opts.port}`),
    ...(opts.allowedHosts ?? []),
  ]);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // same-origin (not no-referrer): browsers then send the real Origin on same-origin POSTs, which the origin check
    // requires; with no-referrer they send Origin: null and every login/action would be refused.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    res.setHeader('Cache-Control', 'no-store');
    const send = (status: number, body: string, type = 'application/json; charset=utf-8') => {
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      res.end(body);
    };
    const json = (status: number, v: unknown) => send(status, JSON.stringify(v));
    try {
      if (!allowed.has(req.headers.host ?? '')) throw new HttpError(421, 'unexpected Host header');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies[SESSION_COOKIE];
      const session = sessions.get(sid);
      const address = req.socket.remoteAddress ?? 'unknown';
      const cookie = (value: string, maxAge: number) =>
        `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${opts.secureCookies ? '; Secure' : ''}`;

      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        const origin = req.headers.origin;
        if (origin && !allowed.has(origin.replace(/^https?:\/\//, '')))
          throw new HttpError(403, 'cross-origin request refused');
      }
      // ---------------- pages + login
      if (req.method === 'GET' && url.pathname === '/')
        return send(200, session ? uiPage(nonce) : loginPage(nonce), 'text/html; charset=utf-8');
      if (req.method === 'POST' && url.pathname === '/login') {
        const body = new URLSearchParams(await readBody(req));
        const r = sessions.login(body.get('token') ?? '', address);
        if ('error' in r) {
          app.store.recordEvent({
            type: 'dashboard.login_failed',
            severity: 'warn',
            payload: { address, reason: r.error },
          });
          return send(401, loginPage(nonce, r.error), 'text/html; charset=utf-8');
        }
        app.store.recordEvent({ type: 'dashboard.login', payload: { address } });
        res.statusCode = 303;
        res.setHeader('Set-Cookie', cookie(r.id, 12 * 3600));
        res.setHeader('Location', '/');
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/logout') {
        sessions.logout(sid);
        res.statusCode = 303;
        res.setHeader('Set-Cookie', cookie('', 0));
        res.setHeader('Location', '/');
        return res.end();
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (!session) throw new HttpError(401, 'login required');
      if (req.method !== 'GET' && !sessions.checkCsrf(sid, req.headers['x-csrf-token'] as string | undefined))
        throw new HttpError(403, 'missing or invalid CSRF token');
      const actor: Actor = { by: 'owner', channel: 'dashboard', address };
      const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
      const body =
        req.method === 'POST' ? (JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>) : {};

      // ---------------- reads
      if (req.method === 'GET') {
        if (parts[0] === 'session') return json(200, { csrf: session.csrf, expiresAt: session.expiresAt });
        if (parts[0] === 'overview') return json(200, await overview(app));
        if (parts[0] === 'system') return json(200, await systemStatus(app));
        if (parts[0] === 'projects' && parts[1]) {
          const d = await projectDetail(app, parts[1]);
          return d ? json(200, d) : json(404, { error: 'unknown project' });
        }
        if (parts[0] === 'tasks' && parts[1]) {
          const d = taskDetail(app, parts[1]);
          return d ? json(200, d) : json(404, { error: 'unknown task' });
        }
        if (parts[0] === 'executions' && parts[1] && parts[2] === 'log') {
          const d = executionLog(app, parts[1]);
          return d ? json(200, d) : json(404, { error: 'unknown execution' });
        }
        if (parts[0] === 'approvals') {
          const audit = app.store.listEvents({ type: 'owner.approval_decided', limit: 200 }).reverse();
          return json(200, { approvals: app.store.listApprovals().reverse(), audit });
        }
        if (parts[0] === 'events') {
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000);
          return json(
            200,
            app.store
              .listEvents({
                type: url.searchParams.get('type') ?? undefined,
                projectId: url.searchParams.get('project') ?? undefined,
                taskId: url.searchParams.get('task') ?? undefined,
                limit,
              })
              .reverse(),
          );
        }
        throw new HttpError(404, 'not found');
      }
      // ---------------- owner controls (POST)
      invalidateStatus();
      if (parts[0] === 'intake') {
        const text = String(body['text'] ?? '');
        const { project, run } = await submitIntake(
          app.store,
          app.registry,
          app.workflows,
          app.provider.name,
          { text, name: body['name'] ? String(body['name']) : undefined },
        );
        app.store.recordEvent({
          type: 'owner.project_assigned',
          projectId: project.id,
          payload: { by: actor.by, channel: actor.channel, address, runId: run.id },
        });
        return json(201, { projectId: project.id, runId: run.id });
      }
      if (parts[0] === 'projects' && parts[1] && (parts[2] === 'pause' || parts[2] === 'resume')) {
        setProjectState(app.store, parts[1], parts[2] === 'pause' ? 'PAUSED' : 'ACTIVE', actor);
        return json(200, { ok: true });
      }
      if (parts[0] === 'projects' && parts[1] && parts[2] === 'priority') {
        setProjectPriority(app.store, parts[1], Number(body['priority']), actor);
        return json(200, { ok: true });
      }
      if (parts[0] === 'tasks' && parts[1] && parts[2] === 'priority') {
        return json(200, setTaskPriority(app.store, parts[1], Number(body['priority']), actor));
      }
      if (
        parts[0] === 'tasks' &&
        parts[1] &&
        ['pause', 'resume', 'cancel', 'retry', 'unblock'].includes(parts[2] ?? '')
      ) {
        return json(200, taskAction(app.store, parts[1], parts[2] as TaskAction, actor));
      }
      if (parts[0] === 'approvals' && parts[1] && (parts[2] === 'approve' || parts[2] === 'deny')) {
        return json(
          200,
          decideApproval(
            app.store,
            parts[1],
            parts[2] === 'approve' ? 'APPROVED' : 'DENIED',
            actor,
            body['note'] ? String(body['note']) : undefined,
          ),
        );
      }
      if (parts[0] === 'workflows' && parts[1] && parts[2] === 'answer') {
        app.workflows.answerQuestion(parts[1], String(body['questionId'] ?? ''), String(body['text'] ?? ''));
        return json(200, { ok: true });
      }
      if (parts[0] === 'workflows' && parts[1] && parts[2] === 'assume') {
        app.workflows.resumeWithAssumptions(parts[1]);
        return json(200, { ok: true });
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 422;
      if (!(err instanceof HttpError)) app.log.warn('dashboard.request_error', { url: req.url, error: err });
      return json(status, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const server = createServer((req, res) => void handler(req, res));
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
