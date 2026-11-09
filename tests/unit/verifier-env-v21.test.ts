import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/verification/verifiers.js';

/** V2.1 (M2): verification commands run worker-written code and must be marked as worker processes. */
describe('verification command environment (V2.1)', () => {
  it('sets ELEVARIQ_WORKER=1 and removes Claude login / agent-control variables', async () => {
    const saved = { ...process.env };
    process.env['CLAUDE_CONFIG_DIR'] = 'C:/secret-login-dir';
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'synthetic-token';
    process.env['ELEVARIQ_AGENT_HOME'] = 'C:/agent-home';
    try {
      const r = await runCommand(
        `node -e "const e=process.env;console.log(JSON.stringify([e.ELEVARIQ_WORKER,e.CLAUDE_CONFIG_DIR??null,e.CLAUDE_CODE_OAUTH_TOKEN??null,e.ELEVARIQ_AGENT_HOME??null]))"`,
        tmpdir(),
        30_000,
      );
      expect(r.exitCode).toBe(0);
      expect(r.outputTail).toContain('["1",null,null,null]');
    } finally {
      process.env = saved;
    }
  });
});
