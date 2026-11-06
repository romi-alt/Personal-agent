import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/index.js';

const base = { AGENT_HOME: '/tmp/x-agent-home' };

describe('configuration validation', () => {
  it('applies safe defaults (mock provider, paid API off, 1 worker)', () => {
    const c = loadConfig({ env: base, noEnvFile: true });
    expect(c.provider).toBe('mock');
    expect(c.allowPaidApi).toBe(false);
    expect(c.maxConcurrentWorkers).toBe(1);
    expect(c.databasePath).toContain('agent.db');
  });
  it('fails clearly on invalid values', () => {
    expect(() => loadConfig({ env: { ...base, MAX_CONCURRENT_WORKERS: '0' }, noEnvFile: true })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: { ...base, EXECUTION_PROVIDER: 'gpt' }, noEnvFile: true })).toThrow(
      /EXECUTION_PROVIDER/,
    );
  });
  it('rejects lease shorter than 3 heartbeats', () => {
    expect(() =>
      loadConfig({
        env: { ...base, HEARTBEAT_INTERVAL_MS: '10000', LEASE_TTL_MS: '15000' },
        noEnvFile: true,
      }),
    ).toThrow(/LEASE_TTL_MS/);
  });
  it('requires a positive per-execution cap when paid API is enabled for claude', () => {
    expect(() =>
      loadConfig({ env: { ...base, EXECUTION_PROVIDER: 'claude', ALLOW_PAID_API: 'true' }, noEnvFile: true }),
    ).toThrow(/MAX_BUDGET_USD_PER_EXECUTION/);
    const ok = loadConfig({
      env: {
        ...base,
        EXECUTION_PROVIDER: 'claude',
        ALLOW_PAID_API: 'true',
        MAX_BUDGET_USD_PER_EXECUTION: '2',
      },
      noEnvFile: true,
    });
    expect(ok.maxBudgetUsdPerExecution).toBe(2);
  });
  it('requires a base URL when an integration is enabled and never echoes tokens', () => {
    expect(() => loadConfig({ env: { ...base, INTEGRATION_ERP_ENABLED: 'true' }, noEnvFile: true })).toThrow(
      /ELEVARIQ_ERP_BASE_URL/,
    );
    const c = loadConfig({
      env: { ...base, ELEVARIQ_ERP_API_TOKEN: 'sk-ant-secretsecretsecret' },
      noEnvFile: true,
    });
    expect(JSON.stringify(c)).not.toContain('secretsecret');
    expect(c.integrations.erp.hasToken).toBe(true);
  });
});
