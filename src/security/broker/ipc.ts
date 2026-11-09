/**
 * Trusted IPC interface to the broker (V2.1 trusted-execution).
 *
 * The worker never calls the broker in-process; it sends a typed, size-bounded, authenticated request over a
 * transport. This module is transport-agnostic: the server validates and dispatches; a Windows named-pipe transport
 * (design in docs) plugs in underneath. Kept transport-agnostic so the validation logic is unit-testable without
 * admin rights or a real pipe.
 *
 * CRITICAL CAVEAT (documented, not worked around): a named pipe whose ACL admits the worker's SID does NOT separate
 * two processes that run under the SAME SID. Caller-SID verification is only meaningful once the worker runs under a
 * DISTINCT Windows account. Until then, treat the "authenticated caller" as advisory. See docs TRUSTED IPC section.
 */
import { ApprovalBroker, type BrokerOutcome, type BrokerRequest } from './broker.js';

export const MAX_REQUEST_BYTES = 64 * 1024;

export type IpcResponse = { ok: true; outcome: BrokerOutcome } | { ok: false; error: string };

export interface IpcServerDeps {
  broker: ApprovalBroker;
  /** Verify the OS identity of the caller against the claimed workerId. Returns null if acceptable, else a reason. */
  verifyCaller: (claimedWorkerId: string, callerSid: string | null) => string | null;
  now: () => number;
  /** Reject requests older/newer than this skew (ms) to bound replay windows. */
  maxClockSkewMs?: number;
}

/** Minimal runtime validation of an untrusted request object. Returns a reason string on failure, else null. */
export function validateRequestShape(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'request is not an object';
  const r = value as Record<string, unknown>;
  const str = (k: string) => typeof r[k] === 'string' && (r[k] as string).length > 0;
  for (const k of [
    'workerId',
    'taskId',
    'executionId',
    'projectId',
    'tool',
    'cwd',
    'policyVersion',
    'requestId',
  ])
    if (!str(k)) return `missing or invalid field: ${k}`;
  if (typeof r['toolInput'] !== 'object' || r['toolInput'] === null) return 'missing toolInput';
  if (typeof r['at'] !== 'number') return 'missing at';
  if (r['category'] !== null && typeof r['category'] !== 'string') return 'invalid category';
  if (r['target'] !== null && typeof r['target'] !== 'string') return 'invalid target';
  if (r['approval'] !== undefined) {
    const a = r['approval'];
    if (typeof a !== 'object' || a === null) return 'invalid approval';
    const ap = a as Record<string, unknown>;
    if (typeof ap['grantId'] !== 'string' || typeof ap['nonce'] !== 'string')
      return 'invalid approval fields';
  }
  return null;
}

export class BrokerIpcServer {
  constructor(private readonly d: IpcServerDeps) {}

  /**
   * Handle one raw request frame. `callerSid` is the OS-verified SID of the connecting process (null when the
   * transport cannot provide it, e.g. in-process tests). Fails closed on every validation error.
   */
  handle(rawBytes: Buffer | string, callerSid: string | null): IpcResponse {
    const text = typeof rawBytes === 'string' ? rawBytes : rawBytes.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) return { ok: false, error: 'request too large' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: 'malformed JSON' };
    }
    const shapeError = validateRequestShape(parsed);
    if (shapeError) return { ok: false, error: shapeError };
    const req = parsed as BrokerRequest;

    const skew = this.d.maxClockSkewMs ?? 60_000;
    if (Math.abs(this.d.now() - req.at) > skew)
      return { ok: false, error: 'request timestamp outside allowed skew' };

    const callerError = this.d.verifyCaller(req.workerId, callerSid);
    if (callerError) return { ok: false, error: `caller identity rejected: ${callerError}` };

    try {
      return { ok: true, outcome: this.d.broker.authorize(req) };
    } catch (err) {
      // Fail closed: an internal error is a denial, never an allow.
      return { ok: false, error: `broker error (fail-closed): ${(err as Error).message}` };
    }
  }
}
