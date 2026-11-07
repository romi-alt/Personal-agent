/**
 * Command-center UI: one self-contained page (no CDN, no third-party code). All dynamic content is inserted with
 * textContent / DOM APIs only (never innerHTML with data), and the page runs under a nonce-based CSP.
 */
const CSS = String.raw`
:root{--bg:#f6f7f9;--panel:#fff;--ink:#14171f;--muted:#5b6474;--line:#e3e6eb;--soft:#eef1f5;--accent:#2f5bd3;--accent-ink:#fff;
--ok:#1f7a4d;--ok-bg:#e3f4ea;--run:#1f5fbf;--run-bg:#e4edfb;--wait:#8a5a00;--wait-bg:#fdf1d8;--auth:#6b3fb5;--auth-bg:#efe7fb;
--appr:#a24b00;--appr-bg:#fde8d6;--bad:#b42318;--bad-bg:#fde7e5;--idle:#5b6474;--idle-bg:#eef1f5;--radius:10px;
--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"Cascadia Code",Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--panel:#161a22;--ink:#e7eaf0;--muted:#98a2b3;--line:#262c38;--soft:#1d2330;
--accent:#6c8cff;--accent-ink:#0b0e14;--ok:#5fd39a;--ok-bg:#12291e;--run:#7aa7ff;--run-bg:#14223b;--wait:#f2c45a;--wait-bg:#2c2412;
--auth:#b993ff;--auth-bg:#241a37;--appr:#ffab6b;--appr-bg:#33200f;--bad:#ff7a6e;--bad-bg:#371614;--idle:#98a2b3;--idle-bg:#1d2330}}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--ink);font:14px/1.5 var(--font)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.app{display:grid;grid-template-columns:232px 1fr;min-height:100%}
nav.side{background:var(--panel);border-right:1px solid var(--line);padding:20px 14px;position:sticky;top:0;height:100vh}
.brand{font-weight:700;letter-spacing:.2px;font-size:15px;margin:2px 8px 18px}.brand small{display:block;color:var(--muted);font-weight:500;font-size:12px}
nav.side a{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-radius:8px;color:var(--ink);margin-bottom:2px}
nav.side a.on{background:var(--soft);font-weight:600}nav.side a:hover{text-decoration:none;background:var(--soft)}
.count{font-size:12px;background:var(--appr-bg);color:var(--appr);border-radius:999px;padding:0 8px;font-weight:600}
main{padding:24px 32px 48px;max-width:1400px;width:100%}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}
h1{font-size:22px;margin:0;letter-spacing:-.2px}h2{font-size:15px;margin:0 0 12px}h3{font-size:13px;margin:16px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.muted{color:var(--muted)}.mono{font-family:var(--mono);font-size:12.5px}
.grid{display:grid;gap:16px}.g4{grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}.g2{grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
@media (max-width:1100px){.g2{grid-template-columns:1fr}.app{grid-template-columns:1fr}nav.side{position:static;height:auto}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px}
.kpi .v{font-size:26px;font-weight:700;letter-spacing:-.5px}.kpi .l{color:var(--muted);font-size:12.5px}
.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.s-RUNNING,.s-CHECKPOINTING{color:var(--run);background:var(--run-bg)}.s-WAITING_FOR_USAGE_RESET,.s-WAITING_FOR_CAPACITY,.s-RETRY_SCHEDULED{color:var(--wait);background:var(--wait-bg)}
.s-WAITING_FOR_AUTHENTICATION{color:var(--auth);background:var(--auth-bg)}.s-WAITING_FOR_APPROVAL,.s-PENDING,.s-ESCALATED{color:var(--appr);background:var(--appr-bg)}
.s-BLOCKED,.s-FAILED,.s-SUPERVISOR_DOWN,.s-DENIED,.s-OWNER_REJECTED{color:var(--bad);background:var(--bad-bg)}
.s-COMPLETED,.s-PASSED,.s-APPROVED,.s-accepted,.s-verified,.s-DELIVERED,.s-READY_FOR_DELIVERY,.s-OWNER_ACCEPTED{color:var(--ok);background:var(--ok-bg)}
.s-default{color:var(--idle);background:var(--idle-bg)}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
.bar{height:8px;background:var(--soft);border-radius:99px;overflow:hidden;min-width:90px}.bar>i{display:block;height:100%;background:var(--ok)}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:0 0 16px;overflow-x:auto}
.tabs a{padding:8px 12px;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap}.tabs a.on{color:var(--ink);border-color:var(--accent);font-weight:600}
.tabs a:hover{text-decoration:none;color:var(--ink)}
.timeline{list-style:none;margin:0;padding:0}.timeline li{display:grid;grid-template-columns:92px 1fr;gap:10px;padding:7px 0;border-bottom:1px dashed var(--line)}
.timeline li:last-child{border:0}.sev-warn{color:var(--wait)}.sev-error{color:var(--bad)}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:6px 12px;border-radius:8px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}button.danger{color:var(--bad);border-color:var(--bad)}
button:focus-visible,a:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:6px;flex-wrap:wrap}
textarea,input[type=text],input[type=number],input[type=password]{font:inherit;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);padding:12px;border-radius:8px;font:12.5px/1.5 var(--mono);margin:0;max-height:520px;overflow:auto}
.kv{display:grid;grid-template-columns:180px 1fr;gap:6px 14px}.kv dt{color:var(--muted)}.kv dd{margin:0}
.empty{color:var(--muted);padding:12px 0}.err{color:var(--bad)}.toast{position:fixed;bottom:20px;right:20px;background:var(--ink);color:var(--bg);padding:10px 14px;border-radius:8px}
.health{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.sr{position:absolute;left:-9999px}
`;

const JS = String.raw`
"use strict";
var S = { csrf: null, route: [], timer: null, cache: {} };
function h(tag, props) {
  var el = document.createElement(tag);
  props = props || {};
  for (var k in props) {
    var v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = String(v);
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, c) { if (c == null || c === false) return; if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; } el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); }
function api(path, method, body) {
  var o = { method: method || 'GET', credentials: 'same-origin', headers: {} };
  if (method && method !== 'GET') { o.headers['content-type'] = 'application/json'; o.headers['x-csrf-token'] = S.csrf || ''; o.body = JSON.stringify(body || {}); }
  return fetch('/api/' + path, o).then(function (r) {
    if (r.status === 401) { location.reload(); throw new Error('session expired'); }
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
  });
}
function toast(msg, bad) { var t = h('div', { class: 'toast', role: 'status', text: msg }); if (bad) t.style.background = 'var(--bad)'; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3500); }
function when(ms) { if (!ms) return '-'; var d = new Date(ms); return d.toLocaleString(); }
function ago(ms) { if (!ms) return '-'; var s = Math.round((Date.now() - ms) / 1000); if (s < 0) return 'in ' + dur(-s); return dur(s) + ' ago'; }
function dur(s) { if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return Math.round(s / 3600) + 'h'; return Math.round(s / 86400) + 'd'; }
function badge(s, label) { var known = /^(RUNNING|CHECKPOINTING|WAITING_FOR_USAGE_RESET|WAITING_FOR_CAPACITY|RETRY_SCHEDULED|WAITING_FOR_AUTHENTICATION|WAITING_FOR_APPROVAL|PENDING|ESCALATED|BLOCKED|FAILED|SUPERVISOR_DOWN|DENIED|OWNER_REJECTED|COMPLETED|PASSED|APPROVED|accepted|verified|DELIVERED|READY_FOR_DELIVERY|OWNER_ACCEPTED)$/.test(s); return h('span', { class: 'badge ' + (known ? 's-' + s : 's-default') }, label || String(s || '-').replace(/_/g, ' ')); }
function bar(ratio, label) { var pct = Math.round((ratio || 0) * 100); return h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label || 'verified progress', title: pct + '% verified' }, h('i', { style: 'width:' + pct + '%' })); }
function table(cols, rows, empty) {
  if (!rows.length) return h('div', { class: 'empty', text: empty || 'Nothing here yet.' });
  return h('div', { style: 'overflow-x:auto' }, h('table', null, h('thead', null, h('tr', null, cols.map(function (c) { return h('th', { scope: 'col', text: c[0] }); }))),
    h('tbody', null, rows.map(function (r) { return h('tr', null, cols.map(function (c) { var v = c[1](r); return h('td', null, v); })); }))));
}
function card(title, body, extra) { return h('section', { class: 'card' }, title ? h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, h('h2', { style: 'margin:0', text: title }), extra || null) : null, body); }
function kpi(label, value, state) { return h('div', { class: 'card kpi' }, h('div', { class: 'v' }, String(value)), h('div', { class: 'l' }, label), state ? h('div', { style: 'margin-top:6px' }, badge(state)) : null); }
function timeline(events) {
  if (!events.length) return h('div', { class: 'empty', text: 'No activity recorded yet.' });
  return h('ul', { class: 'timeline' }, events.map(function (e) {
    var p = e.payload || {}; var detail = p.title || p.reason || p.error || p.decision || p.phase || '';
    return h('li', null, h('span', { class: 'muted mono', title: when(e.at), text: ago(e.at) }), h('div', { class: 'sev-' + e.severity }, h('span', { class: 'mono', text: e.type }), detail ? h('span', { class: 'muted', text: ' - ' + String(detail).slice(0, 160) }) : null));
  }));
}
function act(label, fn, cls) { return h('button', { class: cls || '', onclick: function (ev) { var b = ev.currentTarget; b.disabled = true; Promise.resolve(fn()).then(function () { toast(label + ': done'); render(); }).catch(function (e) { toast(e.message, true); }).finally(function () { b.disabled = false; }); } }, label); }
function nav() {
  var o = S.cache.overview; var pending = o ? o.totals.pendingApprovals : 0; var cur = S.route[0] || '';
  function link(href, label, key, count) { return h('a', { href: href, class: cur === key ? 'on' : '', 'aria-current': cur === key ? 'page' : null }, h('span', null, label), count ? h('span', { class: 'count', text: count }) : null); }
  return h('nav', { class: 'side', 'aria-label': 'Main' }, h('div', { class: 'brand' }, 'ELEVARIQ', h('small', null, 'Personal Agent - Command Center')),
    link('#/', 'Overview', ''), link('#/projects', 'Projects', 'projects'), link('#/workers', 'Live worker', 'workers'), link('#/approvals', 'Approvals', 'approvals', pending), link('#/activity', 'Activity log', 'activity'), link('#/assign', 'Assign a project', 'assign'),
    h('form', { method: 'post', action: '/logout', style: 'margin-top:24px' }, h('button', { type: 'submit' }, 'Sign out')));
}
function health(sys) {
  var sup = sys.supervisor || {};
  return h('div', { class: 'health' }, badge(sys.workerState), h('span', { class: 'muted', text: sys.workerStateReason || '' }),
    h('span', null, 'Supervisor ', badge(sup.live ? 'RUNNING' : 'SUPERVISOR_DOWN', sup.live ? 'live' : 'down')), h('span', { class: 'muted', text: 'heartbeat ' + ago(sup.heartbeatAt) }),
    h('span', null, 'Auth ', badge(sys.authentication.ready ? 'COMPLETED' : 'WAITING_FOR_AUTHENTICATION', sys.authentication.ready ? 'ready' : 'not ready')),
    h('span', null, 'Provider ' + (sys.provider.name || '') + ' ', badge(sys.provider.state === 'AVAILABLE' ? 'COMPLETED' : sys.provider.state, sys.provider.state)));
}
function page(title, sub, body, actions) { return [h('header', { class: 'top' }, h('div', null, h('h1', { text: title }), sub ? h('div', { class: 'muted', text: sub }) : null), actions || null), body]; }

// ---------------------------------------------------------------- views
function viewOverview() {
  return api('overview').then(function (o) {
    S.cache.overview = o; var t = o.totals;
    return page('Overview', 'Generated ' + when(o.generatedAt) + ' from live agent data', [
      card(null, health(o.system)), h('div', { style: 'height:16px' }),
      h('div', { class: 'grid g4' }, kpi('Active projects', t.activeProjects), kpi('Completed projects', t.completedProjects), kpi('Queued tasks', t.queued), kpi('Running workers', t.running, t.running ? 'RUNNING' : null),
        kpi('Waiting for capacity', t.waitingForCapacity, t.waitingForCapacity ? 'WAITING_FOR_USAGE_RESET' : null), kpi('Waiting for approval', t.waitingForApproval + t.pendingApprovals, (t.waitingForApproval + t.pendingApprovals) ? 'WAITING_FOR_APPROVAL' : null),
        kpi('Blocked tasks', t.blocked, t.blocked ? 'BLOCKED' : null), kpi('Failed tasks', t.failed, t.failed ? 'FAILED' : null)),
      h('div', { style: 'height:16px' }),
      h('div', { class: 'grid g2' },
        h('div', { class: 'grid' }, card('Projects', projectsTable(o.projects)), card('Upcoming milestones', table([['Project', function (m) { return h('a', { href: '#/p/' + m.projectId + '/roadmap', text: m.project }); }], ['Milestone', function (m) { return m.key + ' - ' + m.title; }], ['Verified', function (m) { return m.progress ? m.progress.delivered + '/' + m.progress.total : '-'; }], ['', function (m) { return bar(m.progress ? m.progress.ratio : 0); }]], o.upcomingMilestones, 'No open milestones.'))),
        card('Recent activity', timeline(o.recentActivity.slice(0, 25))))]);
  });
}
function projectsTable(ps) {
  return table([['Project', function (p) { return h('a', { href: '#/p/' + p.id + '/overview', text: p.name }); }], ['Lifecycle', function (p) { return badge(p.lifecycle); }], ['State', function (p) { return p.status === 'PAUSED' ? badge('PAUSED', 'paused') : badge('default', 'active'); }],
    ['Verified progress', function (p) { return p.planned ? h('div', null, bar(p.progress.ratio), h('div', { class: 'muted', style: 'font-size:12px', text: p.progress.delivered + '/' + p.progress.total + ' tasks delivered' })) : h('span', { class: 'muted', text: 'not planned' }); }],
    ['Open', function (p) { var c = p.counts; return String((c.QUEUED || 0) + (c.READY || 0) + (c.RUNNING || 0) + (c.RETRY_SCHEDULED || 0)); }], ['Last activity', function (p) { return ago(p.lastActivityAt); }]], ps, 'No projects yet. Assign one.');
}
function viewProjects() { return api('overview').then(function (o) { S.cache.overview = o; return page('Projects', o.projects.length + ' project(s)', card(null, projectsTable(o.projects)), h('a', { class: 'btn', href: '#/assign' }, 'Assign a project')); }); }

var TABS = [['overview', 'Overview'], ['requirements', 'Requirements'], ['research', 'Research'], ['architecture', 'Architecture'], ['adrs', 'ADRs'], ['roadmap', 'Roadmap'], ['tasks', 'Tasks'], ['executions', 'Executions'], ['checkpoints', 'Checkpoints'], ['git', 'Git changes'], ['tests', 'Test evidence'], ['qa', 'QA'], ['issues', 'Issues'], ['report', 'Delivery report']];
function viewProject(id, tab) {
  tab = tab || 'overview';
  return api('projects/' + encodeURIComponent(id)).then(function (d) {
    var p = d.project;
    var tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(function (t) { return h('a', { href: '#/p/' + id + '/' + t[0], class: t[0] === tab ? 'on' : '', role: 'tab', 'aria-selected': t[0] === tab ? 'true' : 'false', text: t[1] + (t[0] === 'issues' && d.outstanding.length ? ' (' + d.outstanding.length + ')' : '') }); }));
    var actions = h('div', { class: 'actions' }, p.status === 'PAUSED' ? act('Resume project', function () { return api('projects/' + id + '/resume', 'POST'); }, 'primary') : act('Pause project', function () { return api('projects/' + id + '/pause', 'POST'); }),
      priorityControl(p.priority, function (v) { return api('projects/' + id + '/priority', 'POST', { priority: v }); }));
    return page(p.name, p.lifecycle.replace(/_/g, ' ') + ' - ' + p.repoPath, [tabs, (PROJECT_TABS[tab] || PROJECT_TABS.overview)(d)], actions);
  });
}
function priorityControl(value, save) { var inp = h('input', { type: 'number', value: value, style: 'width:90px', 'aria-label': 'priority' }); return h('span', { class: 'actions' }, inp, act('Set priority', function () { return save(parseInt(inp.value, 10)); })); }
function kv(pairs) { return h('dl', { class: 'kv' }, pairs.map(function (p) { return [h('dt', { text: p[0] }), h('dd', null, p[1] == null || p[1] === '' ? '-' : p[1])]; })); }
function list(items) { return items && items.length ? h('ul', null, items.map(function (x) { return h('li', { text: x }); })) : h('span', { class: 'muted', text: '-' }); }
var PROJECT_TABS = {
  overview: function (d) {
    var a = d.assignment || {}; var r = d.roadmap;
    return h('div', { class: 'grid g2' }, h('div', { class: 'grid' },
      card('Assignment', a.title ? kv([['Title', a.title], ['Description', a.description], ['Objectives', list(a.businessObjectives)], ['Target users', list(a.targetUsers)], ['Deliverables', list(a.expectedDeliverables)], ['Priority', String(a.priority)], ['Budget', a.budget && Object.keys(a.budget).length ? JSON.stringify(a.budget) : 'none set'], ['Owner review points', list(a.ownerApprovalRequirements)]]) : h('div', { class: 'empty', text: 'No structured assignment yet (intake/planning in progress).' })),
      card('Verified progress', r.tasks.length ? h('div', null, bar(r.progress.overall.ratio), h('p', { class: 'muted', text: r.progress.overall.delivered + ' of ' + r.progress.overall.total + ' planned tasks delivered with passing evidence. Critical path (remaining): ' + (r.criticalPath.path.join(' > ') || '-') })) : h('div', { class: 'empty', text: 'No plan materialised yet.' })),
      card('Planning runs', table([['Run', function (w) { return h('span', { class: 'mono', text: w.id }); }], ['Status', function (w) { return badge(w.status); }], ['Phase', function (w) { return w.phase; }], ['Updated', function (w) { return ago(w.updatedAt); }], ['Owner input', function (w) { return questions(w); }]], d.workflows))),
      h('div', { class: 'grid' }, card('Lifecycle', timeline(d.lifecycle.slice().reverse().map(function (l) { return { at: l.at, type: (l.from || 'new') + ' -> ' + l.to, payload: { reason: l.reason }, severity: 'info' }; }))), card('Documents', table([['Name', function (x) { return x.name; }], ['Kind', function (x) { return x.kind; }], ['Size', function (x) { return x.bytes + ' B'; }]], d.documents))));
  },
  requirements: function (d) { return card('Requirements (' + d.requirements.length + ')', table([['ID', function (r) { return h('span', { class: 'mono', text: r.id }); }], ['Priority', function (r) { return r.priority; }], ['Kind', function (r) { return r.kind; }], ['Source', function (r) { return r.source; }], ['Covered by', function (r) { return d.roadmap.tasks.filter(function (t) { return t.requirementIds.indexOf(r.id) >= 0; }).map(function (t) { return t.key; }).join(', ') || '-'; }], ['Text', function (r) { return r.text; }]], d.requirements)); },
  research: function (d) { return card('Research findings', [h('p', { class: 'muted', text: 'Verified = every cited source was actually retrieved by the research session. Everything else is an assumption.' }), table([['ID', function (f) { return f.findingId; }], ['Area', function (f) { return f.area; }], ['Kind', function (f) { return badge(f.kind, f.kind + (f.claimedKind !== f.kind ? ' (claimed ' + f.claimedKind + ')' : '')); }], ['Confidence', function (f) { return f.confidence; }], ['Statement', function (f) { return f.statement; }], ['Sources', function (f) { return f.sources.length ? h('div', null, f.sources.map(function (s) { return h('div', null, h('a', { href: s.url, rel: 'noopener noreferrer', target: '_blank', text: s.title })); })) : '-'; }], ['Date', function (f) { return when(f.researchedAt); }]], d.research, 'No research yet.')]); },
  architecture: function (d) { var a = d.architecture; if (!a) return card(null, h('div', { class: 'empty', text: 'No architecture yet.' })); return h('div', { class: 'grid' }, Object.keys(a.sections).map(function (k) { return card(k.charAt(0).toUpperCase() + k.slice(1), h('pre', { text: a.sections[k] || '(not specified)' })); }), card('Diagrams (Mermaid source; rendered in docs/architecture/ARCHITECTURE.md)', a.diagrams.length ? a.diagrams.map(function (g) { return [h('h3', { text: g.title }), h('pre', { text: g.mermaid })]; }) : h('div', { class: 'empty', text: 'No diagrams.' }))); },
  adrs: function (d) { return h('div', { class: 'grid' }, d.adrs.length ? d.adrs.map(function (a) { return card('ADR ' + String(a.number).padStart(4, '0') + ': ' + a.title, kv([['Status', badge(a.status)], ['Significant', a.significant ? 'yes - owner review' : 'no'], ['Date', when(a.decidedAt)], ['Context', a.context], ['Decision', a.decision], ['Alternatives', list(a.alternatives)], ['Rationale', a.rationale], ['Consequences', a.consequences], ['File', a.filePath]])); }) : card(null, h('div', { class: 'empty', text: 'No decision records yet.' }))); },
  roadmap: function (d) { var r = d.roadmap; return h('div', { class: 'grid' }, card('Milestones', table([['Key', function (m) { return m.key; }], ['Title', function (m) { return m.title; }], ['Goal', function (m) { return m.goal; }], ['Verified', function (m) { var g = r.progress.milestones.filter(function (x) { return x.key === m.key; })[0]; return g ? h('div', null, bar(g.ratio), h('span', { class: 'muted', text: g.delivered + '/' + g.total })) : '-'; }]], r.milestones)), r.epics.length ? card('Epics', table([['Key', function (e) { return e.key; }], ['Title', function (e) { return e.title; }], ['Verified', function (e) { var g = r.progress.epics.filter(function (x) { return x.key === e.key; })[0]; return g ? g.delivered + '/' + g.total : '-'; }]], r.epics)) : null, card('Task graph (critical path marked)', table([['Key', function (t) { return h('span', { class: 'mono', text: (r.criticalPath.path.indexOf(t.key) >= 0 ? '* ' : '') + t.key }); }], ['Task', function (t) { return t.title; }], ['Milestone', function (t) { return t.milestone; }], ['Size', function (t) { return t.size; }], ['Depends on', function (t) { return t.dependsOn.join(', ') || '-'; }], ['Status', function (t) { return badge(t.status); }], ['Evidence', function (t) { return t.delivered ? badge('PASSED', 'verified') : t.passed.length + '/' + t.required.length; }]], r.tasks, 'No plan yet.'))); },
  tasks: function (d) { return card('Tasks', table([['Task', function (t) { return h('div', null, h('div', { text: t.title }), h('div', { class: 'muted mono', style: 'font-size:11.5px', text: t.id + ' - ' + t.kind + (t.role ? ' - ' + t.role : '') })); }], ['Status', function (t) { return badge(t.status); }], ['Prio', function (t) { return String(t.priority); }], ['Attempts', function (t) { return t.attemptCount + '/' + t.maxRetries; }], ['Last error', function (t) { return t.lastErrorMessage ? h('span', { class: 'err', text: t.lastErrorMessage.slice(0, 160) }) : '-'; }], ['Controls', taskControls]], d.tasks)); },
  executions: function (d) { return card('Execution history', table([['Started', function (e) { return when(e.startedAt); }], ['Task', function (e) { return e.taskTitle; }], ['Provider', function (e) { return e.provider; }], ['Session', function (e) { return h('span', { class: 'mono', text: (e.providerSessionId || '-').slice(0, 13) }); }], ['Outcome', function (e) { return e.outcome ? badge(e.outcome === 'completed' ? 'COMPLETED' : e.outcome === 'interrupted' || e.outcome === 'failed' ? 'FAILED' : e.outcome, e.outcome) : badge('RUNNING'); }], ['Error', function (e) { return e.errorClass || '-'; }], ['Log', function (e) { return h('a', { href: '#/log/' + e.id, text: 'transcript' }); }]], d.executions)); },
  checkpoints: function (d) { return card('Latest checkpoint per task', table([['Task', function (c) { return c.taskTitle; }], ['When', function (c) { return when(c.createdAt); }], ['Repo ref', function (c) { return h('span', { class: 'mono', text: (c.repoRef || '-').slice(0, 12) }); }], ['Completed', function (c) { return (c.completed || '').slice(0, 200); }], ['Next', function (c) { return (c.next || '').slice(0, 200); }]], d.checkpoints)); },
  git: function (d) { return h('div', { class: 'grid g2' }, card('Working tree (git status)', d.git.status.length ? h('pre', { text: d.git.status.join('\n') }) : h('div', { class: 'empty', text: 'Clean or not a git repository.' })), card('Recent commits', d.git.log.length ? h('pre', { text: d.git.log.join('\n') }) : h('div', { class: 'empty', text: 'No commits.' }))); },
  tests: function (d) { return card('Verification evidence', table([['When', function (e) { return when(e.createdAt); }], ['Level', function (e) { return e.level; }], ['Status', function (e) { return badge(e.status); }], ['Task', function (e) { return e.taskId ? h('span', { class: 'mono', text: e.taskId }) : 'project'; }], ['Summary', function (e) { return e.summary; }]], d.evidence.slice().reverse(), 'No evidence recorded yet.')); },
  qa: function (d) { return card('Independent QA', table([['Task', function (q) { return q.taskTitle; }], ['Round', function (q) { return String(q.round); }], ['Status', function (q) { return badge(q.status); }], ['Unmet', function (q) { var u = q.result && q.result.unmet; return u && u.length ? u.map(function (x) { return x.id + ': ' + x.reason; }).join('; ') : '-'; }], ['Correction', function (q) { return q.correctionTaskId ? h('span', { class: 'mono', text: q.correctionTaskId }) : '-'; }]], d.qa, 'No reviews yet.')); },
  issues: function (d) { return card('Outstanding issues', table([['Severity', function (i) { return badge(i.severity === 'high' ? 'FAILED' : 'PENDING', i.severity); }], ['Kind', function (i) { return i.kind; }], ['Issue', function (i) { return i.text; }]], d.outstanding, 'No outstanding issues.')); },
  report: function (d) { var r = d.readiness; return h('div', { class: 'grid g2' }, card('Delivery readiness', [kv(Object.keys(r.levels).map(function (k) { return [k, badge(r.levels[k] === 'MISSING' ? 'default' : r.levels[k], r.levels[k])]; })), h('p', null, r.ready ? badge('READY_FOR_DELIVERY', 'all levels passed') : h('span', { class: 'muted', text: 'Blockers: ' + r.blockers.join('; ') }))]), card('Summary', kv([['Lifecycle', badge(d.project.lifecycle)], ['Requirements', String(d.requirements.length)], ['Tasks delivered', d.roadmap.progress.overall.delivered + '/' + d.roadmap.progress.overall.total], ['ADRs', String(d.adrs.length)], ['Research findings', d.research.length + ' (' + d.research.filter(function (f) { return f.kind === 'verified'; }).length + ' verified)'], ['Open issues', String(d.outstanding.length)]]))); }
};
function questions(w) {
  if (w.status !== 'WAITING_FOR_OWNER' || w.phase !== 'clarify') return '-';
  return h('div', null, (w.questions || []).filter(function (q) { return q.blocking; }).map(function (q) { var inp = h('input', { type: 'text', 'aria-label': 'answer ' + q.id }); return h('div', { style: 'margin-bottom:6px' }, h('div', { text: q.id + ': ' + q.text }), inp, act('Answer', function () { return api('workflows/' + w.id + '/answer', 'POST', { questionId: q.id, text: inp.value }); })); }), act('Continue with assumptions', function () { return api('workflows/' + w.id + '/assume', 'POST'); }));
}
function taskControls(t) {
  var b = []; var id = encodeURIComponent(t.id);
  if (['QUEUED', 'READY', 'RETRY_SCHEDULED', 'WAITING_FOR_CAPACITY'].indexOf(t.status) >= 0) b.push(act('Pause', function () { return api('tasks/' + id + '/pause', 'POST'); }));
  if (t.status === 'PAUSED') b.push(act('Resume', function () { return api('tasks/' + id + '/resume', 'POST'); }));
  if (t.status === 'BLOCKED') b.push(act('Unblock', function () { return api('tasks/' + id + '/unblock', 'POST'); }));
  if (t.status === 'FAILED') b.push(act('Retry', function () { return api('tasks/' + id + '/retry', 'POST'); }));
  if (['COMPLETED', 'CANCELLED'].indexOf(t.status) < 0) b.push(act('Cancel', function () { if (!confirm('Cancel task "' + t.title + '"?')) return Promise.reject(new Error('not cancelled')); return api('tasks/' + id + '/cancel', 'POST'); }, 'danger'));
  return h('div', { class: 'actions' }, b);
}
function viewWorkers() {
  return api('system').then(function (s) {
    var e = s.currentExecution; var cw = e && e.capacityWait;
    return page('Live worker', 'Supervisor ' + (s.supervisor.live ? 'live' : 'DOWN'), h('div', { class: 'grid g2' },
      card('Current worker', e ? kv([['State', badge(s.workerState)], ['Reason', s.workerStateReason], ['Provider', s.provider.name], ['Session', h('span', { class: 'mono', text: e.sessionId || '-' })], ['Task', s.currentTask ? s.currentTask.title : '-'], ['Project', s.currentProject || '-'], ['Worker pid', e.workerPid ? String(e.workerPid) : '-'], ['Started', when(e.startedAt)], ['Latest activity', ago(e.lastActivityAt)], ['Last heartbeat', ago(e.heartbeatAt)], ['Waiting reason', cw ? cw.reason : '-'], ['Usage resets at', cw && cw.resetsAt ? when(cw.resetsAt) : '-'], ['Next recheck', cw && cw.recheckAt ? when(cw.recheckAt) : '-']]) : kv([['State', badge(s.workerState)], ['Reason', s.workerStateReason || 'no execution in progress']])),
      h('div', { class: 'grid' }, card('Health', health(s)), card('Authentication', kv([['Ready', s.authentication.ready ? 'yes' : 'no'], ['Detail', s.authentication.ready ? s.authentication.detail : s.authentication.missing.join('; ')]])), card('Last checkpoint', s.lastCheckpoint ? kv([['When', when(s.lastCheckpoint.createdAt)], ['Repo ref', s.lastCheckpoint.repoRef || '-']]) : h('div', { class: 'empty', text: 'none' })), card('Waiting tasks', table([['Task', function (t) { return t.title; }], ['Status', function (t) { return badge(t.status); }], ['Eligible', function (t) { return ago(t.nextEligibleAt); }], ['Reason', function (t) { return t.reason || '-'; }]], s.waitingTasks, 'Nothing waiting.')))));
  });
}
function viewApprovals() {
  return api('approvals').then(function (d) {
    var pending = d.approvals.filter(function (a) { return a.status === 'PENDING'; }); var done = d.approvals.filter(function (a) { return a.status !== 'PENDING'; });
    return page('Approval center', pending.length + ' pending', [card('Pending decisions', pending.length ? pending.map(function (a) {
      var note = h('textarea', { rows: 2, placeholder: 'Note for the audit trail (optional)', 'aria-label': 'note' });
      return h('div', { style: 'padding:12px 0;border-bottom:1px solid var(--line)' }, h('div', { class: 'actions', style: 'justify-content:space-between' }, h('strong', { text: a.actionType.replace(/_/g, ' ') }), h('span', { class: 'muted', text: 'requested ' + ago(a.requestedAt) })), h('p', { text: a.description }), h('pre', { text: JSON.stringify(a.payload, null, 2) }), h('div', { style: 'margin:8px 0' }, note),
        h('div', { class: 'actions' }, act('Approve', function () { return api('approvals/' + a.id + '/approve', 'POST', { note: note.value }); }, 'primary'), act('Deny', function () { return api('approvals/' + a.id + '/deny', 'POST', { note: note.value }); }, 'danger')));
    }) : h('div', { class: 'empty', text: 'No decisions waiting for you.' })), h('div', { style: 'height:16px' }),
    card('Audit trail', table([['Decided', function (e) { return when(e.at); }], ['Type', function (e) { return e.payload.actionType; }], ['Decision', function (e) { return badge(e.payload.decision); }], ['By', function (e) { return e.payload.by + ' (' + e.payload.channel + (e.payload.address ? ', ' + e.payload.address : '') + ')'; }], ['Note', function (e) { return e.payload.note || '-'; }]], d.audit, 'No decisions yet.')),
    h('div', { style: 'height:16px' }), card('History', table([['Requested', function (a) { return when(a.requestedAt); }], ['Type', function (a) { return a.actionType; }], ['Status', function (a) { return badge(a.status); }], ['Description', function (a) { return a.description; }]], done))]);
  });
}
function viewActivity() { return api('events?limit=300').then(function (ev) { return page('Activity log', ev.length + ' most recent events', card(null, timeline(ev))); }); }
function viewLog(execId) { return api('executions/' + encodeURIComponent(execId) + '/log').then(function (d) { return page('Execution transcript', execId, card(null, d.lines.length ? h('pre', { text: d.lines.map(function (l) { return JSON.stringify(l); }).join('\n') }) : h('div', { class: 'empty', text: 'No transcript.' }))); }); }
function viewAssign() {
  var text = h('textarea', { rows: 8, placeholder: 'Describe the project in your own words, e.g. "Build a complete educational ERP for Pakistani institutions."', 'aria-label': 'assignment' });
  var name = h('input', { type: 'text', placeholder: 'Project name (optional)', 'aria-label': 'project name' });
  return Promise.resolve(page('Assign a project', 'The agent converts your text into a structured contract, researches, designs the architecture and plans the work. Coding starts only after you approve the plan.', card(null, h('div', { class: 'grid' }, name, text, h('div', { class: 'actions' }, act('Submit assignment', function () { return api('intake', 'POST', { text: text.value, name: name.value }).then(function (r) { location.hash = '#/p/' + r.projectId + '/overview'; }); }, 'primary'))))));
}

// ---------------------------------------------------------------- router
function render() {
  var r = (location.hash.replace(/^#\/?/, '') || '').split('/'); S.route = r;
  var p = r[0] === 'p' ? viewProject(r[1], r[2]) : r[0] === 'projects' ? viewProjects() : r[0] === 'workers' ? viewWorkers() : r[0] === 'approvals' ? viewApprovals() : r[0] === 'activity' ? viewActivity() : r[0] === 'log' ? viewLog(r[1]) : r[0] === 'assign' ? viewAssign() : viewOverview();
  return p.then(function (content) {
    var root = document.getElementById('root'); var focus = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
    if (focus) return; // never wipe what the owner is typing
    root.replaceChildren(h('div', { class: 'app' }, nav(), h('main', { id: 'main' }, content)));
  }).catch(function (e) { document.getElementById('root').replaceChildren(h('main', null, h('p', { class: 'err', text: 'Error: ' + e.message }))); });
}
api('session').then(function (s) { S.csrf = s.csrf; return api('overview'); }).then(function (o) { S.cache.overview = o; render(); });
window.addEventListener('hashchange', render);
S.timer = setInterval(function () { if (S.route[0] !== 'assign' && S.route[0] !== 'log') render(); }, 8000);
`;

const shell = (nonce: string, body: string, script = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>ELEVARIQ Command Center</title><style nonce="${nonce}">${CSS}</style></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;

export function uiPage(nonce: string): string {
  return shell(
    nonce,
    '<div id="root"><main><p class="muted">Loading live agent data...</p></main></div>',
    JS,
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function loginPage(nonce: string, error?: string): string {
  return shell(
    nonce,
    `<main style="max-width:420px;margin:12vh auto;padding:0 16px"><div class="card"><h1 style="margin-bottom:6px">ELEVARIQ Command Center</h1><p class="muted">Local owner console. Sign in with the owner token from <span class="mono">dashboard.token</span> in the agent home (<span class="mono">npm run agent -- dashboard:token</span>).</p>${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}<form method="post" action="/login"><label for="t" class="muted">Owner token</label><input id="t" name="token" type="password" autocomplete="current-password" required autofocus><div style="margin-top:12px"><button class="primary" type="submit">Sign in</button></div></form></div></main>`,
  );
}
