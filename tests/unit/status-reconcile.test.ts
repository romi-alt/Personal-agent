import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/database/connection.js';
import { reconcileAllProjects, reconcileProjectStatus } from '../../src/planning/status-reconcile.js';

/**
 * A4: a pilot-shaped database - every requirement OPEN and every milestone PLANNED although tasks were delivered,
 * some through failed-then-passed reviews, one through an owner-accepted escalation.
 */
type T = {
  id: string;
  ms: string;
  reqs: string[];
  status: string;
  verify: string[];
  evidence?: [string, string][];
  ran?: boolean;
  qa?: { status: string; criteria: [string, boolean][]; unmet?: string[] }[];
};

function fixture(tasks: T[], milestones: Record<string, string[]>): Db {
  const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'reconcile-')), 'a.db'));
  db.exec(`INSERT INTO projects(id,name,slug,repo_path,created_at,updated_at,last_activity_at,provider)
           VALUES ('prj_1','Pilot','pilot','.',1,1,1,'mock')`);
  const reqs = new Set([...tasks.flatMap((t) => t.reqs), ...Object.values(milestones).flat()]);
  for (const r of reqs)
    db.prepare(
      "INSERT INTO requirements(project_id,req_id,text,kind,priority,source) VALUES ('prj_1',?,?,'functional','must','test')",
    ).run(r, `requirement ${r}`);
  Object.entries(milestones).forEach(([k, ids], i) =>
    db
      .prepare(
        "INSERT INTO milestones(project_id,key,title,goal,position,requirement_ids) VALUES ('prj_1',?,?,?,?,?)",
      )
      .run(k, k, 'goal', i, JSON.stringify(ids)),
  );
  let at = 10;
  for (const t of tasks) {
    db.prepare(
      `INSERT INTO tasks(id,project_id,title,instructions,status,max_retries,dedupe_key,created_at,updated_at,verification_required)
       VALUES (?,'prj_1',?,'do it',?,1,?,1,1,?)`,
    ).run(t.id, t.id, t.status, `plan:r:${t.id}`, JSON.stringify(t.verify));
    db.prepare(
      "INSERT INTO plan_tasks(task_id,run_id,plan_key,milestone_key,requirement_ids,size) VALUES (?,'r',?,?,?,'M')",
    ).run(t.id, t.id, t.ms, JSON.stringify(t.reqs));
    if (t.ran || t.status === 'COMPLETED')
      db.prepare(
        "INSERT INTO task_transitions(task_id,from_status,to_status,reason,at) VALUES (?,'QUEUED','RUNNING','claimed',?)",
      ).run(t.id, at++);
    for (const [level, status] of t.evidence ?? [])
      db.prepare(
        "INSERT INTO verification_evidence(id,project_id,task_id,level,status,summary,created_at) VALUES (?,'prj_1',?,?,?,'s',?)",
      ).run(`ev_${at}`, t.id, level, status, at++);
    (t.qa ?? []).forEach((q, i) =>
      db
        .prepare(
          'INSERT INTO qa_reviews(task_id,round,status,repairs,result,created_at,updated_at) VALUES (?,?,?,0,?,1,1)',
        )
        .run(
          t.id,
          i + 1,
          q.status,
          JSON.stringify({
            criteria: q.criteria.map(([id, met]) => ({ id, met, evidence: [], note: '' })),
            unmet: (q.unmet ?? []).map((id) => ({ id, text: id, reason: 'r' })),
          }),
        ),
    );
  }
  return db;
}

const QA = ['CHANGES_EXIST', 'REQUIREMENTS_SATISFIED'];
const pilot = () =>
  fixture(
    [
      // failed on a mis-mapped NFR-4, corrected, passed round 2 (NFR-4 not judged in the passing round)
      {
        id: 'T1',
        ms: 'M1',
        reqs: ['FR-1', 'NFR-4'],
        status: 'COMPLETED',
        verify: QA,
        evidence: [
          ['CHANGES_EXIST', 'PASSED'],
          ['REQUIREMENTS_SATISFIED', 'FAILED'],
          ['REQUIREMENTS_SATISFIED', 'PASSED'],
        ],
        qa: [
          {
            status: 'FAILED',
            criteria: [
              ['AC1', true],
              ['FR-1', true],
              ['NFR-4', false],
            ],
            unmet: ['NFR-4'],
          },
          {
            status: 'PASSED',
            criteria: [
              ['AC1', true],
              ['FR-1', true],
            ],
          },
        ],
      },
      // escalated, owner accepted: DR-9 judged only here and never met
      {
        id: 'T2',
        ms: 'M1',
        reqs: ['DR-3', 'DR-9'],
        status: 'COMPLETED',
        verify: QA,
        evidence: [
          ['CHANGES_EXIST', 'PASSED'],
          ['REQUIREMENTS_SATISFIED', 'PASSED'],
        ],
        qa: [
          {
            status: 'OWNER_ACCEPTED',
            criteria: [
              ['AC1', true],
              ['DR-3', false],
              ['DR-9', false],
            ],
            unmet: ['DR-3', 'DR-9'],
          },
        ],
      },
      // owner of NFR-4 and DR-3: passed with both met
      {
        id: 'T3',
        ms: 'M1',
        reqs: ['NFR-4', 'DR-3'],
        status: 'COMPLETED',
        verify: QA,
        evidence: [
          ['CHANGES_EXIST', 'PASSED'],
          ['REQUIREMENTS_SATISFIED', 'PASSED'],
        ],
        qa: [
          {
            status: 'PASSED',
            criteria: [
              ['AC1', true],
              ['NFR-4', true],
              ['DR-3', true],
            ],
          },
        ],
      },
      { id: 'T4', ms: 'M2', reqs: ['FR-2'], status: 'RUNNING', verify: QA, ran: true },
      { id: 'T5', ms: 'M3', reqs: ['FR-3'], status: 'QUEUED', verify: QA },
      // QA disabled for this task: delivered, but no independent review judged NFR-9
      {
        id: 'T6',
        ms: 'M0',
        reqs: ['NFR-9'],
        status: 'COMPLETED',
        verify: ['CHANGES_EXIST'],
        evidence: [['CHANGES_EXIST', 'PASSED']],
      },
      {
        id: 'T7',
        ms: 'M4',
        reqs: ['FR-7'],
        status: 'COMPLETED',
        verify: QA,
        evidence: [
          ['CHANGES_EXIST', 'PASSED'],
          ['REQUIREMENTS_SATISFIED', 'PASSED'],
        ],
        qa: [
          {
            status: 'PASSED',
            criteria: [
              ['AC1', true],
              ['FR-7', true],
            ],
          },
        ],
      },
      // review passed, but the latest build evidence FAILED: must NOT count as verified
      {
        id: 'T8',
        ms: 'M5',
        reqs: ['FR-8'],
        status: 'COMPLETED',
        verify: ['CHANGES_EXIST', 'BUILD_PASSES', 'REQUIREMENTS_SATISFIED'],
        evidence: [
          ['CHANGES_EXIST', 'PASSED'],
          ['BUILD_PASSES', 'PASSED'],
          ['BUILD_PASSES', 'FAILED'],
          ['REQUIREMENTS_SATISFIED', 'PASSED'],
        ],
        qa: [
          {
            status: 'PASSED',
            criteria: [
              ['AC1', true],
              ['FR-8', true],
            ],
          },
        ],
      },
      { id: 'T9', ms: 'M5', reqs: ['FR-9'], status: 'CANCELLED', verify: QA },
      // pilot reality: tests NOT_CONFIGURED, independent review passed -> reviewed, not verified
      {
        id: 'T10',
        ms: 'M6',
        reqs: ['FR-10'],
        status: 'COMPLETED',
        verify: ['CHANGES_EXIST', 'TESTS_PASS', 'REQUIREMENTS_SATISFIED'],
        evidence: [
          ['CHANGES_EXIST', 'PASSED'],
          ['TESTS_PASS', 'NOT_CONFIGURED'],
          ['REQUIREMENTS_SATISFIED', 'PASSED'],
        ],
        qa: [
          {
            status: 'PASSED',
            criteria: [
              ['AC1', true],
              ['FR-10', true],
            ],
          },
        ],
      },
    ],
    {
      M0: ['NFR-9'],
      M1: ['FR-1', 'NFR-4', 'DR-3', 'DR-9'],
      M2: ['FR-2'],
      M3: ['FR-3'],
      M4: ['FR-7'],
      M5: ['FR-8'],
      M6: ['FR-10'],
    },
  );

const statuses = (db: Db, table: 'requirements' | 'milestones') =>
  Object.fromEntries(
    (
      db
        .prepare(`SELECT ${table === 'requirements' ? 'req_id' : 'key'} AS k, status FROM ${table}`)
        .all() as {
        k: string;
        status: string;
      }[]
    ).map((r) => [r.k, r.status]),
  );

describe('A4: requirement and milestone statuses are derived from verified task state', () => {
  it('reconciles a pilot-shaped database, distinguishing verified from owner-accepted, idempotently', () => {
    const db = pilot();
    // dry run: reports, writes nothing
    const dry = reconcileProjectStatus(db, 'prj_1', { dryRun: true });
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(new Set(Object.values(statuses(db, 'requirements')))).toEqual(new Set(['OPEN']));
    expect(new Set(Object.values(statuses(db, 'milestones')))).toEqual(new Set(['PLANNED']));

    const r = reconcileProjectStatus(db, 'prj_1');
    expect(r.changes).toEqual(dry.changes);
    expect(statuses(db, 'requirements')).toEqual({
      'FR-1': 'VERIFIED',
      'NFR-4': 'VERIFIED', // judged met by its owner T3 (T1's mis-mapped failure does not matter)
      'DR-3': 'VERIFIED',
      'DR-9': 'ACCEPTED', // only the owner-accepted review covered it: accepted, NOT verified
      'FR-2': 'IN_PROGRESS',
      'FR-3': 'OPEN',
      'NFR-9': 'IMPLEMENTED', // delivered without an independent review
      'FR-7': 'VERIFIED',
      'FR-8': 'IN_PROGRESS', // latest build evidence failed
      'FR-9': 'OPEN', // only a cancelled task
      'FR-10': 'REVIEWED', // reviewed independently, tests never machine-confirmed
    });
    expect(statuses(db, 'milestones')).toEqual({
      M0: 'COMPLETED',
      M1: 'ACCEPTED',
      M2: 'IN_PROGRESS',
      M3: 'PLANNED',
      M4: 'VERIFIED',
      M5: 'IN_PROGRESS',
      M6: 'REVIEWED',
    });
    // idempotent
    expect(reconcileProjectStatus(db, 'prj_1').changes).toEqual([]);
    expect(reconcileAllProjects(db).changes).toEqual([]);
  });

  it('follows state changes: a reopened task moves statuses back (nothing stays verified that is not)', () => {
    const db = pilot();
    reconcileProjectStatus(db, 'prj_1');
    db.prepare("UPDATE tasks SET status = 'RUNNING' WHERE id = 'T7'").run();
    const r = reconcileProjectStatus(db, 'prj_1');
    expect(r.changes).toEqual([
      { kind: 'requirement', projectId: 'prj_1', id: 'FR-7', from: 'VERIFIED', to: 'IN_PROGRESS' },
      { kind: 'milestone', projectId: 'prj_1', id: 'M4', from: 'VERIFIED', to: 'IN_PROGRESS' },
    ]);
  });
});
