// Helper for run-isolation-tests.ps1. Usage:
//   node iso-db.cjs seed <snapshot> <target-db> <better-sqlite3-dir>
//   node iso-db.cjs fp <target-db> <better-sqlite3-dir>
'use strict';
const fs = require('fs');
const [, , cmd, a, b, c] = process.argv;
if (cmd === 'seed') {
  fs.copyFileSync(a, b);
  const D = require(c);
  const db = new D(b);
  const p = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  for (const id of ['apr_isotestsql0001', 'apr_isotestcli0001'])
    db.prepare(
      "INSERT INTO approvals(id,project_id,action_type,description,status,requested_at,payload) VALUES(?,?,?,?,'PENDING',?,'{}')",
    ).run(id, p, 'protected_branch_push', 'ISOTEST synthetic approval', Date.now());
  db.pragma('journal_mode=DELETE');
  db.close();
} else if (cmd === 'fp') {
  const D = require(b);
  const db = new D(a, { readonly: true });
  const approvals = db.prepare("SELECT id,status,decided_by FROM approvals WHERE id LIKE 'apr_isotest%' ORDER BY id").all();
  const attackerTable = db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='attacker_marker'").get().n;
  console.log(JSON.stringify({ approvals, attackerTable }));
  db.close();
} else if (cmd === 'serve') {
  require('http').createServer((q, r) => r.end('approvals')).listen(Number(a), '127.0.0.1');
}
