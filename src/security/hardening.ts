/**
 * V2.1 command-policy hardening (P1). Closes the ACCIDENTAL and LOW-EFFORT bypass classes found by the 2026-11-09
 * release-readiness probes. It does NOT make the policy a security boundary: a worker that writes a program and runs
 * it can still do anything its OS identity can do (class S, "script indirection"). Real enforcement is the OS-level
 * worker isolation (docs/V2_1_WORKER_ISOLATION.md); this module only reduces what slips through by mistake or by
 * trivial obfuscation.
 *
 * Bypass classes handled here (ids from docs/V2_1_SECURITY_HARDENING.md):
 *  - V  variable / substitution indirection   `X=rm; $X -rf`, `c=appro; ...${c}ve`, `$(echo rm) -rf`
 *  - E  encoding / obfuscation                 `powershell -EncodedCommand`, `base64 -d | sh`, `iex`, `r^m`
 *  - R  recursive-delete spellings             `rm --recursive`, `rd /s`, `ri -r`, `rmSync(..recursive)`, `rmtree`
 *  - G  git indirection                        `git -c alias.p=push p`, `git config alias.x push`, `-c core.hooksPath`
 *  - P  protected-path spelling                globs (`Personal-ag*`), relative escapes (`../../dashboard.tok*`), `cd`
 *  - K  credentials / environment              `~/.claude/.credentials.json`, OAuth token variable, env dumps
 *  - W  guard tampering                        `env -u ELEVARIQ_WORKER`, `unset`, references to the policy location
 *  - N  package-script indirection             `npm run release` whose package.json body is `npm publish`
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface HardDeny {
  cls: string;
  reason: string;
}

/** Expand simple same-command variable assignments and `$(echo x)` / backtick-echo substitutions (class V). */
export function expandIndirection(command: string): string {
  const vars = new Map<string, string>();
  const assign = /(?:^|[\s;&|(])([A-Za-z_]\w*)=('([^']*)'|"([^"$`]*)"|([^\s;&|'"`$()]*))/g;
  let m: RegExpExecArray | null;
  while ((m = assign.exec(command))) vars.set(m[1]!, m[3] ?? m[4] ?? m[5] ?? '');
  // PowerShell: `$a = 'rm'` / `$a="rm"` / `$a=rm`
  const psAssign = /\$([A-Za-z_]\w*)\s*=\s*('([^']*)'|"([^"$`]*)"|([^\s;&|'"`$()]+))/g;
  while ((m = psAssign.exec(command))) vars.set(m[1]!, m[3] ?? m[4] ?? m[5] ?? '');
  // String concatenation ('agent'+'.db', "r"+"m") is flattened.
  let out = command.replace(/(['"])\s*\+\s*(['"])/g, '');
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out
      .replace(/\$\(\s*(?:echo|printf)\s+(?:-[a-z]+\s+)?['"]?([^'")`]*)['"]?\s*\)/g, '$1')
      .replace(/`\s*(?:echo|printf)\s+(?:-[a-z]+\s+)?['"]?([^'"`]*)['"]?\s*`/g, '$1')
      .replace(
        /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
        (all, a: string, b: string) => vars.get(a ?? b) ?? all,
      );
    if (out === before) break;
  }
  return out;
}

/** cmd.exe caret escapes (`r^m -r^f`) and PowerShell backtick escapes removed (class E). */
export function stripEscapes(command: string): string {
  return command.replace(/\^(?=\S)/g, '').replace(/`(?=[A-Za-z])/g, '');
}

const HARD_DENY_RULES: { cls: string; reason: string; re: RegExp; commandOnly?: boolean }[] = [
  {
    cls: 'E',
    reason: 'encoded or obfuscated command execution is not permitted',
    re: /(\b(powershell|pwsh)(\.exe)?\b[^|;&]*\s-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\s+[A-Za-z0-9+/=]{8,}|FromBase64String|\b(Invoke-Expression|iex)\b|\bbase64\s+(-d|-D|--decode)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\bcertutil(\.exe)?\s+-decode|\bxxd\s+-r\b[^;&]*\|\s*(ba)?sh\b)/i,
  },
  {
    cls: 'V',
    reason:
      'a command whose name is computed at run time (command substitution in command position) cannot be verified',
    // PR #5 review fix (finding 2): an optional opening quote before the substitution (`"$(tr …)" -rf`).
    re: /(^|[;&|(]|&&|\|\|)\s*["']?\s*(\$\(|`)/,
  },
  {
    cls: 'W',
    reason: 'changing or reading the agent-control environment of the worker is not permitted',
    re: /(\benv\b[^;&|]*\s(-u|--unset)(=|\s*)["']?ELEVARIQ_|\benv\s+(-i|--ignore-environment)\b|\bunset\b[^;&|]*\bELEVARIQ_|(^|[\s;&|(])["']?ELEVARIQ_[A-Z_]+=|\$env:ELEVARIQ_\w+\s*=|\benv:\\?ELEVARIQ_|\[Environment\]::SetEnvironmentVariable\([^)]*ELEVARIQ_|\bELEVARIQ_(AGENT_HOME|EXECUTION_ID)\b)/i,
  },
  {
    cls: 'K',
    reason: 'reading credentials, credential stores or dumping the environment is not permitted',
    // PR #5 review fix (finding 4): every common per-user credential store, not only Claude's.
    re: /(\.credentials(\.json)?\b|(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$USERPROFILE|[a-z]:[\\/]+users[\\/]+[^\\/'"]+?|\/[a-z]\/users\/[^/'"]+?|\/home\/[^/\s'"]+|\/root)[\\/]+(\.claude|\.ssh|\.npmrc|\.yarnrc(\.yml)?|\.pypirc|\.netrc|_netrc|\.git-credentials|\.aws|\.azure|\.kube|\.gnupg|\.docker[\\/]+config\.json|\.config[\\/]+gh|AppData[\\/]+Roaming[\\/]+GitHub CLI|AppData[\\/]+Roaming[\\/]+npm[\\/]+etc)\b|\bid_(rsa|ed25519|ecdsa|dsa)\b|\bCLAUDE_CODE_OAUTH_TOKEN\b|\bCLAUDE_CONFIG_DIR\b|\bANTHROPIC_(API_KEY|AUTH_TOKEN)\b|\.git-credentials\b|\bgit\s+credential\b|\bcmdkey(\.exe)?\b|\bvaultcmd(\.exe)?\b|\bGet-StoredCredential\b|(^|[;&|(]|&&|\|\|)\s*(printenv|env|set|export\s+-p|declare\s+-x|(Get-ChildItem|gci|dir|ls)\s+env:\\?)\s*($|[;&|>)]))/i,
  },
  {
    // Phase B (Rule K matrix): environment dumps through an interpreter or a nested shell, credential CLIs and OS
    // credential stores. COMMAND text only: source files legitimately pass `process.env` to child processes.
    cls: 'K',
    reason: 'reading credentials, credential stores or dumping the environment is not permitted',
    commandOnly: true,
    re: /(\b(node|nodejs|deno|bun)(\.exe)?\b[^;&|\n]*\bprocess\.env\b(?![.[\w])|\bos\.environ\b(?!\s*(\.get\b|\[))|\/proc\/(self|\d+|\$\$)\/environ\b|\bGetEnvironmentVariables\s*\(|\b(ba|z|da|k)?sh(\.exe)?\s+-c\s+["']\s*(printenv|env|set|export\s+-p|declare\s+-x)\s*($|["';&|>)])|\bcmd(\.exe)?\s+\/[ck]\s+["']?\s*set\s*($|["'&|>])|\b(Get-ChildItem|gci|dir|ls)\s+env:\\?\s*($|["';&|>)])|\bgh(\.exe)?\s+auth\s+(token\b|status\b[^;&|\n]*(\s-t\b|--show-token))|\b(npm|pnpm|yarn)\s+config\s+(get|list|ls)\b[^;&|\n]*(_auth|token|\s(-l|--long|--json)\b)|\bsecurity\s+(find-(generic|internet)-password|dump-keychain)\b|\bkeymgr\.dll\b|\bcredwiz(\.exe)?\b|[\\/]Microsoft[\\/]+(Credentials|Protect|Vault)\b)/i,
  },
];

/** Hard denials added by V2.1 (never approvable). Checked against raw, expanded and de-escaped command text. */
export function hardDenyV21(command: string, dataStripped?: string): HardDeny | null {
  const expanded = expandIndirection(command);
  const views = [command, expanded, stripEscapes(expanded)];
  // PR #5 review fix (finding 6): credential rule K ignores quoted multi-word DATA (commit messages, echo text):
  // it sees the normalized view, which keeps every executed word and switches to raw whenever text may execute.
  const messageless = (v: string) =>
    v.replace(/((?:^|\s)(?:echo|printf|-m|--message)(?:=|\s+))("[^"$`]*"|'[^']*')/g, '$1__MSG__');
  const kViews = dataStripped !== undefined ? [dataStripped, ...views.map(messageless)] : views;
  for (const r of HARD_DENY_RULES)
    if ((r.cls === 'K' ? kViews : views).some((v) => r.re.test(v))) return { cls: r.cls, reason: r.reason };
  // PR #5 review fix (finding 2): a variable assigned from a substitution and then used as the command name
  // (`x=$(printf '\x72\x6d'); $x -rf /tmp/x`).
  const computed = [...command.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=["']?(\$\(|`)/g)].map((m) => m[1]!);
  for (const v of computed) {
    const use = new RegExp(`(^|[;&|(]|&&|\\|\\|)\\s*["']?\\$\\{?${v}\\}?(?![\\w])`);
    if (use.test(command))
      return {
        cls: 'V',
        reason:
          'a command whose name is computed at run time (variable assigned from a substitution) cannot be verified',
      };
  }
  return null;
}

/**
 * Approval rules added by V2.1 (classes R and G). Same category names as the V2 rules so the approval flow,
 * notifications and dashboards need no change.
 */
export const V21_APPROVAL_RULES: { type: string; description: string; re: RegExp }[] = [
  {
    type: 'destructive_delete',
    description: 'Deleting substantial data',
    re: /(\bgh(\.exe)?\s+(repo|release)\s+delete\b|\brm\b[^;&|\n]*\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|\b(rd|rmdir|del|erase)\b[^;&|\n]*\s\/s\b|\b(Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;&|\n]*\s-r(e(c(u(r(se?)?)?)?)?)?\b|\b(rmSync|rmdirSync|fs\.rm|fs\.promises\.rm|fsp\.rm|rmdir)\s*\([^)]*recursive|\bshutil\.rmtree\b|\bos\.removedirs\b|\bIO\.Directory\]::Delete\([^)]*\$true|\brimraf\b|\bdel-cli\b|\bgit\s+clean\b[^;&|\n]*\s-[a-zA-Z]*f)/i,
  },
  {
    type: 'protected_branch_push',
    description: 'Pushing to a remote / protected branch',
    re: /(\bgh(\.exe)?\s+(pr\s+merge|repo\s+sync)\b|\bgit\b(\s+(-C|-c|--git-dir|--work-tree|--namespace)\s+\S+|\s+--[\w-]+(=\S+)?)+\s+push\b|\bgit\b[^;&|\n]*\s-c\s+["']?alias\.|\bgit\s+config\b[^;&|\n]*\balias\.|\bgit\s+send-pack\b|\bgit\s+remote\s+(add|set-url)\b)/i,
  },
  {
    type: 'system_modification',
    description: 'Modifying the host system outside the workspace',
    re: /(\bgh(\.exe)?\s+repo\s+(archive|rename|edit)\b|\bgit\b[^;&|\n]*\s-c\s+["']?(core\.(hooksPath|sshCommand|fsmonitor|gitProxy|editor|pager|askPass)|credential\.|protocol\.[\w.-]*allow|uploadpack\.|receivepack\.)|\bgit\s+config\b[^;&|\n]*\b(core\.(hooksPath|sshCommand|fsmonitor|gitProxy|askPass)|credential\.|include\.path)|\bschtasks(\.exe)?\b|\bRegister-ScheduledTask\b|\breg(\.exe)?\s+(add|delete|import)\b|\bSet-ItemProperty\b[^;&|\n]*HK(CU|LM):|\bNew-ItemProperty\b[^;&|\n]*HK(CU|LM):|\bsetx\b|\bnetsh\b|\bStart-Process\b[^;&|\n]*-Verb\s+RunAs)/i,
  },
];

// Phase E: consequential remote operations that matched no category (unrecognized => allowed) in the V2.1 matrix.
V21_APPROVAL_RULES.push(
  {
    type: 'publish_release',
    description: 'Publishing a release or package',
    re: /(\b(npm|pnpm|yarn)\s+(unpublish|deprecate)\b|\bnpm\s+dist-tag\s+(add|rm)\b|\bgh(\.exe)?\s+release\s+(edit|upload)\b)/i,
  },
  {
    type: 'production_credentials',
    description: 'Changing production credentials/secrets',
    re: /\bgh(\.exe)?\s+(secret|variable)\s+(set|delete|remove)\b/i,
  },
);

/**
 * PR #5 review fix (finding 1): returns EVERY matching V2.1 category. The first version returned only the first
 * match, which re-created the approval short-circuit for commands combining two V2.1-only categories
 * (`rm --recursive x && git -c alias.p=push p` was allowed once destructive_delete had been approved).
 */
export function approvalsV21(text: string): { type: string; description: string }[] {
  const views = [text, stripEscapes(text)];
  return V21_APPROVAL_RULES.filter((r) => views.some((v) => r.re.test(v)));
}

/** @deprecated first match only; use approvalsV21. Kept for callers/tests of the PR #5 API. */
export function approvalV21(text: string): { type: string; description: string } | null {
  return approvalsV21(text)[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Class P: protected paths written with globs, relative escapes, home/env prefixes or after `cd`.
// ---------------------------------------------------------------------------------------------------------------

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function expandHome(tok: string): string {
  const home = os.homedir().replace(/\\/g, '/');
  const local = (process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local')).replace(
    /\\/g,
    '/',
  );
  return tok
    .replace(/^~(?=\/|$)/, home)
    .replace(/^(\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE|\$\{?USERPROFILE\}?)/i, home)
    .replace(/^(%LOCALAPPDATA%|\$env:LOCALAPPDATA|\$\{?LOCALAPPDATA\}?)/i, local)
    .replace(/^\/([a-z])\//i, '$1:/') // Git Bash /e/... -> e:/...
    .replace(/^\/([a-z])$/i, '$1:/');
}

function globSegToRe(seg: string): RegExp {
  const s = seg
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${s}$`, 'i');
}

/** True when the (possibly globbed) absolute path `p` can name `prot` itself or something inside it. */
function pathCanReach(p: string, prot: string): boolean {
  const ps = norm(p).split('/').filter(Boolean);
  const qs = norm(prot).split('/').filter(Boolean);
  if (ps.length < qs.length) {
    // `p` is shorter: only a trailing `**`/`*` could still descend into prot (e.g. `e:/agent/**`).
    if (!ps.length || !/^\*+$/.test(ps[ps.length - 1]!)) return false;
  }
  for (let i = 0; i < qs.length; i++) {
    const s = ps[i];
    if (s === undefined) return true; // matched a trailing ** before the end
    if (s === '**') return true;
    if (!globSegToRe(s).test(qs[i]!)) return false;
  }
  return true;
}

// path.resolve must not interpret glob characters; they are masked with plain-text placeholders meanwhile.
const maskGlob = (p: string): string => p.replace(/\*/g, '__GLOBSTAR__').replace(/\?/g, '__GLOBQM__');
const unmaskGlob = (p: string): string => p.replace(/__GLOBSTAR__/g, '*').replace(/__GLOBQM__/g, '?');

/** The part of `p` before its first wildcard segment lies inside (or equals) `dir`. */
function literalPrefixInside(p: string, dir: string): boolean {
  const segs = norm(p).split('/');
  const i = segs.findIndex((s) => /[*?[]/.test(s));
  const prefix = (i < 0 ? segs : segs.slice(0, i)).join('/');
  const d = norm(dir);
  return prefix === d || prefix.startsWith(`${d}/`);
}

/**
 * Shell-like word splitting. PR #5 review fix (finding 3): quoted words and backslash-escaped spaces stay one
 * word, so protected paths containing spaces (`"/c/Users/John Smith/.cla*"`, `John\ Smith`) are resolved whole.
 */
function tokens(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '\\' && segment[i + 1] === ' ') {
      cur += ' ';
      i++;
    } else if (/[\s<>()]/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out.map((t) => t.replace(/^--?[\w-]+=/, '').replace(/^@/, '')).filter(Boolean);
}

/**
 * Resolves path-like words of a command (tracking `cd`) and reports whether any of them names a protected
 * location outside the workspace. Complements the literal-substring check of V2 (`mentionsProtectedPath`).
 */
export function reachesProtectedPath(
  command: string,
  workspace: string,
  protectedPaths: readonly string[],
): string | null {
  let cwd = workspace;
  const text = expandIndirection(command);
  for (const seg of text.split(/&&|\|\||[;&|\n]/)) {
    const words = tokens(seg);
    if (!words.length) continue;
    const isCd = /^(cd|pushd|Set-Location|sl|chdir)$/i.test(words[0]!);
    for (const raw of isCd ? words.slice(1, 2) : words) {
      if (!/[\\/]|^\.\.?$|^~|^\$|^%/.test(raw)) continue;
      const exp = expandHome(raw);
      if (/^\$|^%/.test(exp)) continue; // unknown variable: nothing to resolve
      const abs = /^[a-z]:[\\/]/i.test(exp) || exp.startsWith('/') ? exp : path.join(cwd, exp);
      const resolved = unmaskGlob(path.resolve(maskGlob(abs)));
      if (isCd) {
        cwd = resolved;
        continue;
      }
      if (literalPrefixInside(resolved, workspace)) continue;
      for (const prot of protectedPaths) if (pathCanReach(resolved, prot)) return raw;
    }
    // A bare relative word after a cd out of the workspace (e.g. `cd ../..; cat dashboard.tok*`).
    if (!isCd && !literalPrefixInside(cwd, workspace)) {
      for (const w of words.slice(1)) {
        if (/^-/.test(w)) continue;
        const resolved = unmaskGlob(path.resolve(cwd, maskGlob(w)));
        if (literalPrefixInside(resolved, workspace)) continue;
        for (const prot of protectedPaths) if (pathCanReach(resolved, prot)) return w;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Class N: npm / yarn / pnpm scripts. The command text `npm run release` hides the script body; read it from the
// workspace package.json and evaluate the body too (bounded recursion). Bodies that call a script FILE remain class S.
// ---------------------------------------------------------------------------------------------------------------

export function packageScriptBodies(command: string, workspace: string): { name: string; body: string }[] {
  const names = new Set<string>();
  const re =
    /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:run|run-script|rum|urn)\s+)?(?:--?[\w-]+(?:=\S+)?\s+)*([\w:.-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const n = m[1]!;
    if (
      /^(install|i|ci|add|remove|uninstall|exec|x|dlx|init|create|view|info|ls|list|outdated|audit|version|--?\w+)$/i.test(
        n,
      )
    )
      continue;
    names.add(n === 't' || n === 'tst' ? 'test' : n);
  }
  if (!names.size) return [];
  const pj = path.join(workspace, 'package.json');
  if (!existsSync(pj)) return [];
  let scripts: Record<string, string>;
  try {
    scripts = (JSON.parse(readFileSync(pj, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return [{ name: 'package.json', body: 'UNPARSEABLE_PACKAGE_JSON' }];
  }
  const out: { name: string; body: string }[] = [];
  for (const n of names)
    for (const k of [`pre${n}`, n, `post${n}`])
      if (typeof scripts[k] === 'string') out.push({ name: k, body: scripts[k]! });
  return out;
}

/** Content written by Write/Edit must not plant references to the agent itself or to credentials. */
export function contentHardDeny(
  content: string,
  workspace: string,
  protectedPaths: readonly string[],
): HardDeny | null {
  const k = HARD_DENY_RULES.find(
    (r) => (r.cls === 'K' || r.cls === 'W') && !r.commandOnly && r.re.test(content),
  );
  if (
    k &&
    !/^\s*[;&|(]?\s*(printenv|env|set|export|declare|Get-ChildItem|gci|dir|ls)\b/i.test(
      content.match(k.re)?.[0] ?? '',
    )
  )
    return { cls: k.cls, reason: `file content: ${k.reason}` };
  let lc = content.replace(/\\\\/g, '\\').toLowerCase();
  const wsBack = path.resolve(workspace).toLowerCase();
  for (const w of [wsBack, wsBack.replace(/\\/g, '/')]) lc = lc.split(w).join('<workspace>');
  for (const p of protectedPaths) {
    const back = path.resolve(p).toLowerCase();
    const fwd = back.replace(/\\/g, '/');
    if (lc.includes(back) || lc.includes(fwd))
      return { cls: 'P', reason: 'file content references the agent home or the agent repository' };
  }
  return null;
}
