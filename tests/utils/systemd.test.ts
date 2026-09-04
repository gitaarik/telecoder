import { describe, it, expect, afterEach } from 'vitest';
import {
  isSystemdService,
  parseCgroupUnit,
  willRestartOnRequestedExit,
  manualRestartCommand,
} from '../../src/utils/systemd.js';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe('isSystemdService', () => {
  it('is true for the process systemd forked for ExecStart', () => {
    process.env.INVOCATION_ID = '42326ce31af94edeae3f28cd9caba5df';
    process.env.SYSTEMD_EXEC_PID = String(process.pid);
    expect(isSystemdService()).toBe(true);
  });

  it('is false in a child that merely inherited the markers', () => {
    // Both variables are inherited, so a Claude session the bot spawns sees
    // them too. Only the pid match distinguishes the service itself.
    process.env.INVOCATION_ID = '42326ce31af94edeae3f28cd9caba5df';
    process.env.SYSTEMD_EXEC_PID = String(process.pid + 1);
    expect(isSystemdService()).toBe(false);
  });

  it('is false outside systemd', () => {
    delete process.env.INVOCATION_ID;
    delete process.env.SYSTEMD_EXEC_PID;
    expect(isSystemdService()).toBe(false);
  });
});

describe('parseCgroupUnit', () => {
  it('reads a --user unit and knows it is one', () => {
    const unit = parseCgroupUnit(
      '0::/user.slice/user-1001.slice/user@1001.service/app.slice/telecoder.service\n'
    );
    expect(unit).toEqual({ name: 'telecoder.service', user: true });
  });

  it('reads a system unit', () => {
    const unit = parseCgroupUnit('0::/system.slice/telecoder.service\n');
    expect(unit).toEqual({ name: 'telecoder.service', user: false });
  });

  it('picks the unit, not the user manager that runs it', () => {
    // user@1001.service also ends in .service and sits on the same path.
    const unit = parseCgroupUnit('0::/user.slice/user-1001.slice/user@1001.service/telecoder.service');
    expect(unit?.name).toBe('telecoder.service');
  });

  it('handles cgroup v1, which emits one line per controller', () => {
    const unit = parseCgroupUnit(
      ['12:pids:/system.slice/telecoder.service', '0::/system.slice/telecoder.service'].join('\n')
    );
    expect(unit).toEqual({ name: 'telecoder.service', user: false });
  });

  it('returns null when nothing on the path is a unit', () => {
    expect(parseCgroupUnit('0::/user.slice/user-1001.slice/session-3.scope')).toBeNull();
    expect(parseCgroupUnit('')).toBeNull();
  });
});

describe('willRestartOnRequestedExit', () => {
  const behaviour = (policy: string, successExitStatuses: number[] = []) => ({
    policy,
    successExitStatuses,
  });

  it('accepts the policies that act on a non-zero exit', () => {
    expect(willRestartOnRequestedExit(behaviour('always'))).toBe(true);
    expect(willRestartOnRequestedExit(behaviour('on-failure'))).toBe(true);
  });

  it('rejects the ones that would leave the bot dead', () => {
    // on-abnormal and on-watchdog restart on signals and timeouts, not on a
    // non-zero exit; on-success is the exact opposite of what we need.
    for (const policy of ['no', 'on-success', 'on-abnormal', 'on-watchdog', '']) {
      expect(willRestartOnRequestedExit(behaviour(policy))).toBe(false);
    }
  });

  it('rejects on-failure when SuccessExitStatus swallows the restart code', () => {
    // A half-applied unit: SuccessExitStatus=75 copied in, Restart left on
    // on-failure. systemd then sees a clean exit and stands down.
    expect(willRestartOnRequestedExit(behaviour('on-failure', [75]))).toBe(false);
  });

  it('still accepts always alongside SuccessExitStatus — the shipped pairing', () => {
    expect(willRestartOnRequestedExit(behaviour('always', [75]))).toBe(true);
  });

  it('ignores unrelated success codes', () => {
    expect(willRestartOnRequestedExit(behaviour('on-failure', [100, 101]))).toBe(true);
  });
});

describe('manualRestartCommand', () => {
  it('includes --user only for a user unit', () => {
    expect(manualRestartCommand({ name: 'telecoder.service', user: true }))
      .toBe('systemctl --user restart telecoder.service');
    expect(manualRestartCommand({ name: 'telecoder.service', user: false }))
      .toBe('systemctl restart telecoder.service');
  });
});
