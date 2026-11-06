import { describe, expect, it } from 'vitest';
import {
  createIntegrations,
  EVENT_MAPPING,
  IntegrationError,
  MockCrmAdapter,
  MockErpAdapter,
} from '../../src/integrations/index.js';
import { loadConfig } from '../../src/config/index.js';

describe('ERP mock adapter', () => {
  const erp = new MockErpAdapter(() => 1_800_000_000_000);
  it('reports health in mock mode', async () => {
    expect(await erp.healthCheck()).toMatchObject({ system: 'erp', status: 'ok', mode: 'mock' });
  });
  it('answers the planned owner questions via read-only contracts', async () => {
    expect((await erp.getProjects({ status: 'active' })).length).toBeGreaterThan(0);
    expect((await erp.getBlockedTasks()).every((t) => t.status === 'blocked')).toBe(true);
    const deadlines = await erp.getUpcomingDeadlines(7);
    expect(deadlines.some((d) => d.overdue)).toBe(true);
    expect((await erp.getTeamAssignments('M-3')).every((a) => a.memberId === 'M-3')).toBe(true);
    expect((await erp.getProjectDetails('P-100')).milestones.length).toBeGreaterThan(0);
    expect((await erp.getTeamMembers()).length).toBe(3);
  });
  it('raises typed errors', async () => {
    await expect(erp.getProjectDetails('nope')).rejects.toBeInstanceOf(IntegrationError);
    await expect(erp.getProjectTasks('nope')).rejects.toMatchObject({ code: 'NOT_FOUND', system: 'erp' });
  });
  it('contains no financial or contract fields (sensitive data stays out of prompts)', async () => {
    expect(JSON.stringify(await erp.getProjectDetails('P-100'))).not.toMatch(
      /budget|salary|invoice|contract/i,
    );
  });
});

describe('CRM mock adapter', () => {
  const crm = new MockCrmAdapter(() => 1_800_000_000_000);
  it('reports health and serves read-only data', async () => {
    expect(await crm.healthCheck()).toMatchObject({ system: 'crm', status: 'ok', mode: 'mock' });
    expect((await crm.getClients({ status: 'active' })).length).toBe(1);
    expect(await crm.getClientProjects('C-1')).toEqual([{ projectId: 'P-100' }]);
    await expect(crm.getClientDetails('zzz')).rejects.toMatchObject({ code: 'NOT_FOUND', system: 'crm' });
  });
});

describe('integration factory', () => {
  it('never creates live adapters in Phase 1 and says so', () => {
    const cfg = loadConfig({
      noEnvFile: true,
      env: {
        AGENT_HOME: '/tmp/x',
        INTEGRATION_ERP_ENABLED: 'true',
        ELEVARIQ_ERP_BASE_URL: 'https://erp.example.invalid',
      },
    });
    const i = createIntegrations(cfg);
    expect(i.erp).toBeInstanceOf(MockErpAdapter);
    expect(i.notes.join(' ')).toMatch(/mock adapters are used/);
    expect(EVENT_MAPPING.every((m) => m.direction && m.phase)).toBe(true);
  });
});
