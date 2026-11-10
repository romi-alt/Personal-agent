# Task capability model

**Status: A — implemented and locally tested (application level). B — the OS ACL is the real enforcement and is awaiting the admin scripts.**

## Principle
Default-deny. A task's worker has exactly the authority its capability grant lists, nothing more. Grants are task-scoped and non-inheritable: each task's grant is derived from its own project, workspace and assignment, never from another task.

## The grant (`src/security/broker/capability.ts`)
Every task declares:
- **Authorized project** (`projectId`) and **task** (`taskId`).
- **Worker identity** (`workerId`; the OS SID once separation exists).
- **Permitted directories** with per-directory operations (`read`/`write`/`delete`). Default: the workspace (rwd) and a task-private temp (rwd); read-only reference dirs optional.
- **Permitted executables** (base names). Default: none beyond the provider's own.
- **Network capability:** an allowed-host list and a loopback flag. Default: no hosts, loopback off.
- **Resource limits:** max processes, memory, wall-clock.
- **Integrations** (e.g. `erp`).
- **Approval categories** pre-authorized for the task (still require a bound single-use approval to execute).
- **Expiry** (absolute). After it, the grant authorizes nothing.
- **Policy version** the grant was derived under.

## Decisions
- `canAccessPath(cap, resolvedPath, op, now)` — the path must already be the real, canonical path (symlinks/junctions resolved) so a link cannot smuggle access past the lexical containment check. The **OS ACL remains the final boundary**; this is the model's view used by the broker and tools.
- `canRunExecutable`, `canReachHost`, `requiresApproval` — all default-deny, all expiry-checked.
- `deriveCapability` builds a fresh grant from task inputs only (non-inheritable by construction).

## Non-inheritance and self-modification
- A new task calls `deriveCapability` with its own inputs. There is no code path that copies another task's directories, hosts or approval categories.
- The grant is owned by the broker/supervisor. A worker cannot edit its own grant through the broker API; it can only *consume* authority, never *widen* it. (Same-user OS code can still edit the in-memory/stored grant until identity separation — documented limitation.)

## Tests (`tests/unit/broker-approval.test.ts`, capability section)
- Writes permitted in workspace/temp, read-only in refs, denied elsewhere (including `~/.ssh`).
- Only listed executables/hosts allowed; loopback off by default.
- Everything denied after expiry.

## Mapping to the policy categories
The existing `src/security/policy.ts` approval categories (`protected_branch_push`, `destructive_delete`, …) are the vocabulary of `approvalCategories`. The broker binds an approval to one of these **and** the exact action, closing the "approval = unrestricted category of future activity" gap from the earlier assessment (E6).

## Limitations
- **Application-level.** The OS ACL (script 02) is what actually stops a worker reaching outside its directories. Until applied, the model describes intent; same-user code is not bound by it.
- Resource limits here are declarative; Windows Job Objects enforce them (design in `WINDOWS_WORKER_ISOLATION_DESIGN.md`).
