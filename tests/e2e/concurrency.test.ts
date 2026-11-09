import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/database/connection.js';
import { Store } from '../../src/queue/store.js';
import { removeTempDir } from '../helpers/fs.js';

/**
 * Real OS processes sharing ONE database file: proves the write transactions (IMMEDIATE) neither deadlock nor
 * raise SQLITE_BUSY, and that a task is never claimed by two processes.
 */
const ROOT = path.resolve(__dirname, '../..');
let home: string;
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'elevariq-conc-'));
});
afterAll(() => removeTempDir(home));

function runWorker(args: string[]): Promise<{ workerId: string; claimed: string[]; errors: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/db-worker.ts', ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('close', (code) =>
      code === 0
        ? resolve(JSON.parse(out.trim().split('\n').at(-1)!))
        : reject(new Error(`worker exit ${code}: ${err}`)),
    );
  });
}

describe('multi-process database concurrency', () => {
  it('4 processes x 60 tasks: no SQLITE_BUSY errors, every task claimed and completed exactly once', async () => {
    const dbPath = path.join(home, 'shared.db');
    const setup = new Store(openDatabase(dbPath));
    const project = setup.createProject({ name: 'Concurrency', repoPath: home, provider: 'mock' });
    const WORKERS = 4;
    const PER = 60;
    const results = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        runWorker([dbPath, project.id, `w${i}`, String(PER), String(WORKERS * PER)]),
      ),
    );
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    const all = results.flatMap((r) => r.claimed);
    expect(all).toHaveLength(WORKERS * PER);
    expect(new Set(all).size).toBe(WORKERS * PER); // no task claimed twice
    const tasks = setup.listTasks({ projectId: project.id });
    expect(tasks).toHaveLength(WORKERS * PER);
    expect(tasks.every((t) => t.status === 'COMPLETED')).toBe(true);
    const execs = setup.db.prepare('SELECT COUNT(*) n FROM executions').get() as { n: number };
    expect(execs.n).toBe(WORKERS * PER); // exactly one execution per task
    expect(results.filter((r) => r.claimed.length > 0).length).toBeGreaterThan(1); // the work really was shared
    // every transition history is the expected 4-step chain
    for (const t of tasks.slice(0, 20)) {
      expect(setup.listTransitions(t.id).map((x) => x.to)).toEqual([
        'QUEUED',
        'RUNNING',
        'CHECKPOINTING',
        'COMPLETED',
      ]);
    }
    expect(setup.db.pragma('integrity_check', { simple: true })).toBe('ok');
    setup.db.close(); // Windows cannot delete a database file that is still open
  }, 90_000);
});
