import { describe, expect, it } from 'vitest';
import { parseAssignment } from '../../src/assignments/schema.js';
import { extractUrls } from '../../src/providers/claude-cli/cli-provider.js';
import { adrFileName, renderAdr } from '../../src/planning/documents.js';
import { reviewPlan } from '../../src/planning/review.js';
import { criticalPath, progress } from '../../src/planning/roadmap.js';
import { architectureSchema, planSchema, researchSchema } from '../../src/planning/schemas.js';
import { checkCitations } from '../../src/planning/validate-plan.js';
import { evaluateToolUse } from '../../src/security/policy.js';
import { assignmentExample } from '../helpers/assignment.js';
import { architectureJson, planJson } from '../helpers/plan-fixtures.js';

describe('critical path', () => {
  it('is the longest size-weighted dependency chain', () => {
    const r = criticalPath([
      { key: 'A', dependsOn: [], size: 'S' },
      { key: 'B', dependsOn: ['A'], size: 'M' },
      { key: 'C', dependsOn: ['A'], size: 'S' },
      { key: 'D', dependsOn: ['B', 'C'], size: 'M' },
      { key: 'E', dependsOn: [], size: 'M' },
    ]);
    expect(r).toEqual({ path: ['A', 'B', 'D'], weight: 5 });
  });
  it('returns nothing for a cyclic graph', () => {
    expect(
      criticalPath([
        { key: 'A', dependsOn: ['B'], size: 'S' },
        { key: 'B', dependsOn: ['A'], size: 'S' },
      ]).path,
    ).toEqual([]);
  });
});

describe('progress counts verified deliverables only', () => {
  it('a COMPLETED task without passed evidence does not count', () => {
    const p = progress([
      {
        key: 'T1',
        milestone: 'M1',
        epic: 'E1',
        size: 'M',
        status: 'COMPLETED',
        required: ['CHANGES_EXIST', 'TESTS_PASS'],
        passed: ['CHANGES_EXIST', 'TESTS_PASS'],
      },
      {
        key: 'T2',
        milestone: 'M1',
        epic: 'E1',
        size: 'S',
        status: 'COMPLETED',
        required: ['CHANGES_EXIST', 'TESTS_PASS'],
        passed: ['CHANGES_EXIST'],
      },
      {
        key: 'T3',
        milestone: 'M2',
        epic: null,
        size: 'S',
        status: 'RUNNING',
        required: ['CHANGES_EXIST'],
        passed: [],
      },
    ]);
    expect(p.overall).toMatchObject({ delivered: 1, total: 3 });
    expect(p.overall.ratio).toBeCloseTo(2 / 4);
    expect(p.milestones.find((m) => m.key === 'M1')).toMatchObject({ delivered: 1, total: 2 });
    expect(p.epics).toEqual([expect.objectContaining({ key: 'E1', delivered: 1, total: 2 })]);
  });
});

describe('deterministic planning review', () => {
  const base = () => ({
    assignment: parseAssignment(assignmentExample()),
    requirements: [
      { id: 'FR-1', text: 'Student enrollment', kind: 'functional', priority: 'must' },
      { id: 'NFR-1', text: 'Role based access', kind: 'non_functional', priority: 'should' },
    ],
    architecture: architectureSchema.parse(JSON.parse(architectureJson())),
    plan: planSchema.parse(JSON.parse(planJson())),
  });
  it('a complete architecture has no high-severity issues', () => {
    expect(reviewPlan(base()).filter((i) => i.severity === 'high')).toEqual([]);
  });
  it('flags missing auth, data model and API design as high severity', () => {
    const b = base();
    b.architecture.sections.authentication = '';
    b.architecture.sections.api = '';
    b.architecture.dataModel = '';
    const high = reviewPlan(b)
      .filter((i) => i.severity === 'high')
      .map((i) => i.category);
    expect(high).toEqual(expect.arrayContaining(['security_gap', 'data_model', 'missing_api']));
  });
  it('flags unused preferred technology and an execution budget the plan exceeds', () => {
    const b = base();
    b.assignment = parseAssignment(
      assignmentExample({ preferredTechnology: ['Laravel'], budget: { maxExecutions: 2 } }),
    );
    const issues = reviewPlan(b);
    expect(issues.some((i) => i.category === 'contradiction' && /Laravel/.test(i.description))).toBe(true);
    expect(issues.some((i) => i.category === 'unrealistic' && i.severity === 'high')).toBe(true);
  });
});

describe('research citation check', () => {
  const r = researchSchema.parse({
    findings: [
      {
        id: 'F-1',
        area: 'apis',
        statement: 'API X supports OAuth2',
        kind: 'verified',
        sources: [{ title: 'X', url: 'https://x.example/docs/auth/' }],
      },
      {
        id: 'F-2',
        area: 'apis',
        statement: 'API X has webhooks',
        kind: 'verified',
        sources: [
          { title: 'X', url: 'https://x.example/webhooks' },
          { title: 'Y', url: 'https://y.example/' },
        ],
      },
      { id: 'F-3', area: 'risks', statement: 'Vendor lock-in', kind: 'assumption' },
    ],
  });
  it('verifies only fully-retrieved citations (normalised), downgrades the rest', () => {
    const out = checkCitations(
      r,
      ['https://X.example/docs/auth#top', 'https://x.example/webhooks'],
      true,
    ).findings;
    expect(out.map((f) => `${f.id}:${f.kind}:${f.citationCheck}`)).toEqual([
      'F-1:verified:observed',
      'F-2:assumption:not_observed', // one of two sources was never retrieved
      'F-3:assumption:none',
    ]);
  });
  it('without web access everything is an assumption', () => {
    expect(checkCitations(r, ['https://x.example/docs/auth/'], false).findings.map((f) => f.kind)).toEqual([
      'assumption',
      'assumption',
      'assumption',
    ]);
  });
  it('extracts retrieved URLs from tool_result payloads', () => {
    expect(
      extractUrls([{ type: 'text', text: 'see https://a.example/x, and (https://b.example/y).' }]),
    ).toEqual(['https://a.example/x', 'https://b.example/y']);
    expect(extractUrls('nothing here')).toEqual([]);
  });
});

describe('research tools policy', () => {
  it('read-only research may use web tools; planning tasks may not; web approval policy still applies', () => {
    expect(evaluateToolUse('WebFetch', { url: 'https://a' }, '/w', { readOnly: true }).allow).toBe(false);
    expect(
      evaluateToolUse('WebFetch', { url: 'https://a' }, '/w', { readOnly: true, allowWeb: true }).allow,
    ).toBe(true);
    expect(evaluateToolUse('Bash', { command: 'ls' }, '/w', { readOnly: true, allowWeb: true }).allow).toBe(
      false,
    );
    expect(
      evaluateToolUse('WebSearch', { query: 'x' }, '/w', {
        readOnly: true,
        allowWeb: true,
        alsoRequire: ['web_access'],
      }).approvalType,
    ).toBe('web_access');
  });
});

describe('ADR rendering', () => {
  it('contains every ADR field and a stable file name', () => {
    const a = {
      adrId: 'D-7',
      number: 7,
      title: 'Use PostgreSQL / Postgres 16!',
      status: 'proposed',
      context: 'ctx',
      decision: 'dec',
      alternatives: ['MySQL'],
      rationale: 'why',
      consequences: 'cons',
      significant: true,
      decidedAt: Date.UTC(2026, 10, 7),
    };
    expect(adrFileName(a)).toBe('0007-use-postgresql-postgres-16.md');
    const md = renderAdr(a);
    for (const s of [
      '# ADR 0007: Use PostgreSQL',
      '**Status:** proposed (significant',
      '**Date:** 2026-11-07',
      '## Context\nctx',
      '## Decision\ndec',
      '- MySQL',
      '## Rationale\nwhy',
      '## Consequences\ncons',
    ])
      expect(md).toContain(s);
  });
});

describe('assignment contract extensions', () => {
  it('requirement ids must be unique across functional, non-functional and security lists', () => {
    expect(() =>
      parseAssignment(
        assignmentExample({ securityRequirements: [{ id: 'FR-1', text: 'dup id', priority: 'must' }] }),
      ),
    ).toThrow(/unique across all lists/);
  });
});
