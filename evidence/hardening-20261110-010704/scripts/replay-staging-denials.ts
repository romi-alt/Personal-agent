// Phase G: replay every Bash tool_use of the staging execution transcripts through the policy with the exact staging
// workspace and protected paths, to find which call was denied and why. Classification only (nothing executed).
// Run from the repo: npx tsx <this> <executions dir> <workspace> <agentHome>
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateToolUse, mentionsProtectedPath } from '../../repo/src/security/policy.ts';
import { reachesProtectedPath } from '../../repo/src/security/hardening.ts';
import { ownerCredentialDirs } from '../../repo/src/providers/claude-cli/cli-provider.ts';

const [dir, ws, home] = process.argv.slice(2) as [string, string, string];
const prot = [home, 'E:\\Agent\\v2-staging\\hardening\\repo', ...ownerCredentialDirs()];
for (const f of readdirSync(dir)) {
  for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { kind: string; tool?: string; input?: string };
    if (r.kind !== 'tool_use' || !r.input) continue;
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(r.input) as Record<string, unknown>;
    } catch {
      console.log(`${f} ${r.tool} (input truncated at 2000 chars; not replayable)`);
      continue;
    }
    const d = evaluateToolUse(r.tool!, input, ws, { protectedPaths: prot });
    const cmd = typeof input['command'] === 'string' ? (input['command'] as string) : '';
    const extra = cmd
      ? ` mentions=${mentionsProtectedPath(cmd, ws, prot)} reaches=${JSON.stringify(reachesProtectedPath(cmd, ws, prot))}`
      : '';
    console.log(`${f} ${r.tool} -> ${d.allow ? 'ALLOW' : 'DENY'} (${d.reason})${extra}\n   ${JSON.stringify(input).slice(0, 300)}`);
  }
}
