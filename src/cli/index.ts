#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { accessSync, constants, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { ConfigError } from '../config/index.js';
import { createApp, type App } from '../core/app.js';
import { readTextFile } from '../core/text.js';
import { createIntegrations, EVENT_MAPPING } from '../integrations/index.js';
import { MEMORY_SECTIONS } from '../memory/context.js';
import { reconcileOrphans } from '../recovery/reconcile.js';
import { registerAssignment, getAssignment } from '../assignments/register.js';
import { AssignmentValidationError } from '../assignments/schema.js';
import { buildProjectContext } from '../assignments/context.js';
import { readAttachments, submitIntake } from '../assignments/intake.js';
import { decideApproval, taskAction, type TaskAction } from '../control/owner-actions.js';
import { ensureOwnerToken, tokenFile } from '../dashboard/auth.js';
import { startDashboard } from '../dashboard/server.js';
import { createBackup, listBackups, restoreBackup, verifyBackup } from '../ops/backup.js';
import { projectRoadmap } from '../planning/roadmap-service.js';
import {
  acceptProject,
  AcceptanceRefusedError,
  deliveryReadiness,
  verifyProject,
} from '../verification/service.js';
import { providerReadiness, verifyApiAccess } from '../providers/readiness.js';
import { validatePlan } from '../planning/validate-plan.js';
import type { Plan } from '../planning/schemas.js';
import { EnvCredentialSource } from '../providers/claude/credentials.js';
import { strippedVariableNames } from '../providers/claude-cli/env.js';
import { Supervisor } from '../supervisor/supervisor.js';
import { startHealthServer } from '../supervisor/health.js';
import { buildStatus } from '../supervisor/status.js';
import { TaskRunner } from '../workers/runner.js';
import { TASK_STATUSES, type TaskStatus } from '../types/index.js';
import { DuplicateSupervisorError } from '../queue/store.js';
import { fmtTime, relative, table } from './format.js';

const execFileP = promisify(execFile);

// Piping into `head` etc. must not crash the CLI.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const OPTIONS = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  detach: { type: 'boolean' },
  wait: { type: 'string' },
  project: { type: 'string' },
  status: { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string' },
  path: { type: 'string' },
  title: { type: 'string' },
  instructions: { type: 'string' },
  file: { type: 'string' },
  criteria: { type: 'string' },
  depends: { type: 'string' },
  priority: { type: 'string' },
  'max-retries': { type: 'string' },
  key: { type: 'string' },
  'start-at': { type: 'string' },
  'allow-dirty': { type: 'boolean' },
  task: { type: 'string' },
  execution: { type: 'string' },
  limit: { type: 'string' },
  app: { type: 'boolean' },
  run: { type: 'boolean' },
  by: { type: 'string' },
  reason: { type: 'string' },
  'acknowledge-unverified': { type: 'string' },
  access: { type: 'boolean' },
  question: { type: 'string' },
  text: { type: 'string' },
  assume: { type: 'boolean' },
  attach: { type: 'string', multiple: true },
  port: { type: 'string' },
  rotate: { type: 'boolean' },
} as const;

const HELP = `ELEVARIQ Personal Agent

Usage: npm run agent -- <command> [options]

  doctor                      Verify environment, configuration and provider readiness
  start [--detach]            Run the supervisor (foreground, or detached background process)
  stop [--wait <ms>]          Request graceful shutdown of the running supervisor
  status [--json]             Supervisor, worker, queue, waiting tasks, checkpoint, auth and provider state
  health                      Exit 0 only if the supervisor is live, the DB is healthy and auth is ready
  projects                    List projects
  project:add --name N [--description D] [--path P --allow-dirty] [--priority N]
  workspaces                  List approved workspace roots
  workspace:approve <path>    Explicitly approve an existing directory as a workspace root
  tasks [--project P] [--status S]
  task:add --project P (--title T --instructions I | --file F.json|F.md) [--criteria C] [--depends id,id]
           [--priority N] [--max-retries N] [--key K] [--start-at ISO]
  task:show <id>              Task details, state transitions, executions and checkpoints
  task:pause|task:resume|task:cancel|task:retry|task:unblock <id>
  approvals                   List approval requests;   approve <id> [--by name] | deny <id>
  logs [--task ID] [--project ID] [--limit N] [--app] [--execution ID]
  recovery [--run]            Show recovery state; --run reconciles orphaned tasks (only if no supervisor is live)
  integrations                ERP/CRM adapter health (mock adapters in Phase 1) and event-mapping spec
  memory:set <project> <section> <text> | memory:get <project> [section]
  intake "<assignment text>" [--name N] [--attach FILE]... [--path DIR [--allow-dirty]]
                                           Natural-language project assignment -> structured contract -> planning
  research:show <project> [--json]         Research findings: verified (citation retrieved) vs assumption, sources, dates
  adr:list <project> [--json]              Architecture Decision Records (status, significance, files)
  architecture:show <project> [--json]     Architecture specification per area (+ diagrams in docs/architecture)
  roadmap <project> [--json]               Milestones, epics, tasks, dependencies, critical path, VERIFIED progress
  review:show <project> [--json]           Planning review rounds (deterministic + independent model review)
  qa [project] [--json]                    Independent QA reviews of completed tasks: rounds, corrections, escalations
  dashboard [--port N]                     Owner command center (local-only web UI, owner-token login)
  dashboard:token [--rotate]               Show (or rotate) the command-center owner token
  backup [--path DIR]                      Online database backup + verification (the supervisor also backs up on BACKUP_INTERVAL_HOURS)
  backup:list | backup:verify [file]       List backups / restore drill (checksum, integrity_check, row counts)
  restore <file> --reason R                Restore a verified backup (supervisor must be stopped; old DB is kept)
  assignment:add --file assignment.json    Validate + register a project assignment (see examples/assignment.example.json)
  assignment:show <project>                Persisted assignment contract
  project:status <project>                 Lifecycle, task progress, spend and delivery readiness
  project:verify <project>                 Run independent verification (changes/build/tests); records evidence
  project:accept <project> [--acknowledge-unverified "why"]   Owner acceptance (never automatic)
  project:deliver <project> --reason R     Mark a READY_FOR_DELIVERY project DELIVERED (records only; deploys nothing)
  plan:start <project>                     Start the planning workflow (analyse -> architect -> decompose -> owner approval -> tasks)
  plan:show <project>                      Requirements, milestones, planned tasks and requirement coverage
  workflow:list | workflow:show <run>      Workflow runs, steps and what they are waiting for
  workflow:answer <run> --question Q --text "..."   Answer a blocking clarification question
  workflow:resume <run> --assume           Continue without answers (the analysis' assumptions are used)
  workflow:cancel <run> [--reason R]       Cancel a planning run
  provider:status                          Provider readiness report (SDK / credentials / API access / budget / live execution / live recovery)
  provider:verify --access                 Non-billable API key check (GET /v1/models); records API_ACCESS_VERIFIED
`;

function fail(msg: string, code = 1): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }
  let app: App;
  try {
    app = createApp();
  } catch (e) {
    if (e instanceof ConfigError) fail(e.message, 2);
    throw e;
  }
  const out = (s: string) => process.stdout.write(s + '\n');
  const { store, config, provider, registry } = app;
  const resolveProject = (ref: string | undefined) => {
    const projects = store.listProjects();
    const p = ref ? store.getProject(ref) : projects.length === 1 ? projects[0] : null;
    if (!p) fail(ref ? `unknown project "${ref}"` : 'specify --project (more than one project exists)');
    return p;
  };

  try {
    switch (cmd) {
      case 'doctor': {
        const checks: { check: string; result: 'OK' | 'WARN' | 'FAIL'; detail: string }[] = [];
        const add = (check: string, result: 'OK' | 'WARN' | 'FAIL', detail: string) =>
          checks.push({ check, result, detail });
        const major = Number(process.versions.node.split('.')[0]);
        add('node', major >= 22 ? 'OK' : 'FAIL', `v${process.versions.node} (need >= 22.12)`);
        add('config', 'OK', `provider=${config.provider} env=${config.environment} home=${config.agentHome}`);
        try {
          mkdirSync(config.agentHome, { recursive: true });
          accessSync(config.agentHome, constants.W_OK);
          add('agent home writable', 'OK', config.agentHome);
        } catch (e) {
          add('agent home writable', 'FAIL', String(e));
        }
        try {
          const r = app.db.pragma('journal_mode', { simple: true });
          add('database', 'OK', `${config.databasePath} journal_mode=${String(r)}`);
        } catch (e) {
          add('database', 'FAIL', String(e));
        }
        try {
          const { stdout } = await execFileP('git', ['--version']);
          add('git', 'OK', stdout.trim());
        } catch {
          add('git', 'FAIL', 'git not found on PATH');
        }
        try {
          const { stdout } = await execFileP('claude', ['--version'], {
            timeout: 15000,
            shell: process.platform === 'win32',
          });
          add('claude code cli', 'OK', stdout.trim());
        } catch {
          add('claude code cli', 'WARN', 'not found (optional: used only for diagnostics)');
        }
        const pre = await provider.preflight();
        add(
          'provider auth',
          pre.ready ? 'OK' : 'WARN',
          pre.ready ? pre.detail : `not ready: ${pre.missing.join('; ')}`,
        );
        const sup = store.getSupervisorState();
        add(
          'supervisor',
          sup && store.supervisorIsLive(sup, config.leaseTtlMs) ? 'OK' : 'WARN',
          sup ? `${sup.status} pid=${sup.pid}` : 'never started',
        );
        out(table(checks, ['check', 'result', 'detail']));
        if (checks.some((c) => c.result === 'FAIL')) process.exitCode = 1;
        break;
      }
      case 'start': {
        if (values.detach) {
          const child = spawn(
            process.execPath,
            [...process.execArgv, fileURLToPath(import.meta.url), 'start'],
            { detached: true, stdio: 'ignore', windowsHide: true, env: process.env },
          );
          child.unref();
          out(`supervisor launching in background (pid ${child.pid}). Check: npm run agent -- status`);
          break;
        }
        const sup = new Supervisor({
          config,
          store,
          provider,
          registry,
          log: app.log,
          workflows: app.workflows,
          qa: app.qa,
        });
        const onSignal = (sig: string) => sup.requestStop(`received ${sig}`);
        for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(s, () => onSignal(s));
        // A bug must never leave a zombie supervisor: log, shut down gracefully (checkpointing), exit non-zero for the service manager.
        const onFatal = (kind: string) => (err: unknown) => {
          app.log.error('supervisor.fatal', { kind, error: err });
          process.exitCode = 1;
          sup.requestStop(`fatal ${kind}`);
        };
        process.on('uncaughtException', onFatal('uncaughtException'));
        process.on('unhandledRejection', onFatal('unhandledRejection'));
        let health: import('node:http').Server | null = null;
        if (config.healthPort > 0)
          health = await startHealthServer(config.healthPort, store, provider, config.leaseTtlMs);
        try {
          await sup.start();
        } catch (e) {
          if (e instanceof DuplicateSupervisorError) fail(e.message, 3);
          throw e;
        } finally {
          health?.close();
        }
        break;
      }
      case 'stop': {
        const sup = store.getSupervisorState();
        if (!sup || !store.supervisorIsLive(sup, config.leaseTtlMs)) {
          out('no live supervisor');
          break;
        }
        store.requestStop();
        out(`stop requested for supervisor pid ${sup.pid}; waiting for graceful shutdown...`);
        const deadline = Date.now() + Number(values.wait ?? config.shutdownGraceMs + 10_000);
        while (Date.now() < deadline) {
          const s = store.getSupervisorState();
          if (!s || !store.supervisorIsLive(s, config.leaseTtlMs)) {
            out('supervisor stopped');
            return;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        fail(
          'supervisor did not stop within the wait window; it will stop at its next heartbeat or its lease will expire',
        );
        break;
      }
      case 'status': {
        const s = await buildStatus(store, provider, config.leaseTtlMs);
        if (values.json) {
          out(JSON.stringify(s, null, 2));
          break;
        }
        out(
          `Supervisor        : ${s.supervisor.status}${s.supervisor.pid ? ` (pid ${s.supervisor.pid}, last heartbeat ${relative(s.supervisor.heartbeatAt)})` : ''}`,
        );
        out(`Current worker    : ${s.currentWorker ?? '-'}`);
        out(`Current project   : ${s.currentProject ?? '-'}`);
        out(`Current task      : ${s.currentTask ? `${s.currentTask.title} [${s.currentTask.id}]` : '-'}`);
        out(
          `Queue length      : ${s.queue.length}   waiting: ${s.queue.waiting}   (${
            Object.entries(s.queue.byStatus)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ') || 'empty'
          })`,
        );
        out(
          `Last checkpoint   : ${s.lastCheckpoint ? `${s.lastCheckpoint.id} at ${fmtTime(s.lastCheckpoint.createdAt)} ${s.lastCheckpoint.repoRef ?? ''}` : '-'}`,
        );
        out(
          `Last error        : ${s.lastError ? `${s.lastError.class}: ${s.lastError.message} [${s.lastError.taskId}]` : '-'}`,
        );
        out(`Next retry        : ${relative(s.nextScheduledRetry)}`);
        out(
          `Authentication    : ${s.authentication.ready ? 'ready' : 'NOT READY'} - ${s.authentication.ready ? s.authentication.detail : s.authentication.missing.join('; ')}`,
        );
        out(
          `Provider (${s.provider.name})  : ${s.provider.state}${s.provider.blockedUntil ? ` until ${relative(s.provider.blockedUntil)}` : ''}${s.provider.reason ? ` - ${s.provider.reason}` : ''}`,
        );
        if (s.waitingTasks.length)
          out(
            '\nWaiting tasks:\n' +
              table(
                s.waitingTasks.map((t) => ({
                  id: t.id,
                  title: t.title,
                  status: t.status,
                  eligible: relative(t.nextEligibleAt),
                  reason: t.reason,
                })),
                ['id', 'title', 'status', 'eligible', 'reason'],
              ),
          );
        break;
      }
      case 'health': {
        const s = await buildStatus(store, provider, config.leaseTtlMs);
        const checks = {
          database: true,
          supervisorLive: s.supervisor.live,
          authenticationReady: s.authentication.ready,
          providerState: s.provider.state,
        };
        out(JSON.stringify(checks));
        if (!s.supervisor.live || !s.authentication.ready) process.exitCode = 1;
        break;
      }
      case 'projects': {
        out(
          table(
            store.listProjects().map((p) => ({
              id: p.id,
              slug: p.slug,
              name: p.name,
              status: p.status,
              priority: p.priority,
              provider: p.provider,
              path: p.repoPath,
              activity: fmtTime(p.lastActivityAt),
            })),
            ['id', 'slug', 'name', 'status', 'priority', 'provider', 'path', 'activity'],
          ),
        );
        break;
      }
      case 'project:add': {
        if (!values.name) fail('--name is required');
        const base = {
          name: values.name,
          description: values.description,
          priority: values.priority ? Number(values.priority) : 0,
          provider: provider.name,
        };
        const p = values.path
          ? await registry.registerExistingProject(store, {
              ...base,
              repoPath: values.path,
              allowDirty: values['allow-dirty'],
            })
          : await registry.createManagedProject(store, base);
        out(`created project ${p.id} (${p.slug}) at ${p.repoPath}`);
        break;
      }
      case 'workspaces':
        out(
          table(
            [
              { id: 'managed', path: registry.root, name: 'managed root', approvedBy: 'config' },
              ...registry
                .list()
                .map((w) => ({ id: w.id, path: w.path, name: w.name, approvedBy: w.approvedBy })),
            ],
            ['id', 'path', 'name', 'approvedBy'],
          ),
        );
        break;
      case 'workspace:approve': {
        if (!rest[0]) fail('usage: workspace:approve <path>');
        const w = registry.register(rest[0], path.basename(rest[0]), values.by ?? 'owner-cli');
        out(`approved workspace ${w.path}`);
        break;
      }
      case 'tasks': {
        const statuses = values.status ? ([values.status.toUpperCase()] as TaskStatus[]) : undefined;
        if (statuses?.some((s) => !TASK_STATUSES.includes(s)))
          fail(`status must be one of ${TASK_STATUSES.join(', ')}`);
        const p = values.project ? resolveProject(values.project) : undefined;
        const tasks = store.listTasks({ projectId: p?.id, statuses });
        out(
          table(
            tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              prio: t.priority,
              attempts: `${t.attemptCount}/${t.maxRetries}`,
              eligible: t.nextEligibleAt ? fmtTime(t.nextEligibleAt) : '-',
              error: t.lastErrorClass,
            })),
            ['id', 'title', 'status', 'prio', 'attempts', 'eligible', 'error'],
          ),
        );
        break;
      }
      case 'task:add': {
        const p = resolveProject(values.project);
        let title = values.title,
          instructions = values.instructions,
          criteria = values.criteria ?? '';
        let depends = values.depends
          ? values.depends
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        let priority = values.priority ? Number(values.priority) : 0;
        if (values.file) {
          const text = readTextFile(values.file);
          if (values.file.endsWith('.json')) {
            const j = JSON.parse(text) as {
              title?: string;
              instructions?: string;
              acceptanceCriteria?: string;
              dependsOn?: string[];
              priority?: number;
            };
            title ??= j.title;
            instructions ??= j.instructions;
            criteria ||= j.acceptanceCriteria ?? '';
            if (!depends.length) depends = j.dependsOn ?? [];
            if (!values.priority) priority = j.priority ?? 0;
          } else {
            const m = text.match(/^#\s+(.+)\n([\s\S]*)$/);
            title ??= m?.[1]?.trim() ?? path.basename(values.file);
            instructions ??= (m?.[2] ?? text).trim();
          }
        }
        if (!title || !instructions) fail('task needs --title and --instructions (or --file)');
        const { task, created } = store.enqueueTask({
          projectId: p.id,
          title,
          instructions,
          acceptanceCriteria: criteria,
          dependsOn: depends,
          priority,
          maxRetries: values['max-retries'] ? Number(values['max-retries']) : config.defaultMaxRetries,
          scheduledStart: values['start-at'] ? Date.parse(values['start-at']) : null,
          dedupeKey: values.key,
        });
        out(
          created
            ? `queued task ${task.id}: ${task.title}`
            : `duplicate ignored; existing task ${task.id} (${task.status})`,
        );
        break;
      }
      case 'task:show': {
        const t = store.getTask(rest[0] ?? '');
        if (!t) fail(`unknown task ${rest[0] ?? ''}`);
        if (values.json) {
          out(
            JSON.stringify(
              {
                task: t,
                transitions: store.listTransitions(t.id),
                executions: store.listExecutions(t.id),
                checkpoints: store.listCheckpoints(t.id),
              },
              null,
              2,
            ),
          );
          break;
        }
        out(
          `${t.title} [${t.id}]\nstatus: ${t.status}   priority: ${t.priority}   attempts: ${t.attemptCount}/${t.maxRetries}   continuations: ${t.continuationCount}`,
        );
        out(
          `session: ${t.sessionId ?? '-'}   next eligible: ${relative(t.nextEligibleAt)}   last error: ${t.lastErrorClass ?? '-'} ${t.lastErrorMessage ?? ''}`,
        );
        if (t.completionEvidence) out(`evidence: ${t.completionEvidence}`);
        out(
          '\nTransitions:\n' +
            table(
              store.listTransitions(t.id).map((x) => ({
                at: fmtTime(x.at),
                from: x.from,
                to: x.to,
                reason: x.reason,
                execution: x.executionId,
              })),
              ['at', 'from', 'to', 'reason', 'execution'],
            ),
        );
        out(
          '\nExecutions:\n' +
            table(
              store.listExecutions(t.id).map((e) => ({
                id: e.id,
                started: fmtTime(e.startedAt),
                outcome: e.outcome ?? 'running',
                error: e.errorClass,
                session: e.providerSessionId,
                cost_est: e.costUsdEstimate,
                log: e.logRef,
              })),
              ['id', 'started', 'outcome', 'error', 'session', 'cost_est', 'log'],
            ),
        );
        out(
          '\nCheckpoints:\n' +
            table(
              store
                .listCheckpoints(t.id)
                .map((c) => ({ id: c.id, at: fmtTime(c.createdAt), repo: c.repoRef, next: c.nextAction })),
              ['id', 'at', 'repo', 'next'],
            ),
        );
        break;
      }
      case 'task:pause':
      case 'task:resume':
      case 'task:cancel':
      case 'task:retry':
      case 'task:unblock': {
        if (!store.getTask(rest[0] ?? '')) fail(`unknown task ${rest[0] ?? ''}`);
        const r = taskAction(store, rest[0]!, cmd.slice('task:'.length) as TaskAction, {
          by: values.by ?? 'owner',
          channel: 'cli',
        });
        out(`task ${r.id} -> ${r.status}`);
        break;
      }
      case 'approvals':
        out(
          table(
            store.listApprovals().map((a) => ({
              id: a.id,
              task: a.taskId,
              type: a.actionType,
              status: a.status,
              description: a.description,
              requested: fmtTime(a.requestedAt),
            })),
            ['id', 'task', 'type', 'status', 'description', 'requested'],
          ),
        );
        break;
      case 'approve':
      case 'deny': {
        const a = decideApproval(
          store,
          rest[0] ?? '',
          cmd === 'approve' ? 'APPROVED' : 'DENIED',
          { by: values.by ?? 'owner-cli', channel: 'cli' },
          values.reason,
        );
        out(`${a.id} ${a.status}`);
        break;
      }
      case 'logs': {
        if (values.execution) {
          const e = store.getExecution(values.execution);
          if (!e?.logRef || !existsSync(e.logRef)) fail('no transcript for that execution');
          out(readFileSync(e.logRef, 'utf8').trimEnd());
        } else if (values.app) {
          const dir = path.join(config.logDir, 'app');
          const files = existsSync(dir)
            ? readdirSync(dir)
                .filter((f) => f.endsWith('.log'))
                .sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
            : [];
          if (!files[0]) {
            out('(no application log yet)');
            break;
          }
          out(
            readFileSync(path.join(dir, files[0]), 'utf8')
              .trimEnd()
              .split('\n')
              .slice(-Number(values.limit ?? 50))
              .join('\n'),
          );
        } else {
          const evs = store.listEvents({
            taskId: values.task,
            projectId: values.project ? resolveProject(values.project).id : undefined,
            limit: Number(values.limit ?? 50),
          });
          out(
            table(
              evs.map((e) => ({
                at: fmtTime(e.at),
                sev: e.severity,
                type: e.type,
                task: e.taskId,
                detail: JSON.stringify(e.payload).slice(0, 120),
              })),
              ['at', 'sev', 'type', 'task', 'detail'],
            ),
          );
        }
        break;
      }
      case 'recovery': {
        if (values.run) {
          const sup = store.getSupervisorState();
          if (sup && store.supervisorIsLive(sup, config.leaseTtlMs))
            fail('a supervisor is live; it reconciles automatically. Stop it first to run manual recovery.');
          const runner = new TaskRunner({
            config,
            store,
            provider,
            registry,
            log: app.log,
            workerId: 'cli-recovery',
          });
          const acts = await reconcileOrphans({
            mode: 'startup',
            store,
            config,
            log: app.log,
            runner,
            registry,
            providerName: provider.name,
            workerImage: provider.workerImage,
          });
          out(
            acts.length
              ? table(
                  acts.map((a) => ({
                    task: a.taskId,
                    title: a.title,
                    was: a.previousStatus,
                    action: a.action,
                    detail: a.detail,
                  })),
                  ['task', 'title', 'was', 'action', 'detail'],
                )
              : 'nothing to recover',
          );
          break;
        }
        const ps = store.getProviderState(provider.name);
        out(
          `Provider state: ${ps.status}${ps.blockedUntil ? ` until ${relative(ps.blockedUntil)}` : ''}  consecutive failures: ${ps.consecutiveFailures}  ${ps.reason ?? ''}`,
        );
        const waiting = store.listTasks({
          statuses: [
            'WAITING_FOR_CAPACITY',
            'WAITING_FOR_AUTHENTICATION',
            'WAITING_FOR_APPROVAL',
            'RETRY_SCHEDULED',
            'BLOCKED',
            'RUNNING',
            'CHECKPOINTING',
          ],
        });
        out(
          '\nTasks needing attention or recovery:\n' +
            table(
              waiting.map((t) => ({
                id: t.id,
                title: t.title,
                status: t.status,
                eligible: relative(t.nextEligibleAt),
                error: t.lastErrorClass,
                session: t.sessionId,
              })),
              ['id', 'title', 'status', 'eligible', 'error', 'session'],
            ),
        );
        const evs = store.listEvents({ type: 'recovery.task_reconciled', limit: 10 });
        out(
          '\nRecent recovery actions:\n' +
            table(
              evs.map((e) => ({
                at: fmtTime(e.at),
                task: e.taskId,
                action: String(e.payload['action'] ?? ''),
                detail: String(e.payload['detail'] ?? ''),
              })),
              ['at', 'task', 'action', 'detail'],
            ),
        );
        break;
      }
      case 'integrations': {
        const i = createIntegrations(config);
        const checks = [await i.erp.healthCheck(), await i.crm.healthCheck()];
        out(
          table(
            checks.map((c) => ({ system: c.system, status: c.status, mode: c.mode, detail: c.detail })),
            ['system', 'status', 'mode', 'detail'],
          ),
        );
        for (const n of i.notes) out(`note: ${n}`);
        out(
          '\nEvent mapping spec (design only):\n' +
            table(
              EVENT_MAPPING.map((m) => ({
                agent_event: m.agentEvent,
                erp_concept: m.erpConcept,
                phase: m.phase,
              })),
              ['agent_event', 'erp_concept', 'phase'],
            ),
        );
        break;
      }
      case 'memory:set': {
        const [pref, section, ...text] = rest;
        const p = resolveProject(pref);
        if (!section || !(MEMORY_SECTIONS as readonly string[]).includes(section))
          fail(`section must be one of: ${MEMORY_SECTIONS.join(', ')}`);
        store.setMemory(p.id, section, text.join(' '));
        out(`saved ${section}`);
        break;
      }
      case 'memory:get': {
        const p = resolveProject(rest[0]);
        for (const m of store.listMemory(p.id).filter((x) => !rest[1] || x.section === rest[1]))
          out(`## ${m.section}\n${m.content}\n`);
        break;
      }
      case 'plan:start': {
        const p = resolveProject(rest[0]);
        const run = app.workflows.startPlanning(p.id);
        out(`planning workflow ${run.id} for ${p.slug}: ${run.status} (phase ${run.context.phase})`);
        out(
          'The supervisor executes the planning steps as read-only tasks. Watch with: workflow:show ' +
            run.id,
        );
        break;
      }
      case 'workflow:list': {
        const runs = app.workflows.repo.listRuns({
          projectId: values.project ? resolveProject(values.project).id : undefined,
        });
        out(
          table(
            runs.map((r) => ({
              id: r.id,
              project: store.getProject(r.projectId)?.slug,
              kind: r.kind,
              status: r.status,
              phase: r.context.phase,
              error: r.error,
            })),
            ['id', 'project', 'kind', 'status', 'phase', 'error'],
          ),
        );
        break;
      }
      case 'workflow:show': {
        const run = app.workflows.repo.getRun(rest[0] ?? '');
        if (!run) fail(`unknown workflow run ${rest[0] ?? ''}`);
        out(
          `${run.id}  ${run.kind}  status=${run.status}  phase=${run.context.phase}${run.error ? `  error=${run.error}` : ''}`,
        );
        out(
          '\nSteps:\n' +
            table(
              app.workflows.repo.listSteps(run.id).map((s2) => ({
                step: s2.name,
                attempt: s2.attempt,
                status: s2.status,
                task: s2.taskId,
                error: s2.error?.split('\n')[0],
              })),
              ['step', 'attempt', 'status', 'task', 'error'],
            ),
        );
        if (run.status === 'WAITING_FOR_OWNER' && run.context.phase === 'clarify') {
          out(
            '\nBlocking questions (answer with workflow:answer, or continue with workflow:resume --assume):',
          );
          for (const q of run.context.questions.filter((x) => x.blocking))
            out(
              `  ${q.id}: ${q.text}${run.context.answers[q.id] ? `\n     answer: ${run.context.answers[q.id]}` : ''}`,
            );
        }
        if (run.status === 'WAITING_FOR_OWNER' && run.context.phase === 'approval')
          out(
            `\nWaiting for plan approval: npm run agent -- approve ${run.context.approvalId}   (or deny ${run.context.approvalId})`,
          );
        break;
      }
      case 'workflow:answer': {
        if (!rest[0] || !values.question || !values.text)
          fail('usage: workflow:answer <run> --question Q-1 --text "answer"');
        app.workflows.answerQuestion(rest[0], values.question, values.text);
        out('answer recorded');
        break;
      }
      case 'workflow:resume': {
        if (!rest[0] || !values.assume) fail('usage: workflow:resume <run> --assume');
        app.workflows.resumeWithAssumptions(rest[0]);
        out('continuing with the analysis assumptions');
        break;
      }
      case 'workflow:cancel': {
        if (!rest[0]) fail('usage: workflow:cancel <run> [--reason R]');
        app.workflows.cancel(rest[0], values.reason ?? 'cancelled by owner');
        out('cancelled');
        break;
      }
      case 'plan:show': {
        const p = resolveProject(rest[0]);
        const reqs = app.workflows.repo.listRequirements(p.id);
        const tasks = app.workflows.repo.listPlanTasks(p.id);
        out(
          `Requirements (${reqs.length}):\n` +
            table(
              reqs.map((r) => ({
                id: r.id,
                priority: r.priority,
                source: r.source,
                covered_by:
                  tasks
                    .filter((t) => t.requirementIds.includes(r.id))
                    .map((t) => t.planKey)
                    .join(',') || '-',
                text: r.text.slice(0, 60),
              })),
              ['id', 'priority', 'source', 'covered_by', 'text'],
            ),
        );
        out(
          '\nMilestones:\n' +
            table(
              app.workflows.repo.listMilestones(p.id).map((m) => ({
                pos: m.position + 1,
                key: m.key,
                title: m.title,
                tasks: tasks.filter((t) => t.milestoneKey === m.key).length,
              })),
              ['pos', 'key', 'title', 'tasks'],
            ),
        );
        out(
          '\nPlanned tasks:\n' +
            table(
              tasks.map((t) => ({
                key: t.planKey,
                milestone: t.milestoneKey,
                size: t.size,
                status: t.status,
                title: t.title,
              })),
              ['key', 'milestone', 'size', 'status', 'title'],
            ),
        );
        const runs = app.workflows.repo.listRuns({ projectId: p.id });
        const last = runs.at(-1);
        const planJson = last ? app.workflows.repo.completedOutput(last.id, 'decompose') : null;
        if (planJson) {
          const v = validatePlan(
            JSON.parse(planJson) as Plan,
            reqs.map((r) => r.id),
            { maxTasks: config.maxPlanTasks },
          );
          out(
            `\nLatest plan: ${v.ok ? 'valid' : 'INVALID'}; uncovered requirements: ${v.coverage.uncovered.join(', ') || 'none'}`,
          );
        }
        break;
      }
      case 'intake': {
        // Natural-language assignment: `intake "Build a complete educational ERP ..." [--attach spec.md ...]`
        const text = values.text ?? rest.join(' ');
        if (!text.trim())
          fail(
            'usage: intake "<assignment in your own words>" [--name N] [--attach FILE ...] [--path DIR [--allow-dirty]]',
          );
        try {
          const { project, run } = await submitIntake(store, registry, app.workflows, provider.name, {
            text,
            name: values.name,
            attachments: readAttachments(values.attach ?? []),
            existing: values.path ? { path: values.path, allowDirty: !!values['allow-dirty'] } : undefined,
            priority: values.priority ? Number(values.priority) : undefined,
          });
          out(`project ${project.id} (${project.slug}) at ${project.repoPath}`);
          out(`planning run ${run.id} started at the intake step; the running supervisor executes it.`);
          out(`Follow it: npm run agent -- workflow:show ${run.id}`);
        } catch (e) {
          fail((e as Error).message);
        }
        break;
      }
      case 'research:show': {
        const p = resolveProject(rest[0]);
        const f = app.workflows.repo.listFindings(p.id);
        if (values.json) {
          out(JSON.stringify(f, null, 2));
          break;
        }
        out(
          table(
            f.map((x) => ({
              id: x.findingId,
              area: x.area,
              kind: x.kind + (x.claimedKind !== x.kind ? ` (claimed ${x.claimedKind})` : ''),
              conf: x.confidence,
              citation: x.citationCheck,
              sources: x.sources.map((s) => s.url).join(' ') || '-',
              statement: x.statement.slice(0, 70),
            })),
            ['id', 'area', 'kind', 'conf', 'citation', 'sources', 'statement'],
          ),
        );
        break;
      }
      case 'adr:list': {
        const p = resolveProject(rest[0]);
        const adrs = app.workflows.repo.listAdrs(p.id);
        if (values.json) {
          out(JSON.stringify(adrs, null, 2));
          break;
        }
        out(
          table(
            adrs.map((a) => ({
              no: String(a.number).padStart(4, '0'),
              id: a.adrId,
              status: a.status,
              significant: a.significant ? 'yes' : '',
              date: fmtTime(a.decidedAt),
              title: a.title,
              file: a.filePath ?? '-',
            })),
            ['no', 'id', 'status', 'significant', 'date', 'title', 'file'],
          ),
        );
        break;
      }
      case 'architecture:show': {
        const p = resolveProject(rest[0]);
        const spec = app.workflows.repo.latestSpec(p.id);
        if (!spec) fail('no architecture has been produced for this project yet');
        if (values.json) {
          out(JSON.stringify(spec, null, 2));
          break;
        }
        for (const [k, v] of Object.entries(spec.sections)) out(`## ${k}\n${v || '(not specified)'}\n`);
        out(
          `Diagrams: ${spec.diagrams.map((d) => d.title).join(', ') || 'none'}  (rendered in docs/architecture/ARCHITECTURE.md)`,
        );
        break;
      }
      case 'roadmap': {
        const p = resolveProject(rest[0]);
        const r = projectRoadmap(store, app.workflows.repo, p.id);
        if (values.json) {
          out(JSON.stringify(r, null, 2));
          break;
        }
        const pct = (x: number) => `${Math.round(x * 100)}%`;
        out(
          `Verified progress: ${r.progress.overall.delivered}/${r.progress.overall.total} tasks delivered (${pct(r.progress.overall.ratio)} by size)`,
        );
        out(
          `Critical path (remaining): ${r.criticalPath.path.join(' -> ') || '-'}  weight ${r.criticalPath.weight}`,
        );
        out(
          '\nMilestones:\n' +
            table(
              r.milestones.map((m) => {
                const g = r.progress.milestones.find((x) => x.key === m.key);
                return {
                  key: m.key,
                  title: m.title,
                  delivered: `${g?.delivered ?? 0}/${g?.total ?? 0}`,
                  progress: pct(g?.ratio ?? 0),
                };
              }),
              ['key', 'title', 'delivered', 'progress'],
            ),
        );
        if (r.epics.length)
          out(
            '\nEpics:\n' +
              table(
                r.epics.map((e) => {
                  const g = r.progress.epics.find((x) => x.key === e.key);
                  return { key: e.key, title: e.title, delivered: `${g?.delivered ?? 0}/${g?.total ?? 0}` };
                }),
                ['key', 'title', 'delivered'],
              ),
          );
        out(
          '\nTasks:\n' +
            table(
              r.tasks.map((t) => ({
                key: t.key,
                milestone: t.milestone,
                epic: t.epic ?? '-',
                size: t.size,
                status: t.status,
                verified: t.delivered ? 'yes' : `${t.passed.length}/${t.required.length}`,
                depends: t.dependsOn.join(',') || '-',
                critical: r.criticalPath.path.includes(t.key) ? '*' : '',
                title: t.title.slice(0, 50),
              })),
              ['key', 'milestone', 'epic', 'size', 'status', 'verified', 'depends', 'critical', 'title'],
            ),
        );
        break;
      }
      case 'dashboard': {
        const port = values.port ? Number(values.port) : config.dashboard.port;
        const server = await startDashboard(app, { ...config.dashboard, port });
        out(
          `ELEVARIQ command center on http://${config.dashboard.host === '::1' ? '[::1]' : config.dashboard.host}:${port}/`,
        );
        out(
          `Sign in with the owner token in ${tokenFile(config.agentHome)} (show it: npm run agent -- dashboard:token)`,
        );
        await new Promise<void>((resolve) => {
          for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)
            process.on(s, () => server.close(() => resolve()));
        });
        break;
      }
      case 'backup': {
        const m = await createBackup(app.db, values.path ?? config.backup.dir);
        const v = verifyBackup(path.join(values.path ?? config.backup.dir, m.file));
        out(
          `backup ${m.file} (${m.bytes} bytes, schema v${m.schemaVersion}) ${v.ok ? 'verified' : 'VERIFY FAILED: ' + v.problems.join('; ')}`,
        );
        out(
          `counts: ${Object.entries(m.counts)
            .map(([k, n]) => `${k}=${n}`)
            .join(' ')}`,
        );
        if (!v.ok) process.exitCode = 1;
        break;
      }
      case 'backup:list': {
        out(
          table(
            listBackups(config.backup.dir).map((m) => ({
              file: m.file,
              created: fmtTime(m.createdAt),
              bytes: m.bytes,
              schema: m.schemaVersion,
              tasks: m.counts['tasks'] ?? '-',
            })),
            ['file', 'created', 'bytes', 'schema', 'tasks'],
          ),
        );
        break;
      }
      case 'backup:verify': {
        const f = rest[0]
          ? path.resolve(rest[0])
          : (() => {
              const l = listBackups(config.backup.dir).at(-1);
              return l ? path.join(config.backup.dir, l.file) : '';
            })();
        if (!f) fail('no backup found');
        const v = verifyBackup(f);
        out(v.ok ? `OK ${f}` : `FAILED ${f}\n  ${v.problems.join('\n  ')}`);
        if (!v.ok) process.exitCode = 1;
        break;
      }
      case 'restore': {
        if (!rest[0]) fail('usage: restore <backup-file> --reason "why"   (supervisor must be stopped)');
        const sup = store.getSupervisorState();
        if (sup && store.supervisorIsLive(sup, config.leaseTtlMs))
          fail('a supervisor is live: stop it first (npm run agent -- stop)');
        if (!values.reason) fail('restore replaces the database: pass --reason "..." to confirm');
        app.close();
        const r = restoreBackup(path.resolve(rest[0]), config.databasePath);
        out(`restored ${rest[0]} -> ${config.databasePath}`);
        if (r.previous) out(`previous database kept at ${r.previous}`);
        const after = createApp();
        after.store.recordEvent({
          type: 'backup.restored',
          severity: 'warn',
          payload: { file: path.basename(rest[0]), previous: r.previous, reason: values.reason },
        });
        after.close();
        return;
      }
      case 'dashboard:token': {
        const t = ensureOwnerToken(config.agentHome, !!values.rotate);
        out(
          values.rotate
            ? 'owner token rotated (restart the dashboard to end existing sessions):'
            : 'owner token:',
        );
        out(t);
        out(`stored in ${tokenFile(config.agentHome)}`);
        break;
      }
      case 'qa': {
        const p = values.project ? resolveProject(values.project) : rest[0] ? resolveProject(rest[0]) : null;
        const rows = app.qa.rows().filter((r) => !p || store.getTask(r.taskId)?.projectId === p.id);
        if (values.json) {
          out(
            JSON.stringify(
              rows.map((r) => ({ ...r, result: app.qa.result(r.taskId, r.round) })),
              null,
              2,
            ),
          );
          break;
        }
        out(
          table(
            rows.map((r) => ({
              task: r.taskId,
              title: (store.getTask(r.taskId)?.title ?? '').slice(0, 40),
              round: r.round,
              status: r.status,
              review: r.reviewTaskId ?? '-',
              correction: r.correctionTaskId ?? '-',
              approval: r.approvalId ?? '-',
            })),
            ['task', 'title', 'round', 'status', 'review', 'correction', 'approval'],
          ),
        );
        break;
      }
      case 'review:show': {
        const p = resolveProject(rest[0]);
        const run = app.workflows.repo.listRuns({ projectId: p.id }).at(-1);
        if (!run) fail('no planning run for this project');
        const reviews = app.workflows.repo.listReviews(run.id);
        if (values.json) {
          out(JSON.stringify(reviews, null, 2));
          break;
        }
        for (const r of reviews) {
          out(`Round ${r.round} ${r.source}: ${r.verdict}`);
          for (const i of r.issues) out(`  [${i.severity}] ${i.category} ${i.id}: ${i.description}`);
        }
        if (!reviews.length) out('(no review yet)');
        break;
      }
      case 'assignment:add': {
        if (!values.file) fail('usage: assignment:add --file assignment.json');
        let raw: unknown;
        try {
          raw = JSON.parse(readTextFile(values.file));
        } catch (e) {
          fail(`cannot read ${values.file}: ${(e as Error).message}`);
        }
        try {
          const r = await registerAssignment(store, registry, provider.name, raw);
          out(
            r.created
              ? `registered project ${r.project.id} (${r.project.slug}) lifecycle=${r.project.lifecycle} at ${r.project.repoPath}`
              : `already registered from the same source id: ${r.project.id} (${r.project.slug})`,
          );
          out(
            'No tasks were created. Planning/decomposition is a Phase 2 capability; add tasks with task:add.',
          );
        } catch (e) {
          if (e instanceof AssignmentValidationError) fail(e.message, 2);
          throw e;
        }
        break;
      }
      case 'assignment:show': {
        const p = resolveProject(rest[0]);
        const a = getAssignment(store, p.id);
        out(a ? JSON.stringify(a, null, 2) : '(no assignment registered for this project)');
        break;
      }
      case 'project:status': {
        const p = resolveProject(rest[0]);
        const ctx = buildProjectContext(store, p.id);
        const ready = deliveryReadiness(store, p.id);
        if (values.json) {
          out(
            JSON.stringify(
              { context: ctx, readiness: ready, transitions: store.listProjectTransitions(p.id) },
              null,
              2,
            ),
          );
          break;
        }
        out(`${p.name} [${p.id}]  lifecycle=${p.lifecycle}  operational-status=${p.status}`);
        out(
          `tasks: ${ctx.tasks.total} total  ${Object.entries(ctx.tasks.byStatus)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}   estimated spend: $${ctx.spendUsdEstimate.toFixed(4)}`,
        );
        out(`delivery ready: ${ready.ready ? 'YES' : 'NO'}`);
        out(
          table(
            Object.entries(ready.levels).map(([level, status]) => ({ level, status })),
            ['level', 'status'],
          ),
        );
        out(
          '\nLifecycle history:\n' +
            table(
              store
                .listProjectTransitions(p.id)
                .map((t) => ({ at: fmtTime(t.at), from: t.from, to: t.to, reason: t.reason })),
              ['at', 'from', 'to', 'reason'],
            ),
        );
        break;
      }
      case 'project:verify': {
        const p = resolveProject(rest[0]);
        const r = await verifyProject(
          { store, timeoutMs: config.verifyCommandTimeoutMs },
          p,
          registry.assertApproved(p.repoPath),
        );
        out(
          table(
            r.evidence.map((e) => ({ level: e.level, status: e.status, summary: e.summary })),
            ['level', 'status', 'summary'],
          ),
        );
        out(
          `\ndelivery ready: ${r.readiness.ready ? 'YES' : 'NO'}${r.readiness.blockers.length ? `\nunresolved: ${r.readiness.blockers.join(', ')}` : ''}`,
        );
        out(`project lifecycle is now ${store.getProject(p.id)!.lifecycle}`);
        break;
      }
      case 'project:accept': {
        const p = resolveProject(rest[0]);
        try {
          acceptProject(store, p.id, values.by ?? 'owner-cli', {
            acknowledgeUnverified: values['acknowledge-unverified'],
          });
          out(`project ${p.slug} -> ${store.getProject(p.id)!.lifecycle}`);
        } catch (e) {
          if (e instanceof AcceptanceRefusedError) fail(e.message);
          throw e;
        }
        break;
      }
      case 'project:deliver': {
        const p = resolveProject(rest[0]);
        if (!values.reason) fail('--reason is required (what was delivered, where)');
        store.transitionProject(p.id, 'DELIVERED', `delivered by owner: ${values.reason}`);
        out(`project ${p.slug} -> DELIVERED (recorded only; nothing was deployed)`);
        break;
      }
      case 'provider:status': {
        if (config.provider === 'claude-cli') {
          // Native CLI: local checks only (version, stored login state); no model request is made.
          const pre = await app.provider.preflight();
          const rep = {
            provider: 'claude-cli',
            ready: pre.ready,
            detail: pre.detail,
            missing: pre.missing,
            minVersion: config.claudeCli.minVersion,
            injectedEnv: config.claudeCli.watchdogEnv,
            strippedFromWorkerEnv: strippedVariableNames(process.env),
          };
          if (values.json) out(JSON.stringify(rep, null, 2));
          else {
            out(
              `Provider: claude-cli (native Claude Code, subscription login)   ready: ${pre.ready ? 'YES' : 'NO'}`,
            );
            out(`  ${pre.detail}`);
            for (const m of pre.missing) out(`  missing: ${m}`);
            out('  injected into every worker:');
            for (const [k, v] of Object.entries(config.claudeCli.watchdogEnv)) out(`    ${k}=${v}`);
            out(`  removed from worker env (names only): ${rep.strippedFromWorkerEnv.join(', ') || 'none'}`);
          }
          if (!pre.ready) process.exitCode = 1;
          break;
        }
        const rep = await providerReadiness(config, store, new EnvCredentialSource(config.envFile));
        if (values.json) {
          out(JSON.stringify(rep, null, 2));
          break;
        }
        out(
          `Provider readiness (claude)   configured provider: ${config.provider}   SDK: ${rep.sdkVersion ?? 'not installed'}`,
        );
        out(
          table(
            Object.entries(rep.levels).map(([level, e]) => ({ level, state: e.state, detail: e.detail })),
            ['level', 'state', 'detail'],
          ),
        );
        out(
          `\noperational: ${rep.operational ? 'YES' : 'NO'}    unattended-ready (live recovery verified): ${rep.unattendedReady ? 'YES' : 'NO'}`,
        );
        break;
      }
      case 'provider:verify': {
        if (!values.access)
          fail(
            'usage: provider:verify --access   (live execution/recovery are verified by: npm run smoke:live, npm run smoke:live-recovery)',
          );
        const r = await verifyApiAccess(store, new EnvCredentialSource(config.envFile));
        out(`${r.ok ? 'OK' : 'FAILED'}: ${r.detail}`);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      default:
        fail(`unknown command "${cmd}". Run with --help.`);
    }
  } finally {
    app.close();
  }
}

main().catch((e) => {
  // Expected operational errors (bad id, illegal transition, workspace violation) get a one-line message.
  const debug = process.env['AGENT_DEBUG'] === '1';
  const msg = e instanceof Error ? (debug ? (e.stack ?? e.message) : e.message) : String(e);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
