import path from 'node:path';
import { isPathInside } from '../workspaces/paths.js';

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
}

export const APPROVAL_RULES: Rule[] = [
  {
    type: 'production_deploy',
    description: 'Production deployment',
    pattern:
      /\b(kubectl\s+(apply|rollout|delete)|terraform\s+(apply|destroy)|serverless\s+deploy|vercel\s+(--prod|deploy)|netlify\s+deploy|fly\s+deploy|flyctl\s+deploy|gcloud\s+(app|run)\s+deploy|aws\s+(cloudformation|ecs|lambda)\s+(deploy|update)|docker\s+push|helm\s+(install|upgrade)|pm2\s+deploy|cap\s+production)\b/i,
  },
  {
    type: 'publish_release',
    description: 'Publishing a release or package',
    pattern:
      /\b(npm\s+publish|yarn\s+publish|pnpm\s+publish|twine\s+upload|cargo\s+publish|gem\s+push|gh\s+release\s+create|git\s+push\s+.*--tags|dotnet\s+nuget\s+push)\b/i,
  },
  {
    type: 'protected_branch_push',
    description: 'Pushing to a remote / protected branch',
    pattern: /\bgit\s+push\b/i,
  },
  {
    type: 'destructive_delete',
    description: 'Deleting substantial data',
    pattern:
      /(\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b|\bRemove-Item\b.*-Recurse|\brmdir\s+\/s\b|\bdel\s+\/s\b|\bgit\s+(clean\s+-[a-z]*f|reset\s+--hard)\b|\bfind\b.*-delete\b|\bshred\b|\bmkfs\b|\bdd\s+if=)/i,
  },
  {
    type: 'live_database_migration',
    description: 'Database migration / destructive SQL against a live system',
    pattern:
      /(\b(prisma\s+migrate\s+deploy|knex\s+migrate:latest|alembic\s+upgrade|rails\s+db:migrate|flyway\s+migrate|sequelize\s+db:migrate)\b|\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b)/i,
  },
  {
    type: 'production_credentials',
    description: 'Changing production credentials/secrets',
    pattern:
      /\b(aws\s+secretsmanager|az\s+keyvault\s+secret\s+set|gcloud\s+secrets|vault\s+(write|kv\s+put)|kubectl\s+create\s+secret|heroku\s+config:set)\b/i,
  },
  {
    type: 'customer_communication',
    description: 'Sending messages to customers',
    pattern: /\b(sendmail|mailx?\s|twilio|sendgrid|mailgun|aws\s+ses|slack\.com\/api\/chat\.postMessage)\b/i,
  },
  {
    type: 'financial_transaction',
    description: 'Financial transaction',
    pattern:
      /\b(stripe\s+(charges|payment_intents|refunds|payouts)|paypal|razorpay|plaid)\b.*\b(create|capture|refund|transfer|payout)\b/i,
  },
  {
    type: 'access_change',
    description: 'Changing user access/permissions',
    pattern:
      /\b(useradd|usermod|userdel|passwd|chmod\s+-R\s+777|icacls|net\s+user|gh\s+api\s+.*collaborators|aws\s+iam\s+(attach|put|create|delete))\b/i,
  },
  {
    type: 'system_modification',
    description: 'Modifying the host system outside the workspace',
    pattern:
      /\b(sudo|apt(-get)?\s+(install|remove)|systemctl\s+(enable|disable|stop|start)|reg\s+add|schtasks\s+\/create|curl\b[^|]*\|\s*(sudo\s+)?(ba)?sh|wget\b[^|]*\|\s*(sudo\s+)?(ba)?sh)\b/i,
  },
];

/** Tools that read/write files take a path; ensure it stays inside the project workspace. */
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
  /** Extra categories this project forces to need approval (e.g. 'web_access'). */
  alsoRequire?: readonly string[];
}

export function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
  options: PolicyOptions = {},
): PolicyDecision {
  const extraReadable = options.extraReadable ?? [];
  const pathKeys = FILE_TOOLS[toolName];
  if (pathKeys) {
    for (const key of pathKeys) {
      const raw = input[key];
      if (typeof raw !== 'string' || raw === '') continue;
      const abs = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw);
      const readOnly = toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep';
      const roots = readOnly ? [workspace, ...extraReadable] : [workspace];
      if (!roots.some((r) => isPathInside(abs, r))) {
        return { allow: false, reason: `Path ${raw} is outside the project workspace` };
      }
    }
    return { allow: true, reason: 'file access inside workspace' };
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = String(input['command'] ?? '');
    for (const rule of APPROVAL_RULES) {
      if (rule.pattern.test(command)) {
        if (options.approvedTypes?.includes(rule.type))
          return { allow: true, reason: `${rule.description} approved by owner` };
        return {
          allow: false,
          approvalType: rule.type,
          reason: `${rule.description} requires owner approval`,
        };
      }
    }
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
