import { describe, expect, it } from 'vitest';
import { evaluateToolUse, invokesAgentCli } from '../../src/security/policy.js';
import { analyzeShellCommand } from '../../src/security/shell-normalize.js';

/**
 * Regression tests for the independent v2 review findings (A2 #1-#5). Each bypass the reviewer constructed against the
 * first A2 normalizer must now be gated (approval) or denied.
 */
const ws = 'C:/ws/project';
const bash = (command: string) =>
  evaluateToolUse('Bash', { command }, ws, { protectedPaths: ['C:/agent-home', 'C:/agent-repo'] });
const gated = (c: string) => expect(bash(c).allow, c).toBe(false);

describe('v2 review: heredoc and arithmetic tricks (HIGH #1, #2)', () => {
  it('command substitution inside an UNQUOTED heredoc body is executed by bash: strict view', () => {
    gated('cat > notes.txt <<EOF\n$(git push --force origin main)\nEOF');
    gated('cat > notes.txt <<EOF\n`rm -rf ../x`\nEOF');
    expect(analyzeShellCommand('cat > n <<EOF\n$(x)\nEOF').useRaw).toBe(true);
    // a QUOTED delimiter disables expansion: still data
    expect(bash("cat > notes.txt <<'EOF'\n$(git push --force origin main)\nEOF").allow).toBe(true);
  });

  it('an arithmetic << is not a heredoc: lines after it are not hidden', () => {
    gated('echo $(( 1 << X ))\ngit push origin main\nX');
    gated('(( y = 1 << 2 )); git push origin main');
  });
});

describe('v2 review: programs that execute an argument (MEDIUM #3) - strict by default', () => {
  it.each([
    'git rebase -x "git push --force origin main" HEAD~1',
    'git submodule foreach "rm -rf ."',
    'npx -y concurrently "git push origin main"',
    "tar -cf /dev/null --checkpoint=1 --checkpoint-action=exec='rm -rf ../x' .",
    "env -i GIT_SSH_COMMAND='rm -rf ../x' git fetch",
    'find . -name "*.tmp" -exec rm -rf {} +',
  ])('%s', (c) => gated(c));

  it('data programs still get the A2 benefit (no approval for quoted text)', () => {
    for (const c of [
      'git commit -m "docs: never git push from workers"',
      'echo "run kubectl apply -f prod.yaml manually" >> NOTES.md',
      'grep -rn "rm -rf" src',
      'cat > test/a.test.ts <<\'EOF\'\nconst q = "DROP TABLE x";\nEOF',
    ])
      expect(bash(c).allow, c).toBe(true);
  });
});

describe('v2 review: write a script and run it in one command (MEDIUM #4)', () => {
  it.each([
    "cat > x.sh <<'EOF'\nrm -rf ../..\nEOF\nchmod +x x.sh && ./x.sh",
    "cat > x.sh <<'EOF'\nrm -rf ../..\nEOF\n./x.sh",
    'make -f - <<EOF\nall:\n\trm -rf ../..\nEOF',
  ])('%s', (c) => gated(c));
});

describe('v2 review: agent CLI deny survives quoting (MEDIUM #5)', () => {
  it.each([
    'node dist/cli/index.js "project:"accept prj_x',
    "node dist/cli/index.js task:un''block tsk_x",
    'node dist/cli/index.js assignment:set-verificatio\\n p --by x',
    'p=project; node dist/cli/index.js $p:accept prj_x',
    'p=project; node dist/cli/index.js ${p}:accept prj_x',
  ])('%s', (c) => {
    expect(invokesAgentCli(c)).toBe(true);
    expect(bash(c)).toMatchObject({ allow: false });
  });

  it('PowerShell string concatenation', () => {
    const d = evaluateToolUse(
      'PowerShell',
      { command: "node dist/cli/index.js ('project:'+'accept') prj_x" },
      ws,
      {},
    );
    expect(d.allow).toBe(false);
  });
});
