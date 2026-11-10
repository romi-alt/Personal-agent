// Phase F secret scan: every file tracked at HEAD is scanned for credential FORMATS (no entropy guessing). Matches
// whose text contains a synthetic marker (SYNTH, EXAMPLE, fake, AAAA..., xxxx) are reported separately as fixtures.
// Prints only file:line and the pattern id, never the matched value. Exit 1 when a non-fixture match exists.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const files = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
const PATTERNS = {
  'anthropic-key': /sk-ant-[A-Za-z0-9_-]{20,}/,
  'github-token': /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  'github-fine-grained': /\bgithub_pat_[A-Za-z0-9_]{50,}/,
  'aws-access-key': /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  'private-key-block': /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  'slack-token': /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  'npm-token': /\bnpm_[A-Za-z0-9]{36}\b/,
  'jwt': /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  'url-password': /\bhttps?:\/\/[^\s:@/'"]+:[^\s@/'"$<{]{6,}@/,
};
const FIXTURE = /SYNTH|EXAMPLE|example|fake|FAKE|test|TEST|dummy|A{8,}|B{8,}|x{8,}|X{8,}|0{8,}|1234|abcdef|ZZZZ/;
const real = [];
const fixtures = [];
for (const f of files) {
  if (/\.(png|jpg|ico|woff2?|db|sqlite|zip|gz)$/i.test(f) || f === 'package-lock.json') continue;
  let text;
  try {
    text = readFileSync(path.join(repo, f), 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    for (const [id, re] of Object.entries(PATTERNS)) {
      const m = re.exec(line);
      if (!m) continue;
      const rec = `${f}:${i + 1} ${id}`;
      (FIXTURE.test(m[0]) || /^tests[\\/]/.test(f) ? fixtures : real).push(rec);
    }
  });
}
console.log(`files=${files.length} matches=${real.length} fixtureMatches=${fixtures.length}`);
for (const r of real) console.log(`MATCH ${r}`);
for (const r of fixtures) console.log(`fixture ${r}`);
process.exit(real.length ? 1 : 0);
