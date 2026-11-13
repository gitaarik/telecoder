import { describe, it, expect } from 'vitest';
import { configErrorExitCode, getServiceManager } from '../../src/utils/exit-codes.js';

describe('configErrorExitCode', () => {
  it('is 78 for a launcher worker, whatever runs the launcher', () => {
    expect(configErrorExitCode(false, null)).toBe(78);
    expect(configErrorExitCode(false, 'launchd')).toBe(78);
  });

  it('is 78 under the systemd unit, for RestartPreventExitStatus=', () => {
    expect(configErrorExitCode(true, 'systemd')).toBe(78);
  });

  it('is 0 under launchd, the only exit KeepAlive leaves alone', () => {
    expect(configErrorExitCode(true, 'launchd')).toBe(0);
  });

  it('is 1 anywhere else', () => {
    expect(configErrorExitCode(true, null)).toBe(1);
  });

  it('reads the manager from TELECODER_SERVICE', () => {
    expect(getServiceManager({ TELECODER_SERVICE: 'systemd' })).toBe('systemd');
    expect(getServiceManager({ TELECODER_SERVICE: 'launchd' })).toBe('launchd');
    expect(getServiceManager({ TELECODER_SERVICE: 'pm2' })).toBeNull();
    expect(getServiceManager({})).toBeNull();
  });
});
