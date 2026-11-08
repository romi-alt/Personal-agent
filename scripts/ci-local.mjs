#!/usr/bin/env node
/* global process, console, setTimeout, URL */
// Local CI. GitHub Actions is turned OFF for this private repository (no paid Actions minutes), so this script is the CI:
// it runs the same steps as .github/workflows/ci.yml on your own machine.
//
// RULE: before pushing a branch that deploys (CONFIG.deployBranches), the full run must pass. The pre-push hook in .githooks/
// enforces it automatically (installed by `npm install`/`npm ci` through the "prepare" script). Other branches get a quick check.
//
//   npm run ci:local                     full CI on HEAD (all jobs)
//   npm run ci:local -- --job <id>       one job
//   npm run ci:local -- --quick          fast subset
//   npm run ci:local -- --ref <branch|sha>
//
// Databases: with Docker running, MariaDB 11.8 / Redis are started in throwaway containers (same images as the workflow).
// Without Docker, run them yourself and set CI_MARIADB_ADMIN_URL=mysql://root:<password>@127.0.0.1:<port>
// (and, if needed, CI_REDIS_EXTERNAL=1 with Redis on the port below; it is flushed). Only *_test databases are recreated.
// It runs in a temporary clean checkout of the commit, so your .env and uncommitted files never affect the result.
// A pass is remembered per commit (in .git/ci-local), so running it by hand before pushing means the push doesn't rerun it.
// With the GitHub CLI (gh) installed, results are posted to the commit as statuses "local/<job>".
//
// KEEP CONFIG IN STEP WITH .github/workflows/ci.yml when either changes.

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH )?PRIVATE KEY/;
const CONFIG = {
  deployBranches: ['main'],
  jobs: [
    {
      id: 'check', // Actions ran this on Linux; locally it runs on your OS
      node: [22],
      steps: [
        ['npm ci', 'npm ci'],
        ['typecheck', 'npm run typecheck'],
        ['lint', 'npm run lint'],
        ['format:check', 'npm run format:check'],
        ['build', 'npm run build'],
        ['test', 'npm test'],
        ['npm audit (runtime)', 'npm audit --omit=dev'],
        ['secret scan (tracked files, excluding tests/)', ({ cwd, sh }) => {
          const files = sh('git ls-files -- . ":!tests"', { cwd }).stdout.split('\n').filter(Boolean);
          const hits = files.filter((f) => { try { return SECRET_RE.test(readFileSync(path.join(cwd, f), 'utf8')); } catch { return false; } });
          if (hits.length) console.error('Possible secret committed in: ' + hits.join(', '));
          return hits.length === 0;
        }],
      ],
    },
    ...(process.platform === 'win32'
      ? [{ id: 'check-windows', node: [22], steps: [['npm ci', 'npm ci'], ['build', 'npm run build'], ['test', 'npm test']] }]
      : []), // only a Windows machine can stand in for the windows-latest job
  ],
  quick: { node: [22], steps: [['npm ci', 'npm ci'], ['typecheck', 'npm run typecheck'], ['lint', 'npm run lint'], ['test', 'npm test']] },
};

// ---------------------------------------------------------------------------------------------------------------------
// Engine (the same file in every romi-alt repo; only CONFIG above differs). No dependencies beyond Node and git.
// ---------------------------------------------------------------------------------------------------------------------
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const say = (s) => console.log(c('1;36', '[ci:local] ') + s);
const fail = (s) => { console.error(c('1;31', '[ci:local] ') + s); process.exit(1); };
const sh = (cmd, opts = {}) => spawnSync(cmd, { shell: true, encoding: 'utf8', ...opts });
const out = (cmd, opts) => { const r = sh(cmd, opts); return r.status === 0 ? r.stdout.trim() : null; };
const has = (bin) => out(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`) !== null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  const top = out('git rev-parse --show-toplevel') ?? fail('run this inside the repository');
  const gitDir = path.resolve(top, out('git rev-parse --git-common-dir', { cwd: top }));
  const cacheDir = path.join(gitDir, 'ci-local');
  mkdirSync(cacheDir, { recursive: true });
  const slug = (out('git remote get-url origin', { cwd: top }) ?? '').match(/github\.com[:/](.+?)(\.git)?$/)?.[1];

  // What to run: --pre-push reads git's pre-push stdin; otherwise --ref (default HEAD).
  let targets = [];
  if (flag('--pre-push')) {
    const input = readFileSync(0, 'utf8').trim();
    for (const line of input ? input.split('\n') : []) {
      const [, localSha, remoteRef] = line.trim().split(/\s+/);
      if (!remoteRef?.startsWith('refs/heads/') || /^0+$/.test(localSha)) continue; // tags, deletions
      const branch = remoteRef.slice('refs/heads/'.length);
      const deploys = CONFIG.deployBranches.includes(branch);
      targets.push({ sha: localSha, label: branch, quick: !deploys });
    }
    if (!targets.length) process.exit(0);
    if (process.env.CI_LOCAL_SKIP === '1') {
      console.error(c('1;33', '[ci:local] CI_LOCAL_SKIP=1: pushing WITHOUT local CI. Say so in the PR / to the team.')); process.exit(0);
    }
  } else {
    const ref = opt('--ref') ?? 'HEAD';
    const sha = out(`git rev-parse --verify "${ref}^{commit}"`, { cwd: top }) ?? fail(`unknown ref ${ref}`);
    targets.push({ sha, label: ref, quick: flag('--quick') });
  }

  for (const t of targets) {
    const mode = t.quick ? 'quick' : 'full';
    const passed = (m) => existsSync(path.join(cacheDir, `passed-${t.sha}-${m}`));
    if (!opt('--job') && (passed('full') || (t.quick && passed('quick')))) {
      say(`${t.sha.slice(0, 12)} (${t.label}) already passed ${passed('full') ? 'full' : 'quick'} local CI on this machine`);
      const queued = path.join(cacheDir, `status-${t.sha}.json`);
      if (flag('--pre-push') && existsSync(queued)) spawn(process.execPath, [SELF, '--post-pending', queued], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      continue;
    }
    if (flag('--pre-push')) say(`${t.label} ${t.quick ? 'is not a deploy branch: quick checks' : 'DEPLOYS: full CI (same steps as GitHub Actions)'}`);
    let jobs = t.quick ? [{ id: 'quick', ...CONFIG.quick }] : CONFIG.jobs;
    if (opt('--job')) jobs = CONFIG.jobs.filter((j) => j.id === opt('--job'));
    if (!jobs.length) fail(`no job ${opt('--job')} (have ${CONFIG.jobs.map((j) => j.id).join(', ')})`);

    const results = await runAll(top, t.sha, jobs);
    const ok = results.every((r) => r.state !== 'failure');
    for (const r of results) console.log(`  ${r.id.padEnd(16)} ${r.state === 'success' ? c(32, r.state) : r.state === 'failure' ? c(31, r.state) : c(33, r.state)}  ${r.note ?? ''}`);
    if (ok && !opt('--job')) writeFileSync(path.join(cacheDir, `passed-${t.sha}-${mode}`), new Date().toISOString());
    if (!t.quick && !flag('--no-status')) queueStatuses(slug, t.sha, results, cacheDir);
    if (!ok) fail(`local CI FAILED for ${t.sha.slice(0, 12)} (${t.label})${flag('--pre-push') ? ': push blocked. Fix it, or (emergency only) CI_LOCAL_SKIP=1 git push' : ''}`);
  }
}

async function runAll(top, sha, jobs) {
  const results = [];
  const wt = mkdtempSync(path.join(os.tmpdir(), `ci-${path.basename(top).slice(0, 12)}-`));
  const cleanup = [];
  const stopAll = () => { for (const f of cleanup.splice(0).reverse()) { try { f(); } catch { /* best effort */ } } };
  process.on('SIGINT', () => { stopAll(); process.exit(130); });
  say(`commit ${sha.slice(0, 12)} in a clean temporary checkout (${wt})`);
  if (sh(`git worktree add --detach "${wt}" ${sha}`, { cwd: top }).status !== 0) fail('git worktree add failed');
  cleanup.push(() => { sh(`git worktree remove --force "${wt}"`, { cwd: top }); rmSync(wt, { recursive: true, force: true }); });
  try {
    for (const job of jobs) {
      const t0 = Date.now();
      console.log('\n' + c('1', `== job ${job.id}`));
      const major = Number(process.versions.node.split('.')[0]);
      if (job.node && !job.node.includes(major)) {
        results.push({ id: job.id, state: 'failure', note: `needs Node ${job.node.join(' or ')}, this is ${process.version} (switch with nvm/fnm and rerun)` });
        continue;
      }
      if (job.needsDocker && !dockerOk()) {
        results.push({ id: job.id, state: 'skipped', note: 'needs Docker (not available here): NOT verified locally' });
        continue;
      }
      // Fresh checkout for every job, like Actions.
      sh('git checkout -q --detach -f ' + sha + ' && git clean -qffdx', { cwd: wt });
      const env = { ...process.env, CI: 'true', ...(job.env ?? {}) };
      for (const k of job.unsetEnv ?? []) delete env[k];
      const svc = await startServices(job, env, wt, cleanup);
      let ok = true;
      for (const s of job.steps) {
        if (!ok) break;
        if (s === '@db') { await prepareDb(job, svc, wt); continue; } // after install: it uses the repo's own MariaDB driver
        ok = runStep(s, wt, env);
      }
      for (const s of job.always ?? []) runStep(s, wt, env);
      svc.stop();
      results.push({ id: job.id, state: ok ? 'success' : 'failure', note: `${Math.round((Date.now() - t0) / 60000)}m` });
    }
  } finally { stopAll(); }
  return results;
}

function runStep([name, cmd], cwd, env) {
  process.stdout.write(c('36', `\n-- ${name}\n`));
  if (typeof cmd === 'function') { try { return cmd({ cwd, env, sh }) !== false; } catch (e) { console.error(e.message); return false; } }
  const r = spawnSync(cmd, { shell: true, cwd, env, stdio: 'inherit' });
  if (r.status !== 0) console.error(c('31', `   step "${name}" failed (exit ${r.status})`));
  return r.status === 0;
}

// ---- services -------------------------------------------------------------------------------------------------------
function dockerOk() { return has('docker') && out('docker info --format "{{.ServerVersion}}"') !== null; }
const portFree = (port) => new Promise((res) => { const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(port, '127.0.0.1'); });
const portOpen = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1').once('connect', () => { s.end(); res(true); }).once('error', () => res(false)); });
const fill = (env, vars) => { for (const k of Object.keys(env)) if (typeof env[k] === 'string') env[k] = env[k].replace(/\$\{(DB_PORT|REDIS_PORT)\}/g, (_, v) => vars[v]); };

async function startServices(job, env, wt, cleanup) {
  const stops = [];
  const svc = { stop: () => { for (const f of stops.splice(0)) { try { f(); } catch { /* best effort */ } } } };
  cleanup.push(svc.stop);
  const vars = {};
  const m = job.services?.mariadb;
  if (m) {
    if (process.env.CI_MARIADB_ADMIN_URL) {
      svc.adminUrl = process.env.CI_MARIADB_ADMIN_URL;
      vars.DB_PORT = new URL(svc.adminUrl).port || '3306';
    } else if (dockerOk()) {
      const port = (await portFree(m.port)) ? m.port : await freePort();
      const name = `ci-local-${process.pid}-mariadb`;
      say(`MariaDB ${m.image} in Docker on 127.0.0.1:${port}`);
      if (sh(`docker run -d --rm --name ${name} -e MARIADB_ROOT_PASSWORD=ci-local-root -p 127.0.0.1:${port}:3306 ${m.image}`).status !== 0) fail('docker run mariadb failed');
      stops.push(() => sh(`docker rm -f ${name}`));
      for (let i = 0; i < 60 && sh(`docker exec ${name} healthcheck.sh --connect --innodb_initialized`).status !== 0; i++) await sleep(2000);
      svc.adminUrl = `mysql://root:ci-local-root@127.0.0.1:${port}`;
      vars.DB_PORT = String(port);
    } else {
      fail(`job ${job.id} needs MariaDB 11.8. Start Docker, or run MariaDB yourself and set CI_MARIADB_ADMIN_URL=mysql://root:<password>@127.0.0.1:<port>`);
    }
  }
  const rd = job.services?.redis;
  if (rd) {
    if (process.env.CI_REDIS_EXTERNAL === '1') {
      if (!(await portOpen(rd.port))) fail(`CI_REDIS_EXTERNAL=1 but nothing listens on 127.0.0.1:${rd.port}`);
    } else if (dockerOk()) {
      if (!(await portFree(rd.port))) fail(`port ${rd.port} is busy; stop that, or run Redis there yourself and set CI_REDIS_EXTERNAL=1 (it WILL be flushed)`);
      const name = `ci-local-${process.pid}-redis`;
      say(`Redis ${rd.image} in Docker on 127.0.0.1:${rd.port}`);
      if (sh(`docker run -d --rm --name ${name} -p 127.0.0.1:${rd.port}:6379 ${rd.image}`).status !== 0) fail('docker run redis failed');
      stops.push(() => sh(`docker rm -f ${name}`));
      for (let i = 0; i < 30 && !(await portOpen(rd.port)); i++) await sleep(500);
      if (rd.cli && !has('redis-cli')) { // tests call redis-cli: route it into the container
        const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-redis-cli-'));
        writeFileSync(path.join(dir, 'redis-cli'), `#!/bin/sh\nexec docker exec ${name} redis-cli "$@"\n`, { mode: 0o755 });
        writeFileSync(path.join(dir, 'redis-cli.cmd'), `@docker exec ${name} redis-cli %*\r\n`);
        env.PATH = dir + path.delimiter + env.PATH; env.Path = env.PATH;
        stops.push(() => rmSync(dir, { recursive: true, force: true }));
      }
    } else {
      fail(`job ${job.id} needs Redis on 127.0.0.1:${rd.port}. Start Docker, or run Redis there yourself and set CI_REDIS_EXTERNAL=1 (it WILL be flushed)`);
    }
    if (rd.cli && !has('redis-cli') && process.env.CI_REDIS_EXTERNAL === '1') fail('the tests call redis-cli: put it on PATH');
    vars.REDIS_PORT = String(rd.port);
  }
  fill(env, vars);
  return svc;
}

async function freePort() { return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

// Create the job's user and an EMPTY database, with production's settings (what the workflow does with `docker exec ... mariadb`).
async function prepareDb(job, svc, wt) {
  const m = job.services.mariadb;
  const req = createRequire(path.join(wt, 'package.json'));
  let conn;
  const u = new URL(svc.adminUrl);
  const cfg = { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), multipleStatements: true };
  try { conn = await req('mariadb').createConnection(cfg); } catch (e1) {
    try { conn = await req('mysql2/promise').createConnection(cfg); } catch { fail(`cannot reach MariaDB as admin (${e1.message})`); }
  }
  const [ver] = await conn.query('SELECT VERSION() AS v');
  const v = (ver.v ?? ver[0]?.v ?? '') + '';
  if (!v.startsWith('11.8')) console.warn(c('33', `   MariaDB is ${v}; production and CI use 11.8`));
  if (!/test|_ci/.test(m.db)) fail(`refusing to recreate database ${m.db}`);
  for (const q of [
    `CREATE USER IF NOT EXISTS '${m.user}'@'%' IDENTIFIED BY '${m.password}'`,
    `ALTER USER '${m.user}'@'%' IDENTIFIED BY '${m.password}'`,
    `GRANT ALL PRIVILEGES ON *.* TO '${m.user}'@'%'`,
    `FLUSH PRIVILEGES`,
    `SET GLOBAL transaction_isolation='READ-COMMITTED'`,
    `SET GLOBAL max_connections=500`,
    `DROP DATABASE IF EXISTS \`${m.db}\``,
    `CREATE DATABASE \`${m.db}\``,
  ]) await conn.query(q);
  await conn.end();
  say(`database ${m.db} ready (empty, READ COMMITTED)`);
}

// ---- GitHub commit statuses (optional: needs the gh CLI) --------------------------------------------------------------
function queueStatuses(slug, sha, results, cacheDir) {
  if (!slug || !has('gh')) { say('gh CLI not found: no status posted to GitHub (the push itself is what matters)'); return; }
  const file = path.join(cacheDir, `status-${sha}.json`);
  writeFileSync(file, JSON.stringify({ slug, sha, host: os.hostname(), results }));
  if (flag('--pre-push')) { // the commit is not on GitHub until the push finishes: post from a background process
    spawn(process.execPath, [SELF, '--post-pending', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else postPending(file, 1);
}

async function postPending(file, tries = 60) {
  const { slug, sha, host, results } = JSON.parse(readFileSync(file, 'utf8'));
  for (let i = 0; i < tries; i++) {
    if (sh(`gh api repos/${slug}/commits/${sha} --jq .sha`).status === 0) {
      for (const r of results) {
        if (r.state === 'skipped') continue;
        sh(`gh api repos/${slug}/statuses/${sha} -f state=${r.state} -f context=local/${r.id} -f "description=${r.state === 'success' ? 'passed' : 'FAILED'} locally on ${host}"`);
      }
      rmSync(file, { force: true });
      if (tries === 1) say(`statuses posted to ${slug}@${sha.slice(0, 12)}`);
      return;
    }
    if (tries > 1) await sleep(5000);
  }
  if (tries === 1) say(`commit not on GitHub yet: statuses will be posted when you push (or run: node scripts/ci-local.mjs --post-pending "${file}")`);
}

// ---- entry (last, so every helper above is initialised) ------------------------------------------------------------------
if (flag('--install-hook')) {
  // Called from the package "prepare" script. Must never fail (it also runs in Hostinger builds, where there may be no .git).
  try {
    const top = out('git rev-parse --show-toplevel');
    if (top && existsSync(path.join(top, '.githooks', 'pre-push'))) sh('git config core.hooksPath .githooks', { cwd: top });
  } catch { /* best effort */ }
  process.exit(0);
}
if (flag('--post-pending')) await postPending(opt('--post-pending'));
else await main();
