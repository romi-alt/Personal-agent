# Implement slugify utility with tests

Implement a small zero-dependency TypeScript utility in this repository (it may be empty).

1. package.json with {"name":"staging-slugify","private":true,"type":"module","scripts":{"test":"node --test"}}.
2. src/slugify.ts exporting `slugify(text: string): string`: lower-case; replace every run of characters that are not
   a-z or 0-9 with a single hyphen; trim leading and trailing hyphens. Throw a TypeError when the argument is not a string.
3. test/slugify.test.ts using node:test and node:assert/strict (import from '../src/slugify.ts'): normal text, repeated
   separators, leading/trailing punctuation, digits, empty string, and the TypeError case.
4. Run `node --test` and `node --check src/slugify.ts` and make sure both pass. Node 26 runs .ts files natively; do not
   install anything and do not use the network.
5. Commit your work with git on the current branch (git add, git commit). Do not push; there is no remote.

## Acceptance criteria
slugify implemented per FR-1/FR-2; tests cover normal text, repeated separators, trimming, digits, empty string and TypeError; node --test passes; work committed
