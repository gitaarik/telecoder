/**
 * The permission mode a chat runs claude in.
 *
 * Claude Code's modes differ in how much it asks before acting, and until now
 * this bot had no say in it: the SDK transport hard-coded `acceptEdits` and
 * the pty spawned with `--dangerously-skip-permissions`, so every chat on
 * every project ran at whatever those two happened to be. `/plan` was the one
 * escape hatch, and only for a single turn.
 *
 * The five modes below are claude's own, described in its own words from the
 * shift+tab lesson text. Only the first four are offered as choices a person
 * cycles through; bypass is here because it is what the pty has always
 * launched in, and a chat that leaves it needs a way back.
 *
 * Two names for one thing, which is the trap this table exists to close: the
 * CLI flag spells the ask-every-time mode `manual` and the SDK spells it
 * `default`, and each rejects the other's word. Anything crossing into either
 * transport goes through `cli` or `sdk` here, never through the id.
 */

import { tailLines } from './tui-state.js';

export type PermissionModeId = 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

export interface PermissionModeInfo {
  id: PermissionModeId;
  /** How the mode is named in the chat. */
  label: string;
  /** Claude's own one-line description of what the mode does. */
  description: string;
  /** What `--permission-mode` accepts. Not always the same as {@link sdk}. */
  cli: string;
  /** What the SDK's `permissionMode` option accepts. */
  sdk: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
  /**
   * The phrase the TUI prints in its indicator while this mode is on. Measured
   * against a live pty — claude draws `⏸ manual mode on · ? for shortcuts` and
   * `⏵⏵ accept edits on (shift+tab to cycle)`, so the phrase plus ` on` is the
   * only part every mode shares.
   */
  tuiPhrase: string;
}

export const PERMISSION_MODES: readonly PermissionModeInfo[] = [
  {
    id: 'manual',
    label: 'Manual',
    description: 'ask before every edit',
    cli: 'manual',
    sdk: 'default',
    tuiPhrase: 'manual mode',
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    description: 'edit freely, ask for commands',
    cli: 'acceptEdits',
    sdk: 'acceptEdits',
    tuiPhrase: 'accept edits',
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'research and propose, never touch files',
    cli: 'plan',
    sdk: 'plan',
    tuiPhrase: 'plan mode',
  },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Claude decides what is safe',
    cli: 'auto',
    sdk: 'auto',
    tuiPhrase: 'auto mode',
  },
  {
    id: 'bypassPermissions',
    label: 'Bypass',
    description: 'never ask — what the pty ran in before auto',
    cli: 'bypassPermissions',
    sdk: 'bypassPermissions',
    tuiPhrase: 'bypass permissions',
  },
];

export function permissionModeInfo(id: PermissionModeId): PermissionModeInfo {
  const info = PERMISSION_MODES.find((m) => m.id === id);
  if (!info) throw new Error(`unknown permission mode: ${id}`);
  return info;
}

export function isPermissionModeId(value: string): value is PermissionModeId {
  return PERMISSION_MODES.some((m) => m.id === value);
}

/**
 * The mode a chat runs in when it has chosen none.
 *
 * "Default" means "leave it to the transport", and the transports disagree, so
 * this is where the disagreement is written down — beside the table, rather
 * than in either transport, so the answer /mode prints and the answer a turn
 * runs in cannot drift apart.
 *
 * The pty answers `auto`, which is also what claude itself launches in when
 * nobody passes a flag. It ran bypassed for as long as it had no way to answer
 * a permission prompt; now that dialogs reach the chat mid-turn, the mode that
 * never asks is a choice rather than the only thing that worked. `/mode bypass`
 * is still one tap away for a chat that wants it back.
 *
 * DANGEROUS_MODE has no say here, exactly as it never had one on the pty: it
 * predates all of this, describes itself as an SDK-side auto-approve, and a
 * config flag quietly re-loosening a default the transport just tightened is
 * the kind of surprise this whole function exists to prevent.
 */
export function transportDefaultMode(
  method: 'sdk' | 'pty',
  dangerousMode: boolean,
): PermissionModeId {
  if (method === 'pty') return 'auto';
  return dangerousMode ? 'bypassPermissions' : 'acceptEdits';
}

/**
 * Resolve what someone typed into a mode id, so `/mode plan` works alongside
 * the buttons. Accepts the id, the label, and the CLI spelling — `manual` and
 * `default` both land on manual, since which word is right depends on which
 * transport you last read about.
 */
export function parsePermissionModeArg(arg: string): PermissionModeId | null {
  const norm = arg.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (norm === 'default') return 'manual';
  if (norm === 'bypass' || norm === 'yolo') return 'bypassPermissions';
  const hit = PERMISSION_MODES.find((m) =>
    norm === m.id.toLowerCase()
    || norm === m.label.toLowerCase().replace(/[\s_-]+/g, '')
    || norm === m.cli.toLowerCase());
  return hit?.id ?? null;
}

/** Rows from the bottom holding the mode indicator, which sits under the input box. */
const INDICATOR_ROWS = 6;

/**
 * Which mode the TUI says it is in, or null when the screen doesn't say.
 *
 * Null is a real answer and the caller must respect it. The indicator is
 * absent while a dialog covers the input box and while the screen is still
 * being painted, and pressing shift+tab at a screen we cannot read is how a
 * blind cycle walks the session into a mode nobody asked for.
 */
export function parsePermissionMode(screenText: string): PermissionModeId | null {
  const tail = tailLines(screenText, INDICATOR_ROWS).join('\n').toLowerCase();
  for (const mode of PERMISSION_MODES) {
    // `<phrase> on` — the suffix differs per mode (`(shift+tab to cycle)` for
    // most, `· ? for shortcuts` for manual), so only the phrase is matched.
    if (tail.includes(`${mode.tuiPhrase} on`)) return mode.id;
  }
  return null;
}

/** What the switcher needs from the pty, kept narrow so it can be tested. */
export interface ModePty {
  write(data: string): void;
  screen(): string;
}

/** Shift+Tab, as xterm encodes it: CSI Z, "back tab". */
const SHIFT_TAB = '\x1b[Z';
/** Settle time after a press, before re-reading the indicator. */
const PRESS_SETTLE_MS = 400;
/**
 * How many presses to spend looking for the target.
 *
 * The cycle is not a fixed list: a pty launched with
 * `--dangerously-skip-permissions` has five stops (bypass, auto, manual,
 * accept edits, plan) and one launched without it has four, so the distance
 * to any mode depends on how the session started. Measured against a live
 * pty, four presses reach every mode from every starting point; the spare
 * covers a release that adds one.
 */
const MAX_PRESSES = 6;

export type ModeSwitchOutcome =
  /** Already there. Nothing was pressed. */
  | { kind: 'already'; mode: PermissionModeId }
  /** Cycled to the target and saw it arrive. */
  | { kind: 'switched'; from: PermissionModeId; to: PermissionModeId }
  /** The screen never named a mode. Nothing was pressed. */
  | { kind: 'unreadable' }
  /** Pressed the whole cycle and the target never came up. */
  | { kind: 'stuck'; from: PermissionModeId; last: PermissionModeId | null };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Put the session in `target`, by pressing shift+tab until it says so.
 *
 * Reading the indicator after every press is what makes this safe to do on a
 * live session. The cycle's order and length both depend on how the pty was
 * launched, so counting presses would land somewhere plausible and wrong —
 * and "wrong" here means claude acting with more freedom than the chat asked
 * for. Every outcome other than `already` and `switched` means the mode was
 * not established, and the caller is expected to refuse the turn rather than
 * run it in whatever mode the session happens to be in.
 */
export async function ensurePermissionMode(
  pty: ModePty,
  target: PermissionModeId,
  settleMs: number = PRESS_SETTLE_MS,
): Promise<ModeSwitchOutcome> {
  const from = parsePermissionMode(pty.screen());
  if (from === null) return { kind: 'unreadable' };
  if (from === target) return { kind: 'already', mode: from };

  let last: PermissionModeId | null = from;
  for (let i = 0; i < MAX_PRESSES; i++) {
    pty.write(SHIFT_TAB);
    await delay(settleMs);
    last = parsePermissionMode(pty.screen());
    if (last === target) return { kind: 'switched', from, to: target };
  }
  return { kind: 'stuck', from, last };
}
