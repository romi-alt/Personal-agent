/**
 * Trusted approval broker (V2.1 trusted-execution).
 *
 * The broker is the single decision point between a worker's request and a privileged effect. It:
 *  - validates every field of a typed request (never trusts worker-supplied status),
 *  - checks the task capability (default-deny),
 *  - computes the bound action and requires a single-use, action-bound owner approval for consequential categories,
 *  - records every decision (allow, deny, approval request/consume) in the signed audit chain,
 *  - rejects replays and expired approvals, and fails closed on any inconsistency.
 *
 * SCOPE: application-level control. The broker is a boundary only when it runs under a DIFFERENT OS identity from the
 * worker, so the worker cannot (a) call `decide` as the owner, (b) edit the grant store or audit log, or (c) debug or
 * replace the broker process. Those require the Windows isolation in the admin scripts. Until then, classify as
 * "implemented, awaiting OS-level verification". A worker that approves via owner identity is out of scope here.
 */
import { actionFingerprint, canonicalArgsFor, type BoundAction } from './canonical.js';
import { type Capability, requiresApproval } from './capability.js';
import { ApprovalGrantStore, type ConsumeResult, DEFAULT_GRANT_TTL_MS } from './approval-grant.js';
import { AuditChain } from './audit-chain.js';

/** A typed request from a worker, as it arrives over the IPC interface. Every field is validated. */
export interface BrokerRequest {
  workerId: string;
  taskId: string;
  executionId: string;
  projectId: string;
  tool: string;
  toolInput: Record<string, unknown>;
  /** The policy category the supervisor assigned (consequential actions only); null for ordinary calls. */
  category: string | null;
  target: string | null;
  cwd: string;
  policyVersion: string;
  requestId: string;
  at: number;
  /** Present when the worker is presenting a previously granted approval to execute. */
  approval?: { grantId: string; nonce: string };
}

export type BrokerOutcome =
  | { decision: 'allow'; reason: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'needs_approval'; reason: string; grantId: string; nonce: string; expiresAt: number };

export interface BrokerDeps {
  /** Resolve the capability grant for a task; the broker never takes it from the worker. */
  capabilityFor(taskId: string): Capability | undefined;
  grants: ApprovalGrantStore;
  audit: AuditChain;
  normalizeCommand: (command: string) => string;
  now: () => number;
  /** Owner/broker principals allowed to decide approvals; used to reject a worker deciding its own. */
  isOwnerPrincipal: (principal: string) => boolean;
  grantTtlMs?: number;
}

export class ApprovalBroker {
  constructor(private readonly d: BrokerDeps) {}

  /**
   * Seen requestIds, to reject duplicate submissions (replay at the request layer). Bounded (FIFO eviction) so a
   * long-running broker cannot grow memory without limit (preflight D10). The single-use approval grant is the
   * durable anti-replay guard for consequential actions; this set covers the recent request window.
   */
  private seenRequests = new Set<string>();
  private static readonly MAX_SEEN_REQUESTS = 10_000;

  private rememberRequest(requestId: string): void {
    this.seenRequests.add(requestId);
    if (this.seenRequests.size > ApprovalBroker.MAX_SEEN_REQUESTS) {
      const oldest = this.seenRequests.values().next().value;
      if (oldest !== undefined) this.seenRequests.delete(oldest);
    }
  }

  private boundAction(req: BrokerRequest, cap: Capability): BoundAction {
    return {
      category: req.category ?? 'none',
      tool: req.tool,
      canonicalArgs: canonicalArgsFor(req.tool, req.toolInput, this.d.normalizeCommand),
      target: req.target,
      workerId: cap.workerId,
      taskId: req.taskId,
      projectId: req.projectId,
      executionId: req.executionId,
      cwd: req.cwd,
      policyVersion: req.policyVersion,
    };
  }

  /** Validate a request's identity/consistency against the capability. Returns a deny reason or null. */
  private validate(req: BrokerRequest, cap: Capability): string | null {
    if (!req.requestId) return 'missing request id';
    if (this.seenRequests.has(req.requestId)) return 'duplicate request id (replay)';
    if (req.taskId !== cap.taskId) return 'task mismatch';
    if (req.projectId !== cap.projectId) return 'project mismatch';
    if (req.workerId !== cap.workerId) return 'worker identity mismatch';
    if (req.policyVersion !== cap.policyVersion) return 'policy version mismatch (grant is stale)';
    if (this.d.now() >= cap.expiresAt) return 'capability grant has expired';
    return null;
  }

  /**
   * Decide a request. For a consequential category with no presented approval, returns `needs_approval` with a fresh
   * single-use grant bound to this exact action. When the worker presents an approval, it is consumed atomically and
   * must match the action.
   */
  authorize(req: BrokerRequest): BrokerOutcome {
    const cap = this.d.capabilityFor(req.taskId);
    if (!cap) return this.deny(req, 'no capability grant for this task');

    const invalid = this.validate(req, cap);
    if (invalid) return this.deny(req, invalid);
    this.rememberRequest(req.requestId);

    // Ordinary (non-consequential) call: capability governs it elsewhere (paths/execs/network). The broker records it.
    if (!req.category) {
      this.d.audit.append('broker.allow', { requestId: req.requestId, tool: req.tool, taskId: req.taskId });
      return { decision: 'allow', reason: 'no approval category; governed by capability' };
    }

    const permitted = requiresApproval(cap, req.category);
    if (!permitted.allow) return this.deny(req, permitted.reason);

    const action = this.boundAction(req, cap);

    if (req.approval) {
      const result: ConsumeResult = this.d.grants.consume(req.approval.grantId, req.approval.nonce, action);
      this.d.audit.append('broker.approval_consume', {
        requestId: req.requestId,
        grantId: req.approval.grantId,
        ok: result.ok,
        reason: result.reason,
        fingerprint: actionFingerprint(action),
      });
      return result.ok
        ? { decision: 'allow', reason: 'single-use approval consumed for this exact action' }
        : this.deny(req, result.reason);
    }

    // No approval presented: create a bound, single-use grant for the owner to decide.
    const grant = this.d.grants.request(action, this.d.grantTtlMs ?? DEFAULT_GRANT_TTL_MS);
    this.d.audit.append('broker.approval_request', {
      requestId: req.requestId,
      grantId: grant.id,
      category: req.category,
      fingerprint: grant.fingerprint,
      expiresAt: grant.expiresAt,
    });
    return {
      decision: 'needs_approval',
      reason: `owner approval required for ${req.category}`,
      grantId: grant.id,
      nonce: grant.nonce,
      expiresAt: grant.expiresAt,
    };
  }

  /** Owner decision path. Rejects a non-owner principal (e.g. the worker deciding its own request). */
  decide(
    grantId: string,
    decision: 'APPROVED' | 'DENIED',
    decidedBy: string,
  ): { ok: boolean; reason: string } {
    if (!this.d.isOwnerPrincipal(decidedBy)) {
      this.d.audit.append('broker.decide_rejected', { grantId, decidedBy, reason: 'not an owner principal' });
      return { ok: false, reason: 'only an owner principal may decide approvals' };
    }
    const g = this.d.grants.decide(grantId, decision, decidedBy);
    this.d.audit.append('broker.decided', { grantId, decision, decidedBy, fingerprint: g.fingerprint });
    return { ok: true, reason: `grant ${decision.toLowerCase()}` };
  }

  revoke(grantId: string, by: string, reason: string): { ok: boolean; reason: string } {
    if (!this.d.isOwnerPrincipal(by)) return { ok: false, reason: 'only an owner principal may revoke' };
    this.d.grants.revoke(grantId, by, reason);
    this.d.audit.append('broker.revoked', { grantId, by, reason });
    return { ok: true, reason: 'revoked' };
  }

  private deny(req: BrokerRequest, reason: string): BrokerOutcome {
    this.d.audit.append('broker.deny', {
      requestId: req.requestId,
      tool: req.tool,
      taskId: req.taskId,
      reason,
    });
    return { decision: 'deny', reason };
  }
}
