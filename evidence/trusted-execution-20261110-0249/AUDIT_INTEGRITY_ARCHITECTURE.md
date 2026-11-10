# Audit integrity architecture

**Status: A — implemented and locally tested (application level). E — not tamper-proof against same-user code until the signing key and storage sit under a separate identity.**

## Design
`src/security/broker/audit-chain.ts`. Each event carries:
- a monotonic `seq` (0-based, no gaps),
- `prevHash` = the previous event's `entryHash` (genesis uses 64 zeros),
- `entryHash` = sha256 over the canonical body `{seq, at, type, data, prevHash}`,
- `signature` = HMAC-SHA256(`entryHash`) under a signing key.

`verifyChain` recomputes the whole chain and every signature. It detects, without the key:
- **edits** (body hash no longer matches),
- **deletions** (sequence gap / broken chain),
- **insertions and reordering** (broken chain),
- and rejects a **forged tail** unless the attacker also holds the signing key.

`checkpoint()` emits a signed `{seq, headHash, at}` for recovery; store it separately so a truncation of the live log is caught by comparing against the last checkpoint.

## Canonical serialization
`canonicalize`/`canonicalJson` sort object keys recursively, so the hash is independent of field order and incidental whitespace. The audit body and the action fingerprint both use it, so evidence is reproducible.

## Redaction before persistence
Redaction (`src/security/redact.ts`, hardened in the V2.1 assessment) runs **before** an event reaches this layer; the chain stores already-redacted data. The audit layer never sees raw secrets, so a secret cannot be sealed into the signed chain. The brokered path removes the pre-logger-stderr gap noted in the earlier assessment, because the broker is the writer, not a child process's stderr.

## Tests
`tests/unit/broker-approval.test.ts` (audit section) and `tests/unit/broker-governance.test.ts`:
- append → verify ok, count correct;
- edit, delete, reorder → verify fails at the right seq;
- forged tail without the key → fails;
- verifying under a different key → fails;
- governance metrics report `chainVerified=false` on a tampered chain, which marks every metric UNVERIFIED.

## Honest limitations (do not overstate)
- **Tamper-evidence, not tamper-proofing.** A same-user attacker can delete or rewrite the entire file; they simply cannot produce a file that *verifies* without the key. The value is detection, plus the inability to forge new valid history.
- **The guarantee holds only if the signing key is secret from the worker.** Today, same-user, the worker could read the key, so the property is currently "tamper-evident given key secrecy", which is **not satisfied**.
- **What makes it real:** the key and the log live under the broker/SYSTEM identity in `C:\ElevariqBroker`, which the ACL script (`02-configure-acls.ps1`) denies to the worker SID. That requires administrator authorization and is not applied.
- Independent backup of the chain to a location the worker cannot write is designed (broker root) and depends on the same identity separation.

## Required before claiming tamper-resistance (gates)
1. Worker runs under a distinct Windows account (script 01).
2. `C:\ElevariqBroker` (key + log) denies the worker SID and grants only owner/SYSTEM (script 02).
3. Independent verification job runs under owner/SYSTEM, not the worker.
4. Independent security review confirms the key never enters worker-readable memory or environment.
