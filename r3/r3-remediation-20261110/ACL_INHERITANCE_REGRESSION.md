# ACL inheritance regression tests (r3, 2026-11-10)

How r3 tests ACL scanning and evaluation across the cases the remediation brief named: inherit-only ACEs, object and
container inheritance, inheritance protection, explicit ALLOW and DENY, group membership, effective token permissions,
ACE ordering, and nested directories. All tests are non-elevated and change no system object.

## Three layers, so a single-layer mistake cannot pass

1. **Pure SDDL unit tests** (`Test-R3.ps1` §F): `Get-ElvAclClassification`, `Get-ElvEffectiveMask`, `Get-ElvAces` over
   hand-written descriptors. No disk, deterministic.
2. **Synthetic on-disk fixtures** (`tests\Fixture-AclCases.ps1`, `Test-R3.ps1` §G): real NTFS ACLs built under
   `%LOCALAPPDATA%\ElevariqR3Fixtures` (the owner's protected profile, so broad groups have no inherited access).
   Two sub-trees:
   - `model\` — the DENY principal is a **fake group SID** not in any token, so the runner can walk it and the sweep /
     per-object model can be checked as a configuration model.
   - `real\` — the DENY principal is `S-1-5-113` ("Local account"), which **is** in the runner's token, so a genuine
     open-for-read with the runner's own token shows whether **Windows** allows or denies. The runner is not the
     worker; this proves the ACL *mechanism*, not the worker's isolation.
3. **r2-baseline comparison** (`tests\r2-baseline-check.ps1`): the **verbatim** r2 classifier (copied from the rejected
   hash `126d700c…`) run in a child process over the same fixture, so the regression is shown against the exact code
   that was rejected.

## Coverage against the brief

| Case the brief named | Fixture | What is asserted |
|---|---|---|
| **Inherit-only ACEs** | `model\X` = `Everyone:(OI)(CI)(IO)F`; `real\X` same with `S-1-5-113` | r3 flags `X` (`explicit-broad-allow (IO)`); r2 does **not** (B1). `X` itself not exposed (IO doesn't apply to the object); its children exposed. REAL: `real\X\c.txt` open **ALLOWED**. |
| **Object + container inheritance** | `(OI)(CI)` on `X`; children `X\c.txt`, `X\deep\deeper\f.txt` | both the file and the nested file inherit the ALLOW and are `exposed`; demonstrates OI (files) and CI (dirs) propagation. |
| **Inheritance protection** | `model\P` protected with IO-only `Users:M`; `model\Q`, `X\deep\locked` protected owner-only | `P` → `protected-with-broad-access` (r3) but **not** flagged by r2; `Q` and `locked` → no finding and not exposed (protection with no broad ACE stops the exposure). |
| **Explicit ALLOW and DENY** | `model\O` = explicit `Everyone:F` then explicit DENY(fake group); `real\O` = explicit `Everyone:F` + explicit DENY(`S-1-5-113`) | `O` flagged `explicit-broad-allow` by **both** r2 and r3 (always caught); but `O\g.txt` **not exposed** / REAL **DENIED**, because an explicit DENY on `O` sorts before its own explicit allow — this is the `-AdditionalDenyPaths` remedy, shown to work. |
| **Group membership** | `Get-ElvEffectiveMask` with and without `S-1-5-32-545` in the SID set; `real\` denies `S-1-5-113` which is in the runner token | mask depends on the SID set; a non-member SID is ignored; the real DENY bites because the SID is in the token. |
| **Effective Windows token permissions** | `real\` open-for-read/write with the runner's token | `REAL agrees with the model on every real\ case`: the modelled mask predicts the real open result wherever the ACL is readable. Where the DENY blocks even ACL read (`O`, `locked`), the real open (DENIED) is the evidence and the model is not consulted — this is exactly why final acceptance must read ACLs/probes **elevated / as the worker**. |
| **ACE ordering** | synthetic `D:(D;;FA;;;WD)(A;;FA;;;WD)` vs `D:(A;;FA;;;WD)(D;;FA;;;WD)` | deny-before-allow → 0; allow-before-deny → Full. Confirms ordered evaluation. |
| **Nested directory structures** | `X\deep\deeper\f.txt`, `X\deep\locked\l.txt` | exposure flows to arbitrary depth; a protected cut (`locked`) stops it. |

## The reviewer's Full-access counterexample

`real\X\c.txt`: an inherit-only `Everyone:(OI)(CI)(IO)F` on `X`, a farther inherit-only DENY(`S-1-5-113`) on `real\`.
- The r2 filter returns **no finding** (reproduced live by `r2-baseline-check.ps1`: `X NOT flagged`).
- The r3 classifier flags it (`sweep r3: X … explicit-broad-allow`).
- The modelled worker mask on `c.txt` is **Full** (`V3: X\c.txt EXPOSED`).
- A real open with the runner's token **succeeds** for both read and write
  (`REAL: real\X\c.txt open-for-read ALLOWED …`, `… open-for-write ALLOWED too`).

So the test fails on the old implementation and passes on the corrected one, and the "it is actually reachable" claim
is backed by a genuine Windows access check, not only the model.

## Not claimed

The per-object model (`Get-ElvEffectiveMask`) is a DACL-only evaluation of the object itself. It does **not** include
privileges, mandatory labels, or owner-implicit rights, and it is **not** the Windows access-check algorithm. r3 uses
it as a sweep tripwire and a pre-flight. Acceptance requires the real worker token (ADVERSARIAL_ACCEPTANCE_MATRIX.md).

## Result

`Test-R3.ps1`: **182 pass, 0 fail** (see `tests\test-r3-output.txt`, `tests\test-r3-results.json`). Fixtures removed
with zero residue in the owner profile. Production untouched (task Running, supervisor alive, HEAD `e60278f`).
