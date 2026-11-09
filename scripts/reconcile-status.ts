/**
 * A4: derive requirement and milestone statuses from verified task state on an existing agent database.
 *
 *   npx tsx scripts/reconcile-status.ts <path-to-agent.db>           dry run (opens the database READ-ONLY)
 *   npx tsx scripts/reconcile-status.ts <path-to-agent.db> --apply   writes the derived statuses
 *
 * The supervisor also reconciles automatically (once at start-up and on every plan-task / QA change).
 */
import Database from 'better-sqlite3';
import { reconcileAllProjects } from '../src/planning/status-reconcile.js';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) {
  console.error('usage: tsx scripts/reconcile-status.ts <agent.db> [--apply]');
  process.exit(2);
}
const db = new Database(file, { readonly: !apply, fileMustExist: true });
const before = (table: 'requirements' | 'milestones') =>
  db.prepare(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`).all();
const reqBefore = before('requirements');
const msBefore = before('milestones');
const r = reconcileAllProjects(db, { dryRun: !apply });
const byTransition: Record<string, number> = {};
for (const c of r.changes) {
  const k = `${c.kind}: ${c.from} -> ${c.to}`;
  byTransition[k] = (byTransition[k] ?? 0) + 1;
}
console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      before: { requirements: reqBefore, milestones: msBefore },
      after: { requirements: r.requirements, milestones: r.milestones },
      changes: r.changes.length,
      byTransition,
      detail: r.changes.map((c) => `${c.kind} ${c.id}: ${c.from} -> ${c.to}`),
    },
    null,
    2,
  ),
);
db.close();
