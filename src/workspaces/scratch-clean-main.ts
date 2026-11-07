/**
 * Worker-facing entry point of the scoped scratch cleanup (see scratch-cleanup.ts).
 *
 * The CLI provider exposes it to a worker as `"$ELEVARIQ_NODE" "$ELEVARIQ_SCRATCH_CLEAN" <dir> [--dry-run]` and sets
 * ELEVARIQ_AGENT_HOME, ELEVARIQ_WORKSPACE, ELEVARIQ_WORKSPACE_ROOT and ELEVARIQ_EXECUTION_ID for the worker.
 * These are context, not authority: all safety checks run here against the real file system.
 * Exit codes: 0 deleted/absent/would_delete, 1 refused, 2 usage error.
 */
import { cleanScratchDir } from './scratch-cleanup.js';

export function runScratchClean(argv: string[], env: NodeJS.ProcessEnv): { code: number; out: string } {
  const args = argv.filter((a) => a !== '--dry-run');
  const dryRun = argv.includes('--dry-run');
  if (args.length !== 1) return { code: 2, out: 'usage: scratch-clean <scratch-dir> [--dry-run]' };
  const workspace = env['ELEVARIQ_WORKSPACE'];
  const root = env['ELEVARIQ_WORKSPACE_ROOT'];
  if (!workspace || !root)
    return { code: 2, out: 'ELEVARIQ_WORKSPACE / ELEVARIQ_WORKSPACE_ROOT are not set' };
  const r = cleanScratchDir({
    agentHome: env['ELEVARIQ_AGENT_HOME'],
    workspace,
    allowedRoots: [root],
    target: args[0]!,
    actor: `worker:${env['ELEVARIQ_EXECUTION_ID'] ?? 'unknown'}`,
    dryRun,
  });
  return {
    code: r.status === 'refused' ? 1 : 0,
    out: `${r.status}: ${r.reason}${r.resolved ? ` (${r.resolved})` : ''}`,
  };
}

if (/scratch-clean-main\.(ts|js)$/.test(process.argv[1] ?? '')) {
  const { code, out } = runScratchClean(process.argv.slice(2), process.env);
  (code === 0 ? process.stdout : process.stderr).write(out + '\n');
  process.exit(code);
}
