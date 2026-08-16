import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fingerprintModuleGraph, launcherHasChanged, launcherRestartHint } from '../../src/utils/stale-launcher.js';

const dirs: string[] = [];

/** A throwaway checkout: { 'a.js': "import './b.js'", 'b.js': '...' }. */
function graph(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-sl-'));
  dirs.push(dir);
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), source);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('fingerprintModuleGraph', () => {
  it('changes when an imported file changes', () => {
    const dir = graph({
      'entry.js': "import { x } from './dep.js';\nexport const y = x;",
      'dep.js': 'export const x = 1;',
    });
    const before = fingerprintModuleGraph(path.join(dir, 'entry.js'));
    fs.writeFileSync(path.join(dir, 'dep.js'), 'export const x = 2;');
    expect(fingerprintModuleGraph(path.join(dir, 'entry.js'))).not.toBe(before);
  });

  it('is unchanged when a rebuild rewrites the same bytes', () => {
    const source = { 'entry.js': "import './dep.js';", 'dep.js': 'export const x = 1;' };
    const dir = graph(source);
    const before = fingerprintModuleGraph(path.join(dir, 'entry.js'));
    // tsc rewrites every output on every build, so this is the common case.
    for (const [name, text] of Object.entries(source)) {
      fs.writeFileSync(path.join(dir, name), text);
    }
    expect(fingerprintModuleGraph(path.join(dir, 'entry.js'))).toBe(before);
  });

  it('changes when an imported file is deleted', () => {
    const dir = graph({ 'entry.js': "import './dep.js';", 'dep.js': 'export const x = 1;' });
    const before = fingerprintModuleGraph(path.join(dir, 'entry.js'));
    fs.rmSync(path.join(dir, 'dep.js'));
    expect(fingerprintModuleGraph(path.join(dir, 'entry.js'))).not.toBe(before);
  });

  it('ignores changes outside the graph', () => {
    const dir = graph({ 'entry.js': "import './dep.js';", 'dep.js': 'x', 'stranger.js': 'y' });
    const before = fingerprintModuleGraph(path.join(dir, 'entry.js'));
    fs.writeFileSync(path.join(dir, 'stranger.js'), 'changed');
    expect(fingerprintModuleGraph(path.join(dir, 'entry.js'))).toBe(before);
  });

  it('follows dynamic imports', () => {
    const dir = graph({ 'entry.js': "await import('./lazy.js');", 'lazy.js': 'export const x = 1;' });
    const before = fingerprintModuleGraph(path.join(dir, 'entry.js'));
    fs.writeFileSync(path.join(dir, 'lazy.js'), 'export const x = 2;');
    expect(fingerprintModuleGraph(path.join(dir, 'entry.js'))).not.toBe(before);
  });

  it('follows a .js specifier to the .ts it was written as', () => {
    // Dev mode runs the sources through tsx, where './dep.js' is dep.ts.
    const dir = graph({ 'entry.ts': "import './dep.js';", 'dep.ts': 'export const x = 1;' });
    const before = fingerprintModuleGraph(path.join(dir, 'entry.ts'));
    fs.writeFileSync(path.join(dir, 'dep.ts'), 'export const x = 2;');
    expect(fingerprintModuleGraph(path.join(dir, 'entry.ts'))).not.toBe(before);
  });

  it('terminates on an import cycle', () => {
    const dir = graph({ 'entry.js': "import './b.js';", 'b.js': "import './entry.js';" });
    expect(fingerprintModuleGraph(path.join(dir, 'entry.js'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('walks past imports it cannot resolve', () => {
    const dir = graph({ 'entry.js': "import 'dotenv';\nimport './gone.js';\nimport './dep.js';", 'dep.js': 'x' });
    expect(fingerprintModuleGraph(path.join(dir, 'entry.js'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns nothing at all when the entry is unreadable', () => {
    const dir = graph({});
    expect(fingerprintModuleGraph(path.join(dir, 'absent.js'))).toBe('');
  });
});

describe('launcherHasChanged', () => {
  it('is true only when two readable fingerprints disagree', () => {
    expect(launcherHasChanged('aaa', 'bbb')).toBe(true);
    expect(launcherHasChanged('aaa', 'aaa')).toBe(false);
  });

  it('says no rather than guess when a fingerprint is missing', () => {
    expect(launcherHasChanged('', 'bbb')).toBe(false);
    expect(launcherHasChanged('aaa', '')).toBe(false);
    expect(launcherHasChanged('', '')).toBe(false);
  });
});

describe('launcherRestartHint', () => {
  it('names the pm2 command when pm2 is running us', () => {
    expect(launcherRestartHint({ pm_id: '4', name: 'telecoder' }))
      .toBe('run "pm2 restart telecoder"');
  });

  it('stays generic when nothing says pm2', () => {
    expect(launcherRestartHint({ name: 'telecoder' })).toBe('restart the launcher process');
    expect(launcherRestartHint({})).toBe('restart the launcher process');
  });

  it('stays generic rather than paste an app name that reads as a command', () => {
    expect(launcherRestartHint({ pm_id: '4', name: 'telecoder"; rm -rf ~ #' }))
      .toBe('restart the launcher process');
  });
});
