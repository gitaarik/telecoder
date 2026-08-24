import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildPromptMessage, listDangerousPatterns } from '../../src/claude/permission-gate.js';

const ADMINS = [{ id: 42, name: 'Rik' }];

function prompt(overrides: Partial<Parameters<typeof buildPromptMessage>[0]> = {}) {
  return buildPromptMessage({
    reason: 'sudo',
    toolName: 'Bash',
    toolInput: { command: 'sudo apt install ffmpeg' },
    requester: 'Bob',
    admins: ADMINS,
    timeoutMinutes: 10,
    ...overrides,
  });
}

describe('buildPromptMessage', () => {
  it('names the reason, the requester, the tool and the timeout', () => {
    const { text } = prompt();
    expect(text).toContain('Permission requested — sudo');
    expect(text).toContain('Asked by Bob');
    expect(text).toContain('Bash');
    expect(text).toContain('sudo apt install ffmpeg');
    expect(text).toContain('Times out in 10 min → denied.');
  });

  it('mentions each admin by id so the prompt raises a notification', () => {
    const { text, entities } = prompt({ admins: [{ id: 42, name: 'Rik' }, { id: 43, name: 'Ann' }] });
    const mentions = entities.filter((e) => e.type === 'text_mention');

    expect(mentions).toHaveLength(2);
    expect(mentions.map((m) => (m as { user: { id: number } }).user.id)).toEqual([42, 43]);
    expect(text).toContain('Only Rik or Ann can approve this.');
  });

  it('still reads correctly when no admin could be resolved in the chat', () => {
    const { text, entities } = prompt({ admins: [] });
    expect(text).toContain('Only an admin can approve this.');
    expect(entities.filter((e) => e.type === 'text_mention')).toHaveLength(0);
  });

  it('omits the attribution line when the requester is unknown', () => {
    const { text } = prompt({ requester: undefined });
    expect(text).not.toContain('Asked by');
  });

  it('places every entity over the text it claims to describe', () => {
    // The whole point of entities over MarkdownV2 is that offsets are exact;
    // an off-by-one here would style the wrong run of characters.
    const { text, entities } = prompt();
    for (const e of entities) {
      expect(e.offset).toBeGreaterThanOrEqual(0);
      expect(e.offset + e.length).toBeLessThanOrEqual(text.length);
    }
    const pre = entities.find((e) => e.type === 'pre');
    expect(pre).toBeDefined();
    expect(text.slice(pre!.offset, pre!.offset + pre!.length)).toBe('sudo apt install ffmpeg');
  });

  it('survives a command full of markdown metacharacters', () => {
    // This is the case that used to 400 the send and fall back to plain text.
    const command = "sed -i 's/_foo_/**bar**/g' ~/a[1].md && echo `date` | tee -a x_y_z.log";
    const { text, entities } = prompt({ toolInput: { command } });

    expect(text).toContain(command);
    const pre = entities.find((e) => e.type === 'pre');
    expect(text.slice(pre!.offset, pre!.offset + pre!.length)).toBe(command);
  });

  it('clips a very long command instead of blowing the message cap', () => {
    const command = 'x'.repeat(5000);
    const { text, entities } = prompt({ toolInput: { command } });

    expect(text.length).toBeLessThan(1000);
    const pre = entities.find((e) => e.type === 'pre');
    expect(text.slice(pre!.offset, pre!.offset + pre!.length)).toMatch(/^x+…$/);
  });

  it('renders the tool input as JSON for a tool that has no command', () => {
    const { text, entities } = prompt({ toolName: 'Write', toolInput: { file_path: '/etc/hosts' } });
    expect(text).toContain('/etc/hosts');
    expect(entities.find((e) => e.type === 'pre')).toMatchObject({ language: 'json' });
  });

  it('includes the model’s own description of what it is doing', () => {
    const { text } = prompt({
      toolInput: { command: 'sudo rm -rf /var/cache/x', description: 'Clear the build cache' },
    });
    expect(text).toContain('Clear the build cache');
  });
});

describe('listDangerousPatterns', () => {
  it('still surfaces the guarded reasons for /permissions', () => {
    const reasons = listDangerousPatterns().map((p) => p.reason);
    expect(reasons).toContain('sudo');
    expect(reasons).toContain('rm -rf');
  });
});

describe('isPermissionGateEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(env: Record<string, string>) {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import('../../src/claude/permission-gate.js');
  }

  it('is off for a solo bot with no explicit opt-in', async () => {
    const { isPermissionGateEnabled } = await load({ ADMIN_USER_IDS: '', TELECODER_PERMISSION_PROMPTS: '' });
    expect(isPermissionGateEnabled()).toBe(false);
  });

  it('turns itself on once the bot has guests', async () => {
    const { isPermissionGateEnabled, isPermissionGateImplicit } = await load({
      ADMIN_USER_IDS: '1',
      TELECODER_PERMISSION_PROMPTS: '',
    });
    expect(isPermissionGateEnabled()).toBe(true);
    expect(isPermissionGateImplicit()).toBe(true);
  });

  it('lets an explicit 0 turn it off even with guests present', async () => {
    const { isPermissionGateEnabled, isPermissionGateImplicit } = await load({
      ADMIN_USER_IDS: '1',
      TELECODER_PERMISSION_PROMPTS: '0',
    });
    expect(isPermissionGateEnabled()).toBe(false);
    expect(isPermissionGateImplicit()).toBe(false);
  });

  it('honours an explicit 1 on a solo bot', async () => {
    const { isPermissionGateEnabled } = await load({
      ADMIN_USER_IDS: '',
      TELECODER_PERMISSION_PROMPTS: '1',
    });
    expect(isPermissionGateEnabled()).toBe(true);
  });
});
