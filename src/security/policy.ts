import os from 'node:os';
import path from 'node:path';
import { isPathInside } from '../workspaces/paths.js';
import { analyzeShellCommand } from './shell-normalize.js';
import {
  approvalsV21,
  contentHardDeny,
  expandIndirection,
  hardDenyV21,
  packageScriptBodies,
  reachesProtectedPath,
  stripEscapes,
} from './hardening.js';

/**
 * Tool-permission policy for unattended coding workers.
 * Local autonomous coding inside the registered project workspace is allowed;
 * anything touching production, publishing, protected branches, credentials,
 * customers, money or access control requires owner approval (see docs/SECURITY.md).
 */
export interface PolicyDecision {
  allow: boolean;
  /** Approval category when denied for needing owner authorisation. */
  approvalType?: string;
  reason: string;
}

interface Rule {
  type: string;
  description: string;
  pattern: RegExp;
  /**
   * Which text the pattern is matched against (defect A2):
   *  - 'normalized': the Bash command with heredoc bodies, comments and quoted multi-word DATA removed
   *    (src/security/shell-normalize.ts). Used for rules about EXECUTABLE OPERATIONS, whose trigger words in a heredoc
   *    body / commit message / test payload are only data. Whenever quoted or heredoc text may itself be executed
   *    (bash -c, sh -c, eval, sqlite3/psql, node -e, python -c, powershell -Command, ssh, xargs, ...), when the
   *    command cannot be parsed confidently, and for every PowerShell-tool command, the analyzer selects the raw
   *    text instead - so the normalized view never applies where it could hide an executed operation.
   *  - 'raw': always the raw command text (pre-A2 behaviour).
   */
  view: 'normalized' | 'raw';
}

export const APPROVAL_RULES: Rule[] = [
  {
    // normalized: CLI command words (kubectl apply, terraform apply, ...); quoted mentions are data.
    type: 'production_deploy',
    description: 'Production deployment',
    view: 'normalized',
    pattern:
      /\b(kubectl\s+(apply|rollout|delete)|terraform\s+(apply|destroy)|serverless\s+deploy|vercel\s+(--prod|deploy)|netlify\s+deploy|fly\s+deploy|flyctl\s+deploy|gcloud\s+(app|run)\s+deploy|aws\s+(cloudformation|ecs|lambda)\s+(deploy|update)|docker\s+push|helm\s+(install|upgrade)|pm2\s+deploy|cap\s+production)\b/i,
  },
  {
    // normalized: CLI command words; a quoted single-word flag such as "--tags" is de-quoted and still matches.
    type: 'publish_release',
    description: 'Publishing a release or package',
    view: 'normalized',
    pattern:
      /\b(npm\s+publish|yarn\s+publish|pnpm\s+publish|twine\s+upload|cargo\s+publish|gem\s+push|gh\s+release\s+create|git\s+push\s+.*--tags|dotnet\s+nuget\s+push)\b/i,
  },
  {
    // normalized: `git commit -m "then git push"` is a message, not a push; `git "push"` is de-quoted and matches.
    type: 'protected_branch_push',
    description: 'Pushing to a remote / protected branch',
    view: 'normalized',
    pattern: /\bgit\s+push\b/i,
  },
  {
    // normalized: rm/rmdir/git clean/find -delete are command words + unquoted (or de-quoted) flags. Pilot false
    // positive #5 (`rm -r .tmp-patch 2>/dev/null`, absent scratch dir) deliberately STAYS gated: whether a recursive
    // delete is harmless depends on the target at run time, which a text policy cannot know; workers have the scoped
    // scratch-clean tool for that ("$ELEVARIQ_NODE" "$ELEVARIQ_SCRATCH_CLEAN" <dir>, src/workspaces/scratch-cleanup.ts).
    type: 'destructive_delete',
    description: 'Deleting substantial data',
    view: 'normalized',
    pattern:
      /(\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b|\bRemove-Item\b.*-Recurse|\brmdir\s+\/s\b|\bdel\s+\/s\b|\bgit\s+(clean\s+-[a-z]*f|reset\s+--hard)\b|\bfind\b.*-delete\b|\bshred\b|\bmkfs\b|\bdd\s+if=)/i,
  },
  {
    // normalized: DROP/TRUNCATE in a quoted test payload or heredoc test file is data (pilot false positive #4). SQL
    // executed through a client (sqlite3/psql/mysql/..., prisma db execute) or an interpreter forces the raw view.
    type: 'live_database_migration',
    description: 'Database migration / destructive SQL against a live system',
    view: 'normalized',
    pattern:
      /(\b(prisma\s+migrate\s+deploy|knex\s+migrate:latest|alembic\s+upgrade|rails\s+db:migrate|flyway\s+migrate|sequelize\s+db:migrate)\b|\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b)/i,
  },
  {
    // normalized: CLI command words.
    type: 'production_credentials',
    description: 'Changing production credentials/secrets',
    view: 'normalized',
    pattern:
      /\b(aws\s+secretsmanager|az\s+keyvault\s+secret\s+set|gcloud\s+secrets|vault\s+(write|kv\s+put)|kubectl\s+create\s+secret|heroku\s+config:set)\b/i,
  },
  {
    // raw: matches service names that typically sit inside URLs and request bodies (`curl -d '{...}' ...`), and a
    // quoted request body IS the message being sent. Not a pilot false positive; kept strict.
    type: 'customer_communication',
    description: 'Sending messages to customers',
    view: 'raw',
    pattern: /\b(sendmail|mailx?\s|twilio|sendgrid|mailgun|aws\s+ses|slack\.com\/api\/chat\.postMessage)\b/i,
  },
  {
    // raw: same reasoning as customer_communication (payment provider names in URLs / request payloads).
    type: 'financial_transaction',
    description: 'Financial transaction',
    view: 'raw',
    pattern:
      /\b(stripe\s+(charges|payment_intents|refunds|payouts)|paypal|razorpay|plaid)\b.*\b(create|capture|refund|transfer|payout)\b/i,
  },
  {
    // normalized: `passwd` in a heredoc body / quoted fixture text is data (pilot false positives #1-#3). The real
    // commands (passwd user, usermod, chmod -R 777, icacls, net user) are unquoted command words and still match.
    type: 'access_change',
    description: 'Changing user access/permissions',
    view: 'normalized',
    pattern:
      /\b(useradd|usermod|userdel|passwd|chmod\s+-R\s+777|icacls|net\s+user|gh\s+api\s+.*collaborators|aws\s+iam\s+(attach|put|create|delete))\b/i,
  },
  {
    // normalized: command words. `curl ... | sh` always selects the raw view (sh executes its stdin).
    type: 'system_modification',
    description: 'Modifying the host system outside the workspace',
    view: 'normalized',
    pattern:
      /\b(sudo|apt(-get)?\s+(install|remove)|systemctl\s+(enable|disable|stop|start)|reg\s+add|schtasks\s+\/create|curl\b[^|]*\|\s*(sudo\s+)?(ba)?sh|wget\b[^|]*\|\s*(sudo\s+)?(ba)?sh)\b/i,
  },
];

/**
 * Commands that would let a worker act on the agent itself - decide its own approvals, read the owner token, edit the
 * agent database or the per-execution policy file, or lift a stop hold. These are DENIED outright and are not
 * approvable: no approval category (not even one the owner granted) unlocks them. Guardrail, not a sandbox.
 */
export const AGENT_CONTROL_PATTERN =
  /(\b(approve|deny)\s+["']?apr_|\bapr_[a-z0-9]{8,}\b|\bworkspace:approve\b|\bdashboard:token\b|\bdashboard\.token\b|\bagent\.db\b|\bSTOP-HOLD\b|\/api\/approvals\b|\.policy\.json\b|\.decisions\.jsonl\b|\bnpm\s+run\s+agent(:dist)?\b|\belevariq-agent\b)/i;

/**
 * Direct invocation of the agent CLI (defect A2 audit). The protected-path check only catches invocations that spell
 * the agent repository path; a relative entry point (`node dist/cli/index.js task:unblock x` after `cd /e` +
 * `cd Agent/Personal-agent`, or with an unknown cwd) and `tsx src/cli/index.ts ...` slipped through whenever the
 * arguments carried no `apr_` id. Hard deny, never approvable, always matched against the RAW command:
 *  1. the agent's distinctive state-changing / sensitive colon subcommands, however the CLI is reached;
 *  2. a CLI entry point (`cli/index.{js,ts,...}`, `elevariq`, `<pkg manager> [run] agent`) together with one of the
 *     bare state-changing subcommands (approve, deny, restore, backup).
 */
const AGENT_CLI_SUBCOMMAND_PATTERN =
  /(?<![\w:-])(project:(add|accept|deliver|verify)|workspace:approve|assignment:(add|set-verification)|task:(add|pause|resume|cancel|retry|unblock)|memory:set|plan:start|workflow:(answer|resume|cancel)|dashboard:token|scratch:clean|provider:verify)(?![\w:-])/i;
const AGENT_CLI_ENTRY_PATTERN =
  /(\bcli[\\/]+index\.[cm]?[jt]sx?\b|\belevariq\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?agent(:dist)?\b)/i;
const AGENT_CLI_BARE_SUBCOMMAND = /(?<![\w:-])(approve|deny|restore|backup)(?![\w:-])/i;

/** Subcommand assembled from a variable (`p=project; ... $p:accept`). */
const AGENT_CLI_ASSEMBLED =
  /\$\{?[A-Za-z_]\w*\}?\s*["']?:(add|accept|deliver|verify|approve|set-verification|pause|resume|cancel|retry|unblock|set|start|answer|token|clean)\b/i;

export function invokesAgentCli(command: string): boolean {
  // v2 review fix: shell quoting/escaping (`"project:"accept`, `task:un''block`, `set-verificatio\n`, PowerShell
  // `'project:'+'accept'`) must not defeat the deny: also test a de-quoted, de-escaped, de-concatenated copy.
  const flat = command.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/[\\'"`]/g, '');
  return [command, flat].some(
    (c) =>
      AGENT_CLI_SUBCOMMAND_PATTERN.test(c) ||
      AGENT_CLI_ASSEMBLED.test(c) ||
      (AGENT_CLI_ENTRY_PATTERN.test(c) && AGENT_CLI_BARE_SUBCOMMAND.test(c)),
  );
}

const slashVariants = (p: string): string[] => {
  const back = path.resolve(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const fwd = back.replace(/\\/g, '/');
  const drive = /^([a-z]):\//.exec(fwd);
  const msys = drive ? `/${drive[1]}/${fwd.slice(3)}` : null; // Git Bash form: /c/Users/...
  return [back, fwd, ...(msys ? [msys] : [])];
};

/**
 * True when `command` mentions a protected agent path (AGENT_HOME, the agent's own repository) anywhere OTHER than as
 * part of the project workspace path (workspaces normally live under AGENT_HOME, so references to the workspace itself
 * are removed before the check).
 */
export function mentionsProtectedPath(
  command: string,
  workspace: string,
  protectedPaths: readonly string[],
): boolean {
  let c = command.toLowerCase().replace(/["']/g, '');
  for (const w of slashVariants(workspace).sort((a, b) => b.length - a.length))
    c = c.split(w).join(' <workspace> ');
  return protectedPaths.some((p) => slashVariants(p).some((v) => v.length > 3 && c.includes(v)));
}

/** Text the 'normalized' approval rules see for a Bash command: normalized, or raw when the analyzer requires it. */
export function commandTextForRules(command: string): string {
  const a = analyzeShellCommand(command);
  return a.useRaw ? command : a.normalized;
}

/**
 * Tools that read/write files take a path; ensure it stays inside the project workspace. Only the PATH is checked:
 * Write/Edit file CONTENT is not a shell command and is never matched against the command rules.
 */
const FILE_TOOLS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
};

export interface PolicyOptions {
  extraReadable?: string[];
  /** Approval categories the owner has explicitly granted for this task. */
  approvedTypes?: readonly string[];
  /** Planning mode: only Read/Glob/Grep/TodoWrite are allowed. */
  readOnly?: boolean;
  /** Read-only research mode: WebSearch/WebFetch are allowed too (subject to web_access approval). */
  allowWeb?: boolean;
  /** Extra categories this project forces to need approval (e.g. 'web_access'). */
  alsoRequire?: readonly string[];
  /** Agent-owned directories (AGENT_HOME, the agent repository) a shell command must not reference. */
  protectedPaths?: readonly string[];
  /** Internal: recursion depth while evaluating package.json script bodies (V2.1 class N). */
  scriptDepth?: number;
}

export function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
  options: PolicyOptions = {},
): PolicyDecision {
  const extraReadable = options.extraReadable ?? [];
  const readOnlyTools = [
    'Read',
    'Glob',
    'Grep',
    'TodoWrite',
    ...(options.allowWeb ? ['WebSearch', 'WebFetch'] : []),
  ];
  if (options.readOnly && !readOnlyTools.includes(toolName)) {
    return { allow: false, reason: `${toolName} is not permitted: this is a read-only planning task` };
  }
  const pathKeys = FILE_TOOLS[toolName];
  if (pathKeys) {
    for (const key of pathKeys) {
      const raw = input[key];
      if (typeof raw !== 'string' || raw === '') continue;
      // Phase D: a leading `~` names the user's home (fail safe: if the tool expands it, the check must too).
      const exp = /^~(?=[\\/]|$)/.test(raw) ? path.join(os.homedir(), raw.slice(1)) : raw;
      const abs = path.isAbsolute(exp) ? exp : path.resolve(workspace, exp);
      const readOnly = toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep';
      const roots = readOnly ? [workspace, ...extraReadable] : [workspace];
      if (!roots.some((r) => isPathInside(abs, r))) {
        return { allow: false, reason: `Path ${raw} is outside the project workspace` };
      }
    }
    // V2.1: content planted by Write/Edit must not reference the agent itself or credentials (class P/K/W).
    const written = [
      input['content'],
      input['new_string'],
      ...(Array.isArray(input['edits'])
        ? (input['edits'] as Record<string, unknown>[]).map((e) => e?.['new_string'])
        : []),
    ].filter((c): c is string => typeof c === 'string');
    for (const c of written) {
      const d = contentHardDeny(c, workspace, options.protectedPaths ?? []);
      if (d) return { allow: false, reason: d.reason };
      if (AGENT_CONTROL_PATTERN.test(c) || invokesAgentCli(c))
        return {
          allow: false,
          reason: 'file content operates on the agent itself (approvals, token, database, policy)',
        };
    }
    return { allow: true, reason: 'file access inside workspace' };
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = String(input['command'] ?? '');
    // V2.1 (class V/E): every hard check also sees the variable-expanded and de-escaped command.
    const expanded = expandIndirection(command);
    const views = [command, expanded, stripEscapes(expanded)];
    // Agent-control, agent-CLI and protected-path checks ALWAYS use the raw command (never relaxed by A2).
    if (views.some((v) => AGENT_CONTROL_PATTERN.test(v) || invokesAgentCli(v)))
      return {
        allow: false,
        reason:
          'Commands that operate on the agent itself (approvals, owner token, agent database, policy) are not permitted',
      };
    const hard = hardDenyV21(command, toolName === 'Bash' ? commandTextForRules(expanded) : undefined);
    if (hard) return { allow: false, reason: `${hard.reason} (V2.1 class ${hard.cls})` };
    if (
      options.protectedPaths?.length &&
      (views.some((v) => mentionsProtectedPath(v, workspace, options.protectedPaths!)) ||
        reachesProtectedPath(command, workspace, options.protectedPaths) !== null)
    )
      return {
        allow: false,
        reason:
          'Commands that reference the agent home or the agent repository outside the project workspace are not permitted',
      };
    // V2.1 (class N): package-manager scripts are evaluated by their package.json bodies as well.
    const depth = options.scriptDepth ?? 0;
    for (const s of depth < 3 ? packageScriptBodies(expanded, workspace) : []) {
      const d = evaluateToolUse('Bash', { command: s.body }, workspace, {
        ...options,
        scriptDepth: depth + 1,
      });
      if (!d.allow) return { ...d, reason: `package script "${s.name}": ${d.reason}` };
    }
    // V2.1 fix (approval short-circuit): EVERY matching category must be approved. V2 returned "allow" on the first
    // approved match, so `git push origin main && rm -rf ~` passed once only protected_branch_push had been approved.
    const matched: { type: string; description: string }[] = [];
    for (const r of approvalsV21(toolName === 'Bash' ? commandTextForRules(expanded) : expanded))
      matched.push(r);
    // Normalized view only for the Bash tool; PowerShell quoting/here-strings differ, so it keeps the raw text.
    const ruleTexts =
      toolName === 'Bash'
        ? [commandTextForRules(command), commandTextForRules(expanded)]
        : [command, expanded];
    for (const rule of APPROVAL_RULES) {
      const texts = rule.view === 'raw' ? [command, expanded] : ruleTexts;
      if (texts.some((t) => rule.pattern.test(t)) && !matched.some((m) => m.type === rule.type))
        matched.push({ type: rule.type, description: rule.description });
    }
    const missing = matched.find((m) => !options.approvedTypes?.includes(m.type));
    if (missing)
      return {
        allow: false,
        approvalType: missing.type,
        reason: `${missing.description} requires owner approval`,
      };
    if (matched.length)
      return { allow: true, reason: `${matched.map((m) => m.description).join('; ')} approved by owner` };
    return { allow: true, reason: 'command permitted by workspace policy' };
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    if (options.alsoRequire?.includes('web_access') && !options.approvedTypes?.includes('web_access')) {
      return {
        allow: false,
        approvalType: 'web_access',
        reason: "Web access must be approved under this project's approval policy",
      };
    }
    return { allow: true, reason: 'read-only web access' };
  }
  if (
    toolName === 'TodoWrite' ||
    toolName === 'Task' ||
    toolName === 'Agent' ||
    toolName === 'ExitPlanMode'
  ) {
    return { allow: true, reason: 'internal tool' };
  }
  if (toolName.startsWith('mcp__') && options.approvedTypes?.includes('external_tool')) {
    return { allow: true, reason: 'external tool pre-approved by owner' };
  }
  if (toolName.startsWith('mcp__'))
    return {
      allow: false,
      approvalType: 'external_tool',
      reason: `External MCP tool ${toolName} requires owner approval`,
    };
  return { allow: false, reason: `Tool ${toolName} is not on the Phase 1 allow-list` };
}
