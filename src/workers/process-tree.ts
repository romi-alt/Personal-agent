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
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already exited */
  }
}

/**
 * An orphaned provider worker (its supervisor died) is stopped before a replacement execution starts, so two sessions
 * never work in the same workspace. The image-name check guards against pid reuse by an unrelated process.
 */
export async function stopOrphanWorker(
  pid: number,
  expectedImage: RegExp = /claude/i,
): Promise<'not_running' | 'terminated' | 'pid_reused'> {
  if (pid === process.pid || !pidExists(pid)) return 'not_running';
  const name = await processImageName(pid);
  if (!name) return 'not_running';
  if (!expectedImage.test(name)) return 'pid_reused';
  await killTree(pid);
  return 'terminated';
}
