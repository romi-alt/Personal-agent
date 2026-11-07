import { rmSync } from 'node:fs';

/**
 * Remove a test's temporary directory. On Windows a file cannot be deleted while any process holds it open
 * (a just-killed child's SQLite/WAL handles are released asynchronously, and antivirus scanners briefly open
 * new files), so retry; if it is still locked, leave it to the OS temp cleaner rather than failing the test.
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY')) return;
    throw err;
  }
}
