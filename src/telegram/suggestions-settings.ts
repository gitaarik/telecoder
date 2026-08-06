/**
 * Per-chat prompt-suggestion settings — controls whether TeleCoder enables
 * Claude Code's `prompt_suggestion` feature for this session and scrapes the
 * resulting ghost text. Persisted to ~/.claudegram/suggestions-settings.json.
 *
 * Takes effect on next PTY spawn (the env var is set at spawn time). A
 * mid-session toggle is recorded but won't activate until the user starts a
 * new session or the PTY is restarted for any other reason.
 */

import { z } from 'zod';
import { config } from '../config.js';
import { createKeyedSettings } from '../utils/keyed-settings.js';

export interface SuggestionsSettings {
  enabled: boolean;
}

const store = createKeyedSettings<SuggestionsSettings>({
  file: 'suggestions-settings.json',
  label: 'Suggestions',
  entrySchema: z.object({ enabled: z.boolean().optional() }),
  normalize: (stored) => ({
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : config.PROMPT_SUGGESTIONS_DEFAULT,
  }),
});

export function getSuggestionsSettings(sessionKey: string): SuggestionsSettings {
  return store.get(sessionKey);
}

export function setSuggestionsEnabled(sessionKey: string, enabled: boolean): void {
  store.update(sessionKey, { enabled });
}

export function isSuggestionsEnabled(sessionKey: string): boolean {
  return store.get(sessionKey).enabled;
}
