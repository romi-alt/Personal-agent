import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { Store } from '../queue/store.js';
import { fingerprint, looksLikeSubscriptionToken, type CredentialSource } from './claude/credentials.js';

/**
 * Provider readiness is reported per level and each level is only YES when it was actually established.
 * Importing the package proves nothing about authentication, budget, network access or real execution.
 */
export const READINESS_LEVELS = [
  'SDK_INSTALLED',
  'CREDENTIALS_CONFIGURED',
  'API_ACCESS_VERIFIED',
  'BUDGET_AUTHORIZED',
  'LIVE_EXECUTION_VERIFIED',
  'LIVE_RECOVERY_VERIFIED',
] as const;
export type ReadinessLevel = (typeof READINESS_LEVELS)[number];

export type ReadinessState = 'YES' | 'NO' | 'NOT_VERIFIED' | 'STALE';
export interface ReadinessEntry {
  state: ReadinessState;
  detail: string;
}
export interface ReadinessReport {
  provider: string;
  sdkVersion: string | null;
  levels: Record<ReadinessLevel, ReadinessEntry>;
  /** First five levels satisfied: the provider may be used for real work. */
  operational: boolean;
  /** Additionally, session resume across a process restart was verified live. */
  unattendedReady: boolean;
  blockers: string[];
}

export function installedSdkVersion(): string | null {
  const req = createRequire(import.meta.url);
  try {
    return (req('@anthropic-ai/claude-agent-sdk/package.json') as { version: string }).version;
  } catch {
    try {
      let dir = path.dirname(req.resolve('@anthropic-ai/claude-agent-sdk'));
      for (let i = 0; i < 4; i++) {
        try {
          const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
            name?: string;
            version?: string;
          };
          if (pj.name === '@anthropic-ai/claude-agent-sdk') return pj.version ?? null;
        } catch {
          /* keep walking up */
        }
        dir = path.dirname(dir);
      }
    } catch {
      /* not installed */
    }
    return null;
  }
}

async function sdkExportsQuery(): Promise<boolean> {
  try {
    const m = (await import('@anthropic-ai/claude-agent-sdk')) as { query?: unknown };
    return typeof m.query === 'function';
  } catch {
    return false;
  }
}

export async function providerReadiness(
  config: AppConfig,
  store: Store,
  credentials: CredentialSource,
): Promise<ReadinessReport> {
  const provider = 'claude';
  const sdkVersion = installedSdkVersion();
  const ev = store.getProviderVerifications(provider);
  const key = credentials.getApiKey();
  const fp = key ? fingerprint(key) : null;
  const levels = {} as Record<ReadinessLevel, ReadinessEntry>;

  levels.SDK_INSTALLED =
    sdkVersion && (await sdkExportsQuery())
      ? {
          state: 'YES',
          detail: `@anthropic-ai/claude-agent-sdk ${sdkVersion} imports and exports query() (this alone does NOT mean the provider works)`,
        }
      : { state: 'NO', detail: 'SDK package missing or does not export query()' };

  levels.CREDENTIALS_CONFIGURED = !key
    ? { state: 'NO', detail: 'ANTHROPIC_API_KEY not set (environment or .env)' }
    : looksLikeSubscriptionToken(key)
      ? { state: 'NO', detail: 'value looks like a subscription OAuth token; a Console API key is required' }
      : {
          state: 'YES',
          detail: `key present (fingerprint ${fp}); format only, not validated against the API`,
        };

  const evidenceState = (level: ReadinessLevel, credentialBound: boolean): ReadinessEntry => {
    const e = ev[level];
    if (!e)
      return { state: 'NOT_VERIFIED', detail: 'never verified; run the corresponding verification command' };
    if (sdkVersion && e.sdkVersion && e.sdkVersion !== sdkVersion) {
      return {
        state: 'STALE',
        detail: `verified with SDK ${e.sdkVersion}, installed is ${sdkVersion}; re-verify`,
      };
    }
    if (credentialBound && e.detail['fingerprint'] && e.detail['fingerprint'] !== fp) {
      return { state: 'STALE', detail: 'verified with a different credential; re-verify' };
    }
    return {
      state: 'YES',
      detail: `verified ${new Date(e.verifiedAt).toISOString()} (sdk ${e.sdkVersion ?? 'n/a'})`,
    };
  };
  levels.API_ACCESS_VERIFIED = evidenceState('API_ACCESS_VERIFIED', true);
  levels.BUDGET_AUTHORIZED =
    config.allowPaidApi && config.maxBudgetUsdPerExecution > 0
      ? {
          state: 'YES',
          detail: `ALLOW_PAID_API=true, per-execution cap $${config.maxBudgetUsdPerExecution}${config.dailyBudgetUsd > 0 ? `, daily estimate cap $${config.dailyBudgetUsd}` : ' (no daily cap)'}`,
        }
      : { state: 'NO', detail: 'needs ALLOW_PAID_API=true and MAX_BUDGET_USD_PER_EXECUTION > 0' };
  levels.LIVE_EXECUTION_VERIFIED = evidenceState('LIVE_EXECUTION_VERIFIED', false);
  levels.LIVE_RECOVERY_VERIFIED = evidenceState('LIVE_RECOVERY_VERIFIED', false);

  const yes = (l: ReadinessLevel) => levels[l].state === 'YES';
  const operational = (
    [
      'SDK_INSTALLED',
      'CREDENTIALS_CONFIGURED',
      'API_ACCESS_VERIFIED',
      'BUDGET_AUTHORIZED',
      'LIVE_EXECUTION_VERIFIED',
    ] as const
  ).every(yes);
  const blockers = READINESS_LEVELS.filter((l) => !yes(l)).map(
    (l) => `${l}: ${levels[l].state} - ${levels[l].detail}`,
  );
  return {
    provider,
    sdkVersion,
    levels,
    operational,
    unattendedReady: operational && yes('LIVE_RECOVERY_VERIFIED'),
    blockers,
  };
}

/**
 * Explicit, on-demand check that the key is accepted by the API. Uses the NON-BILLABLE model-list endpoint
 * (no inference, no tokens). Never run automatically by the supervisor.
 */
export async function verifyApiAccess(
  store: Store,
  credentials: CredentialSource,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const key = credentials.getApiKey();
  if (!key) return { ok: false, detail: 'ANTHROPIC_API_KEY not configured' };
  if (looksLikeSubscriptionToken(key))
    return { ok: false, detail: 'subscription OAuth tokens are not accepted for the unattended runtime' };
  try {
    const res = await fetchFn('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 200) {
      store.setProviderVerification('claude', 'API_ACCESS_VERIFIED', installedSdkVersion(), {
        fingerprint: fingerprint(key),
        endpoint: 'GET /v1/models (non-billable)',
      });
      return { ok: true, detail: 'API accepted the key (HTTP 200 on the non-billable model list)' };
    }
    return {
      ok: false,
      detail: `API responded HTTP ${res.status} (${res.status === 401 || res.status === 403 ? 'key rejected' : 'unexpected'})`,
    };
  } catch (err) {
    return { ok: false, detail: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
