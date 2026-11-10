// Read-only production probe: opens the live DB with readonly:true (no writes, no migrations), prints one JSON line.
const Database = require('E:/Agent/Personal-agent/node_modules/better-sqlite3');
const db = new Database(process.env.LOCALAPPDATA + '/ElevariqAgent/agent.db', { readonly: true, fileMustExist: true });
const now = Date.now();
const s = db.prepare('SELECT pid, status, heartbeat_at, current_task_id FROM supervisor_state ORDER BY heartbeat_at DESC LIMIT 1').get() || {};
const q = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('QUEUED','READY','RUNNING','CHECKPOINTING','WAITING_FOR_CAPACITY')").get().n;
console.log(JSON.stringify({ pid: s.pid, status: s.status, hbAgeS: s.heartbeat_at ? Math.round((now - s.heartbeat_at) / 1000) : null, task: s.current_task_id, activeOrQueued: q }));
db.close();
