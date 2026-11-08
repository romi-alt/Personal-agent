import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/connection.js';
import { Store } from '../../src/queue/store.js';
import { requirementCoverage } from '../../src/verification/service.js';

/**
 * v2 review finding (HIGH): project-level REQUIREMENTS_SATISFIED counted a requirement as verified when ANY linked
 * task passed review, although since A1 contributing tasks do not judge requirements they only contribute to. Now only
 * a passing review that judged THAT requirement met counts; owner acceptance counts as accepted, never verified.
 */
type T = { id: string; reqs: string[]; qa?: { status: string; met: string[] }; ev?: [string, string?] };

function store(tasks: T[]): Store {
  const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'cov-')), 'a.db'));
  db.exec(`INSERT INTO projects(id,name,slug,repo_path,created_at,updated_at,last_activity_at,provider)
           VALUES ('prj_1','P','p','.',1,1,1,'mock')`);
  for (const r of new Set(tasks.flatMap((t) => t.reqs)))
    db.prepare(
      "INSERT INTO requirements(project_id,req_id,text,kind,priority,source) VALUES ('prj_1',?,?,'functional','must','t')",
    ).run(r, r);
  let at = 1;
  for (const t of tasks) {
    db.prepare(
      `INSERT INTO tasks(id,project_id,title,instructions,status,max_retries,dedupe_key,created_at,updated_at,verification_required)
       VALUES (?,'prj_1',?,'x','COMPLETED',1,?,1,1,'["REQUIREMENTS_SATISFIED"]')`,
    ).run(t.id, t.id, `plan:${t.id}`);
    db.prepare(
      "INSERT INTO plan_tasks(task_id,run_id,plan_key,milestone_key,requirement_ids,size) VALUES (?,'r',?,'M1',?,'M')",
    ).run(t.id, t.id, JSON.stringify(t.reqs));
    if (t.qa)
      db.prepare(
        'INSERT INTO qa_reviews(task_id,round,status,repairs,result,created_at,updated_at) VALUES (?,1,?,0,?,1,1)',
      ).run(
        t.id,
        t.qa.status,
        JSON.stringify({
          criteria: t.qa.met.map((id) => ({ id, met: true, evidence: [], note: '' })),
          unmet: [],
        }),
      );
    if (t.ev)
      db.prepare(
        "INSERT INTO verification_evidence(id,project_id,task_id,level,status,summary,evidence,created_at) VALUES (?,'prj_1',?,'REQUIREMENTS_SATISFIED',?,'s',?,?)",
      ).run(`ev${at}`, t.id, t.ev[0], t.ev[1] ?? '{}', at++);
  }
  return new Store(db);
}

describe('project-level requirement coverage respects ownership (v2 review)', () => {
  it('a contributor that passed does NOT verify a requirement whose owner review failed', () => {
    const s = store([
      { id: 'tsk_owner', reqs: ['NFR-1'], qa: { status: 'FAILED', met: [] }, ev: ['FAILED'] },
      // contributor's passing review judged only its own AC1 (NFR-1 was informational for it)
      { id: 'tsk_contrib', reqs: ['NFR-1'], qa: { status: 'PASSED', met: ['AC1'] }, ev: ['PASSED'] },
    ]);
    const r = requirementCoverage(s, 'prj_1');
    expect(r.status).toBe('FAILED');
    expect(r.evidence['missing']).toEqual(['NFR-1']);
  });

  it('verified only by a passing review that judged the id met', () => {
    const s = store([
      { id: 'tsk_owner', reqs: ['NFR-1'], qa: { status: 'PASSED', met: ['AC1', 'NFR-1'] }, ev: ['PASSED'] },
      { id: 'tsk_contrib', reqs: ['NFR-1'], qa: { status: 'PASSED', met: ['AC1'] }, ev: ['PASSED'] },
    ]);
    const r = requirementCoverage(s, 'prj_1');
    expect(r.status).toBe('PASSED');
    expect(r.evidence['byRequirement']).toEqual({ 'NFR-1': ['tsk_owner'] });
  });

  it('owner acceptance (v2 status, and legacy PASSED+ownerOverride) is ACCEPTED, never verified', () => {
    for (const ev of [
      ['OWNER_ACCEPTED', '{"ownerOverride":true}'],
      ['PASSED', '{"ownerOverride":true}'],
    ] as [string, string][]) {
      const s = store([{ id: 'tsk_owner', reqs: ['FR-1'], qa: { status: 'OWNER_ACCEPTED', met: [] }, ev }]);
      const r = requirementCoverage(s, 'prj_1');
      expect(r.status, ev.join()).toBe('OWNER_ACCEPTED');
      expect(r.summary).toMatch(/accepted, not verified/);
    }
  });
});
