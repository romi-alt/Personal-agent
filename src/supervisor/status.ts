import type { ExecutionProvider } from '../providers/types.js';
import type { Store } from '../queue/store.js';
import type { Task } from '../types/index.js';

export interface StatusReport {
  supervisor: {
    live: boolean;
    status: string;
    pid: number | null;
    host: string | null;
    instanceId: string | null;
    startedAt: number | null;
    heartbeatAt: number | null;
    stopRequested: boolean;
    lastError: string | null;
  };
  currentWorker: string | null;
  currentProject: string | null;
  currentTask: { id: string; title: string } | null;
  queue: { length: number; waiting: number; byStatus: Record<string, number> };
  waitingTasks: {
    id: string;
    title: string;
    status: string;
    nextEligibleAt: number | null;
    reason: string | null;
  }[];
  lastCheckpoint: { id: string; taskId: string; createdAt: number; repoRef: string | null } | null;
  lastError: { taskId: string; class: string | null; message: string | null } | null;
  nextScheduledRetry: number | null;
  authentication: { ready: boolean; detail: string; missing: string[] };
  provider: {
    name: string;
    state: string;
    blockedUntil: number | null;
    reason: string | null;
    consecutiveFailures: number;
  };
}

export async function buildStatus(
  store: Store,
  provider: ExecutionProvider,
  leaseTtlMs: number,
): Promise<StatusReport> {
  const sup = store.getSupervisorState();
  const live = !!sup && store.supervisorIsLive(sup, leaseTtlMs);
  const tasks = store.listTasks();
  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const pending = tasks.filter((t) =>
    ['QUEUED', 'READY', 'RETRY_SCHEDULED', 'WAITING_FOR_CAPACITY', 'WAITING_FOR_AUTHENTICATION'].includes(
      t.status,
    ),
  );
  const waiting = tasks.filter((t) => t.status.startsWith('WAITING_') || t.status === 'RETRY_SCHEDULED');
  const running: Task | undefined = store.listActiveTasks()[0];
  const project = running ? store.getProject(running.projectId) : null;
  const errored = tasks.filter((t) => t.lastErrorClass).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const cp = store.latestProjectCheckpoint();
  const pre = await provider.preflight();
  const ps = store.getProviderState(provider.name);
  const retries = waiting.map((t) => t.nextEligibleAt).filter((x): x is number => x !== null);
  return {
    supervisor: {
      live,
      status: sup
        ? live
          ? sup.status
          : sup.status === 'STOPPED'
            ? 'STOPPED'
            : 'DEAD (stale heartbeat)'
        : 'NEVER_STARTED',
      pid: sup?.pid ?? null,
      host: sup?.host ?? null,
      instanceId: sup?.instanceId ?? null,
      startedAt: sup?.startedAt ?? null,
      heartbeatAt: sup?.heartbeatAt ?? null,
      stopRequested: sup?.stopRequested ?? false,
      lastError: sup?.lastError ?? null,
    },
    currentWorker: running?.assignedWorker ?? null,
    currentProject: project?.name ?? null,
    currentTask: running ? { id: running.id, title: running.title } : null,
    queue: { length: pending.length, waiting: waiting.length, byStatus },
    waitingTasks: waiting.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      nextEligibleAt: t.nextEligibleAt,
      reason: t.lastErrorMessage,
    })),
    lastCheckpoint: cp
      ? { id: cp.id, taskId: cp.taskId, createdAt: cp.createdAt, repoRef: cp.repoRef }
      : null,
    lastError: errored
      ? { taskId: errored.id, class: errored.lastErrorClass, message: errored.lastErrorMessage }
      : null,
    nextScheduledRetry: retries.length ? Math.min(...retries) : null,
    authentication: { ready: pre.ready, detail: pre.detail, missing: pre.missing },
    provider: {
      name: provider.name,
      state: ps.status,
      blockedUntil: ps.blockedUntil,
      reason: ps.reason,
      consecutiveFailures: ps.consecutiveFailures,
    },
  };
}
