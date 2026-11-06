/**
 * ELEVARIQ ERP / CRM integration contracts (Phase 1: interfaces + mocks only).
 *
 * These are PROPOSED INTERNAL INTERFACES, not claims about existing ERP/CRM endpoints.
 * Before any real adapter is written (Phase 2+) the actual ERP/CRM codebase, API docs,
 * authentication model and permissions must be inspected. All operations here are read-only.
 */

export type IntegrationErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'NOT_IMPLEMENTED';

export class IntegrationError extends Error {
  constructor(
    readonly code: IntegrationErrorCode,
    message: string,
    readonly system: 'erp' | 'crm',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export interface HealthCheckResult {
  system: 'erp' | 'crm';
  status: 'ok' | 'degraded' | 'down' | 'not_configured';
  mode: 'mock' | 'live';
  checkedAt: number;
  latencyMs?: number;
  detail: string;
}

export interface HealthCheckable {
  healthCheck(): Promise<HealthCheckResult>;
}

/** Auth configuration placeholders. Secrets are referenced by env var name, never stored here. */
export interface IntegrationAuthConfig {
  baseUrl?: string;
  /** e.g. 'bearer' | 'api_key' | 'oauth2_client_credentials' - to be decided after inspecting the real system. */
  scheme: 'unspecified' | 'bearer' | 'api_key' | 'oauth2_client_credentials';
  secretEnvVar?: string;
  /** Scopes the agent identity should hold. Read-only in Phase 1. */
  scopes: readonly string[];
}

export type Iso = string;

export interface ErpProject {
  id: string;
  name: string;
  clientId?: string;
  status: 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled';
  health: 'on_track' | 'at_risk' | 'blocked';
  ownerId?: string;
  startDate?: Iso;
  dueDate?: Iso;
}

export interface ErpProjectDetails extends ErpProject {
  description: string;
  milestones: { id: string; name: string; dueDate: Iso; completed: boolean }[];
  /** Deliberately omits financial/contract values: sensitive data stays out of model prompts unless explicitly authorised. */
}

export interface ErpTask {
  id: string;
  projectId: string;
  title: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'review' | 'done';
  assigneeId?: string;
  dueDate?: Iso;
  blockedReason?: string;
  updatedAt: Iso;
}

export interface ErpTeamMember {
  id: string;
  displayName: string;
  role: string;
}

export interface ErpAssignment {
  memberId: string;
  taskId: string;
  projectId: string;
}

export interface ErpActivity {
  id: string;
  projectId: string;
  actorId?: string;
  kind:
    'task_completed' | 'task_created' | 'task_updated' | 'comment' | 'milestone_reached' | 'blocker_raised';
  summary: string;
  at: Iso;
}

export interface ErpDeadline {
  projectId: string;
  kind: 'task' | 'milestone' | 'project';
  refId: string;
  title: string;
  dueDate: Iso;
  overdue: boolean;
}

export interface ElevariqErpAdapter extends HealthCheckable {
  getProjects(filter?: { status?: ErpProject['status'] }): Promise<ErpProject[]>;
  getProjectDetails(projectId: string): Promise<ErpProjectDetails>;
  getProjectTasks(projectId: string, filter?: { status?: ErpTask['status'] }): Promise<ErpTask[]>;
  getTeamMembers(): Promise<ErpTeamMember[]>;
  getTeamAssignments(memberId?: string): Promise<ErpAssignment[]>;
  getProjectActivity(projectId: string, since: Iso): Promise<ErpActivity[]>;
  getUpcomingDeadlines(withinDays: number): Promise<ErpDeadline[]>;
  getBlockedTasks(): Promise<ErpTask[]>;
}

export interface CrmClient {
  id: string;
  name: string;
  status: 'lead' | 'active' | 'inactive';
  accountOwnerId?: string;
}

export interface CrmInteraction {
  id: string;
  clientId: string;
  kind: 'call' | 'email' | 'meeting' | 'note';
  at: Iso;
  summary: string;
}

/** Read-only CRM contract. Contract/financial fields are intentionally absent from Phase 1. */
export interface ElevariqCrmAdapter extends HealthCheckable {
  getClients(filter?: { status?: CrmClient['status'] }): Promise<CrmClient[]>;
  getClientDetails(clientId: string): Promise<CrmClient>;
  getClientProjects(clientId: string): Promise<{ projectId: string }[]>;
  getRecentInteractions(clientId: string, since: Iso): Promise<CrmInteraction[]>;
}

/** Mapping from agent events to the ERP concepts they would update in a later (separately approved) write phase. */
export interface EventMappingSpec {
  agentEvent: string;
  erpConcept: string;
  direction: 'agent_to_erp' | 'erp_to_agent';
  phase: 'read_only_phase_2' | 'write_phase_3';
  notes: string;
}
