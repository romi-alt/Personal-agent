// Read-only: selected staging events with payloads (Phase G denial analysis).
'use strict';
const path = require('path');
const Database = require(path.join('E:/Agent/v2-staging/hardening/repo/node_modules/better-sqlite3'));
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const types = process.argv.slice(3);
const rows = db
  .prepare(`SELECT type, at, payload FROM activity_events WHERE type IN (${types.map(() => '?').join(',')}) ORDER BY at`)
  .all(...types);
for (const r of rows) console.log(new Date(r.at).toISOString(), r.type, r.payload);
db.close();
