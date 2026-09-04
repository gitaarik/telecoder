/**
 * Whether this process is a systemd service — and whether systemd will bring
 * it back if it exits.
 *
 * This matters because the botctl restart dance cannot work under systemd.
 * `spawn(..., { detached: true })` escapes the process group and session but
 * not the cgroup, so the helper that would start the replacement stays inside
 * the unit. The moment the bot exits, systemd deactivates the unit and (with
 * the default `KillMode=control-group`) reaps everything left in it — the
 * helper included, before it ever gets to the start half of its job. The bot
 * has to exit and let systemd restart it instead, which means first knowing
 * whether systemd actually will.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';

/**
 * Exit code that asks systemd for a restart: EX_TEMPFAIL, conventionally
 * "temporary failure, try again". Non-zero on purpose — it is the only value
 * that both `Restart=always` and `Restart=on-failure` act on, so an install
 * whose unit predates this code still restarts correctly.
 */
export const RESTART_EXIT_CODE = 75;

export interface SystemdUnit {
  /** Unit name, e.g. `telecoder.service`. */
  name: string;
  /** True for a `systemctl --user` unit, false for a system one. */
  user: boolean;
}

/**
 * True only for the process systemd forked for ExecStart.
 *
 * `INVOCATION_ID` alone is not enough: it is inherited, so every Claude
 * session and shell the bot spawns would also claim to be the service.
 * `SYSTEMD_EXEC_PID` is inherited too, but it only *equals* the reader's own
 * pid in the one process systemd started.
 */
export function isSystemdService(): boolean {
  return (
    Boolean(process.env.INVOCATION_ID) &&
    process.env.SYSTEMD_EXEC_PID === String(process.pid)
  );
}

/** A user manager nests its units under `user@<uid>.service`. */
const USER_MANAGER = /^user@\d+\.service$/;

/**
 * Pull the unit out of the contents of `/proc/self/cgroup`.
 *
 * Lines are `hierarchy:controllers:path`; cgroup v2 emits a single `0::<path>`
 * line, v1 one line per controller. The unit is the deepest `.service`
 * component of the path — deepest because a user unit sits below the
 * `user@<uid>.service` manager that runs it, and that manager is not us.
 */
export function parseCgroupUnit(cgroup: string): SystemdUnit | null {
  for (const line of cgroup.split('\n')) {
    const cgroupPath = line.split(':')[2];
    if (!cgroupPath) continue;

    const segments = cgroupPath.split('/').filter(Boolean);
    const name = [...segments]
      .reverse()
      .find((segment) => segment.endsWith('.service') && !USER_MANAGER.test(segment));
    if (!name) continue;

    return { name, user: segments.some((segment) => USER_MANAGER.test(segment)) };
  }
  return null;
}

/** The unit this process runs as, or null if it cannot be determined. */
export function getSystemdUnit(): SystemdUnit | null {
  try {
    return parseCgroupUnit(fs.readFileSync('/proc/self/cgroup', 'utf8'));
  } catch {
    return null;
  }
}

/** The parts of a unit that decide what happens when we exit. */
export interface RestartBehaviour {
  /** The `Restart=` setting. */
  policy: string;
  /** Exit codes `SuccessExitStatus=` promotes to "clean". */
  successExitStatuses: number[];
}

/**
 * Ask systemd how the unit is configured, or null if systemctl cannot answer.
 */
export function getRestartBehaviour(unit: SystemdUnit): Promise<RestartBehaviour | null> {
  return new Promise((resolve) => {
    const args = [
      ...(unit.user ? ['--user'] : []),
      'show',
      unit.name,
      '--property=Restart',
      '--property=SuccessExitStatus',
    ];
    execFile('systemctl', args, { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve(null);
      const properties = new Map(
        stdout
          .split('\n')
          .map((line) => line.split('='))
          .filter((parts): parts is [string, ...string[]] => parts.length >= 2)
          .map(([key, ...rest]) => [key, rest.join('=')] as const)
      );
      const policy = properties.get('Restart')?.trim();
      if (!policy) return resolve(null);
      resolve({
        policy,
        successExitStatuses: (properties.get('SuccessExitStatus') ?? '')
          .split(/\s+/)
          .map(Number)
          .filter((code) => Number.isInteger(code)),
      });
    });
  });
}

/**
 * Whether exiting `RESTART_EXIT_CODE` under this configuration brings the bot
 * back.
 *
 * Only `always` and `on-failure` count: `on-abnormal` and `on-watchdog`
 * restart on signals and timeouts but not on a non-zero exit, and `on-success`
 * is the opposite of what we need.
 *
 * `SuccessExitStatus` is the trap. Naming 75 there makes an intentional
 * restart read as a clean exit in the journal, which is why the shipped unit
 * does it — but it also means `on-failure` would no longer see a failure to
 * act on. The two settings are only safe together with `Restart=always`.
 */
export function willRestartOnRequestedExit(behaviour: RestartBehaviour): boolean {
  if (behaviour.policy === 'always') return true;
  if (behaviour.policy !== 'on-failure') return false;
  return !behaviour.successExitStatuses.includes(RESTART_EXIT_CODE);
}

/** The shell command an operator would run to restart this unit by hand. */
export function manualRestartCommand(unit: SystemdUnit): string {
  return `systemctl ${unit.user ? '--user ' : ''}restart ${unit.name}`;
}
