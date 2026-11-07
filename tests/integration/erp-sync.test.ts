import { afterEach, describe, expect, it } from 'vitest';
import { parseAssignment } from '../../src/assignments/schema.js';
import {
  EnvCredentialSource,
  OAuth2ClientCredentials,
  type ErpSyncSource,
  type Page,
  WriteGate,
} from '../../src/integrations/contracts.js';
import { erpProjectToAssignmentDraft, SyncEngine, suggestAgentRole } from '../../src/integrations/sync.js';
import { IntegrationError, type ErpProject, type ErpTeamMember } from '../../src/integrations/types.js';
import { makeEnv, type TestEnv } from '../helpers/env.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

/** Synthetic paginated source (invented data). `failAt` makes one page throw once (e.g. rate limit). */
class FakeErp implements ErpSyncSource {
  readonly system = 'erp' as const;
  calls: (string | null)[] = [];
  constructor(
    public projects: ErpProject[],
    private readonly pageSize = 2,
    public failAt: string | null = null,
    public members: (ErpTeamMember & { email?: string; phone?: string })[] = [],
  ) {}
  private page<T>(all: T[], cursor: string | null): Page<T> {
    const start = cursor ? Number(cursor) : 0;
    return {
      items: all.slice(start, start + this.pageSize),
      nextCursor: start + this.pageSize < all.length ? String(start + this.pageSize) : null,
    };
  }
  async listProjects(o: { cursor?: string | null }) {
    this.calls.push(o.cursor ?? null);
    if (this.failAt !== null && (o.cursor ?? null) === this.failAt) {
      this.failAt = null;
      throw new IntegrationError('RATE_LIMITED', 'slow down', 'erp', true);
    }
    return this.page(this.projects, o.cursor ?? null);
  }
  async getProjectDetails(id: string) {
    const p = this.projects.find((x) => x.id === id)!;
    return {
      ...p,
      description: 'Synthetic project',
      milestones: [{ id: 'MS-1', name: 'Pilot', dueDate: '2027-01-15T00:00:00Z', completed: false }],
    };
  }
  async listTasks() {
    return { items: [], nextCursor: null };
  }
  async listTeamMembers(o: { cursor?: string | null }) {
    return this.page(this.members, o.cursor ?? null);
  }
  async listActivity() {
    return { items: [], nextCursor: null };
  }
}
const proj = (i: number, over: Partial<ErpProject> = {}): ErpProject => ({
  id: `P-${i}`,
  name: `Synthetic ${i}`,
  status: 'active',
  health: 'on_track',
  ...over,
});

describe('Phase 4 preparation: read-only ERP sync', () => {
  it('paginates, is idempotent on re-sync, detects changes, and audits every run', async () => {
    env = await makeEnv();
    const src = new FakeErp([1, 2, 3, 4, 5].map((i) => proj(i)));
    const sync = new SyncEngine(env.store, { pageSize: 2 });
    const r1 = await sync.syncProjects(src);
    expect(r1).toMatchObject({ status: 'completed', pages: 3, created: 5, updated: 0, unchanged: 0 });
    expect(sync.getCursor('project')).toBeNull();

    // full re-sync of identical data: nothing duplicated, nothing "changed"
    const r2 = await sync.syncProjects(src);
    expect(r2).toMatchObject({ created: 0, updated: 0, unchanged: 5 });
    expect(sync.records('project')).toHaveLength(5);

    src.projects[2] = proj(3, { health: 'blocked' });
    const r3 = await sync.syncProjects(src);
    expect(r3).toMatchObject({ created: 0, updated: 1, unchanged: 4 });
    expect(sync.records('project').find((p) => p.externalId === 'P-3')!.data['health']).toBe('blocked');
    expect(sync.runs().map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);
    expect(env.store.listEvents({ type: 'integration.synced' })).toHaveLength(3);
  });

  it('a failed page (rate limit) keeps the cursor; the next run resumes there without re-reading done pages', async () => {
    env = await makeEnv();
    const src = new FakeErp(
      [1, 2, 3, 4, 5].map((i) => proj(i)),
      2,
      '2',
    );
    const sync = new SyncEngine(env.store, { pageSize: 2 });
    const r1 = await sync.syncProjects(src);
    expect(r1).toMatchObject({ status: 'failed', pages: 1, created: 2 });
    expect(r1.error).toMatch(/RATE_LIMITED/);
    expect(sync.getCursor('project')).toBe('2');
    src.calls = [];
    const r2 = await sync.syncProjects(src);
    expect(src.calls[0]).toBe('2'); // resumed, did not start over
    expect(r2).toMatchObject({ status: 'completed', created: 3 });
    expect(sync.records('project')).toHaveLength(5);
    expect(env.store.listEvents({ type: 'integration.sync_failed' })).toHaveLength(1);
  });

  it('runs are bounded (partial) and continue on the next run', async () => {
    env = await makeEnv();
    const src = new FakeErp(
      [1, 2, 3, 4, 5, 6].map((i) => proj(i)),
      2,
    );
    const sync = new SyncEngine(env.store, { pageSize: 2, maxPagesPerRun: 2 });
    expect((await sync.syncProjects(src)).status).toBe('partial');
    expect((await sync.syncProjects(src)).status).toBe('completed');
    expect(sync.records('project')).toHaveLength(6);
  });

  it('stores only minimal member data (no e-mail/phone) and suggests agent roles', async () => {
    env = await makeEnv();
    const src = new FakeErp([], 10, null, [
      {
        id: 'M-1',
        displayName: 'A. Person',
        role: 'Backend Developer',
        email: 'a@example.invalid',
        phone: '+0',
      },
    ]);
    await new SyncEngine(env.store).syncMembers(src);
    const raw = JSON.stringify(new SyncEngine(env.store).records('member'));
    expect(raw).not.toMatch(/example\.invalid|\+0/);
    expect(suggestAgentRole('Backend Developer')).toBe('backend_engineer');
    expect(suggestAgentRole('Office assistant')).toBeNull();
  });

  it('maps an ERP project to a valid DRAFT assignment carrying its external id', async () => {
    env = await makeEnv();
    const d = await new FakeErp([proj(7)]).getProjectDetails('P-7');
    const a = parseAssignment(erpProjectToAssignmentDraft(d));
    expect(a.source).toEqual({ system: 'erp', externalId: 'P-7' });
    expect(a.functionalRequirements[0]!.text).toMatch(/Milestone: Pilot \(due 2027-01-15\)/);
  });
});

describe('Phase 4 preparation: credentials and write gate', () => {
  it('reads credentials by variable name at call time and never exposes the value in describe()', async () => {
    const env1 = { ERP_TOKEN: 'secret-value' };
    const c = new EnvCredentialSource('bearer', 'ERP_TOKEN', { env: env1 });
    expect(await c.authHeaders()).toEqual({ authorization: 'Bearer secret-value' });
    expect(JSON.stringify(c.describe())).not.toContain('secret-value');
    await expect(
      new EnvCredentialSource('api_key_header', 'MISSING', { env: {} }).authHeaders(),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('OAuth2 client credentials caches the token until shortly before expiry', async () => {
    let fetches = 0;
    let now = 0;
    const c = new OAuth2ClientCredentials(
      'ID',
      'SECRET',
      async () => ({ accessToken: `t${++fetches}`, expiresInSec: 600 }),
      { env: { ID: 'i', SECRET: 's' }, now: () => now },
    );
    expect(await c.authHeaders()).toEqual({ authorization: 'Bearer t1' });
    now = 500_000;
    expect((await c.authHeaders()).authorization).toBe('Bearer t1');
    now = 560_000; // within 60 s of expiry
    expect((await c.authHeaders()).authorization).toBe('Bearer t2');
  });
  it('every ERP/CRM write is refused in this phase', () => {
    expect(() =>
      new WriteGate().assertAllowed({
        system: 'erp',
        operation: 'update_task_status',
        idempotencyKey: 'agent-event:evt_1',
        payload: {},
      }),
    ).toThrow(/not authorised/);
  });
});
