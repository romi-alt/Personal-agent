import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SecretScanVerifier } from '../../src/verification/verifiers.js';
import { removeTempDir } from '../helpers/fs.js';

let dir = '';
afterEach(() => dir && removeTempDir(dir));
const ctx = (cwd: string) => ({ projectId: 'p', cwd, commands: {}, timeoutMs: 1000 });

describe('SECURITY_CHECKS_PASS: secret scan', () => {
  it('passes a clean tree and states its limited scope', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'scan-'));
    writeFileSync(path.join(dir, 'index.ts'), 'export const port = Number(process.env.PORT ?? 3000);\n');
    writeFileSync(path.join(dir, '.env.example'), 'API_TOKEN=<placeholder>\n');
    const r = await new SecretScanVerifier().verify(ctx(dir));
    expect(r.status).toBe('PASSED');
    expect(r.summary).toMatch(/dependency audit not performed/);
  });
  it('fails on credential patterns and committed .env files, reporting file:line but never the value', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'scan-'));
    mkdirSync(path.join(dir, 'src'));
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    writeFileSync(path.join(dir, 'src', 'aws.ts'), `// config\nconst id = "${key}";\n`);
    writeFileSync(path.join(dir, '.env'), 'SECRET=x\n');
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'x', 'k.pem'), '-----BEGIN PRIVATE KEY-----'); // skipped
    const r = await new SecretScanVerifier().verify(ctx(dir));
    expect(r.status).toBe('FAILED');
    const f = r.evidence['findings'] as { file: string; line: number; kind: string }[];
    expect(f).toEqual(
      expect.arrayContaining([
        { file: 'src/aws.ts', line: 2, kind: 'AWS access key id' },
        { file: '.env', line: 0, kind: 'environment file in the repository' },
      ]),
    );
    expect(f).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain(key);
  });
});
