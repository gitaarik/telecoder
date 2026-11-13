import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Context } from 'grammy';

const { resolveShareablePath, shareRootFor, resolveShareableFile, refuseFilePublish } =
  await import('../../src/bot/file-access.js');
const { getWorkspaceRoot } = await import('../../src/utils/workspace-guard.js');

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3 and no ADMIN_USER_IDS,
// so 1 is an admin; 999 is nobody, which isAdmin treats as a non-admin.
const ADMIN = 1;
const GUEST = 999;

let base: string;
let workspace: string;
let project: string;
let otherProject: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-access-')));
  workspace = path.join(base, 'ws');
  project = path.join(workspace, 'proj');
  otherProject = path.join(workspace, 'other');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(otherProject, { recursive: true });
  fs.mkdirSync(path.join(workspace, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });

  fs.writeFileSync(path.join(project, 'src', 'index.ts'), 'export {};');
  fs.writeFileSync(path.join(project, '.env'), 'TOKEN=x');
  fs.writeFileSync(path.join(otherProject, 'notes.md'), '# notes');
  fs.writeFileSync(path.join(workspace, '.ssh', 'id_ed25519'), 'KEY');
  fs.writeFileSync(path.join(workspace, '.claude', '.credentials.json'), '{}');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside');

  // Symlinks that look innocent from inside the project.
  fs.symlinkSync(path.join(workspace, '.ssh', 'id_ed25519'), path.join(project, 'innocent.txt'));
  fs.symlinkSync(path.join(otherProject, 'notes.md'), path.join(project, 'shortcut.md'));
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(project, 'escape.txt'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('resolveShareablePath', () => {
  const guestOpts = () => ({ cwd: project, root: project });
  const adminOpts = () => ({ cwd: project, root: workspace });

  it('resolves a relative project file', () => {
    expect(resolveShareablePath('src/index.ts', guestOpts())).toEqual({
      ok: true,
      path: path.join(project, 'src', 'index.ts'),
    });
  });

  it('confines a guest to the project, by absolute path and by ../', () => {
    expect(resolveShareablePath(path.join(otherProject, 'notes.md'), guestOpts()))
      .toEqual({ ok: false, reason: 'outside-root' });
    expect(resolveShareablePath('../other/notes.md', guestOpts()))
      .toEqual({ ok: false, reason: 'outside-root' });
  });

  it('follows symlinks before judging containment', () => {
    expect(resolveShareablePath('shortcut.md', guestOpts())).toEqual({ ok: false, reason: 'outside-root' });
    expect(resolveShareablePath('escape.txt', guestOpts())).toEqual({ ok: false, reason: 'outside-root' });
  });

  it('does not reveal whether a path outside the root exists', () => {
    expect(resolveShareablePath('../other/nope.md', guestOpts())).toEqual({ ok: false, reason: 'outside-root' });
  });

  it('lets an admin reach other projects in the workspace', () => {
    expect(resolveShareablePath(path.join(otherProject, 'notes.md'), adminOpts()))
      .toEqual({ ok: true, path: path.join(otherProject, 'notes.md') });
    expect(resolveShareablePath('shortcut.md', adminOpts()).ok).toBe(true);
  });

  it('keeps an admin inside the workspace', () => {
    expect(resolveShareablePath(path.join(base, 'outside.txt'), adminOpts()))
      .toEqual({ ok: false, reason: 'outside-root' });
  });

  it('refuses credential paths for admins too', () => {
    expect(resolveShareablePath(path.join(workspace, '.ssh', 'id_ed25519'), adminOpts()))
      .toEqual({ ok: false, reason: 'sensitive' });
    expect(resolveShareablePath(path.join(workspace, '.claude', '.credentials.json'), adminOpts()))
      .toEqual({ ok: false, reason: 'sensitive' });
    expect(resolveShareablePath('.env', adminOpts())).toEqual({ ok: false, reason: 'sensitive' });
  });

  it('refuses a symlink whose target is a credential', () => {
    expect(resolveShareablePath('innocent.txt', adminOpts())).toEqual({ ok: false, reason: 'sensitive' });
  });

  it('refuses credential paths under ~ even when they do not resolve', () => {
    expect(resolveShareablePath('~/.ssh/id_rsa', adminOpts())).toEqual({ ok: false, reason: 'sensitive' });
    expect(resolveShareablePath('~/.claude/.credentials.json', adminOpts())).toEqual({ ok: false, reason: 'sensitive' });
  });

  it('reports missing files and directories inside the root', () => {
    expect(resolveShareablePath('src/missing.ts', guestOpts())).toEqual({ ok: false, reason: 'not-found' });
    expect(resolveShareablePath('src', guestOpts())).toEqual({ ok: false, reason: 'directory' });
  });
});

describe('shareRootFor', () => {
  it('gives an admin the workspace and a guest the project', () => {
    expect(shareRootFor(ADMIN, project)).toBe(getWorkspaceRoot());
    expect(shareRootFor(GUEST, project)).toBe(project);
  });
});

function makeCtx(userId: number) {
  const reply = vi.fn().mockResolvedValue({ message_id: 1 });
  const ctx = { from: { id: userId }, chat: { id: userId, type: 'private' }, reply } as unknown as Context;
  return { ctx, reply };
}

describe('resolveShareableFile', () => {
  it('tells a guest they are confined to the project', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, reply } = makeCtx(GUEST);
    expect(await resolveShareableFile(ctx, project, '../other/notes.md')).toBeNull();
    expect(String(reply.mock.calls[0][0])).toContain("this chat's project");
  });

  it('says plainly why a credential path is refused', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, reply } = makeCtx(ADMIN);
    expect(await resolveShareableFile(ctx, project, '~/.ssh/id_rsa')).toBeNull();
    expect(String(reply.mock.calls[0][0])).toContain('credential');
  });
});

describe('refuseFilePublish', () => {
  it('refuses a guest outright', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, reply } = makeCtx(GUEST);
    expect(await refuseFilePublish(ctx)).toBe(true);
    expect(String(reply.mock.calls[0][0])).toContain('admin-only');
  });

  it('refuses an admin while Telegraph is off (the default)', async () => {
    const { ctx, reply } = makeCtx(ADMIN);
    expect(await refuseFilePublish(ctx)).toBe(true);
    expect(String(reply.mock.calls[0][0])).toContain('Telegraph is off');
  });
});
