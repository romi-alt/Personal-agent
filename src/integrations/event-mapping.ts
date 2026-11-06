import type { EventMappingSpec } from './types.js';

/** Specification only. Nothing here writes to any ERP; see docs/ELEVARIQ_INTEGRATION.md. */
export const EVENT_MAPPING: readonly EventMappingSpec[] = [
  {
    agentEvent: 'task.transition(COMPLETED)',
    erpConcept: 'ERP task status -> done (with completion evidence link)',
    direction: 'agent_to_erp',
    phase: 'write_phase_3',
    notes: 'Requires separate scoped write approval.',
  },
  {
    agentEvent: 'task.transition(BLOCKED|WAITING_FOR_APPROVAL)',
    erpConcept: 'Blocker raised on the ERP project',
    direction: 'agent_to_erp',
    phase: 'write_phase_3',
    notes: 'Owner-facing; includes approval request id.',
  },
  {
    agentEvent: 'checkpoint.created',
    erpConcept: 'Project activity feed entry (progress summary)',
    direction: 'agent_to_erp',
    phase: 'write_phase_3',
    notes: 'Summaries only; never source code or secrets.',
  },
  {
    agentEvent: 'ERP project created / assigned to agent',
    erpConcept: 'Agent project + queued tasks',
    direction: 'erp_to_agent',
    phase: 'read_only_phase_2',
    notes: 'Polled or webhook; idempotent via dedupe key = ERP task id.',
  },
  {
    agentEvent: 'ERP task overdue / deadline approaching',
    erpConcept: 'Owner briefing item',
    direction: 'erp_to_agent',
    phase: 'read_only_phase_2',
    notes: 'Feeds "what needs attention" answers.',
  },
];
