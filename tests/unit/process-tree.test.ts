import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { pidExists, processImageName, stopOrphanWorker } from '../../src/workers/process-tree.js';

const waitExit = (p: ReturnType<typeof spawn>) =>
  new Promise<void>((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once('exit', () => r())));

describe('orphan worker handling (real processes)', () => {
  it('identifies a live process by image name and never kills a process that is not a provider worker', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      expect(pidExists(child.pid!)).toBe(true);
      expect(await processImageName(child.pid!)).toMatch(/node/i);
      // pid "reused" by an unrelated program (node here): left alone
      expect(await stopOrphanWorker(child.pid!, /claude/i)).toBe('pid_reused');
      expect(pidExists(child.pid!)).toBe(true);
      // when the image matches, the whole tree is stopped
      expect(await stopOrphanWorker(child.pid!, /node/i)).toBe('terminated');
      await waitExit(child);
      expect(pidExists(child.pid!)).toBe(false);
      expect(await stopOrphanWorker(child.pid!, /node/i)).toBe('not_running');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
  it('never targets the supervisor itself', async () => {
    expect(await stopOrphanWorker(process.pid, /./)).toBe('not_running');
  });
});
