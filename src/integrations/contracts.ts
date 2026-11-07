import {
  IntegrationError,
  type ErpActivity,
  type ErpProject,
  type ErpProjectDetails,
  type ErpTask,
  type ErpTeamMember,
} from './types.js';

/**
 * Phase 4 integration contracts (finalised interfaces; still NO live adapter).
 *
 * The real ELEVARIQ ERP/CRM API has not been provided, so nothing here names an endpoint, a URL path or a database
 * table of that system. A live adapter is a class implementing these interfaces, written only after the API
 * documentation and read-only credentials exist (see docs/ERP_INTEGRATION_CHECKLIST.md).
 */

// ------------------------------------------------------------------ pagination
/** Cursor pagination. `nextCursor` is opaque to the agent; null means the listing is complete. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface ListOptions {
  cursor?: string | null;
  /** Page size the adapter should request (it may return fewer). */
  limit?: number;
  /** Incremental sync: only records updated at/after this ISO time, if the source supports it. */
  updatedSince?: string;
}

/** Paginated, read-only ERP source used by the sync engine. */
export interface ErpSyncSource {
  readonly system: 'erp';
  listProjects(o: ListOptions): Promise<Page<ErpProject>>;
  getProjectDetails(projectId: string): Promise<ErpProjectDetails>;
  listTasks(projectId: string, o: ListOptions): Promise<Page<ErpTask>>;
  listTeamMembers(o: ListOptions): Promise<Page<ErpTeamMember>>;
  listActivity(projectId: string, o: ListOptions): Promise<Page<ErpActivity>>;
}

// ------------------------------------------------------------- authentication
export type AuthScheme = 'bearer' | 'api_key_header' | 'oauth2_client_credentials';

/**
 * Credentials are referenced by ENVIRONMENT VARIABLE NAME and read at call time; they are never stored in the
 * database, written to logs, or passed to a model. A live adapter receives a CredentialSource, not a secret.
 */
export interface CredentialSource {
  readonly scheme: AuthScheme;
  /** Returns request headers carrying the credential (fresh token for OAuth2). Throws UNAUTHENTICATED if missing. */
  authHeaders(): Promise<Record<string, string>>;
  /** Non-secret description for status output (scheme + variable names + whether they are set). */
  describe(): { scheme: AuthScheme; variables: { name: string; set: boolean }[] };
}

export class EnvCredentialSource implements CredentialSource {
  constructor(
    readonly scheme: Exclude<AuthScheme, 'oauth2_client_credentials'>,
    private readonly variable: string,
    private readonly opts: { headerName?: string; env?: NodeJS.ProcessEnv; system?: 'erp' | 'crm' } = {},
  ) {}

  async authHeaders(): Promise<Record<string, string>> {
    const v = (this.opts.env ?? process.env)[this.variable];
    if (!v)
      throw new IntegrationError(
        'UNAUTHENTICATED',
        `credential variable ${this.variable} is not set`,
        this.opts.system ?? 'erp',
      );
    return this.scheme === 'bearer'
      ? { authorization: `Bearer ${v}` }
      : { [this.opts.headerName ?? 'x-api-key']: v };
  }

  describe() {
    return {
      scheme: this.scheme,
      variables: [{ name: this.variable, set: !!(this.opts.env ?? process.env)[this.variable] }],
    };
  }
}

/** OAuth2 client-credentials with an injected token fetcher (the token endpoint is unknown until documented). */
export class OAuth2ClientCredentials implements CredentialSource {
  readonly scheme = 'oauth2_client_credentials' as const;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientIdVar: string,
    private readonly clientSecretVar: string,
    private readonly fetchToken: (
      clientId: string,
      clientSecret: string,
    ) => Promise<{ accessToken: string; expiresInSec: number }>,
    private readonly opts: { env?: NodeJS.ProcessEnv; now?: () => number } = {},
  ) {}

  async authHeaders(): Promise<Record<string, string>> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cached && this.cached.expiresAt - 60_000 > now)
      return { authorization: `Bearer ${this.cached.token}` };
    const env = this.opts.env ?? process.env;
    const id = env[this.clientIdVar];
    const secret = env[this.clientSecretVar];
    if (!id || !secret)
      throw new IntegrationError(
        'UNAUTHENTICATED',
        `${this.clientIdVar}/${this.clientSecretVar} not set`,
        'erp',
      );
    const t = await this.fetchToken(id, secret);
    this.cached = { token: t.accessToken, expiresAt: now + t.expiresInSec * 1000 };
    return { authorization: `Bearer ${t.accessToken}` };
  }

  describe() {
    const env = this.opts.env ?? process.env;
    return {
      scheme: this.scheme,
      variables: [this.clientIdVar, this.clientSecretVar].map((name) => ({ name, set: !!env[name] })),
    };
  }
}

// ------------------------------------------------------------------- writes
/**
 * Writes to the ERP/CRM (task status, activity, comments) are a separate, owner-authorised phase. Until then every
 * write goes through this gate, which refuses. Future writes carry an idempotency key so a retried request can never
 * create a duplicate record.
 */
export interface WriteIntent {
  system: 'erp' | 'crm';
  operation: string;
  /** Deterministic key (e.g. `agent-event:<event id>`); the live adapter must send it as the idempotency key. */
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export class WriteGate {
  constructor(private readonly enabled: boolean = false) {}
  assertAllowed(w: WriteIntent): never | void {
    if (!this.enabled)
      throw new IntegrationError(
        'FORBIDDEN',
        `write "${w.operation}" refused: ERP/CRM writes are not authorised in this phase`,
        w.system,
      );
  }
}
