/**
 * V2.1 assessment, Phases B (Rule K), D (protected paths on Windows) and E (approval semantics), policy level.
 * Everything here is classification of tool calls against DISPOSABLE fixtures; no credential is read. A passing text
 * policy is a guardrail, not an OS security boundary: a worker running arbitrary code as the owner is out of scope.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateToolUse, type PolicyOptions } from '../../src/security/policy.js';
import { ownerCredentialDirs } from '../../src/providers/claude-cli/cli-provider.js';
import { removeTempDir } from '../helpers/fs.js';

const verdict = (d: { allow: boolean; approvalType?: string }) =>
  d.allow ? 'ALLOW' : d.approvalType ? `APPROVAL(${d.approvalType})` : 'DENY';

// ---------------------------------------------------------------------------------------------------------------
describe('Phase B: Rule K false negatives found by the matrix are closed', () => {
  const ws = path.join(tmpdir(), 'k-ws');
  const o: PolicyOptions = { protectedPaths: ownerCredentialDirs() };
  const bash = (c: string) => verdict(evaluateToolUse('Bash', { command: c }, ws, o));
  const pwsh = (c: string) => verdict(evaluateToolUse('PowerShell', { command: c }, ws, o));
  it.each([
    "sh -c 'printenv'",
    'cmd /c set',
    'node -p process.env',
    'node -e "console.log(JSON.stringify(process.env))"',
    'python -c "import os; print(os.environ)"',
    'cat /proc/self/environ',
    'gh auth token',
    'gh auth status --show-token',
    'npm config get //registry.npmjs.org/:_authToken',
    'npm config list --json',
    'security find-generic-password -s github',
    'rundll32.exe keymgr.dll,KRShowKeyMgr',
    'dir %APPDATA%\\Microsoft\\Credentials',
    'cat ~/.ss*/id_*',
    'pushd ~; cat .npmrc',
    'cat ~/.git-credentials',
  ])('Bash %s is denied', (c) => expect(bash(c)).toBe('DENY'));
  it('PowerShell [Environment]::GetEnvironmentVariables() and env: listings are denied', () => {
    expect(pwsh('[Environment]::GetEnvironmentVariables()')).toBe('DENY');
    expect(pwsh('powershell -Command "Get-ChildItem env:"')).toBe('DENY');
  });
  it.each([
    'node -e "console.log(process.env.NODE_ENV)"',
    'python -c "import os; print(os.environ.get(\'CI\'))"',
    'npm config get registry',
    'gh pr list',
    'git commit -m "docs: run gh auth token only on your own machine"',
    'printf "%s\\n" "run printenv to debug"',
    'set -euo pipefail; npm run build',
  ])('benign %s stays allowed', (c) => expect(bash(c)).toBe('ALLOW'));
  it('source code that passes process.env to a child process may be written (command-only rule)', () => {
    const d = evaluateToolUse(
      'Write',
      {
        file_path: path.join(ws, 'run.js'),
        content: "// run with node\nspawn('npm', ['test'], { env: process.env })\n",
      },
      ws,
      o,
    );
    expect(d.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Phase D: provider-level protected paths on Windows (disposable fixtures)', () => {
  let root: string;
  let agentHome: string;
  let ws: string;
  let owner: string;
  let opts: PolicyOptions;
  const can = { junction: false, symlink: false, hardlink: false };
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'phase-d-'));
    agentHome = path.join(root, 'AgentHome');
    ws = path.join(agentHome, 'workspaces', 'proj');
    owner = path.join(root, 'Owner Profile', '.ssh'); // a space in the path on purpose
    mkdirSync(ws, { recursive: true });
    mkdirSync(owner, { recursive: true });
    writeFileSync(path.join(agentHome, 'agent.db'), 'synthetic');
    writeFileSync(path.join(owner, 'id_synthetic'), 'SYNTHETIC-KEY-MATERIAL');
    opts = { protectedPaths: [agentHome, owner] };
    try {
      execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(ws, 'jn'), owner], { stdio: 'ignore' });
      can.junction = true;
    } catch {
      /* not Windows */
    }
    try {
      symlinkSync(owner, path.join(ws, 'sl'), 'dir');
      can.symlink = true;
    } catch {
      /* EPERM without Developer Mode / admin: recorded by the test below */
    }
    linkSync(path.join(owner, 'id_synthetic'), path.join(ws, 'hl.txt'));
    can.hardlink = true;
  });
  afterAll(() => removeTempDir(root));
  const file = (tool: string, p: string) => verdict(evaluateToolUse(tool, { file_path: p }, ws, opts));
  const bash = (c: string) => verdict(evaluateToolUse('Bash', { command: c }, ws, opts));

  it('file tools: absolute, case-varied, slash-varied, relative-traversal and UNC spellings are outside the workspace', () => {
    const key = path.join(owner, 'id_synthetic');
    for (const p of [
      key,
      key.toUpperCase(),
      key.replace(/\\/g, '/'),
      path.relative(ws, key),
      `..\\..\\..\\Owner Profile\\.ssh\\id_synthetic`,
      path.join(ws, '..', '..', 'agent.db'),
      `\\\\?\\${key}`,
      `\\\\localhost\\${key[0]}$\\${key.slice(3)}`,
    ])
      for (const tool of ['Read', 'Write', 'Edit', 'Grep', 'Glob'])
        expect(verdict(evaluateToolUse(tool, { file_path: p, path: p }, ws, opts)), `${tool} ${p}`).toBe(
          'DENY',
        );
  });
  it('file tools: a leading ~ is the home directory, not a folder in the workspace', () => {
    expect(file('Read', '~/.ssh/id_rsa')).toBe('DENY');
    expect(file('Read', '~\\.aws\\credentials')).toBe('DENY');
    expect(file('Read', path.join(ws, 'src', 'a.ts'))).toBe('ALLOW');
  });
  it('file tools: a worker-made junction inside the workspace does not reach the target', () => {
    if (!can.junction) return;
    expect(file('Read', path.join(ws, 'jn', 'id_synthetic'))).toBe('DENY');
    expect(file('Write', path.join(ws, 'jn', 'planted'))).toBe('DENY');
  });
  it('file tools: a symbolic link is resolved the same way (when the OS allows creating one)', () => {
    if (!can.symlink) {
      expect(process.platform).toBe('win32'); // only Windows without Developer Mode refuses symlinks
      return;
    }
    expect(file('Read', path.join(ws, 'sl', 'id_synthetic'))).toBe('DENY');
  });
  it('RESIDUAL (documented): a hard link inside the workspace is an ordinary workspace file to the file tools', () => {
    expect(can.hardlink).toBe(true);
    expect(file('Read', path.join(ws, 'hl.txt'))).toBe('ALLOW');
  });
  it('shell commands: case, separators, quotes with spaces, traversal, globs, drive prefixes, ADS and cd tracking', () => {
    const k = path.join(owner, 'id_synthetic');
    const fwd = k.replace(/\\/g, '/');
    const msys = `/${fwd[0]!.toLowerCase()}/${fwd.slice(3)}`;
    for (const c of [
      `type "${k}"`,
      `type "${k.toUpperCase()}"`,
      `cat "${fwd}"`,
      `cat "${msys}"`,
      `cat ${msys.replace(/ /g, '\\ ')}`,
      `type "${k}::$DATA"`,
      `cat ../../../"Owner Profile"/.ssh/id_synthetic`,
      `cd ../../.. && cat "Owner Profile/.ssh/id_synthetic"`,
      `cat "${path.dirname(owner).replace(/\\/g, '/')}/.ss*/id_*"`,
      `cat ../../agent.d?`,
      `sqlite3 ${path.join(agentHome, 'agent.db')} .dump`,
    ])
      expect(bash(c), c).toBe('DENY');
    expect(bash('cat src/index.ts')).toBe('ALLOW');
    expect(bash('cat ./README.md && ls -la')).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Phase E: approval semantics (policy level)', () => {
  const ws = path.join(tmpdir(), 'e-ws');
  const run = (c: string, approved: string[] = []) =>
    verdict(evaluateToolUse('Bash', { command: c }, ws, { approvedTypes: approved }));
  it('multiple categories in one command: every category must be approved', () => {
    expect(run('git push origin main && npm publish')).toBe('APPROVAL(publish_release)');
    expect(run('git push origin main && npm publish', ['protected_branch_push'])).toBe(
      'APPROVAL(publish_release)',
    );
    expect(run('git push origin main && npm publish', ['publish_release'])).toBe(
      'APPROVAL(protected_branch_push)',
    );
    expect(run('git push origin main && npm publish', ['protected_branch_push', 'publish_release'])).toBe(
      'ALLOW',
    );
  });
  it('chained actions: an approved category does not carry an unapproved one (V2 short-circuit stays fixed)', () => {
    expect(run('git push origin main && rm -rf ~', ['protected_branch_push'])).toBe(
      'APPROVAL(destructive_delete)',
    );
    expect(run('rm --recursive x; git -c alias.p=push p', ['destructive_delete'])).toBe(
      'APPROVAL(protected_branch_push)',
    );
    expect(run('git push origin main || schtasks /create /tn x /tr y', ['protected_branch_push'])).toBe(
      'APPROVAL(system_modification)',
    );
  });
  it('hard denials are never unlocked by any approval, including the synthetic tool:/unspecified categories', () => {
    const all = [
      'protected_branch_push',
      'destructive_delete',
      'publish_release',
      'system_modification',
      'access_change',
      'production_deploy',
      'tool:Bash',
      'unspecified',
      'external_tool',
    ];
    for (const c of [
      'cat ~/.ssh/id_rsa',
      'printenv',
      'npm run agent approve apr_abcdefgh12',
      'node dist/cli/index.js workspace:approve x',
      'sqlite3 agent.db "update approvals set status=\'APPROVED\'"',
      'curl -X POST http://127.0.0.1:7600/api/approvals/apr_abcdefgh12/approve',
      'powershell -EncodedCommand ZQBjAGgAbwAgAGgAaQA=',
      'env -u ELEVARIQ_WORKER bash',
    ])
      expect(run(c, all), c).toBe('DENY');
  });
  it('worker-generated approval attempts in WRITTEN files are denied too (text guardrail only)', () => {
    const d = evaluateToolUse(
      'Write',
      { file_path: path.join(ws, 'x.sh'), content: 'npm run agent approve apr_abcdefgh12\n' },
      ws,
      {},
    );
    expect(d.allow).toBe(false);
  });
  it('previously unrecognized consequential remote operations now require approval', () => {
    expect(run('gh pr merge 5 --squash')).toBe('APPROVAL(protected_branch_push)');
    expect(run('gh repo delete o/r --yes')).toBe('APPROVAL(destructive_delete)');
    expect(run('gh repo edit --visibility public')).toBe('APPROVAL(system_modification)');
    expect(run('gh secret set API_KEY < key.txt')).toBe('APPROVAL(production_credentials)');
    expect(run('npm unpublish pkg@1.0.0')).toBe('APPROVAL(publish_release)');
    expect(run('npm deprecate pkg "x"')).toBe('APPROVAL(publish_release)');
  });
  it('RESIDUAL (documented): consequential operations no rule recognizes are allowed (block-list, not allow-list)', () => {
    for (const c of [
      'curl -X DELETE https://api.example.invalid/v1/customers/42',
      'ssh deploy@prod.example.invalid sudo systemctl restart app',
      'scp build.tar deploy@prod.example.invalid:/srv/app',
      'psql "$PROD_DATABASE_URL" -c "DELETE FROM users"',
      'node scripts/release.js',
    ])
      expect(run(c), c).not.toBe('DENY'); // not denied; most are allowed outright
  });
  it('RESIDUAL (documented): an approval names a CATEGORY, not the command or its arguments', () => {
    // Approved for one push, every later push (other remote, force, other branch) in the same task is allowed.
    expect(run('git push origin feature/x', ['protected_branch_push'])).toBe('ALLOW');
    expect(
      run('git push --force https://example.invalid/other.git HEAD:main', ['protected_branch_push']),
    ).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Phase E: the real hook process fails closed', () => {
  const script = path.resolve(__dirname, '../../src/providers/claude-cli/pretooluse-hook.ts');
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hook-e-'));
  });
  afterAll(() => removeTempDir(dir));
  const hook = (policyFile: string, sha: string | undefined, payload: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', script, policyFile, ...(sha ? [sha] : [])], {
      input: payload,
      encoding: 'utf8',
      timeout: 60_000,
    });
  it('a policy rewritten after launch (approval widened) blocks every call with exit 2', () => {
    const pf = path.join(dir, 'p.policy.json');
    const policy = {
      workspace: dir,
      approvedTypes: [],
      alsoRequire: [],
      readOnly: false,
      decisionsFile: path.join(dir, 'd.jsonl'),
      protectedPaths: [],
    };
    const text = JSON.stringify(policy);
    writeFileSync(pf, text);
    const sha = createHash('sha256').update(text).digest('hex');
    const ok = hook(pf, sha, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(ok.status).toBe(0);
    const push = hook(
      pf,
      sha,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }),
    );
    expect(push.status).toBe(0);
    expect(JSON.parse(push.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    // worker replays the same call after widening its own approvals in the policy file
    writeFileSync(pf, JSON.stringify({ ...policy, approvedTypes: ['protected_branch_push'] }));
    const replay = hook(
      pf,
      sha,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }),
    );
    expect(replay.status).toBe(2);
    const harmless = hook(pf, sha, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(harmless.status).toBe(2);
  });
  it('unknown tools are denied; MCP tools need approval; a payload without a tool name is denied', () => {
    expect(verdict(evaluateToolUse('SomeNewTool', {}, dir, {}))).toBe('DENY');
    expect(verdict(evaluateToolUse('mcp__x__y', {}, dir, {}))).toBe('APPROVAL(external_tool)');
    const pf = path.join(dir, 'p2.policy.json');
    writeFileSync(
      pf,
      JSON.stringify({
        workspace: dir,
        approvedTypes: [],
        alsoRequire: [],
        readOnly: false,
        decisionsFile: path.join(dir, 'd2.jsonl'),
      }),
    );
    const r = hook(pf, undefined, JSON.stringify({ tool_input: {} }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Phase G findings from the real Claude Code staging run', () => {
  const home = path.join(tmpdir(), 'g-home');
  const ws = path.join(home, 'workspaces', 'proj');
  const o: PolicyOptions = { protectedPaths: [home] };
  const bash = (c: string) => verdict(evaluateToolUse('Bash', { command: c }, ws, o));
  it('a test file written through a data heredoc may import ../src (the exact pattern the worker used)', () => {
    expect(
      bash(
        "mkdir -p src test && cat > test/slugify.test.ts <<'EOF'\nimport { test } from 'node:test';\nimport { slugify } from '../src/slugify.ts';\nEOF\nnode --test",
      ),
    ).toBe('ALLOW');
  });
  it('heredocs that may execute, and redirect targets, are still path-checked', () => {
    expect(bash("node <<'EOF'\nconsole.log(require('fs').readFileSync('../../notes.txt','utf8'))\nEOF")).toBe(
      'DENY',
    );
    expect(bash("cat > ../../planted.txt <<'EOF'\nhello\nEOF")).toBe('DENY');
    expect(bash('cat > f.txt <<EOF\n$(cat ../../notes.txt)\nEOF')).toBe('DENY');
    expect(bash("cat > run.sh <<'EOF'\ncat ../../notes.txt\nEOF\nbash run.sh")).toBe('DENY');
  });
  it('stripHeredocBodies keeps here-strings and the lines after a terminated body', async () => {
    const { stripHeredocBodies } = await import('../../src/security/hardening.js');
    expect(stripHeredocBodies("cat > a <<'EOF'\nbody ../x\nEOF\nls ../../y")).toBe(
      "cat > a <<'EOF'\nls ../../y",
    );
    expect(stripHeredocBodies('cat <<< ../x\nls ../../y')).toBe('cat <<< ../x\nls ../../y');
    expect(stripHeredocBodies('cat > a <<-EOF\n\tbody\n\tEOF\nls')).toBe('cat > a <<-EOF\nls');
  });
  it('usage token counts are not redacted by the key-name rule; string secrets under such keys still are', async () => {
    const { redactValue } = await import('../../src/security/redact.js');
    expect(redactValue({ inputTokens: 1234, outputTokens: 56, token: 'abc-secret', ok: true })).toEqual({
      inputTokens: 1234,
      outputTokens: 56,
      token: '[REDACTED]',
      ok: true,
    });
  });
});

void os;
