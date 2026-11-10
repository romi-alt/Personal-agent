# Trusted installation chain (H2, r3, 2026-11-10)

The elevated admin scripts must run only from a copy that no non-administrator can alter, verified against a value the
attacker cannot write. r2 failed this: the manifest sat beside the scripts, was written by the same non-elevated
process, `-ApprovedSums` was optional, and the frozen copy was owner-writable (the production task runs as the owner,
Limited, so the production agent or any npm dependency it runs could rewrite the scripts and the manifest together).

## The anchor is out of band

The only trust input r3 accepts for `-Apply` is `-ApprovedManifestHash`: the SHA-256 of the canonical `SHA256SUMS`,
obtained from the independent review hand-back (R3_INDEPENDENT_REVIEW_REQUEST.md / the reviewer's message), **not** from
any file on E:\ and **not** from any file the non-elevated owner can write. It is mandatory for every `-Apply`.

For the r3 candidate under review, the canonical manifest and its hash are:

```
MANIFEST_HASH (SHA-256 of SHA256SUMS) = a4ccaababf552b7aa289d5856ef32df93ee83d726646cfbeb9b63804c5f10c9b
```

The per-file hashes are in `admin-scripts-r3-20261110\REVIEW_SHA256SUMS`. The reviewer must confirm **both** the
per-file list and this manifest hash out of band before any freeze.

## Canonical manifest form

`SHA256SUMS` is `'<sha256 lowercase>  <name>'` per `*.ps1`, **ordinal-sorted by name**, LF line endings, one trailing
LF, ASCII. `Get-ElvCanonicalManifest` produces exactly this and `Assert-ElvTrustedScriptLocation` rejects any
`SHA256SUMS` that is not byte-for-byte canonical (so a CRLF or reordered manifest cannot slip through). This makes the
manifest hash deterministic across machines.

## Freeze (A1, owner, ELEVATED)

`Freeze-AdminScripts.ps1 -ApprovedSums <path>`:

1. Refuses unless elevated (so it can set an admin-only DACL the owner's own token cannot later weaken).
2. `-ApprovedSums` is mandatory; the **source** files must match it exactly, so a file swapped on E:\ after review is
   refused before it is ever copied.
3. Copies the `*.ps1` to `<owner>\ElevariqAdmin\trusted\scripts-r3-<ts>\` and writes a canonical `SHA256SUMS` there.
4. Sets `/inheritance:r  SYSTEM:(OI)(CI)F  Administrators:(OI)(CI)F  <owner>:(OI)(CI)RX` and
   `/setowner Administrators /T`. The owner gets **read/execute only**; no non-administrator can write the copy.
5. Re-hashes the copy and re-checks the admin-only predicate (`Test-ElvAdminOnlyWritable`), the same one `-Apply` uses.
6. Prints the manifest hash. The owner compares it with the out-of-band value.

## The admin-only predicate (every `-Apply`)

`Assert-ElvTrustedScriptLocation` refuses `-Apply` unless **all** hold:
- the folder, every `*.ps1`, and `SHA256SUMS` are owned by SYSTEM/Administrators and writable by **no other SID**,
  the owner SID included (`Test-ElvAdminOnlyWritable`, `RequireProtected` for the folder);
- `SHA256SUMS` is complete (lists exactly the present scripts), every hash matches, and it is canonical;
- `-ApprovedManifestHash` is 64 hex and equals the SHA-256 of `SHA256SUMS`.

In dry-run the same check is a **WARN**, never a silent PASS, so running a stage in dry-run from E:\ shows the warning.

## The step the code cannot do for you

The scripts cannot cryptographically verify themselves: a tampered copy would simply skip its own check (H2(b)). So the
procedure is: **in the elevated shell, before invoking any script**, the owner runs

```
Get-ChildItem <frozen>\*.ps1 | Get-FileHash -Algorithm SHA256
```

and compares the output against the out-of-band per-file list by eye. Only then does the owner run
`& <frozen>\00-… -Apply -ApprovedManifestHash <out-of-band hash>`.

## What this does and does not stop

- Stops: a non-elevated owner process (the production agent, an npm `postinstall`) rewriting the scripts or the manifest
  before an elevated run; a file swap on E:\ before freeze (caught by `-ApprovedSums`); a swap during the copy (the copy
  is re-hashed); a reordered or CRLF manifest; a stage run from an owner-writable location.
- Does not stop: an attacker who is **already** an administrator (outside the model — the owner is the root of trust);
  the owner skipping the manual eye-compare (procedure, not enforced).

## The approval path (related, I3, still open)

The broker accepts owner approvals from `spool\approvals`, which the owner has `M` on. But the **production agent also
runs as the owner** (Limited) and could write there; the broker's file-owner-SID check cannot distinguish the agent
from the human owner. The fix is either an owner-held signing key the agent cannot read, or writing approvals only from
an elevated owner session. Both are open design items, recorded here and in `04-broker-install.ps1`. Until one exists,
the broker's approval authenticity rests on an application-level boundary, not an OS one.
