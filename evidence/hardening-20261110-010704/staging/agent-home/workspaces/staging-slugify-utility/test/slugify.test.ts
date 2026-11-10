import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.ts';

test('normal text', () => assert.equal(slugify('Hello World'), 'hello-world'));
test('repeated separators', () => assert.equal(slugify('a  --  b__c'), 'a-b-c'));
test('leading/trailing punctuation', () => assert.equal(slugify('!!Hello, World!!'), 'hello-world'));
test('digits', () => assert.equal(slugify('Top 10 Tips 2024'), 'top-10-tips-2024'));
test('empty string', () => assert.equal(slugify(''), ''));
test('only punctuation', () => assert.equal(slugify('?!.'), ''));
test('throws TypeError for non-string', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.throws(() => slugify(v as unknown as string), TypeError);
  }
});
