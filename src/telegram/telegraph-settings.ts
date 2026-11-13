/**
 * Per-chat Telegraph settings — controls whether long replies are offloaded to
 * a Telegraph page instead of being split across Telegram messages.
 */

import { z } from 'zod';
import { config } from '../config.js';
import { createKeyedSettings } from '../utils/keyed-settings.js';

export interface TelegraphSettings {
  enabled: boolean;
}

const store = createKeyedSettings<TelegraphSettings>({
  file: 'telegraph-settings.json',
  label: 'Telegraph',
  entrySchema: z.object({ enabled: z.boolean().optional() }),
  normalize: (stored) => ({
    // Default to the global config value if not set
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : config.TELEGRAPH_ENABLED,
  }),
});

export function getTelegraphSettings(sessionKey: string): TelegraphSettings {
  return store.get(sessionKey);
}

export function setTelegraphEnabled(sessionKey: string, enabled: boolean): void {
  store.update(sessionKey, { enabled });
}

/**
 * Whether this chat publishes to Telegraph. The global switch wins: a chat
 * that turned it on while TELEGRAPH_ENABLED was true stops publishing the
 * moment the owner turns it off, since every page is public.
 */
export function isTelegraphEnabled(sessionKey: string): boolean {
  return config.TELEGRAPH_ENABLED && store.get(sessionKey).enabled;
}
