/**
 * Child-process helper for the multi-process concurrency test: several OS processes hammer ONE SQLite file
 * (enqueue, then race to claim and complete every task). Prints a JSON summary on stdout.
 */
import { openDatabase } from '../../src/database/connection.js';
import { Store } from '../../src/queue/store.js';

const [dbPath, projectId, workerId, perWorker, expectedTotal] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const store = new Store(openDatabase(dbPath));
const errors: string[] = [];
const claimed: string[] = [];
const guard = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch (e) {
    errors.push(String((e as Error).message));
    return undefined;
  }
};

for (let i = 0; i < Number(perWorker); i++) {
  guard(() => store.enqueueTask({ projectId, title: `${workerId}-${i}`, instructions: 'x', maxRetries: 1 }));
}
// barrier: wait until every worker has finished enqueueing
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const n = (
    store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE project_id = ?').get(projectId) as { n: number }
  ).n;
  if (n >= Number(expectedTotal)) break;
  await new Promise((r) => setTimeout(r, 20));
}
for (;;) {
  const c = guard(() =>
    store.claimNext({
      workerId,
      leaseTtlMs: 60_000,
      maxConcurrent: 10_000,
      provider: 'mock',
      pid: process.pid,
    }),
  );
  if (!c) {
    const open = (
      store.db
        .prepare("SELECT COUNT(*) n FROM tasks WHERE project_id = ? AND status = 'QUEUED'")
        .get(projectId) as { n: number }
    ).n;
    if (open === 0) break;
    await new Promise((r) => setTimeout(r, 10));
    continue;
  }
  claimed.push(c.task.id);
  guard(() =>
    store.transition(c.task.id, 'CHECKPOINTING', {
      reason: 'done',
      executionId: c.execution.id,
      fenceExecutionId: c.execution.id,
    }),
  );
  guard(() => store.transition(c.task.id, 'COMPLETED', { reason: 'done', executionId: c.execution.id }));
}
process.stdout.write(JSON.stringify({ workerId, claimed, errors }) + '\n');
