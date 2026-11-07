# Completion verification

Principle: **"Claude reports that it is done" is a claim, not evidence.** Each rung of the ladder below is separate, persisted evidence
(`verification_evidence`, append-only). A project is *delivery-ready* only if every rung is `PASSED`, including an explicit owner approval.

| Level | Meaning | Phase 1.5 status |
|---|---|---|
| `CLAIMED_COMPLETE` | the provider reported success | **Implemented** (recorded by the worker, includes any denied tool calls) |
| `CHANGES_EXIST` | files/HEAD actually changed (task: vs. its first execution's baseline; project: beyond the initial commit) | **Implemented and tested** (content-level fingerprint: `git diff HEAD` + untracked file contents) |
| `BUILD_PASSES` | owner-configured build command exits 0 | **Implemented and tested**; `NOT_CONFIGURED` if no command |
| `TESTS_PASS` | owner-configured test command exits 0 | **Implemented and tested**; `NOT_CONFIGURED` if no command |
| `REQUIREMENTS_SATISFIED` | each functional/non-functional requirement is demonstrably met | **NOT IMPLEMENTED** - always `NOT_EVALUATED` |
| `SECURITY_CHECKS_PASS` | security review/scans pass | **NOT IMPLEMENTED** - always `NOT_EVALUATED` |
| `OWNER_APPROVAL` | the owner accepted (`project:accept`) | **Implemented** (human decision, stored with the list of acknowledged-unverified levels) |
| ready for delivery | derived: all of the above `PASSED` | **Implemented (derived)**; today this can never be true without an explicit owner override, by design |

Evidence statuses: `PASSED`, `FAILED`, `NOT_EVALUATED` (verifier does not exist yet), `NOT_CONFIGURED` (verifier exists, no command), `PENDING`.
Unknown is never silently treated as pass.

## Interfaces (`src/verification/types.ts`)

```ts
interface Verifier { readonly level: VerificationLevel; verify(ctx: VerifyContext): Promise<VerifierResult>; }
interface VerifyContext { projectId; taskId?; cwd; baseline?; commands: {build?, test?}; timeoutMs; signal? }
interface VerifierResult { status: EvidenceStatus; summary: string; evidence: Record<string, unknown> }
```

`verifyTask(deps, project, task, cwd)` runs the levels a task *requires* (`tasks.verification_required`, subset of `CHANGES_EXIST|BUILD_PASSES|TESTS_PASS`),
**after** the provider claims success and **while the lease is still heartbeated**. Only `FAILED` blocks completion: the outcome is converted to a
`TASK_FAILURE` ("verification failed after the provider reported success: ...") that consumes a retry, so the model gets another attempt with the failure in context.
`verifyProject(deps, project, cwd)` records all project-level levels and moves the lifecycle. `deliveryReadiness(store, projectId)` derives readiness;
`acceptProject` records owner approval. Custom verifiers can be injected through `VerificationDeps.verifiers` (used by tests and by Phase 2).

## Safety notes

* Build/test commands come from the assignment (owner-provided) and run via the shell in the project workspace with `ANTHROPIC_*`/`CLAUDE_CODE_*` variables removed from their environment, a timeout (`VERIFY_COMMAND_TIMEOUT_MS`) and redacted, truncated output stored as evidence.
* They execute code the model wrote. This is **not sandboxed** (see `docs/AUDIT_PHASE_1_5.md` C2); run the agent on an isolated host.
* Tasks default to **no** required verification so research/documentation tasks are not forced to change files. The Phase 2 planner should set `CHANGES_EXIST` (and build/test where applicable) on every coding task.

## What is NOT claimed

Autonomous acceptance testing, requirement-level verification, security scanning and reviewer agents do not exist yet (Phase 2). The verification layer is real
for "did files change", "does the build run", "do the tests pass" and "did the owner accept", and honest ("not evaluated") for everything else.
