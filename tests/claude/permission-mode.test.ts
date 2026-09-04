import { describe, it, expect } from 'vitest';
import {
  PERMISSION_MODES,
  ensurePermissionMode,
  parsePermissionMode,
  parsePermissionModeArg,
  permissionModeInfo,
  transportDefaultMode,
  type ModePty,
  type PermissionModeId,
} from '../../src/claude/permission-mode.js';

const SEP = '─'.repeat(120);

/**
 * The indicator rows, copied verbatim off a live 120x40 pty — including the
 * status-line suffix that shares the row and manual's odd `? for shortcuts`
 * where every other mode says `(shift+tab to cycle)`.
 */
const INDICATORS: Record<PermissionModeId, string> = {
  manual: '  ⏸ manual mode on · ? for shortcuts · ← for agents            ● high · /effort',
  acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents      ● high · /effort',
  plan: '  ⏸ plan mode on (shift+tab to cycle) · ← for agents          ● high · /effort',
  auto: '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents          ● high · /effort',
  bypassPermissions:
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents ● high · /effort',
};

/** A settled input box showing `mode`, the way the provider reads one. */
function screenIn(mode: PermissionModeId): string {
  return [
    '● Done. The rename is committed.',
    SEP,
    '❯ ',
    SEP,
    INDICATORS[mode],
  ].join('\n');
}

/** The order a pty launched with --dangerously-skip-permissions cycles in. */
const BYPASS_CYCLE: PermissionModeId[] = [
  'bypassPermissions', 'auto', 'manual', 'acceptEdits', 'plan',
];

/**
 * A pty that advances through a real measured cycle on Shift+Tab and ignores
 * anything else — so a test can tell a switch that read the screen from one
 * that counted presses and hoped.
 */
function fakePty(cycle: PermissionModeId[], start = 0): ModePty & { written: string[] } {
  const written: string[] = [];
  let i = start;
  return {
    written,
    write(data: string) {
      written.push(data);
      if (data === '\x1b[Z') i = (i + 1) % cycle.length;
    },
    screen: () => screenIn(cycle[i]),
  };
}

describe('parsePermissionMode', () => {
  it('reads every mode off its real indicator row', () => {
    for (const mode of PERMISSION_MODES) {
      expect(parsePermissionMode(screenIn(mode.id))).toBe(mode.id);
    }
  });

  it('reads manual, whose row omits the shift+tab hint the others carry', () => {
    expect(INDICATORS.manual).not.toContain('shift+tab');
    expect(parsePermissionMode(screenIn('manual'))).toBe('manual');
  });

  it('is null when the screen carries no indicator', () => {
    expect(parsePermissionMode([SEP, '❯ ', SEP].join('\n'))).toBeNull();
  });

  it('is null on a dialog, where the indicator is covered rather than changed', () => {
    const dialog = [SEP, ' Select model', ' ❯ 1. Default', '   2. Opus', ' Esc to cancel'].join('\n');
    expect(parsePermissionMode(dialog)).toBeNull();
  });

  it('ignores the phrase in transcript prose above the chrome', () => {
    const screen = [
      '● I would put that behind plan mode on the next turn.',
      '● Then we can look at it again.',
      '● Committed.',
      SEP,
      '❯ ',
      SEP,
      INDICATORS.bypassPermissions,
    ].join('\n');
    expect(parsePermissionMode(screen)).toBe('bypassPermissions');
  });
});

describe('ensurePermissionMode', () => {
  it('presses nothing when the session is already in the mode', async () => {
    const pty = fakePty(BYPASS_CYCLE);
    const outcome = await ensurePermissionMode(pty, 'bypassPermissions', 0);
    expect(outcome).toEqual({ kind: 'already', mode: 'bypassPermissions' });
    expect(pty.written).toEqual([]);
  });

  it('cycles to the target and stops the moment it arrives', async () => {
    const pty = fakePty(BYPASS_CYCLE);
    const outcome = await ensurePermissionMode(pty, 'manual', 0);
    expect(outcome).toEqual({ kind: 'switched', from: 'bypassPermissions', to: 'manual' });
    // bypass → auto → manual. Two presses, and no press after arriving.
    expect(pty.written).toEqual(['\x1b[Z', '\x1b[Z']);
  });

  it('reaches every mode from every starting point within the press budget', async () => {
    for (let start = 0; start < BYPASS_CYCLE.length; start++) {
      for (const target of BYPASS_CYCLE) {
        const pty = fakePty(BYPASS_CYCLE, start);
        const outcome = await ensurePermissionMode(pty, target, 0);
        expect(outcome.kind === 'already' || outcome.kind === 'switched').toBe(true);
        expect(parsePermissionMode(pty.screen())).toBe(target);
      }
    }
  });

  it('presses nothing at a screen it cannot read', async () => {
    const written: string[] = [];
    const pty: ModePty = { write: (d) => written.push(d), screen: () => `${SEP}\n❯ \n${SEP}` };
    expect(await ensurePermissionMode(pty, 'plan', 0)).toEqual({ kind: 'unreadable' });
    expect(written).toEqual([]);
  });

  it('gives up rather than cycle forever when the mode will not move', async () => {
    const written: string[] = [];
    const pty: ModePty = { write: (d) => written.push(d), screen: () => screenIn('manual') };
    const outcome = await ensurePermissionMode(pty, 'plan', 0);
    expect(outcome).toEqual({ kind: 'stuck', from: 'manual', last: 'manual' });
    expect(written.length).toBeGreaterThan(0);
  });
});

describe('mode names', () => {
  it('keeps the CLI and SDK spellings of the ask-every-time mode apart', () => {
    const manual = permissionModeInfo('manual');
    expect(manual.cli).toBe('manual');
    expect(manual.sdk).toBe('default');
  });

  it('resolves what someone might type', () => {
    expect(parsePermissionModeArg('plan')).toBe('plan');
    expect(parsePermissionModeArg('Accept Edits')).toBe('acceptEdits');
    expect(parsePermissionModeArg('accept-edits')).toBe('acceptEdits');
    expect(parsePermissionModeArg('default')).toBe('manual');
    expect(parsePermissionModeArg('bypass')).toBe('bypassPermissions');
    expect(parsePermissionModeArg('nonsense')).toBeNull();
  });
});

describe('transportDefaultMode', () => {
  it('is bypass on the pty, which has no un-bypassed launch', () => {
    expect(transportDefaultMode('pty', false)).toBe('bypassPermissions');
  });

  it('ignores DANGEROUS_MODE on the pty, where it never applied', () => {
    // The flag is on every spawn either way. A menu that credited the env var
    // here would be naming a cause that isn't one.
    expect(transportDefaultMode('pty', true)).toBe('bypassPermissions');
  });

  it('is accept-edits on the sdk, the mode that transport always ran in', () => {
    expect(transportDefaultMode('sdk', false)).toBe('acceptEdits');
  });

  it('lets DANGEROUS_MODE promote the sdk default to bypass', () => {
    expect(transportDefaultMode('sdk', true)).toBe('bypassPermissions');
  });

  it('only ever names a mode the table knows', () => {
    // /mode prints this through permissionModeInfo, which throws on a stranger.
    for (const method of ['sdk', 'pty'] as const) {
      for (const dangerous of [true, false]) {
        expect(() => permissionModeInfo(transportDefaultMode(method, dangerous))).not.toThrow();
      }
    }
  });
});
