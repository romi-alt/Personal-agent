import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  identityMatches,
  pidExists,
  processIdentity,
  processImageName,
  stopOrphanWorker,
} from '../../src/workers/process-tree.js';

const waitExit = (p: ReturnType<typeof spawn>) =>
  new Promise<void>((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once('exit', () => r())));
const longChild = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });

describe('process identity (real processes)', () => {
  it('reads image name and OS creation time of a live process', async () => {
    const before = Date.now();
    const child = longChild();
    try {
      const id = await processIdentity(child.pid!);
      expect(id).not.toBeNull();
      expect(id!.pid).toBe(child.pid);
      expect(id!.image).toMatch(/node/i);
      expect(id!.startedAtMs).toBeGreaterThan(before - 3000);
      expect(id!.startedAtMs).toBeLessThan(Date.now() + 3000);
      expect(await processImageName(child.pid!)).toMatch(/node/i);
    } finally {
      child.kill('SIGKILL');
      await waitExit(child);
    }
    expect(await processIdentity(child.pid!)).toBeNull();
  });
});

describe('identity-verified orphan stop (real processes)', () => {
  it('never kills a process whose identity differs from the recorded worker', async () => {
    const child = longChild();
    try {
      const id = (await processIdentity(child.pid!))!;
      // Same pid and image, different creation time: a different process reused the pid.
      expect(
        await stopOrphanWorker({
          pid: child.pid!,
          identity: { ...id, startedAtMs: id.startedAtMs - 60_000 },
        }),
      ).toBe('pid_reused');
      // Same pid, different image (e.g. the owner's interactive claude.exe vs this node worker).
      expect(await stopOrphanWorker({ pid: child.pid!, identity: { ...id, image: 'claude.exe' } })).toBe(
        'pid_reused',
      );
      // Fallback without a recorded identity: image pattern must match ...
      expect(await stopOrphanWorker({ pid: child.pid!, imagePattern: /^claude(\.exe)?$/i })).toBe(
        'pid_reused',
      );
      // ... and the process must have been created during the execution window.
      expect(
        await stopOrphanWorker({
          pid: child.pid!,
          imagePattern: /node/i,
          notBeforeMs: id.startedAtMs - 120_000,
          notAfterMs: id.startedAtMs - 60_000,
        }),
      ).toBe('pid_reused');
      // No identity and no pattern: nothing to verify against, so nothing is killed.
      expect(await stopOrphanWorker({ pid: child.pid! })).toBe('pid_reused');
      expect(pidExists(child.pid!)).toBe(true);

      // Exact identity: the worker (and its tree) is stopped and its exit is confirmed.
      expect(await stopOrphanWorker({ pid: child.pid!, identity: id })).toBe('terminated');
      await waitExit(child);
      expect(pidExists(child.pid!)).toBe(false);
      expect(await stopOrphanWorker({ pid: child.pid!, identity: id })).toBe('not_running');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
  it('accepts the fallback window when the identity was never recorded', async () => {
    const t0 = Date.now();
    const child = longChild();
    try {
      expect(
        await stopOrphanWorker({
          pid: child.pid!,
          imagePattern: /^node(\.exe)?$/i,
          notBeforeMs: t0,
          notAfterMs: Date.now(),
        }),
      ).toBe('terminated');
      await waitExit(child);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
  it('never targets the supervisor itself or its parent', async () => {
    expect(await stopOrphanWorker({ pid: process.pid, imagePattern: /./ })).toBe('pid_reused');
    expect(await stopOrphanWorker({ pid: process.ppid, imagePattern: /./ })).toBe('pid_reused');
    expect(pidExists(process.pid)).toBe(true);
  });
  it('identityMatches tolerates clock precision only', () => {
    const id = { pid: 1, image: 'claude.exe', startedAtMs: 1_000_000 };
    expect(
      identityMatches({ pid: 1, identity: id }, { ...id, image: 'CLAUDE.EXE', startedAtMs: 1_001_500 }),
    ).toBe(true);
    expect(identityMatches({ pid: 1, identity: id }, { ...id, startedAtMs: 1_003_000 })).toBe(false);
  });
});
