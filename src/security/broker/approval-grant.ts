/**
 * Single-use, action-bound approval grants (V2.1 trusted-execution).
 *
 * An owner decision authorizes ONE action: it is bound to the action fingerprint (canonical.ts), carries a random
 * nonce, expires quickly, and is consumed atomically the first time it is used. A changed command, argument, worker,
 * target or policy version produces a different fingerprint, so the previous grant no longer matches.
 *
 * SCOPE: application-level. The grant store must live under the broker/supervisor identity; while the worker shares
 * the owner's Windows identity it can edit this state directly (same-user finding). See docs.
 */
import { randomBytes } from 'node:crypto';
import { actionFingerprint, type BoundAction } from './canonical.js';

export type GrantState = 'PENDING' | 'APPROVED' | 'DENIED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

export interface ApprovalGrant {
  id: string;
  nonce: string;
  fingerprint: string;
  action: BoundAction;
  state: GrantState;
  requestedAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  consumedAt: number | null;
  reason: string | null;
}

export interface ConsumeResult {
  ok: boolean;
  reason: string;
  grantId?: string;
}

/** Default grant lifetime: short, per the mandate (owner-configurable). */
export const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory grant store with atomic single-use consumption. Persistence is the broker's responsibility (a store the
 * worker identity cannot write). Exposed as a class so a persistent backend can subclass the three storage hooks.
 */
export class ApprovalGrantStore {
  private grants = new Map<string, ApprovalGrant>();
  /** At most one live (PENDING/APPROVED) grant per fingerprint, so a reused action cannot stockpile approvals. */
  private liveByFingerprint = new Map<string, string>();

  constructor(
    private readonly now: () => number,
    private readonly newId: () => string,
    private readonly onEvent?: (e: { type: string; grant: ApprovalGrant }) => void,
  ) {}

  /** Create a PENDING grant for an action. Supersedes any earlier live grant for the same fingerprint. */
  request(action: BoundAction, ttlMs: number = DEFAULT_GRANT_TTL_MS): ApprovalGrant {
    const fingerprint = actionFingerprint(action);
    const prior = this.liveByFingerprint.get(fingerprint);
    if (prior) {
      const p = this.grants.get(prior);
      if (p && (p.state === 'PENDING' || p.state === 'APPROVED')) {
        p.state = 'REVOKED';
        p.reason = 'superseded by a newer request for the same action';
        this.onEvent?.({ type: 'grant.superseded', grant: p });
      }
    }
    const t = this.now();
    const grant: ApprovalGrant = {
      id: this.newId(),
      nonce: randomBytes(32).toString('hex'),
      fingerprint,
      action,
      state: 'PENDING',
      requestedAt: t,
      expiresAt: t + ttlMs,
      decidedAt: null,
      decidedBy: null,
      consumedAt: null,
      reason: null,
    };
    this.grants.set(grant.id, grant);
    this.liveByFingerprint.set(fingerprint, grant.id);
    this.onEvent?.({ type: 'grant.requested', grant });
    return grant;
  }

  /** Owner decision. `decidedBy` must be an owner/broker principal, never the worker (caller enforces identity). */
  decide(grantId: string, decision: 'APPROVED' | 'DENIED', decidedBy: string): ApprovalGrant {
    const g = this.require(grantId);
    this.expireIfDue(g);
    if (g.state !== 'PENDING') throw new Error(`grant ${grantId} is ${g.state}, cannot be decided`);
    g.state = decision;
    g.decidedAt = this.now();
    g.decidedBy = decidedBy;
    if (decision === 'DENIED') this.liveByFingerprint.delete(g.fingerprint);
    this.onEvent?.({ type: `grant.${decision.toLowerCase()}`, grant: g });
    return g;
  }

  /**
   * Atomically consume a grant for an action. Succeeds only when: the grant exists, is APPROVED, not expired, the
   * nonce matches, and the presented action's fingerprint equals the bound one. On success the grant becomes
   * CONSUMED and can never be used again (replay prevention). Fail-closed: any mismatch denies.
   */
  consume(grantId: string, nonce: string, action: BoundAction): ConsumeResult {
    const g = this.grants.get(grantId);
    if (!g) return { ok: false, reason: 'no such approval grant' };
    this.expireIfDue(g);
    if (g.state === 'CONSUMED')
      return { ok: false, reason: 'approval already used (replay denied)', grantId };
    if (g.state === 'EXPIRED') return { ok: false, reason: 'approval expired', grantId };
    if (g.state !== 'APPROVED') return { ok: false, reason: `approval is ${g.state}`, grantId };
    if (nonce !== g.nonce) return { ok: false, reason: 'approval nonce mismatch', grantId };
    if (actionFingerprint(action) !== g.fingerprint)
      return { ok: false, reason: 'action does not match the approved action', grantId };
    g.state = 'CONSUMED';
    g.consumedAt = this.now();
    this.liveByFingerprint.delete(g.fingerprint);
    this.onEvent?.({ type: 'grant.consumed', grant: g });
    return { ok: true, reason: 'approval consumed', grantId };
  }

  revoke(grantId: string, by: string, reason: string): ApprovalGrant {
    const g = this.require(grantId);
    if (g.state === 'CONSUMED') throw new Error('cannot revoke an already-consumed approval');
    g.state = 'REVOKED';
    g.decidedBy = by;
    g.reason = reason;
    this.liveByFingerprint.delete(g.fingerprint);
    this.onEvent?.({ type: 'grant.revoked', grant: g });
    return g;
  }

  get(grantId: string): ApprovalGrant | undefined {
    const g = this.grants.get(grantId);
    if (g) this.expireIfDue(g);
    return g;
  }

  list(): ApprovalGrant[] {
    for (const g of this.grants.values()) this.expireIfDue(g);
    return [...this.grants.values()];
  }

  private require(grantId: string): ApprovalGrant {
    const g = this.grants.get(grantId);
    if (!g) throw new Error(`no such approval grant ${grantId}`);
    return g;
  }

  private expireIfDue(g: ApprovalGrant): void {
    if ((g.state === 'PENDING' || g.state === 'APPROVED') && this.now() >= g.expiresAt) {
      g.state = 'EXPIRED';
      this.liveByFingerprint.delete(g.fingerprint);
      this.onEvent?.({ type: 'grant.expired', grant: g });
    }
  }
}
