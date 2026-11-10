# R3 test results (2026-11-10)

Suite: `admin-scripts-r3-20261110\tests\Test-R3.ps1`. Non-elevated, Windows PowerShell 5.1.26100.9818, free RAM ~1.6 GB,
run 2026-11-10 ~16:16 (+05:00). Full console log: `tests\test-r3-output.txt`; machine-readable: `tests\test-r3-results.json`.

## Headline

**182 checks, 182 pass, 0 fail.** Synthetic ACL fixtures built and removed with **zero residue** in the owner profile.
Production untouched throughout: task `ElevariqPersonalAgent` Running, supervisor found by command line (PID 8992),
`.git\HEAD` = `e60278f`; the E:\ and F:\ root SDDL, the `.env` SDDL, the local users, groups, Elevariq tasks and ELEVARIQ
firewall-rule count are identical before and after the run.

## By section

| Section | Checks | What it proves |
|---|---|---|
| A. r1/r2 regressions kept | 2 | the r1 interpolation bug and its fix stay covered |
| B. path guards (L1) | 20 | UNC/device/admin-share forms refused; staging/production/owner guards; M3 coverable-finding gate |
| C. IPv4 complement (L6) | 8 | merge/unaligned/invalid; leading-zero octal trap; empty complement refused |
| D. user-rights INF (L2/L3) | 6 | add/remove/idempotent; case-mismatch removal terminates (timed job); held-by-SID-or-name |
| E. spec semantics (M9/I4) | 8 | `WD-this`, `RX+D`, DENY/none; layout bin/requests/approvals specs; grant strings |
| F. B1 classification (pure SDDL) | 12 | **old filter misses inherit-only; new flags it**; protected IO-only; null DACL; ordering; generic rights; group membership; L5 SIDs |
| G. on-disk fixtures: sweep, r2 baseline, per-object verify, REAL opens | 48 | B1 reproduced on disk vs the verbatim r2 code; reviewer counterexample ALLOWED by Windows; explicit-DENY remedy DENIED; M9 request semantics; M1/M2 report+backup; H1 coverage |
| H. H2 trusted location + manifest | 11 | owner-writable copy → WARN/refused; missing/wrong/non-canonical manifest refused; tamper caught; Freeze non-elevated refused; every script exposes `-ApprovedManifestHash` |
| I. H4/L4/H5/I1/I2 | 15 | firewall bound to current SID (stale/substring rejected, exact address set); ADSI groups fail closed; shadow UNKNOWN fail-closed; owner by fixed SID; supervisor by command line, no git.exe, no hard-coded PID |
| J. real objects (read-only) | 4 | E:\ broad-writable today; owner profile closed; no group DENY yet; `$RECYCLE.BIN` broad today |
| K. 00 modes + 06 gate (dry-run) | 10 | mode-combination guards; `-ListShadows` fails closed; chunk record + coverage FAIL; **06 gate G5/G8 fail closed** |
| L. parse + dry-run + no-change | 38 | 12 scripts parse; 16 dry-runs write a dry-run report with no applied change and no error; 7 system-state fields unchanged; production untouched |

## The three evidence tests that matter most

1. **`B1 OLD filter misses the explicit inherit-only Everyone:F`** passes — i.e. the reviewer's rejected logic is
   reproduced and shown blind — while **`B1 NEW classification flags it`** and **`sweep r3: X … explicit-broad-allow`**
   pass. The verbatim r2 classifier (child process, hash `126d700c…`) on the same fixture shows `X NOT flagged`.
2. **`REAL: real\X\c.txt open-for-read ALLOWED despite the ancestor DENY`** (and `… open-for-write ALLOWED too`) passes:
   a genuine Windows access check, with a token that actually contains the denied SID, confirms the counterexample is
   reachable, not just modelled. The positive controls (`real\N\e.txt DENIED`, `real\O\g.txt DENIED`) pass too.
3. **`06 gate dry-run: G5 (verify-complete) and G8 (shadows) FAIL closed`** passes: the worker cannot be enabled without
   a completed per-object verification and a cleared shadow-copy check.

## What the suite does NOT cover (by design)

- No `-Apply` path runs: no ACL change, diskpart, secedit, account/task/firewall creation, live archive or stop.
- The per-object model is a DACL evaluation of the object, not the Windows access check; the real-token acceptance
  matrix (ADVERSARIAL_ACCEPTANCE_MATRIX.md) is not run (no worker account).
- The elevated sweep/verify over the ~350k live objects on E:/F:/C:/D: is not run.

## Reproduce

```
cd E:\Agent\v2-staging\worker-isolation\admin-scripts-r3-20261110
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Test-R3.ps1
```

The last line prints `TEST-R3 pass=182 fail=0`. The run is read-only apart from fixtures it creates under
`%LOCALAPPDATA%\ElevariqR3Fixtures` and removes, and reports under `reports\` / `state\` beside the scripts.
