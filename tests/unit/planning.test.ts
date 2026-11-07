import { describe, expect, it } from 'vitest';
import { extractJson, firstBalancedObject } from '../../src/planning/extract-json.js';
import { analysisSchema, architectureSchema, planSchema, type Plan } from '../../src/planning/schemas.js';
import {
  topologicalOrder,
  validateAnalysis,
  validateArchitecture,
  validatePlan,
} from '../../src/planning/validate-plan.js';
import { evaluateToolUse } from '../../src/security/policy.js';
import { analysisJson, architectureJson, planObject } from '../helpers/plan-fixtures.js';

const REQS = ['FR-1', 'FR-2', 'NFR-1', 'DR-1'];
const LIMITS = { maxTasks: 10 };
const plan = (mutate?: (p: Plan) => void): Plan => {
  const p = planSchema.parse(planObject());
  mutate?.(p);
  return p;
};

describe('extractJson', () => {
  it('parses a bare object, a fenced block and an object surrounded by prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('Here you go:\n```json\n{"a":{"b":[1,2]}}\n```\nDone.')).toEqual({
      ok: true,
      value: { a: { b: [1, 2] } },
    });
    expect(extractJson('Sure! {"a":"x } y"} hope it helps')).toEqual({ ok: true, value: { a: 'x } y' } });
  });
  it('rejects empty replies, arrays, truncated JSON and prose without reporting success', () => {
    for (const bad of ['', '   ', '[1,2]', '{"a":', 'I could not do it']) {
      const r = extractJson(bad);
      expect(r.ok).toBe(false);
    }
  });
  it('finds the first balanced object even with escaped quotes', () => {
    expect(firstBalancedObject('x {"a":"q\\"}"} y {"b":1}')).toBe('{"a":"q\\"}"}');
    expect(firstBalancedObject('no braces')).toBeNull();
  });
});

describe('schemas', () => {
  it('accept the fixtures and apply defaults', () => {
    expect(analysisSchema.parse(JSON.parse(analysisJson())).requirements).toHaveLength(4);
    expect(architectureSchema.parse(JSON.parse(architectureJson())).components).toHaveLength(3);
    expect(planSchema.parse(planObject()).tasks[0]!.verify).toEqual(['CHANGES_EXIST']);
  });
  it('reject malformed identifiers and empty plans', () => {
    expect(planSchema.safeParse({ milestones: [], tasks: [] }).success).toBe(false);
    const p = planObject();
    p.tasks[0]!.key = 'bad key!';
    expect(planSchema.safeParse(p).success).toBe(false);
  });
});

describe('validateAnalysis', () => {
  const a = (over = {}) => analysisSchema.parse(JSON.parse(analysisJson(over)));
  it('accepts refinements and derived DR- requirements', () => {
    expect(validateAnalysis(a(), ['FR-1', 'FR-2', 'NFR-1']).ok).toBe(true);
  });
  it('rejects dropped assignment requirements and invented non-derived ids', () => {
    const dropped = a({ requirements: [{ id: 'FR-1', text: 'only one requirement' }] });
    expect(validateAnalysis(dropped, ['FR-1', 'FR-2']).errors.join('\n')).toMatch(/"FR-2" is missing/);
    const invented = a({
      requirements: [
        { id: 'FR-1', text: 'ok ok' },
        { id: 'X-9', text: 'made up' },
      ],
    });
    expect(validateAnalysis(invented, ['FR-1']).errors.join('\n')).toMatch(/unknown requirement id "X-9"/);
  });
});

describe('validateArchitecture', () => {
  it('requires every requirement to be owned by a component', () => {
    const arch = architectureSchema.parse(JSON.parse(architectureJson()));
    expect(validateArchitecture(arch, REQS).ok).toBe(true);
    expect(validateArchitecture(arch, [...REQS, 'FR-9']).errors).toContain(
      'requirement "FR-9" is not covered by any architecture component',
    );
    arch.components[0]!.requirementIds.push('ZZ');
    expect(validateArchitecture(arch, REQS).errors.join()).toMatch(/unknown requirement "ZZ"/);
  });
});

describe('validatePlan (deterministic checks, never model opinion)', () => {
  it('accepts a complete, acyclic plan and reports full coverage and an order', () => {
    const v = validatePlan(plan(), REQS, LIMITS);
    expect(v.ok).toBe(true);
    expect(v.coverage.uncovered).toEqual([]);
    expect(v.coverage.byRequirement['FR-1']).toEqual(['T2']);
    expect(v.order).toEqual(['T1', 'T2', 'T3']);
  });
  it.each([
    [
      'uncovered requirement',
      (p: Plan) => p.tasks.pop(),
      /requirement "FR-2" is not implemented by any task/,
    ],
    ['dependency cycle', (p: Plan) => (p.tasks[0]!.dependsOn = ['T3']), /cycle/],
    ['unknown dependency', (p: Plan) => (p.tasks[1]!.dependsOn = ['NOPE']), /unknown task "NOPE"/],
    ['self dependency', (p: Plan) => (p.tasks[1]!.dependsOn = ['T2']), /depends on itself/],
    ['duplicate task key', (p: Plan) => (p.tasks[2]!.key = 'T1'), /duplicate task key "T1"/],
    ['oversized task', (p: Plan) => (p.tasks[1]!.size = 'L'), /size L; split it/],
    ['unknown milestone', (p: Plan) => (p.tasks[1]!.milestone = 'M9'), /unknown milestone "M9"/],
    [
      'empty milestone',
      (p: Plan) => p.milestones.push({ key: 'M3', title: 'Empty', goal: 'nothing here', requirementIds: [] }),
      /milestone "M3" has no tasks/,
    ],
    [
      'unknown requirement reference',
      (p: Plan) => p.tasks[1]!.requirementIds.push('FR-99'),
      /unknown requirement "FR-99"/,
    ],
    [
      'missing CHANGES_EXIST',
      (p: Plan) => (p.tasks[0]!.verify = ['TESTS_PASS']),
      /must require CHANGES_EXIST/,
    ],
    ['depends on a later milestone', (p: Plan) => (p.tasks[0]!.dependsOn = ['T2']), /later milestone/],
  ])('rejects: %s', (_name, mutate, expected) => {
    const v = validatePlan(
      plan((p) => void mutate(p)),
      REQS,
      LIMITS,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(expected);
  });
  it('enforces the task-count limit', () => {
    expect(validatePlan(plan(), REQS, { maxTasks: 2 }).errors.join()).toMatch(/3 tasks; the limit is 2/);
  });
});

describe('topologicalOrder (property tests over random graphs)', () => {
  // small deterministic PRNG
  const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  it('orders random DAGs so every dependency precedes its dependant', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const n = 2 + Math.floor(r() * 25);
      const tasks = Array.from({ length: n }, (_, i) => ({
        key: `K${i}`,
        dependsOn: Array.from({ length: i }, (_, j) => `K${j}`).filter(() => r() < 0.25), // only earlier nodes => acyclic
      }));
      const order = topologicalOrder(tasks);
      expect(order).not.toBeNull();
      const pos = new Map(order!.map((k, i) => [k, i]));
      for (const t of tasks) for (const d of t.dependsOn) expect(pos.get(d)!).toBeLessThan(pos.get(t.key)!);
      expect(order).toHaveLength(n);
    }
  });
  it('detects a cycle whenever a back-edge is added to a connected random DAG', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 7);
      const n = 3 + Math.floor(r() * 15);
      const tasks = Array.from({ length: n }, (_, i) => ({
        key: `K${i}`,
        dependsOn: i === 0 ? [] : [`K${i - 1}`],
      })); // a chain
      expect(topologicalOrder(tasks)).not.toBeNull();
      tasks[0]!.dependsOn = [`K${n - 1}`]; // close the chain into a cycle
      expect(topologicalOrder(tasks)).toBeNull();
    }
  });
});

describe('read-only planning policy', () => {
  const ws = '/tmp/ws-readonly';
  it('allows reading inside the workspace and denies every mutating or executing tool', () => {
    expect(evaluateToolUse('Read', { file_path: 'src/a.ts' }, ws, { readOnly: true }).allow).toBe(true);
    expect(evaluateToolUse('Grep', { pattern: 'x' }, ws, { readOnly: true }).allow).toBe(true);
    for (const tool of ['Write', 'Edit', 'Bash', 'WebFetch', 'NotebookEdit']) {
      const d = evaluateToolUse(tool, { file_path: 'a', command: 'ls' }, ws, { readOnly: true });
      expect(d.allow, tool).toBe(false);
      expect(d.reason).toMatch(/read-only planning task/);
    }
    expect(evaluateToolUse('Read', { file_path: '/etc/passwd' }, ws, { readOnly: true }).allow).toBe(false);
  });
});
