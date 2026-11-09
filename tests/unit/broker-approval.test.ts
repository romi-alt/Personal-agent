/**
 * V2.1 trusted-execution: synthetic tests for the application-level approval broker, capability model, single-use
 * action-bound approvals, hash-chained signed audit, and the IPC validation layer. Nothing here is an OS boundary;
 * these verify the application logic. No real credential, pipe, account or system object is used.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  actionFingerprint,
  canonicalArgsFor,
  canonicalJson,
  type BoundAction,
} from '../../src/security/broker/canonical.js';
import {
  deriveCapability,
  canAccessPath,
  canRunExecutable,
  canReachHost,
} from '../../src/security/broker/capability.js';
import { ApprovalGrantStore, DEFAULT_GRANT_TTL_MS } from '../../src/security/broker/approval-grant.js';
import { AuditChain, MemoryAuditSink, verifyChain } from '../../src/security/broker/audit-chain.js';
import { ApprovalBroker, type BrokerRequest } from '../../src/security/broker/broker.js';
import { BrokerIpcServer, validateRequestShape, MAX_REQUEST_BYTES } from '../../src/security/broker/ipc.js';

const identity = (c: string) => c.replace(/\s+/g, ' ').trim();

function fakeNow() {
  const clock = { t: 1_800_000_000_000 };
  return { now: () => clock.t, advance: (ms: number) => (clock.t += ms), clock };
}
let counter = 0;
const newId = () => `grant_${(++counter).toString(36)}`;

const baseAction = (over: Partial<BoundAction> = {}): BoundAction => ({
  category: 'protected_branch_push',
  tool: 'Bash',
  canonicalArgs: { command: 'git push origin main' },
  target: 'origin/main',
  workerId: 'worker-1',
  taskId: 'task-1',
  projectId: 'proj-1',
  executionId: 'exec-1',
  cwd: 'C:/ws/proj',
  policyVersion: 'v1',
  ...over,
});

describe('canonical binding', () => {
  it('canonicalizes object key order so equal actions hash equally', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(actionFingerprint(baseAction())).toBe(actionFingerprint(baseAction()));
  });
  it('any meaningful change diverges the fingerprint', () => {
    const base = actionFingerprint(baseAction());
    expect(
      actionFingerprint(baseAction({ canonicalArgs: { command: 'git push --force origin main' } })),
    ).not.toBe(base);
    expect(actionFingerprint(baseAction({ target: 'origin/other' }))).not.toBe(base);
    expect(actionFingerprint(baseAction({ workerId: 'worker-2' }))).not.toBe(base);
    expect(actionFingerprint(baseAction({ taskId: 'task-2' }))).not.toBe(base);
    expect(actionFingerprint(baseAction({ cwd: 'C:/ws/other' }))).not.toBe(base);
    expect(actionFingerprint(baseAction({ policyVersion: 'v2' }))).not.toBe(base);
  });
  it('canonicalArgsFor normalizes commands so cosmetic differences do not force re-approval', () => {
    const a = canonicalArgsFor('Bash', { command: 'git   push   origin main' }, identity);
    const b = canonicalArgsFor('Bash', { command: 'git push origin main' }, identity);
    expect(a).toEqual(b);
  });
});

describe('capability model (default-deny, task-scoped)', () => {
  const nowH = fakeNow();
  const cap = deriveCapability({
    projectId: 'proj-1',
    taskId: 'task-1',
    workerId: 'worker-1',
    workspaceDir: 'C:/ws/proj',
    tempDir: 'C:/tmp/task-1',
    readOnlyRefs: ['C:/ref/lib'],
    executables: ['node', 'git'],
    allowedHosts: ['registry.npmjs.org'],
    integrations: ['erp'],
    approvalCategories: ['protected_branch_push'],
    policyVersion: 'v1',
    now: nowH.now(),
  });
  it('permits writes in the workspace and temp, read-only in refs, denies elsewhere', () => {
    expect(canAccessPath(cap, 'C:/ws/proj/src/a.ts', 'write', nowH.now()).allow).toBe(true);
    expect(canAccessPath(cap, 'C:/tmp/task-1/x', 'delete', nowH.now()).allow).toBe(true);
    expect(canAccessPath(cap, 'C:/ref/lib/readme.md', 'read', nowH.now()).allow).toBe(true);
    expect(canAccessPath(cap, 'C:/ref/lib/readme.md', 'write', nowH.now()).allow).toBe(false);
    expect(canAccessPath(cap, 'C:/Users/Roman/.ssh/id_rsa', 'read', nowH.now()).allow).toBe(false);
  });
  it('allows only listed executables and hosts; loopback off by default', () => {
    expect(canRunExecutable(cap, 'C:/Program Files/nodejs/node.exe', nowH.now()).allow).toBe(true);
    expect(canRunExecutable(cap, 'powershell.exe', nowH.now()).allow).toBe(false);
    expect(canReachHost(cap, 'registry.npmjs.org', nowH.now()).allow).toBe(true);
    expect(canReachHost(cap, 'evil.example', nowH.now()).allow).toBe(false);
    expect(canReachHost(cap, '127.0.0.1', nowH.now()).allow).toBe(false);
  });
  it('denies everything after expiry', () => {
    const h = fakeNow();
    const c = deriveCapability({
      projectId: 'p',
      taskId: 't',
      workerId: 'w',
      workspaceDir: 'C:/ws',
      tempDir: 'C:/tmp',
      policyVersion: 'v1',
      now: h.now(),
      ttlMs: 1000,
    });
    h.advance(2000);
    expect(canAccessPath(c, 'C:/ws/a', 'read', h.now()).allow).toBe(false);
  });
});

describe('single-use, action-bound approval grants', () => {
  it('a grant approves exactly one action and cannot be replayed', () => {
    const h = fakeNow();
    const store = new ApprovalGrantStore(h.now, newId);
    const action = baseAction();
    const g = store.request(action);
    expect(g.state).toBe('PENDING');
    // cannot consume before approval
    expect(store.consume(g.id, g.nonce, action).ok).toBe(false);
    store.decide(g.id, 'APPROVED', 'owner');
    // first consume ok
    expect(store.consume(g.id, g.nonce, action).ok).toBe(true);
    // replay denied
    const replay = store.consume(g.id, g.nonce, action);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toMatch(/already used/);
  });
  it('a changed action does not match the approval', () => {
    const h = fakeNow();
    const store = new ApprovalGrantStore(h.now, newId);
    const g = store.request(baseAction());
    store.decide(g.id, 'APPROVED', 'owner');
    const tampered = baseAction({ canonicalArgs: { command: 'git push --force origin main' } });
    expect(store.consume(g.id, g.nonce, tampered).ok).toBe(false);
  });
  it('a wrong nonce is rejected even for the right action', () => {
    const h = fakeNow();
    const store = new ApprovalGrantStore(h.now, newId);
    const g = store.request(baseAction());
    store.decide(g.id, 'APPROVED', 'owner');
    expect(store.consume(g.id, randomBytes(32).toString('hex'), baseAction()).ok).toBe(false);
  });
  it('expires after its TTL and cannot be consumed', () => {
    const h = fakeNow();
    const store = new ApprovalGrantStore(h.now, newId);
    const g = store.request(baseAction());
    store.decide(g.id, 'APPROVED', 'owner');
    h.advance(DEFAULT_GRANT_TTL_MS + 1);
    const r = store.consume(g.id, g.nonce, baseAction());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });
  it('revocation and supersession invalidate a grant', () => {
    const h = fakeNow();
    const store = new ApprovalGrantStore(h.now, newId);
    const g1 = store.request(baseAction());
    store.decide(g1.id, 'APPROVED', 'owner');
    store.revoke(g1.id, 'owner', 'changed my mind');
    expect(store.consume(g1.id, g1.nonce, baseAction()).ok).toBe(false);
    // re-requesting the same action supersedes any prior live grant
    const g2 = store.request(baseAction());
    const g3 = store.request(baseAction());
    expect(store.get(g2.id)?.state).toBe('REVOKED');
    expect(store.get(g3.id)?.state).toBe('PENDING');
  });
});

describe('hash-chained signed audit', () => {
  it('appends a verifiable chain and detects edits, deletion and reordering', () => {
    const h = fakeNow();
    const key = randomBytes(32);
    const sink = new MemoryAuditSink();
    const chain = new AuditChain(sink, key, h.now);
    chain.append('a', { x: 1 });
    chain.append('b', { y: 2 });
    chain.append('c', { z: 3 });
    expect(verifyChain(sink, key).ok).toBe(true);
    expect(verifyChain(sink, key).count).toBe(3);

    // edit event 1's data
    const lines = sink.readAll();
    const edited = new MemoryAuditSink();
    const e1 = JSON.parse(lines[1]!);
    e1.data = { y: 999 };
    for (const [i, l] of lines.entries()) edited.append(i === 1 ? JSON.stringify(e1) : l);
    const r = verifyChain(edited, key);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/altered/);

    // delete the middle event
    const deleted = new MemoryAuditSink();
    lines.filter((_, i) => i !== 1).forEach((l) => deleted.append(l));
    expect(verifyChain(deleted, key).ok).toBe(false);

    // reorder
    const reordered = new MemoryAuditSink();
    [lines[0]!, lines[2]!, lines[1]!].forEach((l) => reordered.append(l));
    expect(verifyChain(reordered, key).ok).toBe(false);
  });
  it('a forged tail fails without the signing key, and the real key verifies', () => {
    const h = fakeNow();
    const key = randomBytes(32);
    const sink = new MemoryAuditSink();
    const chain = new AuditChain(sink, key, h.now);
    chain.append('a', {});
    // attacker without the key appends a plausible but wrongly-signed event
    const forged = new MemoryAuditSink();
    sink.readAll().forEach((l) => forged.append(l));
    const last = JSON.parse(sink.readAll()[0]!);
    forged.append(
      JSON.stringify({
        seq: 1,
        at: h.now(),
        type: 'forged',
        data: {},
        prevHash: last.entryHash,
        entryHash: 'deadbeef',
        signature: 'deadbeef',
      }),
    );
    expect(verifyChain(forged, key).ok).toBe(false);
    // verifying under a DIFFERENT key fails too (signatures are key-bound)
    expect(verifyChain(sink, randomBytes(32)).ok).toBe(false);
  });
  it('a signed checkpoint reflects the head', () => {
    const h = fakeNow();
    const key = randomBytes(32);
    const sink = new MemoryAuditSink();
    const chain = new AuditChain(sink, key, h.now);
    chain.append('a', {});
    chain.append('b', {});
    const cp = chain.checkpoint();
    expect(cp.seq).toBe(1);
    expect(cp.headHash).toHaveLength(64);
  });
});

function makeBroker() {
  const h = fakeNow();
  const key = randomBytes(32);
  const sink = new MemoryAuditSink();
  const audit = new AuditChain(sink, key, h.now);
  const grants = new ApprovalGrantStore(h.now, newId, (e) => audit.append(e.type, { grantId: e.grant.id }));
  const cap = deriveCapability({
    projectId: 'proj-1',
    taskId: 'task-1',
    workerId: 'worker-1',
    workspaceDir: 'C:/ws/proj',
    tempDir: 'C:/tmp/task-1',
    policyVersion: 'v1',
    now: h.now(),
    approvalCategories: ['protected_branch_push'],
  });
  const broker = new ApprovalBroker({
    capabilityFor: (id) => (id === 'task-1' ? cap : undefined),
    grants,
    audit,
    normalizeCommand: identity,
    now: h.now,
    isOwnerPrincipal: (p) => p === 'owner',
  });
  return { h, broker, grants, audit, sink, key };
}

const req = (over: Partial<BrokerRequest> = {}): BrokerRequest => ({
  workerId: 'worker-1',
  taskId: 'task-1',
  executionId: 'exec-1',
  projectId: 'proj-1',
  tool: 'Bash',
  toolInput: { command: 'git push origin main' },
  category: 'protected_branch_push',
  target: 'origin/main',
  cwd: 'C:/ws/proj',
  policyVersion: 'v1',
  requestId: `r-${Math.random()}`,
  at: 1_800_000_000_000,
  ...over,
});

describe('broker end to end', () => {
  it('consequential action needs approval; the owner approves; the worker consumes it once', () => {
    const { broker } = makeBroker();
    const out = broker.authorize(req());
    expect(out.decision).toBe('needs_approval');
    if (out.decision !== 'needs_approval') return;
    expect(broker.decide(out.grantId, 'APPROVED', 'owner').ok).toBe(true);
    const run = broker.authorize(
      req({ requestId: 'r-run', approval: { grantId: out.grantId, nonce: out.nonce } }),
    );
    expect(run.decision).toBe('allow');
    // replay with a new requestId but same consumed grant -> deny
    const replay = broker.authorize(
      req({ requestId: 'r-run2', approval: { grantId: out.grantId, nonce: out.nonce } }),
    );
    expect(replay.decision).toBe('deny');
  });
  it('the worker cannot approve its own request', () => {
    const { broker } = makeBroker();
    const out = broker.authorize(req());
    if (out.decision !== 'needs_approval') throw new Error('expected needs_approval');
    expect(broker.decide(out.grantId, 'APPROVED', 'worker-1').ok).toBe(false);
    expect(broker.decide(out.grantId, 'APPROVED', 'owner-cli').ok).toBe(false);
  });
  it('an approval for one command does not authorize a different command', () => {
    const { broker } = makeBroker();
    const out = broker.authorize(req());
    if (out.decision !== 'needs_approval') throw new Error();
    broker.decide(out.grantId, 'APPROVED', 'owner');
    const other = broker.authorize(
      req({
        requestId: 'r-other',
        toolInput: { command: 'git push --force origin main' },
        approval: { grantId: out.grantId, nonce: out.nonce },
      }),
    );
    expect(other.decision).toBe('deny');
  });
  it('a category the task did not pre-authorize is denied', () => {
    const { broker } = makeBroker();
    const out = broker.authorize(req({ category: 'production_deploy' }));
    expect(out.decision).toBe('deny');
  });
  it('duplicate requestId is rejected', () => {
    const { broker } = makeBroker();
    broker.authorize(req({ requestId: 'dup', category: null, toolInput: { command: 'ls' } }));
    const again = broker.authorize(req({ requestId: 'dup', category: null, toolInput: { command: 'ls' } }));
    expect(again.decision).toBe('deny');
  });
  it('mismatched worker/policy/project is denied; every decision is audited verifiably', () => {
    const { broker, sink, key } = makeBroker();
    expect(broker.authorize(req({ workerId: 'worker-2' })).decision).toBe('deny');
    expect(broker.authorize(req({ policyVersion: 'v2' })).decision).toBe('deny');
    expect(broker.authorize(req({ projectId: 'proj-9' })).decision).toBe('deny');
    expect(verifyChain(sink, key).ok).toBe(true);
  });
});

describe('IPC validation (fail-closed)', () => {
  const server = () => {
    const { broker } = makeBroker();
    return new BrokerIpcServer({
      broker,
      verifyCaller: (claimed, sid) => (sid === null || sid === claimed ? null : `sid ${sid} != ${claimed}`),
      now: () => 1_800_000_000_000,
    });
  };
  it('rejects malformed JSON, bad shapes and oversized frames', () => {
    const s = server();
    expect(s.handle('not json', null).ok).toBe(false);
    expect(s.handle(JSON.stringify({ tool: 'Bash' }), null).ok).toBe(false);
    expect(s.handle('x'.repeat(MAX_REQUEST_BYTES + 1), null).ok).toBe(false);
  });
  it('rejects a request whose timestamp is outside the skew window', () => {
    const s = server();
    const bad = JSON.stringify(req({ at: 1 }));
    expect(s.handle(bad, null).ok).toBe(false);
  });
  it('rejects a caller SID that does not match the claimed worker', () => {
    const s = server();
    const r = JSON.stringify(req({ category: null, toolInput: { command: 'ls' } }));
    expect(s.handle(r, 'worker-2').ok).toBe(false);
    expect(s.handle(r, 'worker-1').ok).toBe(true);
  });
  it('validateRequestShape catches each missing field', () => {
    expect(validateRequestShape(null)).toMatch(/not an object/);
    expect(validateRequestShape({})).toMatch(/workerId/);
  });
});
