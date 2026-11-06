import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { redactValue } from '../security/redact.js';
import type { Severity } from '../types/index.js';

const LEVELS: Record<Severity, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSinkOptions {
  dir: string;
  prefix: string;
  maxFileBytes: number;
  retentionDays: number;
}

/** Append-only daily JSONL file with size-based rotation and age-based retention. */
export class FileSink {
  private currentPath: string | null = null;

  constructor(private readonly opts: LogSinkOptions) {
    mkdirSync(opts.dir, { recursive: true });
    this.prune();
  }

  private day(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private resolvePath(): string {
    const base = path.join(this.opts.dir, `${this.opts.prefix}-${this.day()}`);
    let idx = 0;
    for (;;) {
      const candidate = idx === 0 ? `${base}.log` : `${base}.${idx}.log`;
      if (!existsSync(candidate) || statSync(candidate).size < this.opts.maxFileBytes) return candidate;
      idx++;
    }
  }

  write(line: string): void {
    if (
      !this.currentPath ||
      !this.currentPath.includes(this.day()) ||
      this.size() >= this.opts.maxFileBytes
    ) {
      this.currentPath = this.resolvePath();
    }
    appendFileSync(this.currentPath, line + '\n');
  }

  private size(): number {
    try {
      return this.currentPath ? statSync(this.currentPath).size : 0;
    } catch {
      return 0;
    }
  }

  prune(now = Date.now()): number {
    let removed = 0;
    const cutoff = now - this.opts.retentionDays * 86_400_000;
    for (const f of readdirSync(this.opts.dir)) {
      if (!f.startsWith(this.opts.prefix + '-') || !f.endsWith('.log')) continue;
      const full = path.join(this.opts.dir, f);
      try {
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full);
          removed++;
        }
      } catch {
        /* ignore races */
      }
    }
    return removed;
  }
}

export interface LoggerOptions {
  level: Severity;
  sink?: FileSink;
  console?: boolean;
  /** Test hook: capture lines instead of writing. */
  capture?: (line: string) => void;
}

export class Logger {
  constructor(
    private readonly opts: LoggerOptions,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.opts, { ...this.bindings, ...bindings });
  }

  private emit(level: Severity, event: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.opts.level]) return;
    const record = redactValue({
      ts: new Date().toISOString(),
      level,
      event,
      ...this.bindings,
      ...fields,
    });
    const line = JSON.stringify(record);
    this.opts.sink?.write(line);
    this.opts.capture?.(line);
    if (this.opts.console) process.stderr.write(line + '\n');
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.emit('debug', event, fields);
  }
  info(event: string, fields?: Record<string, unknown>): void {
    this.emit('info', event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>): void {
    this.emit('warn', event, fields);
  }
  error(event: string, fields?: Record<string, unknown>): void {
    this.emit('error', event, fields);
  }
}

export function createLogger(cfg: {
  logDir: string;
  logLevel: Severity;
  logMaxFileBytes: number;
  logRetentionDays: number;
  logToConsole: boolean;
}): Logger {
  const sink = new FileSink({
    dir: path.join(cfg.logDir, 'app'),
    prefix: 'agent',
    maxFileBytes: cfg.logMaxFileBytes,
    retentionDays: cfg.logRetentionDays,
  });
  return new Logger({ level: cfg.logLevel, sink, console: cfg.logToConsole });
}

export function silentLogger(capture?: (line: string) => void): Logger {
  return new Logger({ level: 'debug', capture });
}

/** Per-execution JSONL transcript (separate from application logs). Returns the log reference path. */
export class ExecutionLog {
  readonly ref: string;
  constructor(
    logDir: string,
    executionId: string,
    private readonly maxBytes: number,
  ) {
    const dir = path.join(logDir, 'executions');
    mkdirSync(dir, { recursive: true });
    this.ref = path.join(dir, `${executionId}.jsonl`);
  }
  private written = 0;
  append(record: Record<string, unknown>): void {
    const line = JSON.stringify(redactValue({ ts: new Date().toISOString(), ...record }));
    if (this.written + line.length > this.maxBytes) return; // bound growth per execution
    this.written += line.length + 1;
    appendFileSync(this.ref, line + '\n');
  }
}

/** Remove execution transcripts older than the retention window. */
export function pruneExecutionLogs(logDir: string, retentionDays: number, now = Date.now()): number {
  const dir = path.join(logDir, 'executions');
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const full = path.join(dir, f);
    try {
      if (statSync(full).mtimeMs < now - retentionDays * 86_400_000) {
        unlinkSync(full);
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
