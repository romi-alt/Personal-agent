// Read-only query of the STAGING agent DB (Phase G driver). Usage: node staging-query.cjs <db> projects|tasks|qa
'use strict';
const path = require('path');
const Database = require(path.join('E:/Agent/v2-staging/hardening/repo/node_modules/better-sqlite3'));
const [file, what] = process.argv.slice(2);
const db = new Database(file, { readonly: true, fileMustExist: true });
let rows = [];
if (what === 'projects') rows = db.prepare('SELECT id, slug, repo_path AS repoPath FROM projects ORDER BY created_at').all();
if (what === 'tasks')
  rows = db.prepare('SELECT id, title, status, kind, attempt_count AS attempts FROM tasks ORDER BY rowid').all();
if (what === 'qa') rows = db.prepare('SELECT task_id AS taskId, round, status, repairs FROM qa_reviews ORDER BY rowid').all();
db.close();
console.log(JSON.stringify(rows));
