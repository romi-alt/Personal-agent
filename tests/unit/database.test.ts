import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/database/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/database/migrations.js';

describe('database initialisation and migrations', () => {
  it('creates the schema, enables WAL and records migrations', () => {
    const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'db-')), 'a.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((t) => t.name);
    for (const t of [
      'projects',
      'tasks',
      'executions',
      'checkpoints',
      'activity_events',
      'task_transitions',
      'provider_state',
      'supervisor_state',
      'approvals',
      'workspaces',
      'project_memory',
      'schema_migrations',
    ]) {
      expect(tables).toContain(t);
    }
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations').get()).toEqual({ c: MIGRATIONS.length });
    db.close();
  });
  it('is idempotent and applies only new migrations', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db)).toEqual([]);
    const extra = { version: 99, name: 'extra', sql: 'CREATE TABLE extra_t (id INTEGER)' };
    expect(runMigrations(db, [...MIGRATIONS, extra])).toEqual([99]);
    expect(runMigrations(db, [...MIGRATIONS, extra])).toEqual([]);
  });
  it('rolls back a failing migration atomically', () => {
    const db = openDatabase(':memory:');
    const bad = { version: 100, name: 'bad', sql: 'CREATE TABLE ok_t (id INTEGER); THIS IS NOT SQL;' };
    expect(() => runMigrations(db, [...MIGRATIONS, bad])).toThrow();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ok_t'").get()).toBeUndefined();
  });
});
