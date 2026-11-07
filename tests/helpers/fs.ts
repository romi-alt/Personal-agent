import { rmSync } from 'node:fs';

/** rm -rf that tolerates Windows file locks that linger briefly after a process or DB handle closes. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
