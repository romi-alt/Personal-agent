# Blocker B1: root cause and fix (r3, 2026-11-10)

## The finding

From the independent r2 review: the sweep flags an explicit broad ALLOW only when it is **not inherit-only**, and the
protected-DACL test uses `Get-ElvEffectiveMask`, which skips inherit-only ACEs. So a folder whose only broad ACE is
inherit-only (for example `Everyone:(OI)(CI)(IO)F`, or a protected DACL whose single broad ACE is inherit-only)
produces **no sweep finding**. After `00 -Apply`, a child of that folder inherits the broad ALLOW from the **nearer**
ancestor, which sorts **before** the group DENY inherited from the volume root. The worker's effective access on that
child is Full. The sweep reported 0 findings; the DENY-ACE presence check still passed, so r2 reported success.

## Why it mattered

An inherited DENY is the entire isolation mechanism. Windows evaluates a DACL in order and stops at the first ACE that
grants or denies the requested access. An **explicit or nearer-inherited ALLOW is evaluated before a farther-inherited
DENY.** An inherit-only ALLOW on a parent does not apply to the parent itself (so the parent looked clean), but it
**does** flow to the parent's children as a normal inherited ALLOW, reaching them ahead of the root DENY. The r2 sweep
was blind to exactly the ACEs that defeat the control.

## The r2 code (reviewed hash `126d700c…`, `00-isolation-group-deny.ps1:87-89`)

```powershell
$explicitBroad = @($aces | Where-Object { -not $_.Inherited -and -not $_.InheritOnly -and $_.Type -eq 'AccessAllowed' -and ($script:BroadSids -contains $_.Sid) })
if ($explicitBroad.Count) { & $emit $fp 'explicit-broad-allow' ... }
if ($acl.AreAccessRulesProtected -and (Get-ElvEffectiveMask $fp $script:BroadSids -Aces $aces) -ne 0) { & $emit $fp 'protected-with-broad-access' $sddl }
```

`-not $_.InheritOnly` drops the dangerous ACE. `Get-ElvEffectiveMask` skips inherit-only ACEs (correct for the object
itself, wrong as a sweep gate), so the protected test misses an inherit-only broad ACE too.

## The r3 fix (`_common.ps1`, `Get-ElvAclClassification`)

Classification runs on the parsed DACL and is a pure function of the SDDL, so it is unit-testable with synthetic
descriptors and needs no live object:

```powershell
$explicitBroad = @($aces | ? { -not $_.Inherited -and $_.Type -eq 'AccessAllowed' -and $_.Mask -ne 0 -and ($BroadSids -contains $_.Sid) })
# ^ NO InheritOnly filter: a non-inherited broad ALLOW counts whether or not it is inherit-only.
if (Test-ElvDaclProtected $Sddl) {
    $anyBroad = @($aces | ? { $_.Type -eq 'AccessAllowed' -and $_.Mask -ne 0 -and ($BroadSids -contains $_.Sid) })
    # ^ any broad ALLOW on a protected DACL, inherit-only included.
}
```

The sweep (`Invoke-ElvSweep`) calls this for every item. The broad-SID set is also widened (L5): NTLM, asserted
identity, NETWORK, SERVICE, Guests, RDP users, plus any SID captured from the real worker's token.

But a static classifier is still not the Windows access check. So r3 adds a second, independent gate.

## Defence in depth: per-object post-DENY verification (H1)

`00 -Verify` walks every object after the DENY and requires the modelled worker-token effective mask to be **0**
(`Invoke-ElvObjectVerify`). It is chunkable and state-recorded; `00 -Verify -Finalize` checks coverage against the live
top level of every target and writes `verify-complete.json`. The `06` gate refuses to enable the worker unless that
file is complete, newer than the apply, and matched to the apply reference. This catches a B1-class ACL that somehow
survived, and any object the propagation silently skipped.

## The required acceptance step

r3 deliberately does **not** claim the evaluator reproduces the Windows access-check algorithm. Final acceptance is a
real access check under the restricted worker identity (ADVERSARIAL_ACCEPTANCE_MATRIX.md), independently reviewed. The
model is a pre-flight and a tripwire, not the boundary.

## Reproduction: the test fails on the old implementation and passes on the fixed one

`tests\Test-R3.ps1` builds a synthetic fixture (`tests\Fixture-AclCases.ps1`) under the owner's protected profile and
runs **three** checks on the reviewer's counterexample, folder `X` with an explicit `Everyone:(OI)(CI)(IO)F`:

1. **Pure SDDL (§F).**
   - `B1 OLD filter misses the explicit inherit-only Everyone:F` — the verbatim r2 filter returns 0 on
     `D:AI(A;OICIIO;FA;;;WD)(A;ID;0x1301bf;;;AU)`.
   - `B1 NEW classification flags it as explicit-broad-allow (IO)` — r3 returns one finding, detail
     `S-1-1-0:0x1F01FF(IO)(inheritable)`.
   - The protected variant (`P`, `D:PAI(A;OICIIO;…;BU)…`): old effective-mask test returns 0; r3 flags
     `protected-with-broad-access`.

2. **On-disk sweep vs the real r2 code (§G).** The r3 sweep over the fixture flags `X` as `explicit-broad-allow`. A
   child process runs the **verbatim r2 filter** (copied from hash `126d700c…`, `tests\r2-baseline-check.ps1`) over the
   same fixture and shows `X NOT flagged` and `P NOT flagged`, while `O` (a non-inherit-only explicit allow, which r2
   always caught) **is** flagged by both. This is the rejected behaviour reproduced on disk beside the fix.

3. **Per-object verification + a REAL Windows access check (§G).** With a modelled token:
   - `V3: X\c.txt EXPOSED` and `V3: nested X\deep\deeper\f.txt EXPOSED` — the child mask is non-zero.
   - `V3: X itself NOT exposed` — the inherit-only ACE does not apply to `X`.
   - `V3: O\g.txt NOT exposed` — an explicit DENY on `O` (the `-AdditionalDenyPaths` remedy) sorts first.

   And a genuine open, with the runner's own token, against a parallel fixture whose ancestor DENY uses
   `S-1-5-113` (a SID actually in that token):
   - `REAL: real\X\c.txt open-for-read ALLOWED despite the ancestor DENY` — the counterexample, demonstrated by
     Windows, not modelled.
   - `REAL: real\X\c.txt open-for-write ALLOWED too` — Full, not just read.
   - `REAL: real\N\e.txt DENIED` — the DENY works where nothing precedes it (positive control).
   - `REAL: real\O\g.txt DENIED` — the explicit-DENY remedy works.
   - `REAL agrees with the model on every real\ case` — the model's prediction matches Windows where the ACL is
     readable.

All 182 checks in `Test-R3.ps1` pass; the fixture is removed with zero residue; production is untouched (task Running,
supervisor alive by command line, HEAD `e60278f`).

## Consequence for the sweep already run

The full chunked sweep of 2026-11-10 (39/39 chunks, 347,509 items) used the defective r2 filter. It is therefore
**incomplete** and must be re-run with the r3 logic, **elevated**, chunked, production idle, before any `00 -Apply`.
`SWEEP_REPORT_20261110.md` already carries this downgrade. r3's `00 -Sweep -Finalize` records whether every chunk was
elevated and whether coverage is complete; `-Apply -UseFinalizedSweep` refuses a sweep that is not both.
