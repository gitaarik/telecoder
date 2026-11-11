/**
 * The settings commands send plain text with entities, never a parse mode, so
 * whatever a user typed comes back verbatim and nothing in it can be misparsed.
 *
 * Drives the real handlers with the chat's preferences kept under a scratch
 * home, so nothing here touches the real ~/.telecoder.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { marked } from '../helpers/entity-marks.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-settings-entities-'));
process.env.TELECODER_TEST_HOME = home;

const {
  handleVerbosity,
  handleVerbosityCallback,
  handlePermissionMode,
} = await import('../../src/bot/handlers/command/settings.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

type SendOptions = { parse_mode?: string; entities?: MessageEntity[]; reply_markup?: unknown };

let nextChat = 11000;

/** A command message in a fresh chat, and every reply it got. */
function command(text: string) {
  const reply = vi.fn(async (_text: string, _opts?: SendOptions) => ({}));
  const ctx = { chat: { id: nextChat++ }, message: { text }, reply } as unknown as Context;
  return { ctx, reply };
}

/** The one reply, its formatting marked as `*x*`, `_x_` and `` `x` ``. */
function onlyReply(reply: ReturnType<typeof command>['reply']): { text: string; opts?: SendOptions } {
  expect(reply).toHaveBeenCalledTimes(1);
  const [text, opts] = reply.mock.calls[0]!;
  expect(opts?.parse_mode).toBeUndefined();
  return { text: marked(text, opts?.entities), opts };
}

describe('/verbosity', () => {
  it('quotes an unknown level back as typed', async () => {
    const { ctx, reply } = command('/verbosity *very*_loud_');
    await handleVerbosity(ctx);

    expect(onlyReply(reply).text).toBe(
      '❌ Unknown verbosity level "*very*_loud_".\n\nValid: quiet, normal, verbose, debug, default',
    );
    expect(reply.mock.calls[0]![1]?.entities).toEqual([]);
  });

  it('confirms a level by its label, with its description in italics', async () => {
    const { ctx, reply } = command('/verbosity quiet');
    await handleVerbosity(ctx);

    expect(onlyReply(reply).text).toBe(
      '✅ Verbosity set to *🔇 Quiet*\n\n' +
      '_Answer only. Suppresses completion pings and the usage footer; keeps compaction warnings._',
    );
  });

  it('shows the menu with its keyboard', async () => {
    const { ctx, reply } = command('/verbosity');
    await handleVerbosity(ctx);

    const { text, opts } = onlyReply(reply);
    expect(text.startsWith('🎚️ *Verbosity*\n\nCurrent: *')).toBe(true);
    expect(text).toContain('_(from env default)_');
    expect(text.endsWith('• *Default* - Use the env-level setting (`VERBOSITY_DEFAULT`)')).toBe(true);
    expect(opts?.reply_markup).toBeDefined();
  });

  it('edits the menu in place when a level is tapped', async () => {
    const chatId = nextChat++;
    const editMessageText = vi.fn(async () => true);
    const ctx = {
      chat: { id: chatId },
      callbackQuery: { data: 'verbosity:quiet', message: { message_id: 42, chat: { id: chatId } } },
      answerCallbackQuery: vi.fn(async () => true),
      api: { editMessageText },
    } as unknown as Context;

    await handleVerbosityCallback(ctx);

    expect(editMessageText).toHaveBeenCalledTimes(1);
    const [editedChat, messageId, text, opts] = editMessageText.mock.calls[0] as unknown as
      [number, number, string, SendOptions];
    expect([editedChat, messageId]).toEqual([chatId, 42]);
    expect(opts.parse_mode).toBeUndefined();
    expect(marked(text, opts.entities)).toMatch(/^✅ Verbosity set to \*🔇 Quiet\*\n\n_Answer only\./);
  });
});

describe('/mode', () => {
  it('lists the valid modes as code when given an unknown one', async () => {
    const { ctx, reply } = command('/mode `yolo`');
    await handlePermissionMode(ctx);

    const { text } = onlyReply(reply);
    expect(text.startsWith('❌ Unknown mode "`yolo`".\n\nValid: `manual`, `acceptEdits`, ')).toBe(true);
    expect(text.endsWith(', `default`')).toBe(true);
  });

  it('names the mode the transport default resolves to', async () => {
    const { ctx, reply } = command('/mode');
    await handlePermissionMode(ctx);

    const { text, opts } = onlyReply(reply);
    expect(text).toMatch(/^🔐 \*Permission mode\*\n\nCurrent: \*[^*]+\* _\(default — [^)]+\)_\n\n• \*Manual\* - ask before every edit\n/);
    expect(text.endsWith("_Takes effect on your next message. Modes that ask will put Claude Code's own prompts in the chat as buttons._")).toBe(true);
    expect(opts?.reply_markup).toBeDefined();
  });
});
