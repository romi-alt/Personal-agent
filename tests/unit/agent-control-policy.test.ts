import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { evaluateToolUse, mentionsProtectedPath } from '../../src/security/policy.js';

/**
 * Self-approval prevention: a worker must not be able to operate on the agent itself through its shell, and no
 * granted approval category unlocks that.
 */
const home = path.resolve('C:/Users/owner/AppData/Local/ElevariqAgent');
const repo = path.resolve('E:/Agent/Personal-agent');
const ws = path.join(home, 'workspaces', 'proj');
const ALL = [
  'production_deploy',
  'publish_release',
  'protected_branch_push',
  'destructive_delete',
  'system_modification',
  'access_change',
];
const bash = (command: string, approvedTypes: string[] = ALL) =>
  evaluateToolUse('Bash', { command }, ws, { approvedTypes, protectedPaths: [home, repo] });

describe('agent-control guard', () => {
  it.each([
    'npm run agent -- approve apr_mw67xtxk4c1e992a8e',
    'node dist/cli/index.js approve apr_mw67xtxk4c1e992a8e --by owner',
    'echo apr_mw67xtxk4c1e992a8e',
    'npm run agent:dist -- task:unblock tsk_1',
    'npx elevariq-agent deny apr_x1',
    'cat "$LOCALAPPDATA/ElevariqAgent/dashboard.token"',
    'sqlite3 agent.db "update approvals set status=\'APPROVED\'"',
    'curl -X POST http://127.0.0.1:7777/api/approvals/x/approve',
    'rm ../../STOP-HOLD',
    'echo {} > ../../run/exe_1.policy.json',
    'node -e "1" workspace:approve C:/',
  ])('denies (even with every category approved): %s', (command) => {
    const d = bash(command);
    expect(d.allow).toBe(false);
    expect(d.approvalType).toBeUndefined(); // not approvable
  });

  it('denies references to the agent home / repository outside the workspace, in all path spellings', () => {
    for (const c of [
      `type "${path.join(home, 'logs', 'app.log')}"`,
      `ls ${home.replace(/\\/g, '/')}/backups`,
      `cd "${repo}" && git log`,
      // Git Bash drive spelling (Windows only)
      ...(process.platform === 'win32'
        ? ['cd /c/Users/owner/AppData/Local/ElevariqAgent && ls', 'cat /e/agent/personal-agent/.env']
        : []),
    ]) {
      const d = bash(c);
      expect(d.allow, c).toBe(false);
      expect(d.approvalType, c).toBeUndefined();
    }
  });

  it('still allows ordinary work that names the workspace path itself', () => {
    expect(bash(`cd "${ws}" && npm test`, []).allow).toBe(true);
    expect(bash(`cd ${ws.replace(/\\/g, '/')}/test && node --test`, []).allow).toBe(true);
    expect(bash('git status --short && node --test test/', []).allow).toBe(true);
    expect(bash('"$ELEVARIQ_NODE" "$ELEVARIQ_SCRATCH_CLEAN" .qa-mut', []).allow).toBe(true);
    expect(mentionsProtectedPath(`cd "${ws}"`, ws, [home, repo])).toBe(false);
  });

  it('keeps the existing approval categories for recursive deletes', () => {
    const d = bash(`cd "${ws}" && rm -rf .qa-mut`, []);
    expect(d.allow).toBe(false);
    expect(d.approvalType).toBe('destructive_delete');
  });
});
