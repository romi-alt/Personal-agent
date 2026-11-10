// Finding 9 probe: can the naive heredoc-body stripper (1e5b7d4) hide a later command line from the path check?
// Classification only. Run from a checkout whose src is 1e5b7d4 / main: npx tsx <this> <repoRoot>
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2]!;
const { evaluateToolUse } = await import(pathToFileURL(path.join(root, 'src/security/policy.ts')).href);
const { analyzeShellCommand } = await import(pathToFileURL(path.join(root, 'src/security/shell-normalize.ts')).href);
const home = path.join(os.tmpdir(), 'hd-home');
const ws = path.join(home, 'workspaces', 'p');
const o = { protectedPaths: [home] };
const cases: [string, string, string][] = [
  ['H1 baseline: direct traversal', 'cat ../../notes.txt', 'DENY'],
  ['H2 quoted <<EOF in echo, then traversal on next line', 'echo "x<<EOF"\ncat ../../notes.txt', 'DENY'],
  ["H3 single-quoted <<EOF then traversal", "echo 'a <<EOF'\ncat ../../notes.txt", 'DENY'],
  ['H4 <<EOF inside a comment, then traversal', '# see <<EOF\ncat ../../notes.txt', 'DENY'],
  ['H5 arithmetic shift, then traversal', 'echo $((1<<EOF))\ncat ../../notes.txt', 'DENY'],
  ['H6 real data heredoc with ../src import (legit)', "cat > t.ts <<'EOF'\nimport x from '../src/x';\nEOF", 'ALLOW'],
  ['H7 heredoc never terminated, traversal inside', "cat > a <<'EOF'\ncat ../../notes.txt", 'DENY'],
];
for (const [name, cmd, exp] of cases) {
  const d = evaluateToolUse('Bash', { command: cmd }, ws, o);
  const got = d.allow ? 'ALLOW' : 'DENY';
  console.log(`${got === exp ? 'OK  ' : 'FAIL'} ${name}: expected ${exp}, got ${got} (useRaw=${analyzeShellCommand(cmd).useRaw})`);
}

