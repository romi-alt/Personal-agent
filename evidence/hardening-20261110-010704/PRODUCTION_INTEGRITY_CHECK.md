# Phase I: production integrity check (read-only)

**Checks.** Two passes:
- **at the start:** 2026-11-10 01:16–01:22, before staging work;
- **at the end:** 02:05:26, after both regressions and the real-CLI staging run.

Raw output:
- `evidence\prod-integrity-final.txt`;
- `evidence\prod-db-readonly.json` (start);
- `evidence\prod-db-readonly-final.json` (end).

**Read-only.**
- Nothing in production was started, stopped, written or reconfigured.
- The database was opened with `better-sqlite3 { readonly: true, fileMustExist: true }` (`scripts\prod-readonly-check.cjs`, reported `openedReadonly: true`).
- The query selects metadata only: no payloads, descriptions or instructions.

## Verdict: **HEALTHY and UNMODIFIED.** One expected memory-gate deferral.

| Check | Start | End | Assessment |
|---|---|---|---|
| Production version | `E:\Agent\Personal-agent` on `deploy/v2` @ `e60278f` | Same | Unchanged |
| Git status | 0 changed files; no stash | 0; no stash | Clean |
| Reflog top | `2026-11-09 18:07:30 checkout … to deploy/v2` | Same | No checkout, commit or reset since deployment |
| `dist\` | 164 files, newest 2026-11-09 18:07:37 | Same | Not rebuilt |
| `src\` newest | — | 2026-11-09 18:07:29 | Not modified |
| `.env` | Last written 2026-11-07 15:40:35 | Same | Not modified |
| Supervisor process | pid 8992, started 2026-11-09 18:07:57, child of wrapper `powershell … run-supervisor.ps1` pid 13380 (started 18:07:55) | pid 8992 alive (CPU 126 s → 136 s); wrapper 13380 alive | **Same pid since deployment.** No restart to investigate. |
| Heartbeat (database `supervisor_state`) | pid 8992, IDLE, heartbeat age 0 s, `stop_requested` false, started 13:07:58Z | IDLE, heartbeat age 0 s | **Live**: heartbeats are being written. Process presence alone was not taken as proof. |
| Supervisor restarts since deployment | `supervisor.started` × 1 | × 1 | None |
| Schema | Migrations 1–8, 10, 11 (10 rows; v9 does not exist by design); WAL mode | Same | Unchanged |
| Queue | `tasks`: COMPLETED 141; `approvals`: APPROVED 9 | Same | No staging task or approval entered production |
| Error events (24 h) | 0 | 0 | — |
| Scheduled task `ElevariqPersonalAgent` | State Running; logon trigger plus 5-minute keepalive; `MultipleInstances=IgnoreNew`; principal Roman, Interactive, Limited | Running; last run 02:01:49; next run 02:06:48 | Healthy. `LastTaskResult 0x800710E0` is the expected "request refused": the keepalive fired while the instance was already running, so it was ignored. |
| Agent node processes | Only pid 8992 runs `dist\cli\index.js start` | Same | The staging supervisor (pid 5820) exited with code 0 at 01:41:53 |
| Staging → production | — | Staging used its own `AGENT_HOME`, env file, database and port. No production path appears in any staging tool call (`staging\denial-replay*.txt`). Production checkout, database counts and files are unchanged. | No modification found |

## Memory-gate deferral (expected; no action taken)
- Since deployment, production logged 10 `supervisor.resource_deferred` and 9 `supervisor.resource_resumed` events.
- The latest is a **deferral at 01:23:14 (+05:00)**, during this session's regression run. At 02:05, free memory was 1152 MB, below the 1536 MB resume threshold, so production **is still deferring new work**.
- It has **no queued tasks**, so nothing is delayed. Scheduling resumes by itself once free memory exceeds 1536 MB.
- The thresholds were not changed, and no process was terminated.
- All processes started in this session had exited by 02:05. The remaining memory pressure comes from the owner's applications: the Claude desktop app and browsers (see the 2026-11-09 memory assessment).

## Not checked
- Production dashboard and HTTP endpoints (not probed).
- Backup files.
- The reboot path (never exercised; it needs the owner).
