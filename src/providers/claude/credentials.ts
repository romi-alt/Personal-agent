import { createHash } from 'node:crypto';
import { readEnvFile } from '../../config/index.js';

export interface CredentialSource {
  /** Returns the API key or undefined. Re-evaluated on every call so rotated keys are picked up without restart. */
  getApiKey(): string | undefined;
}

/** Reads ANTHROPIC_API_KEY from the real environment first, then the untracked .env file. */
export class EnvCredentialSource implements CredentialSource {
  constructor(
    private readonly envFile: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  getApiKey(): string | undefined {
    const direct = this.env['ANTHROPIC_API_KEY']?.trim();
    if (direct) return direct;
    const fromFile = readEnvFile(this.envFile)['ANTHROPIC_API_KEY']?.trim();
    return fromFile || undefined;
  }
}

export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

/** Console API keys look like sk-ant-api...; OAuth/subscription tokens (sk-ant-oat...) must not be used here. */
export function looksLikeSubscriptionToken(key: string): boolean {
  return /^sk-ant-oat/i.test(key);
}
