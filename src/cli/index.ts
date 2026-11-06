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
import { createIntegrations, EVENT_MAPPING } from '../integrations/index.js';
import { MEMORY_SECTIONS } from '../memory/context.js';
import { reconcileOrphans } from '../recovery/reconcile.js';
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
} as const;

const HELP = `ELEVARIQ Personal Agent - Phase 1

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
        const sup = new Supervisor({ config, store, provider, registry, log: app.log });
        const onSignal = (sig: string) => sup.requestStop(`received ${sig}`);
        for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(s, () => onSignal(s));
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
          const text = readFileSync(values.file, 'utf8');
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
        const t = store.getTask(rest[0] ?? '');
        if (!t) fail(`unknown task ${rest[0] ?? ''}`);
        const map: Record<string, [TaskStatus, string]> = {
          'task:pause': ['PAUSED', 'paused by owner'],
          'task:resume': ['READY', 'resumed by owner'],
          'task:cancel': ['CANCELLED', 'cancelled by owner'],
          'task:retry': ['QUEUED', 'manual retry by owner'],
          'task:unblock': ['READY', 'unblocked by owner'],
        };
        const [to, reason] = map[cmd]!;
        const patch =
          cmd === 'task:retry'
            ? { resetAttempts: true, nextEligibleAt: null, lastErrorClass: null, lastErrorMessage: null }
            : { nextEligibleAt: null };
        const r = store.transition(t.id, to, { reason, patch });
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
        const a = store.decideApproval(
          rest[0] ?? '',
          cmd === 'approve' ? 'APPROVED' : 'DENIED',
          values.by ?? 'owner-cli',
        );
        if (a.taskId) {
          const open = store.listApprovals('PENDING').filter((x) => x.taskId === a.taskId);
          const t = store.requireTask(a.taskId);
          if (t.status === 'WAITING_FOR_APPROVAL' && open.length === 0) {
            store.transition(t.id, cmd === 'approve' ? 'READY' : 'BLOCKED', {
              reason:
                cmd === 'approve' ? 'owner approved requested action(s)' : 'owner denied requested action',
              patch: { nextEligibleAt: null },
            });
          }
        }
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
