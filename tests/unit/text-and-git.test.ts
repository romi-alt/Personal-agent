import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeText } from '../../src/core/text.js';
import { gitState, initRepo, shortStatusLine } from '../../src/workspaces/git.js';
import { removeTempDir } from '../helpers/fs.js';

describe('normalizeText (owner files saved on Windows)', () => {
  it('strips a UTF-8 BOM and converts CRLF / CR to LF', () => {
    expect(normalizeText('﻿{"a":1}\r\n')).toBe('{"a":1}\n');
    expect(normalizeText('# Title\r\n\r\nBody\rmore')).toBe('# Title\n\nBody\nmore');
    expect(JSON.parse(normalizeText('﻿{"title":"x"}'))).toEqual({ title: 'x' });
  });
  it('lets the task:add markdown title regex match a CRLF file', () => {
    const m = normalizeText('# Add attendance tracking\r\n\r\nImplement it.\r\n').match(/^#\s+(.+)\n([\s\S]*)$/);
    expect(m?.[1]).toBe('Add attendance tracking');
  });
});

describe('shortStatusLine (git status --porcelain=v2)', () => {
  it('renders ordinary, renamed, unmerged and untracked entries', () => {
    expect(shortStatusLine('1 .M N... 100644 100644 100644 abc abc src/a file.ts')).toBe(' M src/a file.ts');
    expect(shortStatusLine('1 A. N... 000000 100644 100644 000 abc new.ts')).toBe('A  new.ts');
    expect(shortStatusLine('2 R. N... 100644 100644 100644 abc abc R100 to.ts\tfrom.ts')).toBe('R  from.ts -> to.ts');
    expect(shortStatusLine('u UU N... 100644 100644 100644 100644 a b c conflict.ts')).toBe('UU conflict.ts');
    expect(shortStatusLine('? untracked dir/x.txt')).toBe('?? untracked dir/x.txt');
    expect(shortStatusLine('# branch.oid abc')).toBeNull();
  });
});

describe('gitState (single git call)', () => {
  let dir = '';
  afterEach(() => dir && removeTempDir(dir));
  it('reports head, branch and changes for a real repository; non-repos are not repos', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gitstate-'));
    expect((await gitState(dir)).isRepo).toBe(false);
    await initRepo(dir);
    const clean = await gitState(dir);
    expect(clean).toMatchObject({ isRepo: true, dirty: false, changes: [] });
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.branch).toBeTruthy();
    writeFileSync(path.join(dir, 'new file.txt'), 'x');
    const dirty = await gitState(dir);
    expect(dirty.dirty).toBe(true);
    expect(dirty.changes).toEqual(['?? new file.txt']);
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: dir });
    expect((await gitState(dir)).branch).toBe('HEAD');
  });
});
