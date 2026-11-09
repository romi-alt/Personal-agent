/**
 * Append-only, hash-chained, signed audit log (V2.1 trusted-execution).
 *
 * Each event carries a monotonic sequence number and the hash of the previous event; the chain hash is signed with an
 * HMAC key. Verification recomputes the chain and the signatures, so any insertion, deletion, reordering or edit is
 * detectable WITHOUT the key, and forging a new valid tail is infeasible WITHOUT the key.
 *
 * SCOPE AND HONEST LIMITS:
 *  - Tamper-EVIDENCE only: a same-user attacker can still delete or rewrite the whole file, but cannot produce a file
 *    that VERIFIES unless they also hold the signing key.
 *  - The protection is real only when the signing key and the log live under a separate identity the worker cannot
 *    read or write. On this machine that is NOT yet true (same-user). The key here is SYNTHETIC and the guarantee is
 *    "tamper-evident given key secrecy", which is not satisfied same-user. See docs AUDIT_INTEGRITY_ARCHITECTURE.md.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical.js';

export interface AuditEvent {
  seq: number;
  at: number;
  type: string;
  /** Redacted payload (redaction happens before this layer; see redact.ts). */
  data: Record<string, unknown>;
  /** Hash of the previous event's `entryHash`; the genesis uses GENESIS_PREV. */
  prevHash: string;
  /** sha256 over the canonical event body (everything except signatures/entryHash). */
  entryHash: string;
  /** HMAC-SHA256(entryHash) under the signing key. */
  signature: string;
}

export const GENESIS_PREV = '0'.repeat(64);

function entryBody(e: Omit<AuditEvent, 'entryHash' | 'signature'>): string {
  return canonicalJson({ seq: e.seq, at: e.at, type: e.type, data: e.data, prevHash: e.prevHash });
}

export interface AuditSink {
  /** Durable append of one event line. Must be append-only at the storage layer where possible. */
  append(line: string): void;
  /** All event lines in order. */
  readAll(): string[];
}

/** In-memory sink for tests; production uses a file sink owned by the broker identity. */
export class MemoryAuditSink implements AuditSink {
  private lines: string[] = [];
  append(line: string): void {
    this.lines.push(line);
  }
  readAll(): string[] {
    return [...this.lines];
  }
}

export class AuditChain {
  private lastHash: string;
  private nextSeq: number;

  constructor(
    private readonly sink: AuditSink,
    private readonly signingKey: Buffer,
    private readonly now: () => number,
  ) {
    const existing = sink.readAll();
    if (existing.length === 0) {
      this.lastHash = GENESIS_PREV;
      this.nextSeq = 0;
    } else {
      const last = JSON.parse(existing[existing.length - 1]!) as AuditEvent;
      this.lastHash = last.entryHash;
      this.nextSeq = last.seq + 1;
    }
  }

  private sign(entryHash: string): string {
    return createHmac('sha256', this.signingKey).update(entryHash).digest('hex');
  }

  /** Append one event. Returns it. The chain and signature are computed here; callers cannot forge them. */
  append(type: string, data: Record<string, unknown>): AuditEvent {
    const base = { seq: this.nextSeq, at: this.now(), type, data, prevHash: this.lastHash };
    const entryHash = sha256Hex(entryBody(base));
    const event: AuditEvent = { ...base, entryHash, signature: this.sign(entryHash) };
    this.sink.append(JSON.stringify(event));
    this.lastHash = entryHash;
    this.nextSeq += 1;
    return event;
  }

  /** A signed checkpoint over the current head: seq and head hash, signed. Store it separately for recovery. */
  checkpoint(): { seq: number; headHash: string; at: number; signature: string } {
    const at = this.now();
    const headSeq = this.nextSeq - 1;
    const body = canonicalJson({ kind: 'checkpoint', seq: headSeq, headHash: this.lastHash, at });
    const h = sha256Hex(body);
    return { seq: headSeq, headHash: this.lastHash, at, signature: this.sign(h) };
  }
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  /** First problem found, if any. */
  error?: string;
  /** Sequence number where verification failed. */
  failedAtSeq?: number;
}

/** Recompute the chain and verify every signature. Detects edits, deletions, insertions and reordering. */
export function verifyChain(sink: AuditSink, signingKey: Buffer): VerifyResult {
  const lines = sink.readAll();
  let prev = GENESIS_PREV;
  let expectedSeq = 0;
  for (const line of lines) {
    let e: AuditEvent;
    try {
      e = JSON.parse(line) as AuditEvent;
    } catch {
      return { ok: false, count: expectedSeq, error: 'unparseable event line', failedAtSeq: expectedSeq };
    }
    if (e.seq !== expectedSeq)
      return {
        ok: false,
        count: expectedSeq,
        error: `sequence gap (expected ${expectedSeq}, got ${e.seq})`,
        failedAtSeq: expectedSeq,
      };
    if (e.prevHash !== prev)
      return { ok: false, count: expectedSeq, error: 'broken hash chain', failedAtSeq: e.seq };
    const recomputed = sha256Hex(entryBody(e));
    if (recomputed !== e.entryHash)
      return { ok: false, count: expectedSeq, error: 'event body was altered', failedAtSeq: e.seq };
    const expectedSig = createHmac('sha256', signingKey).update(e.entryHash).digest('hex');
    const a = Buffer.from(expectedSig, 'hex');
    const b = Buffer.from(e.signature, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return { ok: false, count: expectedSeq, error: 'invalid signature', failedAtSeq: e.seq };
    prev = e.entryHash;
    expectedSeq += 1;
  }
  return { ok: true, count: expectedSeq };
}
