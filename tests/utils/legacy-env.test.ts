import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { legacyEnv, resetLegacyEnvWarnings } from '../../src/utils/legacy-env.js';

const NEW = 'TELECODER_FIXTURE_VAR';
const OLD = 'CLAUDEGRAM_FIXTURE_VAR';

describe('legacyEnv', () => {
  beforeEach(() => {
    delete process.env[NEW];
    delete process.env[OLD];
    resetLegacyEnvWarnings();
  });

  afterEach(() => {
    delete process.env[NEW];
    delete process.env[OLD];
    vi.restoreAllMocks();
  });

  it('reads the current TELECODER_ name', () => {
    process.env[NEW] = 'current';
    expect(legacyEnv('FIXTURE_VAR')).toBe('current');
  });

  it('falls back to the pre-rename CLAUDEGRAM_ name', () => {
    process.env[OLD] = 'legacy';
    expect(legacyEnv('FIXTURE_VAR')).toBe('legacy');
  });

  it('prefers the new name when both are set', () => {
    process.env[NEW] = 'current';
    process.env[OLD] = 'legacy';
    expect(legacyEnv('FIXTURE_VAR')).toBe('current');
  });

  it('returns undefined when neither is set', () => {
    expect(legacyEnv('FIXTURE_VAR')).toBeUndefined();
  });

  it('preserves an empty string rather than treating it as unset', () => {
    process.env[NEW] = '';
    expect(legacyEnv('FIXTURE_VAR')).toBe('');
  });

  it('does not warn when only the new name is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[NEW] = 'current';
    legacyEnv('FIXTURE_VAR');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per var, not once per read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[OLD] = 'legacy';
    legacyEnv('FIXTURE_VAR');
    legacyEnv('FIXTURE_VAR');
    legacyEnv('FIXTURE_VAR');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(OLD);
    expect(warn.mock.calls[0][0]).toContain(NEW);
  });
});
