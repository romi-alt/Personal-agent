/**
 * Pull one JSON object out of a model reply. Tolerates a ```json fence or stray prose, but never guesses:
 * if no balanced top-level object parses, the result is an error that is fed back to the model for repair.
 */
export type ExtractResult = { ok: true; value: unknown } | { ok: false; error: string };

export function extractJson(text: string): ExtractResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'empty reply' };
  const candidates: string[] = [];
  candidates.push(trimmed);
  for (const m of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(m[1]!.trim());
  const balanced = firstBalancedObject(trimmed);
  if (balanced) candidates.push(balanced);
  let lastError = 'no JSON object found in the reply';
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v };
      lastError = 'the JSON value is not an object';
    } catch (e) {
      lastError = `invalid JSON: ${(e as Error).message}`;
    }
  }
  return { ok: false, error: lastError };
}

/** First balanced {...} that respects string literals and escapes. */
export function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
