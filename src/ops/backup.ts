import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../database/connection.js';

/**
 * Database backups (Phase 6). Uses SQLite's online backup API, so a consistent snapshot is taken while the supervisor
 * keeps running. Each backup is `<dir>/agent-<UTC timestamp>.db` plus a manifest with schema version, row counts and a
 * SHA-256 of the file. Secrets are NOT in the database (credentials live in the environment / .env / the Claude Code
 * login store), and the dashboard owner token is deliberately not backed up.
 */
export interface BackupManifest {
  file: string;
  createdAt: number;
  bytes: number;
  sha256: string;
  schemaVersion: number;
  counts: Record<string, number>;
}

const COUNTED = [
  'projects',
  'tasks',
  'executions',
  'checkpoints',
  'approvals',
  'activity_events',
  'verification_evidence',
  'workflow_runs',
];

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function counts(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNTED) {
    try {
      out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    } catch {
      out[t] = -1; // table absent in an older schema
    }
  }
  return out;
}

const schemaVersion = (db: Database.Database) =>
  (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;

export async function createBackup(db: Db, dir: string, now = Date.now()): Promise<BackupManifest> {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `agent-${stamp}.db`);
  const tmp = `${file}.partial`;
  await db.backup(tmp);
  renameSync(tmp, file); // a half-written backup is never mistaken for a complete one
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const manifest: BackupManifest = {
      file: path.basename(file),
      createdAt: now,
      bytes: statSync(file).size,
      sha256: sha256(file),
      schemaVersion: schemaVersion(copy),
      counts: counts(copy),
    };
    writeFileSync(`${file}.json`, JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    copy.close();
  }
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  manifest: BackupManifest | null;
}

/** Restore drill without touching the live database: checksum, SQLite integrity check, row counts vs. manifest. */
export function verifyBackup(file: string): VerifyResult {
  const problems: string[] = [];
  if (!existsSync(file)) return { ok: false, problems: [`missing file ${file}`], manifest: null };
  let manifest: BackupManifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as BackupManifest;
  } catch {
    problems.push('manifest missing or unreadable');
  }
  if (manifest && sha256(file) !== manifest.sha256)
    problems.push('checksum mismatch (file changed or corrupted)');
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const ic = db.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') problems.push(`integrity_check: ${String(ic)}`);
    if (manifest) {
      const c = counts(db);
      for (const [t, n] of Object.entries(manifest.counts))
        if (c[t] !== n) problems.push(`row count ${t}: ${c[t]} != manifest ${n}`);
      if (schemaVersion(db) !== manifest.schemaVersion) problems.push('schema version differs from manifest');
    }
  } catch (e) {
    problems.push(`not a readable SQLite database: ${(e as Error).message}`);
  } finally {
    db?.close();
  }
  return { ok: problems.length === 0, problems, manifest };
}

export function listBackups(dir: string): BackupManifest[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^agent-.*\.db$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(path.join(dir, `${f}.json`), 'utf8')) as BackupManifest;
      } catch {
        return null;
      }
    })
    .filter((m): m is BackupManifest => !!m)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Keep the newest `keep` backups (and their manifests). */
export function pruneBackups(dir: string, keep: number): string[] {
  const all = listBackups(dir);
  const removed: string[] = [];
  for (const m of all.slice(0, Math.max(0, all.length - keep))) {
    for (const f of [m.file, `${m.file}.json`]) rmSync(path.join(dir, f), { force: true });
    removed.push(m.file);
  }
  return removed;
}

/**
 * Restore a verified backup over the database file. The caller must guarantee no supervisor is running (the CLI checks
 * the supervisor lease). The current database is kept as `<db>.pre-restore-<ts>` so a restore can itself be undone.
 */
export function restoreBackup(
  file: string,
  databasePath: string,
  now = Date.now(),
): { previous: string | null } {
  const v = verifyBackup(file);
  if (!v.ok) throw new Error(`refusing to restore an unverified backup: ${v.problems.join('; ')}`);
  let previous: string | null = null;
  if (existsSync(databasePath)) {
    previous = `${databasePath}.pre-restore-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    renameSync(databasePath, previous);
    for (const ext of ['-wal', '-shm'])
      if (existsSync(databasePath + ext)) renameSync(databasePath + ext, previous + ext);
  }
  copyFileSync(file, databasePath);
  return { previous };
}
