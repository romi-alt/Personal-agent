import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/database/connection.js';
import { Store } from '../../src/queue/store.js';
import { removeTempDir } from '../helpers/fs.js';

/** A6/A7 through the real CLI against a throwaway AGENT_HOME. */
const ROOT = path.resolve(__dirname, '../..');
let home: string;
let env: NodeJS.ProcessEnv;
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
const ok = (...args: string[]) => {
  const r = run(...args);
  expect(r.status, `${args.join(' ')} => ${r.stderr}`).toBe(0);
  return r.stdout;
};

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'elevariq-cliv2-'));
  env = {
    ...process.env,
    AGENT_HOME: home,
    AGENT_ENV_FILE: path.join(home, 'none.env'),
    LOG_TO_CONSOLE: 'false',
    EXECUTION_PROVIDER: 'mock',
    NODE_NO_WARNINGS: '1',
  };
});
afterAll(() => removeTempDir(home));

describe('CLI v2: verification after intake and task:add QA parity', () => {
  it('assignment:set-verification is authorised (--by/--reason), validated, audited and visible', () => {
    ok('assignment:add', '--file', 'examples/assignment.example.json');
    const p = 'school-management-erp';
    expect(run('assignment:set-verification', p, '--test', 'npm test').status).toBe(2); // no --by/--reason
    expect(run('assignment:set-verification', p, '--by', 'owner', '--reason', 'r').status).toBe(2); // nothing to set
    expect(
      run('assignment:set-verification', p, '--by', 'o', '--reason', 'r', '--clear', 'lint').status,
    ).toBe(2);
    const out = ok(
      'assignment:set-verification',
      p,
      '--by',
      'owner',
      '--reason',
      'verification commands missing at intake (pilot A7)',
      '--build',
      'npm run build:prod',
      '--test',
      'npm test',
      '--browser-test',
      'npm run test:e2e -w @x/web',
    );
    expect(out).toMatch(/buildCommand\s+npm run build\s+->\s+npm run build:prod/);
    expect(out).toMatch(/browserTestCommand\s+\(none\)\s+->\s+npm run test:e2e -w @x\/web/);
    const shown = JSON.parse(ok('assignment:show', p)) as { verification: Record<string, string> };
    expect(shown.verification).toEqual({
      buildCommand: 'npm run build:prod',
      testCommand: 'npm test',
      browserTestCommand: 'npm run test:e2e -w @x/web',
    });
    const store = new Store(openDatabase(path.join(home, 'agent.db')));
    const ev = store.listEvents({}).filter((e) => e.type === 'assignment.verification_changed');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ by: 'owner', source: 'owner' });
    store.db.close();
  });

  it('task:add requires criteria, enables independent review and the configured commands, audits waivers', () => {
    const p = 'school-management-erp';
    const missing = run('task:add', '--project', p, '--title', 'Fix D9', '--instructions', 'do it');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/acceptance criteria/);
    const out = ok(
      'task:add',
      '--project',
      p,
      '--title',
      'Fix D9',
      '--instructions',
      'do it',
      '--criteria',
      'no flake in 20 runs',
    );
    expect(out).toMatch(
      /verification: CHANGES_EXIST, BUILD_PASSES, TESTS_PASS, REQUIREMENTS_SATISFIED \(independent review\)/,
    );
    expect(
      run('task:add', '--project', p, '--title', 'Spike', '--instructions', 'x', '--no-review').status,
    ).toBe(2);
    const waived = ok(
      'task:add',
      '--project',
      p,
      '--title',
      'Spike',
      '--instructions',
      'x',
      '--no-review',
      '--reason',
      'throwaway spike',
    );
    expect(waived).toMatch(/review WAIVED: throwaway spike/);
    const md = ok('task:add', '--project', p, '--file', 'examples/task-example.md');
    expect(md).toMatch(/independent review/); // "Acceptance: ..." line read as criteria

    const store = new Store(openDatabase(path.join(home, 'agent.db')));
    const tasks = store.listTasks({}).filter((t) => t.title === 'Fix D9' || t.title === 'Spike');
    expect(tasks.find((t) => t.title === 'Fix D9')!.verificationRequired).toContain('REQUIREMENTS_SATISFIED');
    expect(tasks.find((t) => t.title === 'Spike')!.verificationRequired).not.toContain(
      'REQUIREMENTS_SATISFIED',
    );
    const pol = store.listEvents({}).filter((e) => e.type === 'task.verification_policy');
    expect(pol.map((e) => e.payload['reviewWaivedReason'])).toEqual([null, 'throwaway spike', null]);
    store.db.close();
  });
});
