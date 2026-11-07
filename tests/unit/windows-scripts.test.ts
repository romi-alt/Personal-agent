import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * STATIC checks only. No PowerShell was available in the build environment, so these scripts have NOT been parsed
 * or executed. The tests guard against regressions in the properties reviewed by hand (see docs/WINDOWS_DEPLOYMENT.md).
 */
const read = (f: string) => readFileSync(path.resolve(__dirname, '../../scripts/windows', f), 'utf8');
const code = (f: string) =>
  read(f)
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

describe('Windows scripts (static review guards)', () => {
  const files = ['install-task.ps1', 'run-supervisor.ps1', 'uninstall-task.ps1', 'verify-install.ps1'];

  it.each(files)('%s avoids PowerShell-7-only syntax so Windows PowerShell 5.1 can run it', (f) => {
    const c = code(f);
    expect(c).not.toMatch(/&&|\|\|/); // pipeline chain operators
    expect(c).not.toMatch(/\?\?/); // null-coalescing
    expect(c).not.toMatch(/\$\w+\s*\?\s*[^\s]+\s*:/); // ternary
  });

  it.each(files)('%s has balanced braces, parentheses and double quotes', (f) => {
    const c = code(f)
      .replace(/`"/g, '')
      .replace(/'[^'\n]*'/g, "''");
    const count = (ch: string) => c.split(ch).length - 1;
    expect(count('{')).toBe(count('}'));
    expect(count('(')).toBe(count(')'));
    expect(count('"') % 2).toBe(0);
  });

  it('wrapper: restart policy distinguishes graceful stop (0), invalid config (2) and duplicate supervisor (3)', () => {
    const c = code('run-supervisor.ps1');
    expect(c).toMatch(/-eq 0\)[^\n]*exit 0/);
    expect(c).toMatch(/-eq 2\)[^\n]*exit 2/);
    // 3: another supervisor is live -> monitor it; exit only when it stops gracefully, take over if it dies
    expect(c).toMatch(/-eq 3\)/);
    expect(c).toMatch(/monitoring it/);
    expect(c).toMatch(/status -eq 'STOPPED'\)[^\n]*exit 0/);
    expect(c).toMatch(/taking over/);
    // PS 5.1: $PSScriptRoot is empty inside param() defaults
    expect(c).not.toMatch(/param\([^)]*\$PSScriptRoot/s);
    expect(c).toMatch(/Start-Process/); // avoids 5.1 native-stderr terminating errors
    expect(c).toMatch(/LOG_TO_CONSOLE/); // no unbounded console capture
    expect(c).toMatch(/Set-Location/); // .env is resolved relative to the working directory
  });

  it('installer: resolves and embeds the node path, checks the Node version, supports -WhatIf, stores no secrets', () => {
    const c = code('install-task.ps1');
    expect(c).toMatch(/SupportsShouldProcess/);
    expect(c).toMatch(/-NodePath/);
    expect(c).toMatch(/22\.12\.0/);
    expect(c).toMatch(/ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
    expect(c).toMatch(/MultipleInstances IgnoreNew/);
    expect(c).not.toMatch(/ANTHROPIC_API_KEY\s*=/);
    expect(c).not.toMatch(/ConvertTo-SecureString|-AsPlainText/);
  });

  it('uninstaller stops the supervisor gracefully through the CLI before unregistering', () => {
    const c = code('uninstall-task.ps1');
    expect(c.indexOf("'stop'")).toBeGreaterThan(-1);
    expect(c.indexOf("'stop'")).toBeLessThan(c.indexOf('Unregister-ScheduledTask'));
  });

  it('no script disables Defender, UAC, the firewall or execution-policy protections machine-wide', () => {
    for (const f of files) {
      const c = code(f);
      expect(c).not.toMatch(
        /Set-MpPreference|DisableRealtimeMonitoring|EnableLUA|netsh advfirewall|Set-ExecutionPolicy/i,
      );
      expect(c).not.toMatch(/ExecutionPolicy\s+(Bypass|Unrestricted)/i);
    }
  });
});
