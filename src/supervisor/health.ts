import http from 'node:http';
import type { Store } from '../queue/store.js';
import type { ExecutionProvider } from '../providers/types.js';
import { buildStatus } from './status.js';

/** Loopback-only, read-only status endpoint. Never binds a public interface and exposes no secrets or task content. */
export function startHealthServer(
  port: number,
  store: Store,
  provider: ExecutionProvider,
  leaseTtlMs: number,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || (req.url !== '/health' && req.url !== '/status')) {
      res.writeHead(404).end();
      return;
    }
    const s = await buildStatus(store, provider, leaseTtlMs);
    const ok = s.supervisor.live;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok, supervisor: s.supervisor, queue: s.queue, provider: s.provider }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
