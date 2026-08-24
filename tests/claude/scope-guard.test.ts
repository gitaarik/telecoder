import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  checkToolScope,
  classify,
  resolvePath,
  extractPathTokens,
  getAllowedRoots,
} from '../../src/claude/scope-guard.js';

// Test env (vitest.config.ts): WORKSPACE_DIR=/tmp/telecoder-test-workspace.
// That lives under /tmp, which is itself a root, so the tests below use an
// explicit root list wherever containment is the thing under test.
const ROOT = '/srv/shared';
const CWD = '/srv/shared/project';
const ROOTS = [ROOT, '/tmp'];
const HOME = os.homedir();

describe('resolvePath', () => {
  it('takes absolute paths as they are', () => {
    expect(resolvePath('/srv/shared/a.ts', CWD)).toBe('/srv/shared/a.ts');
  });

  it('expands ~ and $HOME', () => {
    expect(resolvePath('~/.ssh/id_rsa', CWD)).toBe(path.join(HOME, '.ssh/id_rsa'));
    expect(resolvePath('$HOME/notes.md', CWD)).toBe(path.join(HOME, 'notes.md'));
    expect(resolvePath('${HOME}/notes.md', CWD)).toBe(path.join(HOME, 'notes.md'));
  });

  it('resolves a relative climb against the session cwd', () => {
    expect(resolvePath('../../etc/passwd', CWD)).toBe('/srv/etc/passwd');
    expect(resolvePath('./src/index.ts', CWD)).toBe('/srv/shared/project/src/index.ts');
  });

  it('ignores strings that do not announce themselves as paths', () => {
    // These are the false positives that would make the guard unusable.
    expect(resolvePath('s/foo/bar/g', CWD)).toBeUndefined();
    expect(resolvePath('npm', CWD)).toBeUndefined();
    expect(resolvePath('src/index.ts', CWD)).toBeUndefined();
    expect(resolvePath('a/b', CWD)).toBeUndefined();
  });

  it('keeps the literal prefix of a glob', () => {
    expect(resolvePath('/srv/shared/**/*.ts', CWD)).toBe('/srv/shared');
    expect(resolvePath('*.ts', CWD)).toBeUndefined();
  });

  it('strips surrounding quotes', () => {
    expect(resolvePath('"/srv/shared/a b.ts"', CWD)).toBe('/srv/shared/a b.ts');
  });
});

describe('classify', () => {
  it('allows a path inside a root', () => {
    expect(classify('/srv/shared/project/src/a.ts', CWD, ROOTS)).toEqual({ outOfScope: false });
  });

  it('allows the root itself but not a sibling with the same prefix', () => {
    expect(classify('/srv/shared', CWD, ROOTS).outOfScope).toBe(false);
    expect(classify('/srv/shared-secrets/x', CWD, ROOTS).outOfScope).toBe(true);
  });

  it('flags another project outside the roots', () => {
    const v = classify('/home/rik/dev/telecoder/src/index.ts', CWD, ROOTS);
    expect(v.outOfScope).toBe(true);
    expect(v).toMatchObject({ reason: 'path outside the shared projects' });
  });

  it('flags credential directories even when they sit inside a root', () => {
    // The case where someone points WORKSPACE_DIR at a home directory.
    const v = classify('/srv/shared/.ssh/id_rsa', CWD, ROOTS);
    expect(v.outOfScope).toBe(true);
    expect(v).toMatchObject({ reason: 'reads a credential or bot-state path' });
  });

  it('flags the bot’s own state and token files', () => {
    expect(classify(path.join(HOME, '.claudegram/user-preferences.json'), CWD, ROOTS).outOfScope).toBe(true);
    expect(classify('/home/rik/dev/telecoder/.env', CWD, ROOTS).outOfScope).toBe(true);
    expect(classify('/home/rik/dev/telecoder/.env.bot2', CWD, ROOTS).outOfScope).toBe(true);
  });

  it('flags credential config subdirs but not ordinary config', () => {
    expect(classify(path.join(HOME, '.config/gcloud/creds.db'), CWD, ROOTS).outOfScope).toBe(true);
    expect(classify(path.join(HOME, '.config/nvim/init.lua'), CWD, ROOTS).outOfScope).toBe(true);
  });

  it('lets system paths be read without a prompt', () => {
    for (const p of ['/etc/os-release', '/usr/lib/node_modules/x', '/proc/cpuinfo', '/var/log/syslog']) {
      expect(classify(p, CWD, ROOTS), p).toEqual({ outOfScope: false });
    }
  });

  it('still flags the sensitive files that live in system paths', () => {
    expect(classify('/etc/shadow', CWD, ROOTS).outOfScope).toBe(true);
    expect(classify('/etc/sudoers', CWD, ROOTS).outOfScope).toBe(true);
  });

  it('lets language toolchains under home be read', () => {
    for (const suffix of ['.nvm/versions/node/x', '.cargo/registry/y', '.cache/pip/z']) {
      expect(classify(path.join(HOME, suffix), CWD, ROOTS), suffix).toEqual({ outOfScope: false });
    }
  });

  it('reports the offending path with home shortened', () => {
    const v = classify(path.join(HOME, 'Documents/tax.pdf'), CWD, ROOTS);
    expect(v.outOfScope && v.offender).toBe('~/Documents/tax.pdf');
  });
});

describe('extractPathTokens', () => {
  it('finds absolute, home and relative paths', () => {
    expect(extractPathTokens('cat /etc/hosts ~/.bashrc ../out.txt')).toEqual([
      '/etc/hosts',
      '~/.bashrc',
      '../out.txt',
    ]);
  });

  it('finds a path behind a flag', () => {
    expect(extractPathTokens('gcc -I/usr/include -o /tmp/a main.c')).toContain('/usr/include');
    expect(extractPathTokens('node --prof-process=/tmp/x.log')).toContain('/tmp/x.log');
  });

  it('ignores URLs', () => {
    expect(extractPathTokens('curl https://example.com/a/b')).toEqual([]);
  });

  it('leaves ordinary dev commands alone', () => {
    // The noise test: these must produce nothing, or the guard prompts on
    // everything and people stop reading the prompts.
    const quiet = [
      'npm run build',
      'git commit -m "fix: a thing"',
      "sed -i 's/foo/bar/g' src/index.ts",
      'grep -rn "TODO" src',
      'npx vitest run tests/unit',
      'docker compose up -d',
      'python3 -c "import sys; print(sys.version)"',
      'ls -la && pwd',
    ];
    for (const cmd of quiet) {
      expect(extractPathTokens(cmd), cmd).toEqual([]);
    }
  });

  it('splits on shell operators so a piped path is still seen', () => {
    expect(extractPathTokens('cat a.txt|tee /etc/motd')).toContain('/etc/motd');
    expect(extractPathTokens('echo hi > /srv/other/x')).toContain('/srv/other/x');
  });

  it('does not report the same path twice', () => {
    expect(extractPathTokens('cp /tmp/a /tmp/a')).toEqual(['/tmp/a']);
  });
});

describe('checkToolScope', () => {
  beforeEach(() => {
    vi.stubEnv('SCOPE_ALLOWED_PATHS', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the path field of each file tool', () => {
    expect(checkToolScope('Read', { file_path: '/etc/os-release' }, CWD).outOfScope).toBe(false);
    expect(checkToolScope('Read', { file_path: `${HOME}/.ssh/config` }, CWD).outOfScope).toBe(true);
    expect(checkToolScope('Write', { file_path: '/srv/other/x' }, CWD).outOfScope).toBe(true);
    expect(checkToolScope('NotebookEdit', { notebook_path: '/srv/other/n.ipynb' }, CWD).outOfScope).toBe(true);
  });

  it('scans a Bash command for out-of-scope paths', () => {
    const v = checkToolScope('Bash', { command: 'cat ~/.ssh/id_rsa' }, CWD);
    expect(v.outOfScope).toBe(true);
    expect(v).toMatchObject({ reason: 'reads a credential or bot-state path' });
  });

  it('passes a Bash command that stays inside the workspace', () => {
    // /tmp is always a root, so this is in-bounds regardless of WORKSPACE_DIR.
    expect(checkToolScope('Bash', { command: 'npm ci && cp dist/a /tmp/a' }, CWD).outOfScope).toBe(false);
  });

  it('ignores a tool with no path input', () => {
    expect(checkToolScope('WebSearch', { query: 'x' }, CWD).outOfScope).toBe(false);
  });

  it('always includes the temp dir among the roots', () => {
    expect(getAllowedRoots()).toContain('/tmp');
  });
});
