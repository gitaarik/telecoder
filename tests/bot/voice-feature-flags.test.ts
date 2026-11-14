/**
 * TTS_ENABLED and TRANSCRIBE_ENABLED turn voice off for the whole bot.
 *
 * TTS_ENABLED used to be parsed and never read, so voice replies went out
 * whenever a chat had /tts on; TRANSCRIBE_ENABLED stopped /transcribe but a
 * voice note was still transcribed. Both now do what .env.example says.
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

const generateSpeech = vi.fn(async () => Buffer.from('audio'));
vi.mock('../../src/tts/tts.js', () => ({ generateSpeech }));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-voice-flags-'));
process.env.TELECODER_TEST_HOME = home;

const { config } = await import('../../src/config.js');
const { maybeSendVoiceReply } = await import('../../src/tts/voice-reply.js');
const { setTTSEnabled } = await import('../../src/tts/tts-settings.js');
const { handleTTS } = await import('../../src/bot/handlers/command/settings.js');
const { handleVoice } = await import('../../src/bot/handlers/voice.handler.js');

const saved = {
  TTS_ENABLED: config.TTS_ENABLED,
  TRANSCRIBE_ENABLED: config.TRANSCRIBE_ENABLED,
  TTS_PROVIDER: config.TTS_PROVIDER,
  GROQ_API_KEY: config.GROQ_API_KEY,
};

afterEach(() => {
  Object.assign(config, saved);
  generateSpeech.mockClear();
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
    replyWithVoice: vi.fn(async () => ({})),
    replyWithAudio: vi.fn(async () => ({})),
    api: { getFile: vi.fn() },
    ...extra,
  };
  return ctx;
}

describe('TTS_ENABLED', () => {
  const reply = 'Done. The toggle follows the system theme until you pick one.';

  function ttsReadyChat() {
    config.TTS_PROVIDER = 'groq';
    config.GROQ_API_KEY = 'gsk_test';
    const ctx = chatCtx();
    setTTSEnabled(String(ctx.chat.id), true);
    return ctx;
  }

  it('sends a voice reply when on and the chat has /tts on', async () => {
    config.TTS_ENABLED = true;
    const ctx = ttsReadyChat();
    await maybeSendVoiceReply(ctx as unknown as Context, reply);
    expect(generateSpeech).toHaveBeenCalledTimes(1);
  });

  it('sends none when off, whatever the chat has set', async () => {
    config.TTS_ENABLED = false;
    const ctx = ttsReadyChat();
    await maybeSendVoiceReply(ctx as unknown as Context, reply);
    expect(generateSpeech).not.toHaveBeenCalled();
    expect(ctx.replyWithVoice).not.toHaveBeenCalled();
    expect(ctx.replyWithAudio).not.toHaveBeenCalled();
  });

  it('makes /tts say voice replies are turned off', async () => {
    config.TTS_ENABLED = false;
    const ctx = chatCtx({ message: { text: '/tts' } });
    await handleTTS(ctx as unknown as Context);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/Voice replies feature is disabled/);
  });
});

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
