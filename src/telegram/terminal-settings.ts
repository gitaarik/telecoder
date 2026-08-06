/**
 * Terminal UI settings per chat.
 * Persists user preferences for terminal-style display mode.
 */

import { z } from 'zod';
import { config } from '../config.js';
import { createKeyedSettings } from '../utils/keyed-settings.js';

export interface TerminalUISettings {
  enabled: boolean;
}

const store = createKeyedSettings<TerminalUISettings>({
  file: 'terminal-ui-settings.json',
  label: 'TerminalUI',
  entrySchema: z.object({ enabled: z.boolean().optional() }),
  normalize: (stored) => ({
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : config.TERMINAL_UI_DEFAULT,
  }),
});

export function getTerminalUISettings(sessionKey: string): TerminalUISettings {
  return store.get(sessionKey);
}

export function setTerminalUIEnabled(sessionKey: string, enabled: boolean): void {
  store.update(sessionKey, { enabled });
}

export function isTerminalUIEnabled(sessionKey: string): boolean {
  return store.get(sessionKey).enabled;
}
