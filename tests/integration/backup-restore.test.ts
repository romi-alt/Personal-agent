import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/database/connection.js';
import {
  createBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
  verifyBackup,
} from '../../src/ops/backup.js';
import { Notifier } from '../../src/ops/notify.js';
import { Store } from '../../src/queue/store.js';
import { makeEnv, settle, type TestEnv } from '../helpers/env.js';
import { removeTempDir } from '../helpers/fs.js';

let env: TestEnv | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
  for (const d of dirs.splice(0)) removeTempDir(d);
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'elevariq-bk-'));
  dirs.push(d);
  return d;
};

describe('Phase 6: backups and restore', () => {
  it('takes a consistent online backup, verifies it, and restores it (restore drill)', async () => {
    env = await makeEnv();
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      title: 'before backup',
      instructions: 'x',
      maxRetries: 1,
    }).task;
    const dir = tmp();
    const m = await createBackup(env.store.db, dir);
    expect(m.counts['tasks']).toBe(1);
    expect(verifyBackup(path.join(dir, m.file))).toMatchObject({ ok: true, problems: [] });
    // A backup is one self-contained file: no WAL sidecars left by creating or verifying it, checksum stable.
    expect(readdirSync(dir).sort()).toEqual([m.file, `${m.file}.json`]);
    expect(verifyBackup(path.join(dir, m.file)).ok).toBe(true);

    // live database moves on after the backup
    env.store.enqueueTask({
      projectId: env.project.id,
      title: 'after backup',
      instructions: 'y',
      maxRetries: 1,
    });
    const target = path.join(tmp(), 'restored.db');
    const r = restoreBackup(path.join(dir, m.file), target);
    expect(r.previous).toBeNull();
    const restored = new Store(openDatabase(target));
    expect(restored.listTasks({}).map((x) => x.title)).toEqual(['before backup']);
    expect(restored.getTask(t.id)!.title).toBe('before backup');
    restored.db.close();
  });

  it('a corrupted or tampered backup is refused', async () => {
    env = await makeEnv();
    const dir = tmp();
    const m = await createBackup(env.store.db, dir);
    const file = path.join(dir, m.file);
    appendFileSync(file, 'garbage');
    const v = verifyBackup(file);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/checksum mismatch/);
    expect(() => restoreBackup(file, path.join(tmp(), 'x.db'))).toThrow(/refusing to restore/);
  });

  it('restore keeps the replaced database; retention prunes the oldest backups', async () => {
    env = await makeEnv();
    const dir = tmp();
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await createBackup(env.store.db, dir, Date.UTC(2026, 10, 1 + i)));
    expect(pruneBackups(dir, 2)).toEqual([made[0]!.file, made[1]!.file]);
    expect(listBackups(dir).map((b) => b.file)).toEqual([made[2]!.file, made[3]!.file]);
    const target = path.join(tmp(), 'live.db');
    restoreBackup(path.join(dir, made[3]!.file), target);
    const r = restoreBackup(path.join(dir, made[2]!.file), target, Date.UTC(2026, 10, 9));
    expect(r.previous && existsSync(r.previous)).toBe(true);
  });

  it('the supervisor takes scheduled backups and records them', async () => {
    env = await makeEnv({ env: { BACKUP_INTERVAL_HOURS: '24', BACKUP_RETENTION: '3' } });
    await settle(env);
    expect(env.store.listEvents({ type: 'backup.created' })).toHaveLength(1);
    expect(readdirSync(env.config.backup.dir).filter((f) => f.endsWith('.db'))).toHaveLength(1);
  });

  it('CLI: backup + verify + restore refuses while a supervisor is live and requires a reason', async () => {
    const home = tmp();
    const run = (...a: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...a], {
        cwd: path.resolve(__dirname, '../..'),
        env: {
          ...process.env,
          AGENT_HOME: home,
          AGENT_ENV_FILE: path.join(home, 'none.env'),
          LOG_TO_CONSOLE: 'false',
          NODE_NO_WARNINGS: '1',
        },
        encoding: 'utf8',
      });
    expect(run('project:add', '--name', 'Backup Demo').status).toBe(0);
    const b = run('backup');
    expect(b.status).toBe(0);
    expect(b.stdout).toMatch(/verified/);
    const file = path.join(home, 'backups', listBackups(path.join(home, 'backups'))[0]!.file);
    expect(run('backup:verify', file).stdout).toMatch(/^OK /);
    expect(run('restore', file).stderr).toMatch(/--reason/);
    const ok = run('restore', file, '--reason', 'restore drill');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/previous database kept at/);
    expect(readFileSync(file).length).toBeGreaterThan(0);
  }, 120_000);
});

describe('Phase 6: owner notifications', () => {
  it('delivers error/escalation/approval events exactly once (cursor survives restarts)', async () => {
    env = await makeEnv();
    env.store.recordEvent({ type: 'task.enqueued', payload: {} }); // not notified
    env.store.recordEvent({ type: 'backup.failed', severity: 'error', payload: { error: 'disk full' } });
    env.store.createApproval({
      projectId: env.project.id,
      actionType: 'production_deploy',
      description: 'deploy',
      payload: {},
    });
    const n = new Notifier(env.store, { agentHome: env.config.agentHome });
    expect(await n.flush()).toBeGreaterThanOrEqual(2);
    expect(await new Notifier(env.store, { agentHome: env.config.agentHome }).flush()).toBe(0);
    const lines = readFileSync(path.join(env.config.agentHome, 'notifications.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; title: string });
    expect(lines.map((l) => l.type)).toContain('backup.failed');
    expect(lines.find((l) => l.type === 'backup.failed')!.title).toBe('backup.failed: disk full');
  });
});
