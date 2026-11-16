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
const { handleTranscribe } = await import('../../src/bot/handlers/command/media.js');

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

  it('answers a bare /transcribe the same way, without asking for audio', async () => {
    config.TRANSCRIBE_ENABLED = true;
    config.GROQ_API_KEY = undefined;
    const ctx = chatCtx({ message: { message_id: 9, date: Math.floor(Date.now() / 1000), text: '/transcribe' } });
    await handleTranscribe(ctx as unknown as Context);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/Voice transcription is off/);
  });

  it('TRANSCRIBE_ENABLED=false still wins over a missing key', async () => {
    config.TRANSCRIBE_ENABLED = false;
    config.GROQ_API_KEY = undefined;
    const ctx = voiceNote();
    await handleVoice(ctx as unknown as Context);
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/feature is disabled/);
  });
});
