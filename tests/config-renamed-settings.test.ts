import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * TERMINAL_UI_VERBOSE was renamed FULL_TOOL_INPUTS when /terminalui went. A
 * .env written before keeps working: the old name is read when the new one
 * isn't set, and counts as an explicit override of the verbosity tier.
 */
async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv('FULL_TOOL_INPUTS', '');
  vi.stubEnv('TERMINAL_UI_VERBOSE', '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('../src/config.js');
}

describe('renamed settings', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reads the old name when only it is set', async () => {
    const { config, explicitFlags } = await loadConfig({ TERMINAL_UI_VERBOSE: 'true' });
    expect(config.FULL_TOOL_INPUTS).toBe(true);
    expect(explicitFlags.FULL_TOOL_INPUTS).toBe(true);
  });

  it('lets the new name win over the old', async () => {
    const { config, explicitFlags } = await loadConfig({ TERMINAL_UI_VERBOSE: 'true', FULL_TOOL_INPUTS: 'false' });
    expect(config.FULL_TOOL_INPUTS).toBe(false);
    expect(explicitFlags.FULL_TOOL_INPUTS).toBe(true);
  });

  it('leaves the tier in charge when neither is set', async () => {
    const { config, explicitFlags } = await loadConfig({});
    expect(config.FULL_TOOL_INPUTS).toBe(false);
    expect(explicitFlags.FULL_TOOL_INPUTS).toBe(false);
  });

  it('copies an old value under the new name without touching a set one', async () => {
    const { withRenamedSettings } = await loadConfig({});
    expect(withRenamedSettings({ TERMINAL_UI_VERBOSE: 'true' }).FULL_TOOL_INPUTS).toBe('true');
    expect(withRenamedSettings({ TERMINAL_UI_VERBOSE: 'true', FULL_TOOL_INPUTS: 'false' }).FULL_TOOL_INPUTS).toBe('false');
    expect(withRenamedSettings({}).FULL_TOOL_INPUTS).toBeUndefined();
  });
});
