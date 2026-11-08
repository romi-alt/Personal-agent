import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAssignment } from '../../src/assignments/register.js';
import { MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { assignmentExample } from '../helpers/assignment.js';
import { makeEnv, settle, type TestEnv } from '../helpers/env.js';
import { happyPlanning, reply } from '../helpers/plan-fixtures.js';

/** A3: a review task never exists without its QA round (no orphan review tasks). */
let env: TestEnv;
afterEach(() => env?.cleanup());

const QA = { PLAN_APPROVAL: 'auto', INDEPENDENT_REVIEW: 'true' };
const code = (file: string) => ({
  type: 'success' as const,
  writes: [{ file, content: '// a\n// b\n// c\n' }],
});
const verdict = (ids: string[], file: string) =>
  reply(
    JSON.stringify({
      criteria: ids.map((id) => ({ id, met: true, evidence: [{ file, line: 1 }], note: 'ok' })),
      defects: [],
      testsAssessment: 'ok',
    }),
  );

const reviewTaskCount = () =>
  (
    env.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE dedupe_key LIKE 'qa:%'").get() as {
      n: number;
    }
  ).n;

describe('A3: transactional review creation', () => {
  it('a failure between creating the review task and its qa_reviews row leaves neither behind', async () => {
    env = await makeEnv({ env: QA });
    const { task } = env.store.enqueueTask({
      projectId: env.project.id,
      kind: 'CODING',
      title: 'Implement feature',
      instructions: 'Implement the feature with tests.',
      acceptanceCriteria: 'feature works',
      maxRetries: 1,
      dedupeKey: 'manual:feature',
      verificationRequired: ['REQUIREMENTS_SATISFIED'],
    });
    env.store.db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(task.id);

    // Inject a crash right after the review task is inserted (before the qa_reviews row).
    const original = env.store.enqueueTask.bind(env.store);
    env.store.enqueueTask = ((input: Parameters<typeof original>[0]) => {
      const r = original(input);
      if (input.dedupeKey?.startsWith('qa:')) throw new Error('injected failure between inserts');
      return r;
    }) as typeof original;
    await expect(env.qa.tick()).rejects.toThrow('injected failure between inserts');
    expect(reviewTaskCount()).toBe(0);
    expect(env.qa.rows(task.id)).toEqual([]);
    expect(env.qa.reviewTasks(task.id)).toEqual([]);
    expect(env.qa.orphanReviewTasks()).toEqual([]);

    // Next tick (fault gone): the review task, its round and its link appear together.
    env.store.enqueueTask = original;
    expect(await env.qa.tick()).toBe(1);
    const rows = env.qa.rows(task.id);
    expect(rows.map((r) => `${r.round}:${r.status}`)).toEqual(['1:REVIEWING']);
    expect(env.qa.reviewTasks(task.id)).toEqual([
      { reviewTaskId: rows[0]!.reviewTaskId, round: 1, repair: 0 },
    ]);
    expect(reviewTaskCount()).toBe(1);
    expect(env.qa.orphanReviewTasks()).toEqual([]);
  });

  it('a repair re-dispatch keeps the superseded review task linked to its round (the pilot orphan)', async () => {
    env = await makeEnv({
      env: QA,
      mock: {
        scenario: {
          tasks: {
            ...happyPlanning(),
            'Scaffold project and auth': [code('src/auth.ts')],
            'Review: Scaffold project and auth': [reply('I think it looks fine.')], // unusable -> repair
            'Review: Scaffold project and auth (repair 1)': [verdict(['AC1', 'AC2', 'NFR-1'], 'src/auth.ts')],
            'Enrollment module': [code('src/enroll.ts')],
            'Review: Enrollment module': [verdict(['AC1', 'FR-1', 'DR-1'], 'src/enroll.ts')],
            'Attendance module': [code('src/att.ts')],
            'Review: Attendance module': [verdict(['AC1', 'FR-2'], 'src/att.ts')],
          } as never,
        },
      },
    });
    const { project } = await registerAssignment(env.store, env.registry, 'mock', assignmentExample());
    env.workflows.startPlanning(project.id);
    await settle(env);
    const t1 = env.store
      .listTasks({ projectId: project.id })
      .find((t) => t.title === 'Scaffold project and auth')!;
    const row = env.qa.rows(t1.id);
    expect(row.map((r) => `${r.round}:${r.status}:${r.repairs}`)).toEqual(['1:PASSED:1']);
    const links = env.qa.reviewTasks(t1.id);
    expect(links.map((l) => `${l.round}:${l.repair}`)).toEqual(['1:0', '1:1']);
    expect(links[1]!.reviewTaskId).toBe(row[0]!.reviewTaskId);
    expect(env.qa.orphanReviewTasks()).toEqual([]);
    const events = env.store.db
      .prepare("SELECT COUNT(*) AS n FROM activity_events WHERE type = 'qa.review_queued'")
      .get() as { n: number };
    expect(events.n).toBe(reviewTaskCount()); // every queued review is a linked review task
  });

  it('migration v10 links review tasks that already exist (backfill from the dedupe key)', () => {
    const raw = new Database(':memory:');
    runMigrations(
      raw,
      MIGRATIONS.filter((m) => m.version <= 8),
    );
    raw.exec(`INSERT INTO projects(id,name,slug,repo_path,created_at,updated_at,last_activity_at,provider)
              VALUES ('prj_1','P','p','.',1,1,1,'mock')`);
    const ins = raw.prepare(
      `INSERT INTO tasks(id,project_id,title,instructions,status,max_retries,dedupe_key,created_at,updated_at)
       VALUES (?,'prj_1','t','i','COMPLETED',1,?,5,5)`,
    );
    ins.run('tsk_orig', 'plan:run:T1');
    ins.run('tsk_rev0', 'qa:tsk_orig:1:0');
    ins.run('tsk_rev1', 'qa:tsk_orig:1:1');
    ins.run('tsk_rev2', 'qa:tsk_orig:12:0');
    expect(runMigrations(raw)).toEqual(MIGRATIONS.filter((m) => m.version > 8).map((m) => m.version));
    expect(
      raw
        .prepare('SELECT review_task_id, task_id, round, repair FROM qa_review_tasks ORDER BY review_task_id')
        .all(),
    ).toEqual([
      { review_task_id: 'tsk_rev0', task_id: 'tsk_orig', round: 1, repair: 0 },
      { review_task_id: 'tsk_rev1', task_id: 'tsk_orig', round: 1, repair: 1 },
      { review_task_id: 'tsk_rev2', task_id: 'tsk_orig', round: 12, repair: 0 },
    ]);
    raw.close();
  });
});
