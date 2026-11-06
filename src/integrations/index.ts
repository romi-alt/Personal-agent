import type { AppConfig } from '../config/index.js';
import { MockCrmAdapter, MockErpAdapter } from './mocks.js';
import type { ElevariqCrmAdapter, ElevariqErpAdapter } from './types.js';

export * from './types.js';
export { EVENT_MAPPING } from './event-mapping.js';
export { MockCrmAdapter, MockErpAdapter } from './mocks.js';

/**
 * Phase 1 always returns mock adapters. Live adapters must not be written until the real ERP/CRM
 * codebase, API docs, auth model and permissions have been inspected (see docs/ELEVARIQ_INTEGRATION.md).
 */
export function createIntegrations(config: AppConfig): {
  erp: ElevariqErpAdapter;
  crm: ElevariqCrmAdapter;
  notes: string[];
} {
  const notes: string[] = [];
  if (config.integrations.erp.enabled || config.integrations.crm.enabled) {
    notes.push(
      'INTEGRATION_*_ENABLED is set but live adapters do not exist in Phase 1; mock adapters are used. No network calls are made.',
    );
  }
  return { erp: new MockErpAdapter(), crm: new MockCrmAdapter(), notes };
}
