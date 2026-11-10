# Resource and recovery plan

## Measured now
- Host: 8 GB RAM (`TotalMB=8029`), free ~1.0 GB at audit time.
- Production supervisor (PID 8992) working set: ~24 MB (idle).
- Claude desktop app + CLI processes: ~0.96 GB (owner's apps, the dominant pressure).
- Last boot: 2026-11-05; the reboot-recovery path has never exercised the worker task.
- Production memory gate: pause < ~1024 MB free, resume > ~1536 MB (unchanged; **do not modify**).

## Memory budget with separate identities
Identity separation adds processes but little resident memory:
- **Broker/supervisor** (owner identity): small Node process, tens of MB (like the current supervisor).
- **Worker** (`elevariq-worker`): the `claude` CLI + its Node worker — the same footprint as today, just under a different token. Isolation does **not** duplicate the model; it relabels who runs it.
- **Named-pipe IPC**: negligible.
- Net new overhead vs. today ≈ the broker process (tens of MB). The 964 MB figure is the owner's **desktop app**, not the agent worker; closing it frees far more than isolation costs.

Conclusion: separate-identity isolation is feasible on this host at **single-worker** concurrency. Keep `MAX_CONCURRENT_WORKERS=1` and the existing 1024/1536 thresholds until an OS-isolation + memory test justifies more.

## Recovery requirements (verify during staging S7, do not test on production)
| Scenario | Expectation | How to verify (staging) |
|---|---|---|
| Scheduled-task startup | `ElevariqWorker` starts the worker under the worker identity at logon/interval | `Get-ScheduledTaskInfo`; worker process owner = `elevariq-worker` |
| Supervisor/broker restart | Broker reloads grant store + audit head from `C:\ElevariqBroker`; chain still verifies | restart staging broker; `verifyChain` ok |
| Windows logon / reboot recovery | Task re-registers worker; broker resumes; no duplicate task execution | staging reboot rehearsal (owner-scheduled; not in this phase) |
| Crash recovery | A killed worker's lease expires; the task is re-dispatched once (fencing) | kill the staging worker; confirm single re-dispatch |
| Usage-limit wait / resume | Watchdog waits, resumes after reset; not charged as a stall | existing A10/A11 mock tests; real behavior needs B5 |
| Memory pressure | Gate pauses new dispatch, resumes above threshold | existing resource-gate test; observed in production logs |
| Worker timeout / stale detection | Supervisor reclaims a stale lease | existing supervisor tests |
| Approval persistence | PENDING/APPROVED grants survive a broker restart (once persisted to broker root, B8) | restart; grant state intact |
| DB backup / rollback | Staging DB backup + restore drill passes (synthetic DB) | `backup`/`backup:verify` on the staging home |

## Compatibility with production V2
- Staging and production share **no** DB, home, port (4417/staging vs 4317/prod), pipe or account.
- The worker-DENY ACE on the production checkout does not change production behavior (the owner/SYSTEM supervisor keeps Full).
- No schema change; no production migration. Production stays on `e60278f`.

## Open reliability items carried from earlier
- Reboot-recovery path still unexercised (needs an owner-chosen reboot window; **not** this phase).
- Claude login renewal before 2026-12-04 (owner).
