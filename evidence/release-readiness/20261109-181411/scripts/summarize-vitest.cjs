// Summarise vitest JSON reports: totals per suite and per test file. usage: node summarize-vitest.cjs <json>...
const fs = require('node:fs');
const path = require('node:path');
for (const f of process.argv.slice(2)) {
  if (!fs.existsSync(f)) { console.log(`${path.basename(f)}: MISSING`); continue; }
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const dur = j.testResults.reduce((s, r) => s + ((r.endTime ?? 0) - (r.startTime ?? 0)), 0);
  console.log(`== ${path.basename(f)}: files=${j.numTotalTestSuites ?? j.testResults.length} tests=${j.numTotalTests} passed=${j.numPassedTests} failed=${j.numFailedTests} skipped/pending=${(j.numPendingTests ?? 0) + (j.numTodoTests ?? 0)} success=${j.success} sumFileMs=${dur}`);
  for (const r of j.testResults) {
    const a = r.assertionResults;
    const c = (s) => a.filter((x) => x.status === s).length;
    console.log(`  ${path.basename(r.name).padEnd(40)} ${r.status.padEnd(7)} pass=${c('passed')} fail=${c('failed')} skip=${c('skipped') + c('pending') + c('todo')}`);
    for (const x of a.filter((x) => x.status === 'failed')) console.log(`     FAILED: ${x.fullName}`);
  }
}
