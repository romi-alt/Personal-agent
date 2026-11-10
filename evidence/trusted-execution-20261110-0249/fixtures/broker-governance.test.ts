/** V2.1 trusted-execution: governance metrics computed from the signed audit chain (synthetic). */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { AuditChain, MemoryAuditSink } from '../../src/security/broker/audit-chain.js';
import { ApprovalGrantStore } from '../../src/security/broker/approval-grant.js';
import { ApprovalBroker, type BrokerRequest } from '../../src/security/broker/broker.js';
import { deriveCapability } from '../../src/security/broker/capability.js';
import { computeGovernanceMetrics } from '../../src/security/broker/governance.js';

const identity = (c: string) => c;
let n = 0;

function scenario() {
  const clock = { t: 1_800_000_000_000 };
  const now = () => clock.t;
  const key = randomBytes(32);
  const sink = new MemoryAuditSink();
  const audit = new AuditChain(sink, key, now);
  const grants = new ApprovalGrantStore(now, () => `g${++n}`);
  const cap = deriveCapability({
    projectId: 'p',
    taskId: 't',
    workerId: 'w',
    workspaceDir: 'C:/ws',
    tempDir: 'C:/tmp',
    policyVersion: 'v1',
    now: now(),
    approvalCategories: ['protected_branch_push'],
  });
  const broker = new ApprovalBroker({
    capabilityFor: (id) => (id === 't' ? cap : undefined),
    grants,
    audit,
    normalizeCommand: identity,
    now,
    isOwnerPrincipal: (p) => p === 'owner',
  });
  const req = (o: Partial<BrokerRequest> = {}): BrokerRequest => ({
    workerId: 'w',
    taskId: 't',
    executionId: 'e',
    projectId: 'p',
    tool: 'Bash',
    toolInput: { command: 'git push origin main' },
    category: 'protected_branch_push',
    target: 'origin/main',
    cwd: 'C:/ws',
    policyVersion: 'v1',
    requestId: `r${++n}`,
    at: now(),
    ...o,
  });
  return { broker, grants, audit, sink, key, req };
}

describe('governance metrics from the signed chain', () => {
  it('counts self-approval, replay, bypass and human interventions; chain stays verified', () => {
    const s = scenario();
    // one legit approved+consumed action
    const o = s.broker.authorize(s.req());
    if (o.decision !== 'needs_approval') throw new Error();
    s.broker.decide(o.grantId, 'APPROVED', 'owner'); // human intervention
    s.broker.authorize(s.req({ approval: { grantId: o.grantId, nonce: o.nonce } })); // allow
    // replay the consumed grant
    s.broker.authorize(s.req({ approval: { grantId: o.grantId, nonce: o.nonce } })); // replay -> deny
    // self-approval attempt
    const o2 = s.broker.authorize(s.req());
    if (o2.decision !== 'needs_approval') throw new Error();
    s.broker.decide(o2.grantId, 'APPROVED', 'worker'); // rejected: not owner
    // bypass: approve one command, present a different one
    s.broker.decide(o2.grantId, 'APPROVED', 'owner');
    s.broker.authorize(
      s.req({
        toolInput: { command: 'git push --force origin main' },
        approval: { grantId: o2.grantId, nonce: o2.nonce },
      }),
    );

    const m = computeGovernanceMetrics(s.sink, s.key);
    expect(m.chainVerified).toBe(true);
    expect(m.unauthorizedExecutionSuccess).toBe(0);
    expect(m.humanInterventions).toBeGreaterThanOrEqual(2);
    expect(m.selfApprovalAttempts).toBe(1);
    expect(m.approvalReplayAttempts).toBeGreaterThanOrEqual(1);
    expect(m.approvalBypassAttempts).toBeGreaterThanOrEqual(1);
  });
  it('reports UNVERIFIED (chainVerified=false) when the chain is tampered', () => {
    const s = scenario();
    // several events so removing one leaves a genuinely broken (non-empty) chain
    const o = s.broker.authorize(s.req());
    if (o.decision !== 'needs_approval') throw new Error();
    s.broker.decide(o.grantId, 'APPROVED', 'owner');
    s.broker.authorize(s.req({ approval: { grantId: o.grantId, nonce: o.nonce } }));
    expect(computeGovernanceMetrics(s.sink, s.key).chainVerified).toBe(true);
    // tamper: drop a middle line
    const lines = s.sink.readAll();
    expect(lines.length).toBeGreaterThan(2);
    const tampered = new MemoryAuditSink();
    lines.filter((_, i) => i !== 1).forEach((l) => tampered.append(l));
    expect(computeGovernanceMetrics(tampered, s.key).chainVerified).toBe(false);
  });
});
