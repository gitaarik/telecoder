/**
 * The reasoning-effort levels `claude --effort` accepts, as /effort offers
 * them. Stored per chat or thread in the user preferences; the pty passes the
 * chosen one at spawn.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const VALID_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function isValidEffortLevel(level: string): level is EffortLevel {
  return VALID_EFFORT_LEVELS.includes(level as EffortLevel);
}
