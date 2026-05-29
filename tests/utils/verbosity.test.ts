import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the prefs store so tests don't read/write the real ~/.claudegram file.
const getVerbosity = vi.fn();
vi.mock('../../src/providers/user-preferences.js', () => ({
  userPreferences: { getVerbosity: (...a: unknown[]) => getVerbosity(...a) },
}));

import {
  isValidVerbosityLevel,
  VERBOSITY_LEVELS,
  VERBOSITY_INFO,
  getVerbosityLevel,
  resolveVerbosityFlags,
} from '../../src/utils/verbosity.js';

describe('isValidVerbosityLevel', () => {
  it('accepts the four known tiers', () => {
    for (const lvl of ['quiet', 'normal', 'verbose', 'debug']) {
      expect(isValidVerbosityLevel(lvl)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isValidVerbosityLevel('loud')).toBe(false);
    expect(isValidVerbosityLevel('')).toBe(false);
  });
});

describe('verbosity metadata', () => {
  it('has info entries matching the level list, in order', () => {
    expect(VERBOSITY_INFO.map((i) => i.id)).toEqual(VERBOSITY_LEVELS);
  });

  it('every info entry has a label and description', () => {
    for (const info of VERBOSITY_INFO) {
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });
});

describe('getVerbosityLevel', () => {
  beforeEach(() => getVerbosity.mockReset());

  it('returns the per-chat preference when set', () => {
    getVerbosity.mockReturnValue('debug');
    expect(getVerbosityLevel(123)).toBe('debug');
  });

  it('falls back to the env default when unset', () => {
    getVerbosity.mockReturnValue(undefined);
    // config.VERBOSITY_DEFAULT defaults to 'normal' in the test env.
    expect(getVerbosityLevel(123)).toBe('normal');
  });
});

describe('resolveVerbosityFlags', () => {
  beforeEach(() => getVerbosity.mockReset());

  it('quiet suppresses pings, footer and tool output but keeps compaction notices', () => {
    getVerbosity.mockReturnValue('quiet');
    const f = resolveVerbosityFlags(1);
    expect(f.sendCompletionPing).toBe(false);
    expect(f.showUsageFooter).toBe(false);
    expect(f.showToolResults).toBe(false);
    expect(f.useActionLog).toBe(false);
    expect(f.notifyCompaction).toBe(true);
  });

  it('normal enables the completion ping but not the action log', () => {
    getVerbosity.mockReturnValue('normal');
    const f = resolveVerbosityFlags(1);
    expect(f.sendCompletionPing).toBe(true);
    expect(f.useActionLog).toBe(false);
    expect(f.showUsageFooter).toBe(false);
  });

  it('verbose enables the action log, footer and tool result previews', () => {
    getVerbosity.mockReturnValue('verbose');
    const f = resolveVerbosityFlags(1);
    expect(f.useActionLog).toBe(true);
    expect(f.showUsageFooter).toBe(true);
    expect(f.showToolResults).toBe(true);
    expect(f.showDiffs).toBe(true);
    expect(f.toolResultMaxLines).toBe(20);
    expect(f.diffMaxLines).toBe(25);
  });

  it('debug widens the truncation limits relative to verbose', () => {
    getVerbosity.mockReturnValue('debug');
    const f = resolveVerbosityFlags(1);
    expect(f.toolResultMaxLines).toBe(40);
    expect(f.toolResultMaxChars).toBe(4000);
    expect(f.diffMaxLines).toBe(50);
  });
});
