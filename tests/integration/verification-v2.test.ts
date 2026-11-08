import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerAssignment } from '../../src/assignments/register.js';
import {
  deriveVerificationCommands,
  ensureDerivedCommands,
  setVerificationCommands,
  VerificationConfigError,
} from '../../src/assignments/verification-config.js';
import { verifyProject } from '../../src/verification/service.js';
import { manualTaskPolicy } from '../../src/verification/task-policy.js';
import { assignmentExample } from '../helpers/assignment.js';
import { makeEnv, settle, type TestEnv } from '../helpers/env.js';
import { reply } from '../helpers/plan-fixtures.js';
import { removeTempDir } from '../helpers/fs.js';

/**
 * A5 / A6 / A7 regression tests (pilot: `project:verify` reported BUILD_PASSES/TESTS_PASS NOT_CONFIGURED with no way
 * to fix it after intake; corrections added with task:add got no independent QA).
 */
let env: TestEnv;
afterEach(() => env?.cleanup());

const node = (code: string) => `"${process.execPath}" -e "${code}"`;
const pass = node('process.exit(0)');
const failCmd = node('process.exit(3)');

describe('A7: verification commands can be set after intake (authorised, audited)', () => {
  it('records who/why/before/after, validates, refuses no-ops and missing authorisation', async () => {
    env = await makeEnv();
    const { project } = await registerAssignment(env.store, env.registry, 'mock', assignmentExample());
    const meta = { by: 'owner', reason: 'pilot: commands were missing at intake', source: 'owner' as const };

    expect(() =>
      setVerificationCommands(env.store, project.id, { buildCommand: 'x' }, { ...meta, by: '' }),
    ).toThrow(/--by is required/);
    expect(() =>
      setVerificationCommands(env.store, project.id, { buildCommand: 'x' }, { ...meta, reason: ' ' }),
    ).toThrow(/--reason is required/);
    expect(() => setVerificationCommands(env.store, env.project.id, { buildCommand: 'x' }, meta)).toThrow(
      /no registered assignment/,
    );

    const r = setVerificationCommands(
      env.store,
      project.id,
      { buildCommand: 'npm run build', testCommand: 'npm test', browserTestCommand: 'npm run test:e2e' },
      meta,
    );
    expect(r.before).toEqual({});
    expect(r.after).toEqual({
      buildCommand: 'npm run build',
      testCommand: 'npm test',
      browserTestCommand: 'npm run test:e2e',
    });
    expect(() => setVerificationCommands(env.store, project.id, { testCommand: 'npm test' }, meta)).toThrow(
      VerificationConfigError,
    );
    setVerificationCommands(env.store, project.id, { browserTestCommand: null }, meta); // clear one
    const ev = env.store
      .listEvents({ projectId: project.id })
      .filter((e) => e.type === 'assignment.verification_changed');
    expect(ev).toHaveLength(2);
    expect(ev[0]!.payload).toMatchObject({ by: 'owner', reason: meta.reason, source: 'owner', before: {} });
    expect(ev[1]!.payload['after']).toEqual({ buildCommand: 'npm run build', testCommand: 'npm test' });
    // the rest of the assignment contract is untouched
    const data = env.store.getAssignmentData(project.id)!;
    expect((data['functionalRequirements'] as unknown[]).length).toBe(
      assignmentExample().functionalRequirements.length,
    );
  });
});

describe('project:verify records real execution evidence when commands exist (A5/A7)', () => {
  it('PASSED / FAILED with exit codes; the browser suite is part of TESTS_PASS; nothing is NOT_CONFIGURED', async () => {
    env = await makeEnv();
    const { project } = await registerAssignment(env.store, env.registry, 'mock', assignmentExample());
    const meta = { by: 'owner', reason: 'test', source: 'owner' as const };
    setVerificationCommands(
      env.store,
      project.id,
      { buildCommand: pass, testCommand: pass, browserTestCommand: failCmd },
      meta,
    );
    let v = await verifyProject(
      { store: env.store, timeoutMs: 60_000 },
      env.store.getProject(project.id)!,
      project.repoPath,
    );
    const lvl = (l: string) => v.evidence.find((e) => e.level === l)!;
    expect(lvl('BUILD_PASSES')).toMatchObject({ status: 'PASSED' });
    expect(lvl('BUILD_PASSES').evidence).toMatchObject({ exitCode: 0 });
    expect(lvl('TESTS_PASS').status).toBe('FAILED');
    const runs = lvl('TESTS_PASS').evidence['runs'] as { exitCode: number }[];
    expect(runs.map((r) => r.exitCode)).toEqual([0, 3]);
    expect(lvl('TESTS_PASS').summary).toMatch(/exited with code 3/);

    setVerificationCommands(env.store, project.id, { browserTestCommand: pass }, meta);
    v = await verifyProject(
      { store: env.store, timeoutMs: 60_000 },
      env.store.getProject(project.id)!,
      project.repoPath,
    );
    expect(v.evidence.find((e) => e.level === 'TESTS_PASS')!.status).toBe('PASSED');
    expect(v.evidence.filter((e) => e.status === 'NOT_CONFIGURED')).toHaveLength(0);
  });

  it('A5: with no commands configured they are derived from package.json once (audited) and then executed', async () => {
    env = await makeEnv();
    const { project } = await registerAssignment(env.store, env.registry, 'mock', assignmentExample());
    writeFileSync(
      path.join(project.repoPath, 'package.json'),
      JSON.stringify({
        name: 'x',
        scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
      }),
    );
    const v = await verifyProject(
      { store: env.store, timeoutMs: 120_000 },
      env.store.getProject(project.id)!,
      project.repoPath,
    );
    expect(v.evidence.find((e) => e.level === 'BUILD_PASSES')).toMatchObject({ status: 'PASSED' });
    expect(v.evidence.find((e) => e.level === 'TESTS_PASS')).toMatchObject({ status: 'PASSED' });
    const ev = env.store
      .listEvents({ projectId: project.id })
      .filter((e) => e.type === 'assignment.verification_changed');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ source: 'derived', by: 'project:verify' });
    // owner-set commands are never overridden by derivation
    expect(ensureDerivedCommands(env.store, project.id, project.repoPath, 'again')).toBeNull();
  });

  it('deriveVerificationCommands: ignores the npm placeholder test script; picks the browser suite', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'derive-'));
    try {
      expect(deriveVerificationCommands(dir)).toEqual({});
      writeFileSync(
        path.join(dir, 'package.json'),
        '﻿' +
          JSON.stringify({
            scripts: {
              build: 'tsc',
              test: 'echo "Error: no test specified" && exit 1',
              'test:e2e': 'playwright test',
            },
          }),
      );
      expect(deriveVerificationCommands(dir)).toEqual({
        buildCommand: 'npm run build',
        browserTestCommand: 'npm run test:e2e',
      });
      mkdirSync(path.join(dir, 'sub'));
      writeFileSync(path.join(dir, 'sub', 'package.json'), '{ not json');
      expect(deriveVerificationCommands(path.join(dir, 'sub'))).toEqual({});
    } finally {
      removeTempDir(dir);
    }
  });
});

describe('A6: manually added coding tasks get the same independent QA as planned tasks', () => {
  it('policy: review + criteria required by default; waiver needs a reason; configured commands become levels', () => {
    const base = { independentReview: true, criteria: 'endpoint returns 400 on bad input', commands: {} };
    expect(manualTaskPolicy(base)).toEqual({
      ok: true,
      verificationRequired: ['CHANGES_EXIST', 'REQUIREMENTS_SATISFIED'],
      review: true,
      waived: null,
    });
    expect(manualTaskPolicy({ ...base, criteria: '' })).toMatchObject({
      ok: false,
      error: /acceptance criteria/,
    });
    expect(manualTaskPolicy({ ...base, noReview: true })).toMatchObject({
      ok: false,
      error: /needs --reason/,
    });
    expect(manualTaskPolicy({ ...base, criteria: '', noReview: true, reason: 'spike' })).toMatchObject({
      ok: true,
      review: false,
      waived: 'spike',
      verificationRequired: ['CHANGES_EXIST'],
    });
    expect(manualTaskPolicy({ ...base, commands: { build: 'b', test: 't' } })).toMatchObject({
      verificationRequired: ['CHANGES_EXIST', 'BUILD_PASSES', 'TESTS_PASS', 'REQUIREMENTS_SATISFIED'],
    });
    expect(manualTaskPolicy({ ...base, verify: 'tests_pass' })).toMatchObject({
      verificationRequired: ['TESTS_PASS', 'REQUIREMENTS_SATISFIED'],
    });
    expect(manualTaskPolicy({ ...base, verify: 'OWNER_APPROVAL' })).toMatchObject({ ok: false });
  });

  it('a task added the task:add way is independently reviewed before it counts as verified', async () => {
    const verdict = reply(
      JSON.stringify({
        criteria: [{ id: 'AC1', met: true, evidence: [{ file: 'src/fix.ts', line: 2 }], note: 'ok' }],
        defects: [],
        testsAssessment: 'ok',
      }),
    );
    env = await makeEnv({
      env: { INDEPENDENT_REVIEW: 'true' },
      mock: {
        scenario: {
          tasks: {
            'Owner correction': [
              { type: 'success', writes: [{ file: 'src/fix.ts', content: '// a\n// b\n// c\n' }] },
            ],
            'Review: Owner correction': [verdict],
          } as never,
        },
      },
    });
    const policy = manualTaskPolicy({
      independentReview: true,
      criteria: 'legacy demo accounts are flagged',
      commands: {},
    });
    if (!policy.ok) throw new Error(policy.error);
    const t = env.store.enqueueTask({
      projectId: env.project.id,
      kind: 'CODING',
      title: 'Owner correction',
      instructions: 'fix it',
      acceptanceCriteria: 'legacy demo accounts are flagged',
      maxRetries: 2,
      verificationRequired: policy.verificationRequired,
    }).task;
    await settle(env);
    const titles = env.mock!.runs.map((r) => `${r.taskTitle}${r.readOnly ? ' [ro]' : ''}`);
    expect(titles).toEqual(['Owner correction', 'Review: Owner correction [ro]']);
    expect(env.store.listEvidence({ taskId: t.id, level: 'REQUIREMENTS_SATISFIED' }).at(-1)!.status).toBe(
      'PASSED',
    );
    expect(env.qa.rows().map((r) => `${r.round}:${r.status}`)).toEqual(['1:PASSED']);
  });
});
