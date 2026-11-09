import { readFileSync } from 'node:fs';

/**
 * Normalise text that came from an owner-supplied file: strip a UTF-8 byte-order mark (Windows editors and
 * PowerShell `Out-File` add one, and `JSON.parse` rejects it) and convert CRLF / lone CR line endings to LF
 * (git `core.autocrlf=true` checks files out with CRLF on Windows; in JS regexes `.` does not match `\r`).
 */
export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Read an owner-supplied UTF-8 text file with {@link normalizeText} applied. */
export function readTextFile(file: string): string {
  return normalizeText(readFileSync(file, 'utf8'));
}
