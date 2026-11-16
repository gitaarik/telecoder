/**
 * TRANSCRIBE_ENABLED turns voice notes off for the whole bot, and a missing
 * Groq key gets the way to turn them on instead of a raw error.
 */

import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import type { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-voice-flags-'));
process.env.TELECODER_TEST_HOME = home;

const { config } = await import('../../src/config.js');
const { handleVoice } = await import('../../src/bot/handlers/voice.handler.js');

const saved = {
  TRANSCRIBE_ENABLED: config.TRANSCRIBE_ENABLED,
  GROQ_API_KEY: config.GROQ_API_KEY,
};

afterEach(() => {
  Object.assign(config, saved);
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

let nextChat = 21000;

function chatCtx(extra: Record<string, unknown> = {}) {
  const ctx = {
    chat: { id: nextChat++ },
    reply: vi.fn(async () => ({ message_id: 1 })),
    api: { getFile: vi.fn() },
    ...extra,
  };
  return ctx;
}

describe('TRANSCRIBE_ENABLED', () => {
  it('stops a voice note from being downloaded and transcribed when off', async () => {
    config.TRANSCRIBE_ENABLED = false;
    const ctx = chatCtx({
      message: {
        message_id: 7,
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voice-1', file_size: 1000, duration: 3 },
      },
    });
    await handleVoice(ctx as unknown as Context);
    expect(ctx.api.getFile).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/Voice transcription feature is disabled/);
  });
});

describe('no Groq key', () => {
  // Declining voice in `telecoder init` is the common case. A voice note then
  // used to get a "Transcribing..." ack and a raw "GROQ_API_KEY not configured"
  // error; now it gets the way to turn transcription on, before any download.
  // Each note needs its own message id: the dedup filter remembers them.
  let nextMessageId = 100;
  function voiceNote() {
    return chatCtx({
      message: {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voice-2', file_size: 1000, duration: 3 },
      },
    });
  }

  it('answers a voice note with how to turn transcription on', async () => {
    config.TRANSCRIBE_ENABLED = true;
    config.GROQ_API_KEY = undefined;
    const ctx = voiceNote();
    await handleVoice(ctx as unknown as Context);
    expect(ctx.api.getFile).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const text = ctx.reply.mock.calls[0]![0] as string;
    expect(text).toMatch(/Voice transcription is off/);
    expect(text).toContain('console.groq.com/keys');
    expect(text).toContain('telecoder init');
    expect(text).toContain('GROQ_API_KEY=');
    expect(text).not.toMatch(/Transcribing/);
  });

  it('TRANSCRIBE_ENABLED=false still wins over a missing key', async () => {
    config.TRANSCRIBE_ENABLED = false;
    config.GROQ_API_KEY = undefined;
    const ctx = voiceNote();
    await handleVoice(ctx as unknown as Context);
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/feature is disabled/);
  });
});
