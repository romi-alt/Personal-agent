import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Owner authentication for the command center.
 *  - A random owner token (256 bit) lives in <AGENT_HOME>/dashboard.token (created on first use, owner-only file mode
 *    where the OS supports it). It is never logged or put in URLs.
 *  - Logging in with the token creates a server-side session (random id, HttpOnly + SameSite=Strict cookie) with its
 *    own CSRF token that every state-changing request must echo in a header.
 *  - Failed logins are rate limited per client address.
 */
export const SESSION_COOKIE = 'elevariq_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function tokenFile(agentHome: string): string {
  return path.join(agentHome, 'dashboard.token');
}

export function ensureOwnerToken(agentHome: string, rotate = false): string {
  const file = tokenFile(agentHome);
  if (!rotate && existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  mkdirSync(agentHome, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: the file inherits the user's profile ACL (%LOCALAPPDATA% is per-user) */
  }
  return token;
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

interface Session {
  csrf: string;
  expiresAt: number;
  createdAt: number;
  address: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly failures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();

  constructor(
    private readonly ownerToken: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns a new session id, or null if the token is wrong or the address is locked out. */
  login(token: string, address: string): { id: string; csrf: string } | { error: string } {
    const now = this.now();
    const f = this.failures.get(address);
    if (f && f.lockedUntil > now) return { error: 'too many failed attempts; try again later' };
    if (!eq(token.trim(), this.ownerToken())) {
      // 5 failures within 15 minutes lock the address out for 5 minutes.
      const inWindow = f && now - f.firstAt < 15 * 60_000;
      const count = (inWindow ? f.count : 0) + 1;
      this.failures.set(address, {
        count,
        firstAt: inWindow ? f.firstAt : now,
        lockedUntil: count >= 5 ? now + 5 * 60_000 : 0,
      });
      return { error: 'invalid token' };
    }
    this.failures.delete(address);
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    this.sessions.set(id, { csrf, expiresAt: this.now() + SESSION_TTL_MS, createdAt: this.now(), address });
    return { id, csrf };
  }

  get(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt < this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  checkCsrf(id: string | undefined, header: string | undefined): boolean {
    const s = this.get(id);
    return !!s && !!header && eq(header, s.csrf);
  }

  logout(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  /** Invalidate every session (e.g. after the owner token was rotated). */
  clear(): void {
    this.sessions.clear();
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
