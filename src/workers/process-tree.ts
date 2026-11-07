import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** True if a process with this pid currently exists (signal 0 probes without delivering anything). */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * OS identity of a process: executable name plus its OS creation time. A pid alone is not an identity (pids are
 * reused); pid + creation time is. Recorded when a provider worker is spawned and compared before it is ever stopped.
 */
export interface ProcessIdentity {
  pid: number;
  image: string;
  /** OS process creation time (Unix ms). Precision: Windows ~1 ms, Linux 10 ms, macOS 1 s. */
  startedAtMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Identity of a running process, or null if it does not exist or cannot be read. */
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      // pid is a validated integer; nothing user-controlled reaches the command text.
      const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { '{0}|{1}' -f $p.Name, ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`;
      const { stdout } = await execFileP(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 30_000 },
      );
      const m = /^(.+)\|(\d+)\s*$/m.exec(stdout.trim());
      return m ? { pid, image: m[1]!.trim(), startedAtMs: Number(m[2]) } : null;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 2 (comm) may contain spaces/parens; the remaining fields start after the LAST ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const startTicks = Number(rest[19]); // field 22 (starttime), clock ticks since boot
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
      const image = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (!Number.isFinite(startTicks) || !Number.isFinite(btime) || !image) return null;
      return { pid, image, startedAtMs: btime * 1000 + Math.round((startTicks * 1000) / 100) };
    }
    const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'lstart=,comm='], { timeout: 15_000 });
    const m = /^\s*(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(stdout.trim());
    if (!m) return null;
    const startedAtMs = Date.parse(m[1]!);
    return Number.isFinite(startedAtMs) ? { pid, image: m[2]!.split('/').pop()!, startedAtMs } : null;
  } catch {
    return null;
  }
}

/** Executable name of a running process, or null if it does not exist / cannot be read. */
export async function processImageName(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        timeout: 15_000,
      });
      const m = /^"([^"]+)","(\d+)"/m.exec(stdout.trim());
      return m && Number(m[2]) === pid ? m[1]! : null;
    }
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null;
    const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 15_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Kill a process and its descendants. Windows has no process groups, so `taskkill /T` walks the tree. */
export async function killTree(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await execFileP('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
    } else {
      try {
        process.kill(-pid, 'SIGKILL'); // whole process group when the worker leads one
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* already exited */
  }
}

/** What the recovery code knows about the worker it wants to stop. */
export interface OrphanExpectation {
  pid: number;
  /** Identity recorded at spawn time (preferred: exact match on image + creation time). */
  identity?: ProcessIdentity | null;
  /** Fallback when the identity was never recorded (the supervisor died within ~1 s of spawning). */
  imagePattern?: RegExp;
  /** Fallback window: the worker must have been created within the execution's lifetime. */
  notBeforeMs?: number;
  notAfterMs?: number;
}

export type OrphanStopResult =
  | 'not_running'
  | 'terminated'
  /** A different process now owns the pid: never touched. */
  | 'pid_reused'
  /** The process exists but its identity cannot be read: never touched (fail safe). */
  | 'unverifiable'
  /** Identity matched and a kill was sent, but the process is still alive: the caller must NOT start a replacement. */
  | 'still_running';

const CLOCK_SLACK_MS = 2_000;

/** Pure identity decision (exported for tests). */
export function identityMatches(expect: OrphanExpectation, live: ProcessIdentity): boolean {
  if (expect.identity) {
    return (
      expect.identity.image.toLowerCase() === live.image.toLowerCase() &&
      Math.abs(expect.identity.startedAtMs - live.startedAtMs) <= CLOCK_SLACK_MS
    );
  }
  if (!expect.imagePattern || !expect.imagePattern.test(live.image)) return false;
  if (expect.notBeforeMs !== undefined && live.startedAtMs < expect.notBeforeMs - CLOCK_SLACK_MS)
    return false;
  if (expect.notAfterMs !== undefined && live.startedAtMs > expect.notAfterMs + CLOCK_SLACK_MS) return false;
  return true;
}

/**
 * An orphaned provider worker (its supervisor died) is stopped before a replacement execution starts, so two sessions
 * never work in the same workspace. Only a process whose OS identity matches the recorded worker is ever stopped: an
 * unrelated process that reused the pid (including the owner's own interactive Claude Code) is left alone.
 */
export async function stopOrphanWorker(
  expect: OrphanExpectation,
  opts: { confirmTimeoutMs?: number } = {},
): Promise<OrphanStopResult> {
  const { pid } = expect;
  if (pid === process.pid || pid === process.ppid) return 'pid_reused';
  if (!pidExists(pid)) return 'not_running';
  const live = await processIdentity(pid);
  if (!live) return pidExists(pid) ? 'unverifiable' : 'not_running';
  if (!identityMatches(expect, live)) return 'pid_reused';
  await killTree(pid);
  const deadline = Date.now() + (opts.confirmTimeoutMs ?? 10_000);
  while (pidExists(pid)) {
    if (Date.now() > deadline) {
      // The pid may have been reused in the meantime; only report still_running if it is the same process.
      const again = await processIdentity(pid);
      return again && identityMatches(expect, again) ? 'still_running' : 'terminated';
    }
    await sleep(100);
  }
  return 'terminated';
}
