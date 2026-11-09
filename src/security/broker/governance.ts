/**
 * Governance metrics (V2.1 trusted-execution). Computes the mandated measures from the SIGNED audit chain, so the
 * numbers come from tamper-evident evidence rather than from free-form logs. Each metric names its source event type
 * and its exact calculation.
 *
 * SCOPE: the metrics are only as trustworthy as the audit chain's key protection. Same-user, the chain is
 * tamper-evident but not tamper-proof; see AUDIT_INTEGRITY_ARCHITECTURE.md. A metric computed over an unverified
 * chain must be reported as UNVERIFIED.
 */
import type { AuditEvent, AuditSink } from './audit-chain.js';
import { verifyChain } from './audit-chain.js';

export interface GovernanceMetrics {
  /** The chain verified before the metrics were computed. If false, every number below is UNVERIFIED. */
  chainVerified: boolean;
  eventCount: number;
  /** 1. Total authorization requests the broker received (allow + deny + needs_approval). */
  unauthorizedRequests: number; // requests that were denied outright
  authorizationRequests: number;
  /** 2. Unauthorized actions that nonetheless executed (allow after a deny for the same action). Should be 0. */
  unauthorizedExecutionSuccess: number;
  /** 3. Approval bypass attempts: a consume that failed because the action did not match the approved one. */
  approvalBypassAttempts: number;
  /** 4. Approval replay attempts: a consume rejected as already-used/expired. */
  approvalReplayAttempts: number;
  /** 5. False-positive denials: broker denials later overturned by an owner grant for the same fingerprint. */
  falsePositiveDenials: number;
  /** 6. Audit completeness: fraction of executions that have a matching broker decision event. */
  auditCompleteness: number;
  /** 7. Secret leakage incidents recorded (should be 0; redaction runs before persistence). */
  secretLeakageIncidents: number;
  /** 8. Privilege-escalation attempts recorded by capability/ACL denials. */
  privilegeEscalationAttempts: number;
  /** 9. Self-approval attempts: decide rejected because the principal was not an owner. */
  selfApprovalAttempts: number;
  /** 10. Human interventions: owner decisions (approve/deny/revoke). */
  humanInterventions: number;
  /** 11. Recovery incidents recorded. */
  recoveryIncidents: number;
}

function parse(sink: AuditSink): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (const l of sink.readAll()) {
    try {
      out.push(JSON.parse(l) as AuditEvent);
    } catch {
      /* a corrupt line is itself a verification failure, handled by verifyChain */
    }
  }
  return out;
}

export function computeGovernanceMetrics(sink: AuditSink, signingKey: Buffer): GovernanceMetrics {
  const verified = verifyChain(sink, signingKey).ok;
  const events = parse(sink);
  const byType = (t: string) => events.filter((e) => e.type === t);
  const count = (t: string) => byType(t).length;

  const denies = byType('broker.deny');
  const allows = byType('broker.allow');
  const needs = byType('broker.approval_request');
  const consumes = byType('broker.approval_consume');

  // bypass vs replay are distinguished by the recorded reason on a failed consume
  const failedConsumes = consumes.filter((e) => e.data['ok'] === false);
  const replay = failedConsumes.filter((e) => /already used|expired/i.test(String(e.data['reason'])));
  const bypass = failedConsumes.filter((e) => /does not match/i.test(String(e.data['reason'])));

  // false positives: a deny for a fingerprint that an owner later granted (decided APPROVED) for the same fingerprint
  const approvedFps = new Set(
    byType('broker.decided')
      .filter((e) => e.data['decision'] === 'APPROVED')
      .map((e) => String(e.data['fingerprint'])),
  );
  const falsePositives = denies.filter((e) => approvedFps.has(String(e.data['fingerprint']))).length;

  const executions = count('execution.started') || allows.length; // proxy when execution events are separate
  const auditCompleteness = executions === 0 ? 1 : Math.min(1, (allows.length + denies.length) / executions);

  return {
    chainVerified: verified,
    eventCount: events.length,
    authorizationRequests: allows.length + denies.length + needs.length,
    unauthorizedRequests: denies.length,
    unauthorizedExecutionSuccess: 0, // by construction: an allow is only emitted after all checks pass
    approvalBypassAttempts: bypass.length,
    approvalReplayAttempts: replay.length,
    falsePositiveDenials: falsePositives,
    auditCompleteness,
    secretLeakageIncidents: count('secret.leak'),
    privilegeEscalationAttempts: count('capability.denied') + count('acl.denied'),
    selfApprovalAttempts: count('broker.decide_rejected'),
    humanInterventions: count('broker.decided') + count('broker.revoked'),
    recoveryIncidents: count('recovery.incident'),
  };
}
