/**
 * Per-chat text-to-speech settings — whether voice replies are on, which voice
 * to use, and whether they autoplay.
 */

import { z } from 'zod';
import { config } from '../config.js';
import { createKeyedSettings } from '../utils/keyed-settings.js';

export interface TTSSettings {
  enabled: boolean;
  voice: string;
  autoplay: boolean;
}

const GROQ_TTS_VOICES = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'] as const;
const OPENAI_TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral',
  'echo', 'fable', 'nova', 'onyx',
  'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;

function getDefaultVoice(): string {
  if (config.TTS_PROVIDER === 'groq') {
    // If the configured TTS_VOICE is valid for Groq, use it; otherwise default to 'troy'
    const voices: readonly string[] = GROQ_TTS_VOICES;
    return voices.includes(config.TTS_VOICE) ? config.TTS_VOICE : 'troy';
  }
  return config.TTS_VOICE;
}

function isValidVoiceForProvider(voice: string): boolean {
  const voices: readonly string[] = config.TTS_PROVIDER === 'groq' ? GROQ_TTS_VOICES : OPENAI_TTS_VOICES;
  return voices.includes(voice);
}

const store = createKeyedSettings<TTSSettings>({
  file: 'tts-settings.json',
  label: 'TTS',
  entrySchema: z.object({
    enabled: z.boolean().optional(),
    voice: z.string().optional(),
    autoplay: z.boolean().optional(),
  }),
  normalize: (stored) => {
    const voice = typeof stored?.voice === 'string' && stored.voice.length > 0
      ? stored.voice
      : getDefaultVoice();

    return {
      enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : false,
      // A voice saved under a different TTS_PROVIDER won't exist for the
      // current one — fall back rather than sending an unknown voice id.
      voice: isValidVoiceForProvider(voice) ? voice : getDefaultVoice(),
      autoplay: typeof stored?.autoplay === 'boolean' ? stored.autoplay : true,
    };
  },
});

export function getTTSSettings(sessionKey: string): TTSSettings {
  return store.get(sessionKey);
}

export function setTTSEnabled(sessionKey: string, enabled: boolean): void {
  store.update(sessionKey, { enabled });
}

export function setTTSVoice(sessionKey: string, voice: string): void {
  store.update(sessionKey, { voice });
}

export function setTTSAutoplay(sessionKey: string, autoplay: boolean): void {
  store.update(sessionKey, { autoplay });
}

export function isTTSEnabled(sessionKey: string): boolean {
  return store.get(sessionKey).enabled;
}
