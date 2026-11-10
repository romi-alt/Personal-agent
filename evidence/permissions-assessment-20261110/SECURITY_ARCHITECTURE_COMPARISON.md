# Security architecture comparison: three isolation options for this host

Host facts that drive the decision (measured 2026-11-10):
- Windows 11 Pro 26300, 8 logical CPUs, **8.4 GB RAM, about 1.2 GB free** with production idle. The production memory gate (MIN 1024 / RESUME 1536 MB) already defers work.
- A hypervisor is present (WSL2/VMP). The Hyper-V and Windows Sandbox feature state could not be read without elevation.
- Smart App Control is enforced: it blocks unsigned locally built executables.
- Disks:
  - NVMe 1 TB: C: 391 GB (309 free), D: 145 GB (24 free), E: 414 GB (381 free).
  - HDD: F: 298 GB.
- E:\ and F:\ grant `Authenticated Users: Modify`. C:\ and D:\ have the Windows default (AU may create root folders, and those folders inherit AU:Modify).

## Option A: dedicated NTFS staging volume (alone)

A separate partition or a VHDX mounted at `C:\ElevariqStaging`, with a clean root ACL. The worker only writes there.

**Key point:** a staging volume controls **where the worker writes**, not **what the worker can reach**. On its own it changes nothing about P1/P2. The worker is still an Authenticated User and can still write `E:\Agent\Personal-agent`. It is a useful **container**, not an isolation boundary.

## Option B: dedicated Windows virtual machine (Hyper-V, or Windows Sandbox)

The worker runs in a guest OS with no shared folders. The host's E:/F: are unreachable unless explicitly mapped. Separate kernel, separate SAM and separate network stack (NAT plus host firewall/proxy).

It is the strongest boundary, but:
- A Windows 11 guest needs ≥4 GB RAM for Node, git and the Claude CLI. A Linux guest needs about 2 GB. **This host has about 1.2 GB free**, so either guest would starve production (the memory gate already pauses it).
- Windows Sandbox is disposable, which means the worker's Claude login (G12) is lost at every start.
- A full VM also needs its own OS patching and toolchain, and Claude login state inside the guest.
- Shared folders and Enhanced Session re-introduce host exposure if they are used.

## Option C: carefully scoped ACL restrictions

The worker identities (worker, and broker as well) join a new local group `ElevariqIsolatedIdentities`. That group receives an **inheritable DENY Full** at the roots of E:\ and F:\, and an explicit DENY on `D:\src`, `D:\Intel`, `C:\Download` and `C:\Intel`. Before that, explicit broad allows (P4) are removed and a file-level sweep is done.

- **Zero impact on existing principals,** because the group is empty until the worker is added.
- Reversible by removing one ACE per root.
- Weaknesses:
  - A DENY fails open on children that have an explicit broad allow or a protected DACL. A sweep plus periodic re-tests mitigate this.
  - New volumes need the same ACE.
  - The worker shares the kernel.

Variant **C′ (allow-list)**: replace `AU:M` and `Users:RX` on E:\ and F:\ with an explicit grant to the owner SID. This fails closed for **all** non-owner principals and also closes the pre-existing T3 path. It is a bigger change to production ACLs, and other software or services that read E: may break. Recommended later, as hardening.

## Scoring (5 = best)

| Criterion | A: staging volume alone | B: VM | C: scoped ACL (group DENY) | **Recommended: C + A + separate broker identity + SID egress** |
|---|---|---|---|---|
| Confidentiality (prod, owner data) | 1: no effect on E:/F: reach | 5 | 4: fail-open edge cases need sweeps | 4 |
| Integrity (prod code, task, broker, audit) | 1 | 5 | 4 | 4–5: the broker gets its own identity and an admin-only code dir |
| Availability (production keeps running) | 4: size cap protects C: | **1: RAM starvation of production** | 4: empty group means no impact; propagation is a one-off metadata write | 4 |
| Rollback complexity | 5: dismount and delete the VHDX | 4: delete the VM; but guest state and login are lost | 4: `/remove:d` of one ACE per root (auto-propagates) + SDDL backups | 4 |
| Resource consumption | 5 | 1: 2–4 GB RAM, 30–64 GB disk, guest licence | 5 | 5 (VHDX is dynamic) |
| Operational maintenance | 4 | 2: second OS to patch, toolchain, login | 3: re-sweep after new folders or drives | 3 |
| Residual: shared kernel | yes | **no** | yes | yes |
| Works with Smart App Control, no unsigned binaries | yes | yes | yes | yes (no custom launcher) |

Options considered and **not** recommended as primary:
- **AppContainer/LPAC.** Deny-by-default, so E: is unreachable without an `ALL APPLICATION PACKAGES` ACE. But the earlier measurement showed node piped spawns spinning at 100% CPU, and Smart App Control blocks an unsigned launcher.
- **Low integrity level.** A low-labelled `node.exe` copy would block all writes to Medium objects without any ACL change. That protects **integrity only, not confidentiality**, and it breaks tools that write to HKCU, `%TEMP%` or npm caches. Optional defense in depth, gated on its own tests.

## Recommendation

Use **C + A**, with a separately-identified broker and SID-scoped egress:

1. **Group DENY** (C) on E:\, F:\ and the four AU-modifiable root folders on C:/D:. Before applying it: remove P4 and run a **file**-level sweep.
2. **A size-capped VHDX staging volume** (A), mounted at `C:\ElevariqStaging`, with a protected root ACL (no AU, no Users). This also fixes finding F-10a, where the root would otherwise inherit AU:M from C:\.
3. **A broker under its own identity `elv-stg-broker`.** It is a member of the deny group and is neither the worker nor the owner. Its code lives in a directory that only Administrators can write. Its HMAC key is protected with DPAPI under the broker identity. Owner approvals arrive through a spool directory that only the owner can write, and the broker verifies the file-owner SID.
4. **SID-scoped egress for the worker:** a block rule on the complement of the allowlist (IPv4 and IPv6), plus a loopback egress proxy that enforces the hostname allowlist.
5. **Do not enable any worker identity until 1–2 are applied and the adversarial matrix passes on a real account.**

**Option B is the target state** for unattended production-scale autonomy. It becomes practical once the host has at least 16 GB RAM, or when the worker moves to a separate machine (for example the Phase 6 Linux VPS). Until then, this plan is the safest *practical* choice. Its residual risk is the shared kernel.
