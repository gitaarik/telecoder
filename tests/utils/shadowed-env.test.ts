import { describe, it, expect } from 'vitest';
import { findShadowedEnvKeys } from '../../src/config.js';

describe('findShadowedEnvKeys', () => {
  it('names a file value the environment is overriding', () => {
    // The shape of the bug this exists for: the shell that launched the bot
    // exported an empty allow-list, so editing .env changed nothing.
    const keys = findShadowedEnvKeys(
      { ALLOWED_GROUP_IDS: '-4808682238', ALLOWED_USER_IDS: '1' },
      { ALLOWED_GROUP_IDS: '', ALLOWED_USER_IDS: '1' },
    );
    expect(keys).toEqual(['ALLOWED_GROUP_IDS']);
  });

  it('stays quiet when the environment agrees with the file', () => {
    expect(findShadowedEnvKeys({ A: '1' }, { A: '1' })).toEqual([]);
  });

  it('stays quiet for a launcher worker, which is configured by env on purpose', () => {
    const keys = findShadowedEnvKeys(
      { BOT_NAME: 'TeleCoder' },
      { BOT_NAME: 'TeleCoder 2', TELECODER_INSTANCE_NAME: 'TeleCoder 2' },
    );
    expect(keys).toEqual([]);
  });

  it('handles a missing or empty parse result', () => {
    expect(findShadowedEnvKeys(undefined, {})).toEqual([]);
    expect(findShadowedEnvKeys({}, {})).toEqual([]);
  });

  it('counts a file value absent from the environment as applied', () => {
    // dotenv did set it, so process.env matches — nothing to warn about.
    expect(findShadowedEnvKeys({ A: '1' }, { A: '1', B: '2' })).toEqual([]);
  });
});
