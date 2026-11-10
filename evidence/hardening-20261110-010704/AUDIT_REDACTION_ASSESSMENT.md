# Phase C: audit redaction (redact-before-persistence) assessment

## Verdict
1. Before this phase, synthetic secrets reached disk through several agent-controlled paths.
2. Fixes `ba87473` close them at the persistence boundary.
3. A byte-level scan of every database page, WAL and log/JSONL file under a test agent home now finds **none of the 14 secret markers**.
4. Redaction is **pattern- and name-based**: an opaque secret that does not look like a secret and is not in the agent's environment cannot be recognised. Remaining paths are listed under "Residual" below.

## Method
- **Test:** `tests/integration/audit-redaction-v21.test.ts` (20 tests).
- **Synthetic secrets:** 14 formats, each carrying a unique marker (`SYNTHMKAA`…`SYNTHMKNN`). None is a real credential.

  | Formats | Format list |
  |---|---|
  | Provider and platform tokens | Anthropic key/OAuth, GitHub classic, GitHub fine-grained, AWS access key id, Slack, npm, Bearer |
  | Structured secrets | JWT, PEM private key |
  | Embedded in text | `DB_PASSWORD=` pair, URL userinfo, `CLAUDE_CODE_OAUTH_TOKEN=` assignment, `"api_key"` inside JSON text |
  | Environment-derived | An opaque value held only in a sensitive environment variable |
- **Persistence paths exercised:**
  - **store write paths:**
    - task transitions;
    - task error/evidence fields;
    - execution `retry_reason`, `summary` and `usage`;
    - checkpoints;
    - provider state;
    - supervisor `last_error` (exception text);
    - approvals (description and payload), plus the decision event;
    - verification evidence (QA results);
    - nested event payloads, including `Error` objects;
    - task outputs;
    - logger error records.
  - **a hostile provider driven through the real supervisor and runner:**
    - `tool_use` events (tool-call arguments, including a `password` key);
    - `web_evidence` URLs with credentials;
    - status events carrying exception text;
    - a `PERMISSION_DENIED` failure whose CLI stderr message and summary contain all formats;
    - a denial whose input contains secrets, which creates an approval record.
  - **the PreToolUse hook decision record** (`decisions.jsonl`), for an approval-gated call and for a hard-denied call.
- **Assertion:** after each scenario, every file under the agent home (main DB, `-wal`, `logs\app\*.log`, `logs\executions\*.jsonl`) is read as bytes and searched for each marker. Owner-provided project content (`workspaces\`) is excluded.

## Results

| Run | Code | Result | Leak locations found |
|---|---|---|---|
| Before | `c447cdb` source, with the new test | **15 of 20 failed** | `test.db-wal` (database), `logs\executions\<id>.jsonl`. 10 of 14 formats were not recognised by `redactString` at all; only Anthropic, GitHub classic, Bearer and the OAuth assignment were. The hook record was unredacted. The QA deputy test failed (helper absent). |
| After | `ba87473` and later | **20 of 20 passed** | None |

Logs: `logs\phaseC-before-c447cdb.log` and `logs\phaseC-after.log`.

A third test checks for over-redaction. Benign text must come back unchanged: `max_tokens=4096`, `inputTokens: 12`, Windows paths, `git push origin feature/x`, "token budget ok".

## Coverage by requested path

| Requested path | Where it is persisted | Before | After |
|---|---|---|---|
| Worker execution events | `activity_events.payload`, `logs\executions\*.jsonl` | Key-name and 5 token formats only; leaked | Redacted (extended `redactValue`) |
| Supervisor audit records | `supervisor_state.last_error`, `task_transitions.reason`, `project_transitions.reason` | **Not redacted** | `redactString` at write |
| CLI provider errors | `tasks.last_error_message`, `executions.retry_reason`, `provider_state.reason` | **Not redacted** | Redacted at write |
| QA results | `verification_evidence.summary` and `.evidence`, `qa_reviews` (no text) | Summary **not redacted** | Redacted, *then* truncated |
| Tool-call arguments | `tool_use` event (supervisor view), hook `decisions.jsonl` | The event used token formats only; the hook record was **unredacted** | `redactValue` (key names and formats); hook record redacted. The policy still evaluates the raw input. |
| Nested JSON objects | Event, approval and evidence payloads | Depth 8, key-name based | Unchanged depth limit; formats extended |
| Exception messages | `Error` objects in payloads and logs; `heartbeatSupervisor(lastError)` | Errors in payloads were redacted (5 formats); `last_error` was not | Both redacted |
| Environment-derived values | Any text that echoes a sensitive variable's value | **Not handled** | Exact values of variables whose names look sensitive (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*CREDENTIAL*`; at least 8 characters) are replaced |
| Approval records | `approvals.description` (plain text), `approvals.payload` | Description **not redacted** | Redacted |
| Dashboard-facing events | The dashboard reads the same tables and `notifications.jsonl`, which is built from redacted event payloads | Inherited the leaks above | Covered by the database scan |
| Generated reports | Checkpoint summaries, task outputs, QA review prompt (stored as review-task instructions) | **Not redacted** | Checkpoints are redacted before the integrity hash; outputs are redacted; the QA review diff is redacted |
| ERP sync | `sync_runs.error` | Not redacted | Redacted |

**Compatibility:**
- The checkpoint integrity hash is computed over the redacted text, so stored text and hash agree.
- `readDenials` compares hook records with result denials in redacted form, so a denial is not reported twice.

## Residual leakage paths (not fixed; owner awareness)
1. **Claude Code's own session transcripts** (`~/.claude/projects/...`), written by the `claude` CLI itself, contain full tool inputs and outputs. They are outside the agent's control, and the worker identity can read them (V2.2 scope).
2. **Owner- and model-authored planning artifacts** are stored verbatim:
   - task instructions;
   - assignment, intake text and attachments;
   - `project_documents`, workflow context, ADRs, requirements and plan reviews.

   Redacting them could corrupt the contract. A secret pasted into an assignment is persisted.
3. **Opaque secrets** that match no format and are not in the agent's environment, for example a database password the worker reads from a file and prints. These cannot be recognised by pattern.
4. **The wrapper's raw stderr capture** (`logs\supervisor-stderr.log`): an uncaught exception printed by Node *before* the logger exists bypasses redaction.
5. **Workspace content and git history** (the project repository) are not agent records and are not scanned.
6. **Over-redaction risk.** The `key=value` rule replaces non-numeric values of keys such as `*token*` and `*secret*` in free text, for example `tokenizer: bert` in a task summary. It preserves JSON validity, because quotes are kept.
7. **A same-user worker can rewrite or delete any log, JSONL or database row** (executed baseline A1/A2). Redaction protects against *accidental* persistence, not against a hostile worker. Tamper-evidence needs the V2.2 broker.

## Real secrets
- No real secret was used, inspected, printed or persisted in this phase.
- The secret scan of all 206 tracked files at the final commit `1e5b7d4` (and earlier at `7de4d66`) found **0 real matches**.
- Phase G later found one more redaction defect: the key-name rule turned `inputTokens`/`outputTokens` counts into `[REDACTED]`. It is fixed in `1e5b7d4` (numbers and booleans are not redacted by key name). Its 22 matches are synthetic test fixtures (`logs\regression\06-secret-scan.log`).
