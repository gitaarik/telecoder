import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-home-'));
fs.mkdirSync(path.join(workspace, 'sjs'));

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { ...actual, config: { ...actual.config, WORKSPACE_DIR: workspace, HOME_PROJECT: 'sjs' } };
});

const createSession = vi.fn((_key: string, dir: string) => ({ workingDirectory: dir }));
let restorable: { workingDirectory: string } | undefined;
vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getOrRestoreSession: () => ({ session: restorable, restored: !!restorable }),
    createSession,
  },
}));

const { homeProject, isHomeProject } = await import('../../src/utils/home-project.js');
const { requireSession } = await import('../../src/bot/handlers/session-guard.js');

describe('home project', () => {
  beforeAll(() => createSession.mockClear());
  afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

  it('resolves HOME_PROJECT against the workspace', () => {
    expect(homeProject()).toBe(path.join(workspace, 'sjs'));
    expect(isHomeProject(path.join(workspace, 'sjs/'))).toBe(true);
    expect(isHomeProject(path.join(workspace, 'other'))).toBe(false);
    expect(isHomeProject(undefined)).toBe(false);
  });

  it('starts a conversation there when there is nothing to restore', async () => {
    restorable = undefined;
    const reply = vi.fn();

    const session = await requireSession({ reply } as never, '1:2');

    expect(createSession).toHaveBeenCalledWith('1:2', path.join(workspace, 'sjs'));
    expect(session?.workingDirectory).toBe(path.join(workspace, 'sjs'));
    expect(reply).not.toHaveBeenCalled();
  });

  it('restores the last conversation rather than start a new one', async () => {
    createSession.mockClear();
    restorable = { workingDirectory: path.join(workspace, 'elsewhere') };
    const reply = vi.fn().mockResolvedValue({});

    const session = await requireSession({ reply } as never, '1:2');

    expect(createSession).not.toHaveBeenCalled();
    expect(session?.workingDirectory).toBe(path.join(workspace, 'elsewhere'));
  });
});
