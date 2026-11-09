/**
 * Shell-command normalizer for the tool-permission policy (defect A2: false-positive approvals).
 *
 * The approval rules in policy.ts are regexes over command text. Matched against the RAW text they also fire on
 * *data* - a heredoc body written to a test file, a quoted commit message, a quoted SQL-injection test payload - which
 * produced five false-positive owner approvals in the pilot. This module produces a NORMALIZED view of a Bash command in
 * which data that the shell never executes is removed, while everything the shell does execute is kept:
 *
 *  - heredoc BODIES are dropped; the line that starts the heredoc (`cat > f <<'EOF'`) is kept;
 *  - comments (`# ...` at the start of a word) are dropped;
 *  - a quoted argument whose content contains whitespace becomes the placeholder `__STR__` (one argv element with
 *    spaces is data to the program receiving it; a program that *executes* its argument is handled below);
 *  - quoted text WITHOUT whitespace is de-quoted and kept (`"push"` -> push, `r"m"` -> rm, quoted URLs, quoted
 *    flags), as is any quoted text starting with `-`, any word in command position and any redirection target -
 *    so de-quoting can only ADD matches compared with the raw text, never hide a command word, flag or URL;
 *  - command names, flags, operators (`&&`, `||`, `;`, `|`, `&`, `$(...)`, backticks, subshells) are kept.
 *
 * FAIL CLOSED. `analyzeShellCommand` reports `useRaw: true` - the caller must then match against the raw command,
 * i.e. the pre-A2 strict behaviour - whenever the command cannot be parsed confidently (unbalanced quotes, unterminated
 * heredoc or substitution) or when quoted/heredoc text may itself be EXECUTED:
 *  - a shell or string-evaluating program appears (bash, sh, cmd, powershell, eval, source, ssh, xargs, awk, sed, ...);
 *  - a SQL/database client appears (sqlite3, psql, mysql, ...), or `prisma db execute`;
 *  - a code interpreter (node, python, ruby, perl, php, deno, tsx, ...) gets inline code: -c/-e/-p/--eval/...,
 *    `-` (stdin), a heredoc/here-string, or a pipe into it;
 *  - any inline-code flag (-c, -e, --eval, --command, -Command, -EncodedCommand, /c, /k, -S) appears anywhere;
 *  - a command substitution / variable expansion is used AS the command (`$(...)`, `$X`, `"$X"`);
 *  - a double-quoted string contains `$(...)` or backticks (executed by the shell even inside quotes);
 *  - `$'...'` ANSI-C quoting with escapes, or a `git` alias definition (`!` aliases run shell code).
 *
 * This is a guardrail, not a sandbox (see docs/SECURITY.md): a worker can still write a script with the Write tool
 * and run it; the policy has never been able to see inside such files.
 */

export interface ShellAnalysis {
  /** True when the rules must be matched against the raw command (strict). */
  useRaw: boolean;
  /** Normalized text; equals the raw command when parsing failed. */
  normalized: string;
  /** Why the raw view is required (empty when the normalized view may be used). */
  reasons: string[];
  /**
   * Exact [start, end) source ranges of heredoc BODIES (including the delimiter line) found by the lexer, which knows
   * quoting, comments and here-strings. Empty when parsing failed. V2.1 trusted-execution fix for finding 9: the
   * earlier line-based stripper treated `<<EOF` inside quotes or comments as a heredoc and hid later command lines.
   */
  heredocBodyRanges: [number, number][];
}

/** The command with exactly the lexer-identified heredoc bodies removed; null when the command could not be parsed. */
export function withoutHeredocBodies(command: string): string | null {
  const a = analyzeShellCommand(command);
  if (a.reasons.some((r) => r.startsWith('unparseable')) || a.reasons.includes('arithmetic expression (( ))'))
    return null;
  let out = '';
  let at = 0;
  for (const [s, e] of a.heredocBodyRanges) {
    out += command.slice(at, s);
    at = e;
  }
  return out + command.slice(at);
}

export const STRING_PLACEHOLDER = '__STR__';

class ParseError extends Error {}

interface Part {
  text: string;
  quoted: boolean;
}

interface Word {
  value: string;
  norm: string;
  quoted: boolean;
}

interface Segment {
  words: Word[];
  /** Receives a pipe (`a | b` -> b). */
  pipeTarget: boolean;
  /** Has a heredoc or here-string attached (stdin is literal text). */
  stdinLiteral: boolean;
}

/** Programs that execute (part of) their arguments or stdin as shell/script code, or that expand strings into commands. */
const EXECUTING_PROGRAMS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'ash',
  'fish',
  'csh',
  'tcsh',
  'busybox',
  'cmd',
  'powershell',
  'pwsh',
  'wsl',
  'eval',
  'source',
  'su',
  'runuser',
  'ssh',
  'xargs',
  'parallel',
  'watch',
  'at',
  'batch',
  'crontab',
  'trap',
  'alias',
  'tmux',
  'screen',
  'script',
  'expect',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'sed',
  'perl',
  'raku',
  'osascript',
  'invoke-expression',
  'iex',
  'start-process',
  'invoke-command',
]);

/** SQL / database clients: a quoted argument or stdin text is a statement executed against a database. */
const SQL_CLIENTS = new Set([
  'sqlite3',
  'sqlite',
  'psql',
  'mysql',
  'mariadb',
  'sqlcmd',
  'osql',
  'isql',
  'mongosh',
  'mongo',
  'redis-cli',
  'duckdb',
  'clickhouse',
  'clickhouse-client',
  'cqlsh',
  'snowsql',
  'bq',
  'cockroach',
  'turso',
  'wrangler',
  'supabase',
  'pg_restore',
]);

/** Code interpreters: raw view only when they receive inline code (see INTERPRETER_INLINE_FLAG). */
const CODE_INTERPRETERS =
  /^(node|nodejs|deno|bun|tsx|ts-node|python[0-9.]*|py|pypy[0-9.]*|ruby|irb|php|lua|luajit|rscript|r|julia|groovy|jshell|dotnet)$/;
/** For interpreters: long inline-code flags, or a short-flag cluster containing c/e/E/p/r (-c, -e, -pe, -Bc ...). */
const INTERPRETER_INLINE_FLAG =
  /^(--(eval|print|command|exec|code|input-type)(=.*)?|-[a-zA-Z]*[ceEpr][a-zA-Z]*)$/;
/** Inline-code flags for ANY program (harmless over-approximation: they only select the strict raw view). */
const GENERIC_INLINE_FLAG =
  /^(-c|-e|-S|--eval|--command|--exec|-[Cc]ommand|-[Ee]ncoded[Cc]ommand|-enc|-ec|\/[cCkK])$/;

/** Words after which the next word is still in command position. */
const COMMAND_PREFIXES = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'nice',
  'ionice',
  'time',
  'command',
  'builtin',
  'exec',
  'npx',
  'bunx',
  'stdbuf',
  'timeout',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
  '}',
]);

/**
 * v2 review fix (strict by default): quoted multi-word text is treated as DATA only for programs that never execute
 * their arguments; for every other program it stays visible to the rules (a quoted argument of `git rebase -x`,
 * `tar --checkpoint-action`, `concurrently`, `env -i X='...'` etc. may be executed). Heredoc bodies are likewise only
 * dropped when they feed one of these programs.
 */
const DATA_PROGRAMS = new Set(['echo', 'printf', 'cat', 'tee', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'git']);
/** For git, only these subcommands take free text (messages, patterns) and never execute it. */
const GIT_DATA_SUBCOMMANDS = new Set([
  'commit',
  'tag',
  'log',
  'show',
  'notes',
  'stash',
  'grep',
  'status',
  'diff',
]);

/** The program of a segment (first word that is not an assignment or a command prefix) and the word after it. */
function segmentProgram(words: { value: string }[]): { prog: string | null; sub: string | null } {
  let k = 0;
  while (k < words.length) {
    const v = words[k]!.value;
    if (ASSIGNMENT.test(v) || COMMAND_PREFIXES.has(programName(v))) k++;
    else break;
  }
  const prog = k < words.length ? programName(words[k]!.value) : null;
  let s = k + 1;
  while (s < words.length && words[s]!.value.startsWith('-')) s++; // git -C dir, -c is caught elsewhere
  return { prog, sub: s < words.length ? words[s]!.value.toLowerCase() : null };
}
function isDataProgram(words: { value: string }[]): boolean {
  const { prog, sub } = segmentProgram(words);
  if (!prog || !DATA_PROGRAMS.has(prog)) return false;
  return prog !== 'git' || (sub !== null && GIT_DATA_SUBCOMMANDS.has(sub));
}

const programName = (value: string): string => {
  const base = value.split(/[\\/]/).pop() ?? value;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Lexes a Bash command into segments of words and builds the normalized text. Throws ParseError when unsure. */
function lex(
  src: string,
  reasons: string[],
): { normalized: string; segments: Segment[]; heredocBodyRanges: [number, number][] } {
  const out: string[] = [];
  const heredocBodyRanges: [number, number][] = [];
  const segments: Segment[] = [];
  let seg: Segment = { words: [], pipeTarget: false, stdinLiteral: false };
  const stack: string[] = []; // open '(' / '$(' / '<(' / '`'
  const pendingHeredocs: { delim: string; stripTabs: boolean; quoted: boolean; data: boolean }[] = [];
  let cmdPos = true;
  let redirectNext = false;
  let i = 0;
  const n = src.length;

  const endSegment = (pipe: boolean) => {
    segments.push(seg);
    seg = { words: [], pipeTarget: pipe, stdinLiteral: false };
    cmdPos = true;
  };

  const readHeredocBodies = () => {
    // `i` is just past a newline. Consume each pending body up to and including its delimiter line.
    while (pendingHeredocs.length) {
      const { delim, stripTabs, quoted, data } = pendingHeredocs.shift()!;
      const body: string[] = [];
      const bodyStart = i;
      for (;;) {
        if (i >= n) throw new ParseError(`unterminated heredoc (${delim})`);
        let end = src.indexOf('\n', i);
        if (end === -1) end = n;
        let line = src.slice(i, end).replace(/\r$/, '');
        if (stripTabs) line = line.replace(/^\t+/, '');
        i = end + 1;
        if (line === delim) break;
        body.push(line);
      }
      heredocBodyRanges.push([bodyStart, Math.min(i, n)]);
      // v2 review fix: Bash runs $(...) and backticks inside an UNQUOTED heredoc body before the program sees it.
      if (!quoted && /\$\(|`/.test(body.join('\n')))
        reasons.push('unquoted heredoc body contains command substitution (executed by the shell)');
      // A heredoc feeding anything but a data program (make -f -, docker exec ... sh, kubectl exec, ...) may be code.
      if (!data) reasons.push('heredoc feeds a program that may execute it');
    }
  };

  /** Reads one word starting at `i`; returns its parts. Stops at whitespace / operators outside quotes. */
  const readWord = (): { parts: Part[]; dynamic: boolean } => {
    const parts: Part[] = [];
    let dynamic = false; // contains $var / ${...} / $(...) / backticks (value unknown statically)
    let buf = '';
    const flush = () => {
      if (buf) parts.push({ text: buf, quoted: false });
      buf = '';
    };
    while (i < n) {
      const c = src[i]!;
      if (/\s/.test(c) || ';&|<>()'.includes(c)) {
        // `$(` and `<(` are handled by the caller; a bare `(` ends the word.
        break;
      }
      if (c === '\\') {
        if (i + 1 >= n) throw new ParseError('trailing backslash');
        const d = src[i + 1]!;
        i += 2;
        if (d === '\n') continue; // line continuation
        if (d === '\r' && src[i] === '\n') {
          i++;
          continue;
        }
        buf += d;
        continue;
      }
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end === -1) throw new ParseError('unbalanced single quote');
        flush();
        parts.push({ text: src.slice(i + 1, end), quoted: true });
        i = end + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === "'") {
        let j = i + 2;
        let text = '';
        while (j < n && src[j] !== "'") {
          if (src[j] === '\\') {
            reasons.push("ANSI-C $'...' quoting with escapes");
            text += src.slice(j, j + 2);
            j += 2;
            continue;
          }
          text += src[j];
          j++;
        }
        if (j >= n) throw new ParseError("unbalanced $' quote");
        flush();
        parts.push({ text, quoted: true });
        i = j + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        let text = '';
        while (j < n && src[j] !== '"') {
          const ch = src[j]!;
          if (ch === '\\' && j + 1 < n) {
            const d = src[j + 1]!;
            if ('"\\$`'.includes(d)) text += d;
            else if (d !== '\n') text += ch + d;
            j += 2;
            continue;
          }
          if (ch === '`' || (ch === '$' && src[j + 1] === '(')) {
            reasons.push('command substitution inside a double-quoted string');
          }
          if (ch === '$') dynamic = true;
          text += ch;
          j++;
        }
        if (j >= n) throw new ParseError('unbalanced double quote');
        flush();
        parts.push({ text, quoted: true });
        i = j + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === '(') break; // command substitution: handled by caller
      if (c === '`') break; // backtick substitution: handled by caller
      if (c === '$' && src[i + 1] === '{') {
        const end = src.indexOf('}', i + 2);
        if (end === -1) throw new ParseError('unterminated ${');
        buf += src.slice(i, end + 1);
        dynamic = true;
        i = end + 1;
        continue;
      }
      if (c === '$') dynamic = true;
      buf += c;
      i++;
    }
    flush();
    return { parts, dynamic };
  };

  const pushWord = (parts: Part[], dynamic: boolean, glued: boolean) => {
    const value = parts.map((p) => p.text).join('');
    const quoted = parts.some((p) => p.quoted);
    const keepAll = cmdPos || redirectNext || !isDataProgram(seg.words);
    const norm = keepAll
      ? value
      : parts
          .map((p) =>
            p.quoted && /\s/.test(p.text) && !p.text.trimStart().startsWith('-')
              ? STRING_PLACEHOLDER
              : p.text,
          )
          .join('');
    out.push((glued ? '' : ' ') + norm);
    if (redirectNext) {
      redirectNext = false;
      return;
    }
    if (cmdPos && (dynamic || glued)) reasons.push('command name is computed (variable or substitution)');
    seg.words.push({ value, norm, quoted });
    if (cmdPos) {
      const first = parts[0];
      if (first && !first.quoted && ASSIGNMENT.test(first.text)) return; // VAR=value keeps command position
      const prog = programName(value);
      if (prog === '.') reasons.push('`.` (source) executes a file/stream as shell code');
      // Flags of a prefix (`sudo -u x cmd`) end command position here; that only affects de-quoting of `cmd`, and
      // executing programs are detected in every word position anyway.
      if (!COMMAND_PREFIXES.has(prog)) cmdPos = false;
    }
  };

  let prevWasWordEnd = false; // last token was a word that ended without whitespace (for `a$(b)` glueing)
  while (i < n) {
    const c = src[i]!;
    if (c === '\n') {
      out.push('\n');
      i++;
      endSegment(false);
      prevWasWordEnd = false;
      readHeredocBodies();
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      prevWasWordEnd = false;
      continue;
    }
    if (c === '#' && !prevWasWordEnd) {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    // Operators
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (two === '&&' || two === '||' || two === '|&' || c === ';' || c === '&' || c === '|') {
      if (two === '&>') {
        // &> / &>> redirection
        const op = three === '&>>' ? '&>>' : '&>';
        out.push(' ' + op);
        i += op.length;
        redirectNext = true;
        prevWasWordEnd = false;
        continue;
      }
      const op = two === '&&' || two === '||' || two === '|&' ? two : c;
      if (op === ';' && src[i + 1] === ';') {
        out.push(' ;;');
        i += 2;
      } else {
        out.push(' ' + op);
        i += op.length;
      }
      endSegment(op === '|' || op === '|&');
      prevWasWordEnd = false;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      if (cmdPos && !prevWasWordEnd) reasons.push('command substitution used as the command');
      if (cmdPos && prevWasWordEnd) reasons.push('command name is computed (variable or substitution)');
      out.push((prevWasWordEnd ? '' : ' ') + '$(');
      stack.push('$(');
      i += 2;
      cmdPos = true;
      prevWasWordEnd = false;
      continue;
    }
    if (c === '`') {
      if (stack[stack.length - 1] === '`') {
        stack.pop();
        out.push('`');
        i++;
        cmdPos = false;
        prevWasWordEnd = true;
        continue;
      }
      if (cmdPos) reasons.push('command substitution used as the command');
      out.push((prevWasWordEnd ? '' : ' ') + '`');
      stack.push('`');
      i++;
      cmdPos = true;
      prevWasWordEnd = false;
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      out.push(' ' + c + '(');
      stack.push('<(');
      i += 2;
      cmdPos = true;
      prevWasWordEnd = false;
      continue;
    }
    if (c === '(') {
      out.push(' (');
      stack.push('(');
      i++;
      cmdPos = true;
      prevWasWordEnd = false;
      continue;
    }
    if (c === ')') {
      const top = stack.pop();
      if (!top || top === '`') throw new ParseError('unbalanced )');
      out.push(' )');
      i++;
      if (top === '(') endSegment(false);
      cmdPos = false;
      prevWasWordEnd = top !== '(';
      continue;
    }
    if (c === '<' || c === '>') {
      if (three === '<<<') {
        out.push(' <<<');
        i += 3;
        seg.stdinLiteral = true;
        prevWasWordEnd = false;
        continue; // the next word is a here-string argument (normal quoting rules)
      }
      if (two === '<<') {
        let j = i + 2;
        let stripTabs = false;
        if (src[j] === '-') {
          stripTabs = true;
          j++;
        }
        while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        i = j;
        const { parts } = readWord();
        const delim = parts.map((p) => p.text).join('');
        if (!delim) throw new ParseError('heredoc without delimiter');
        out.push(` <<${stripTabs ? '-' : ''}${src.slice(j, i)}`); // keep the heredoc start, drop the body
        pendingHeredocs.push({
          delim,
          stripTabs,
          quoted: parts.some((p) => p.quoted) || /\\/.test(src.slice(j, i)),
          data: isDataProgram(seg.words),
        });
        seg.stdinLiteral = true;
        prevWasWordEnd = false;
        continue;
      }
      // other redirections: > >> < <> >& <& >| ; the following word is the target
      let op = c;
      let j = i + 1;
      if (src[j] === '>' || src[j] === '&' || src[j] === '|' || (c === '<' && src[j] === '>')) op += src[j++];
      out.push(' ' + op);
      i = j;
      // `>&2`, `<&-`: fd target
      if (op.endsWith('&') && /[0-9-]/.test(src[i] ?? '')) {
        let k = i;
        while (k < n && /[0-9-]/.test(src[k]!)) k++;
        out.push(src.slice(i, k));
        i = k;
      } else {
        redirectNext = true;
      }
      prevWasWordEnd = false;
      continue;
    }
    // A word
    const start = i;
    const { parts, dynamic } = readWord();
    if (i === start) throw new ParseError(`unexpected character ${c}`);
    // fd number glued to a redirection (`2>/dev/null`): not a word
    if (
      parts.length === 1 &&
      !parts[0]!.quoted &&
      /^[0-9]+$/.test(parts[0]!.text) &&
      /[<>]/.test(src[i] ?? '')
    ) {
      out.push(' ' + parts[0]!.text);
      prevWasWordEnd = true;
      continue;
    }
    const wasCmdPos = cmdPos && !redirectNext;
    pushWord(parts, dynamic, prevWasWordEnd);
    // readWord only stops early (glued) at `$(` or a backtick.
    prevWasWordEnd = src[i] === '$' || src[i] === '`';
    if (prevWasWordEnd && wasCmdPos) reasons.push('command name is computed (variable or substitution)');
  }
  if (stack.length) throw new ParseError(`unterminated ${stack[stack.length - 1]}`);
  if (pendingHeredocs.length) throw new ParseError('unterminated heredoc');
  if (redirectNext) throw new ParseError('redirection without target');
  segments.push(seg);
  return { normalized: out.join('').trim(), segments, heredocBodyRanges };
}

function executedTextReasons(segments: Segment[]): string[] {
  const reasons: string[] = [];
  for (const seg of segments) {
    const progs = seg.words.map((w) => programName(w.value));
    const values = seg.words.map((w) => w.value);
    for (const p of progs) {
      if (EXECUTING_PROGRAMS.has(p)) reasons.push(`${p} executes its arguments or input as code`);
      if (SQL_CLIENTS.has(p)) reasons.push(`${p} executes SQL/database statements`);
    }
    if (progs.includes('prisma') && progs.includes('execute')) reasons.push('prisma db execute runs SQL');
    if (progs.includes('git') && values.some((v) => /alias\./i.test(v))) reasons.push('git alias definition');
    for (const v of values) if (GENERIC_INLINE_FLAG.test(v)) reasons.push(`inline-code flag ${v}`);
    if (progs.some((p) => CODE_INTERPRETERS.test(p))) {
      if (seg.pipeTarget) reasons.push('interpreter reads code from a pipe');
      if (seg.stdinLiteral) reasons.push('interpreter reads code from a heredoc/here-string');
      if (values.some((v) => v === '-' || INTERPRETER_INLINE_FLAG.test(v)))
        reasons.push('interpreter receives inline code');
    }
  }
  return reasons;
}

/**
 * Analyses a Bash command. `useRaw` is true when the approval rules must see the raw text (see module comment).
 * Never throws.
 */
export function analyzeShellCommand(command: string): ShellAnalysis {
  const reasons: string[] = [];
  // v2 review fix: the lexer has no arithmetic context, so `<<` inside $((...)) / ((...)) would start a fake heredoc
  // and hide the following lines. Any arithmetic expression selects the strict raw view.
  if (/\$\(\(|(^|[\s;&|(!])\(\(/.test(command))
    return {
      useRaw: true,
      normalized: command,
      reasons: ['arithmetic expression (( ))'],
      heredocBodyRanges: [],
    };
  try {
    const { normalized, segments, heredocBodyRanges } = lex(command, reasons);
    reasons.push(...executedTextReasons(segments));
    // v2 review fix: writing a file through a heredoc and running a script in the same command (`cat > x.sh <<EOF
    // ... EOF; chmod +x x.sh && ./x.sh`) executes the hidden body.
    const hasHeredoc = segments.some((s) => s.stdinLiteral);
    const runsScript = segments.some((s) => {
      const { prog } = segmentProgram(s.words);
      const first = s.words.find((w) => !ASSIGNMENT.test(w.value))?.value ?? '';
      return prog === 'chmod' || prog === 'make' || /^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(first);
    });
    if (hasHeredoc && runsScript) reasons.push('a heredoc-written file may be executed in the same command');
    return {
      useRaw: reasons.length > 0,
      normalized,
      reasons: [...new Set(reasons)],
      heredocBodyRanges,
    };
  } catch (err) {
    if (err instanceof ParseError)
      return {
        useRaw: true,
        normalized: command,
        reasons: [`unparseable: ${err.message}`],
        heredocBodyRanges: [],
      };
    return { useRaw: true, normalized: command, reasons: ['unparseable'], heredocBodyRanges: [] };
  }
}
