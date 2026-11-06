import {
  type CrmClient,
  type CrmInteraction,
  type ElevariqCrmAdapter,
  type ElevariqErpAdapter,
  type ErpActivity,
  type ErpAssignment,
  type ErpDeadline,
  type ErpProject,
  type ErpProjectDetails,
  type ErpTask,
  type ErpTeamMember,
  type HealthCheckResult,
  IntegrationError,
  type Iso,
} from './types.js';

/** Fully synthetic fixture data. Names/IDs are invented; nothing here reflects real ELEVARIQ records. */
const DAY = 86_400_000;
const iso = (ms: number): Iso => new Date(ms).toISOString();

export class MockErpAdapter implements ElevariqErpAdapter {
  constructor(private readonly now: () => number = Date.now) {}

  private projects(): ErpProject[] {
    const n = this.now();
    return [
      {
        id: 'P-100',
        name: 'Sample School ERP',
        status: 'active',
        health: 'on_track',
        ownerId: 'M-1',
        startDate: iso(n - 30 * DAY),
        dueDate: iso(n + 60 * DAY),
      },
      {
        id: 'P-200',
        name: 'Sample Client Portal',
        status: 'active',
        health: 'blocked',
        ownerId: 'M-2',
        startDate: iso(n - 45 * DAY),
        dueDate: iso(n + 10 * DAY),
      },
      {
        id: 'P-300',
        name: 'Sample Mobile App',
        status: 'planning',
        health: 'at_risk',
        ownerId: 'M-1',
        dueDate: iso(n + 120 * DAY),
      },
    ];
  }
  private tasks(): ErpTask[] {
    const n = this.now();
    return [
      {
        id: 'T-1',
        projectId: 'P-100',
        title: 'Student enrollment module',
        status: 'in_progress',
        assigneeId: 'M-1',
        dueDate: iso(n + 5 * DAY),
        updatedAt: iso(n - DAY),
      },
      {
        id: 'T-2',
        projectId: 'P-100',
        title: 'Attendance API',
        status: 'done',
        assigneeId: 'M-3',
        dueDate: iso(n - 2 * DAY),
        updatedAt: iso(n - 3600_000),
      },
      {
        id: 'T-3',
        projectId: 'P-200',
        title: 'SSO integration',
        status: 'blocked',
        assigneeId: 'M-2',
        dueDate: iso(n - DAY),
        blockedReason: 'waiting on client credentials',
        updatedAt: iso(n - 2 * DAY),
      },
      {
        id: 'T-4',
        projectId: 'P-200',
        title: 'Dashboard widgets',
        status: 'todo',
        assigneeId: 'M-3',
        dueDate: iso(n + 3 * DAY),
        updatedAt: iso(n - 4 * DAY),
      },
    ];
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      system: 'erp',
      status: 'ok',
      mode: 'mock',
      checkedAt: this.now(),
      latencyMs: 0,
      detail: 'mock ERP adapter (synthetic data, no network)',
    };
  }
  async getProjects(filter?: { status?: ErpProject['status'] }): Promise<ErpProject[]> {
    return this.projects().filter((p) => !filter?.status || p.status === filter.status);
  }
  async getProjectDetails(projectId: string): Promise<ErpProjectDetails> {
    const p = this.projects().find((x) => x.id === projectId);
    if (!p) throw new IntegrationError('NOT_FOUND', `project ${projectId} not found`, 'erp');
    return {
      ...p,
      description: `Synthetic description for ${p.name}`,
      milestones: [{ id: 'MS-1', name: 'Alpha', dueDate: iso(this.now() + 14 * DAY), completed: false }],
    };
  }
  async getProjectTasks(projectId: string, filter?: { status?: ErpTask['status'] }): Promise<ErpTask[]> {
    if (!this.projects().some((p) => p.id === projectId))
      throw new IntegrationError('NOT_FOUND', `project ${projectId} not found`, 'erp');
    return this.tasks().filter(
      (t) => t.projectId === projectId && (!filter?.status || t.status === filter.status),
    );
  }
  async getTeamMembers(): Promise<ErpTeamMember[]> {
    return [
      { id: 'M-1', displayName: 'Member One', role: 'Lead Developer' },
      { id: 'M-2', displayName: 'Member Two', role: 'Developer' },
      { id: 'M-3', displayName: 'Member Three', role: 'Developer' },
    ];
  }
  async getTeamAssignments(memberId?: string): Promise<ErpAssignment[]> {
    return this.tasks()
      .filter((t) => t.assigneeId && (!memberId || t.assigneeId === memberId))
      .map((t) => ({ memberId: t.assigneeId!, taskId: t.id, projectId: t.projectId }));
  }
  async getProjectActivity(projectId: string, since: Iso): Promise<ErpActivity[]> {
    const all: ErpActivity[] = [
      {
        id: 'A-1',
        projectId: 'P-100',
        actorId: 'M-3',
        kind: 'task_completed',
        summary: 'Completed Attendance API',
        at: iso(this.now() - 3600_000),
      },
      {
        id: 'A-2',
        projectId: 'P-200',
        actorId: 'M-2',
        kind: 'blocker_raised',
        summary: 'SSO blocked on client credentials',
        at: iso(this.now() - 2 * DAY),
      },
    ];
    return all.filter((a) => a.projectId === projectId && a.at >= since);
  }
  async getUpcomingDeadlines(withinDays: number): Promise<ErpDeadline[]> {
    const limit = this.now() + withinDays * DAY;
    return this.tasks()
      .filter((t) => t.status !== 'done' && t.dueDate && Date.parse(t.dueDate) <= limit)
      .map((t) => ({
        projectId: t.projectId,
        kind: 'task' as const,
        refId: t.id,
        title: t.title,
        dueDate: t.dueDate!,
        overdue: Date.parse(t.dueDate!) < this.now(),
      }));
  }
  async getBlockedTasks(): Promise<ErpTask[]> {
    return this.tasks().filter((t) => t.status === 'blocked');
  }
}

export class MockCrmAdapter implements ElevariqCrmAdapter {
  constructor(private readonly now: () => number = Date.now) {}
  private clients(): CrmClient[] {
    return [
      { id: 'C-1', name: 'Sample Academy', status: 'active', accountOwnerId: 'M-1' },
      { id: 'C-2', name: 'Sample Prospect Ltd', status: 'lead' },
    ];
  }
  async healthCheck(): Promise<HealthCheckResult> {
    return {
      system: 'crm',
      status: 'ok',
      mode: 'mock',
      checkedAt: this.now(),
      latencyMs: 0,
      detail: 'mock CRM adapter (synthetic data, no network)',
    };
  }
  async getClients(filter?: { status?: CrmClient['status'] }): Promise<CrmClient[]> {
    return this.clients().filter((c) => !filter?.status || c.status === filter.status);
  }
  async getClientDetails(clientId: string): Promise<CrmClient> {
    const c = this.clients().find((x) => x.id === clientId);
    if (!c) throw new IntegrationError('NOT_FOUND', `client ${clientId} not found`, 'crm');
    return c;
  }
  async getClientProjects(clientId: string): Promise<{ projectId: string }[]> {
    return clientId === 'C-1' ? [{ projectId: 'P-100' }] : [];
  }
  async getRecentInteractions(clientId: string, since: Iso): Promise<CrmInteraction[]> {
    const all: CrmInteraction[] = [
      {
        id: 'I-1',
        clientId: 'C-1',
        kind: 'meeting',
        at: iso(this.now() - DAY),
        summary: 'Weekly sync (synthetic)',
      },
    ];
    return all.filter((i) => i.clientId === clientId && i.at >= since);
  }
}
