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

export function isTelegraphEnabled(sessionKey: string): boolean {
  return store.get(sessionKey).enabled;
}
