import { spawn, ChildProcess } from 'child_process';

let caffeinateProcess: ChildProcess | null = null;

export function preventSleep(): void {
  if (process.platform !== 'darwin') {
    console.log('[Caffeinate] Not on macOS, skipping sleep prevention');
    return;
  }

  if (caffeinateProcess) {
    console.log('[Caffeinate] Already running');
    return;
  }

  try {
    // -i keeps the Mac from idle-sleeping, which would take the bot offline.
    // The display may still sleep: a bot needs no screen, and -d kept it lit
    // for as long as the bot ran. -w ends caffeinate with this process, so a
    // crash or a kill that skips allowSleep() doesn't leave the Mac awake.
    caffeinateProcess = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: true,
    });

    caffeinateProcess.unref();

    caffeinateProcess.on('error', (err) => {
      console.error('[Caffeinate] Error:', err.message);
      caffeinateProcess = null;
    });

    caffeinateProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.log('[Caffeinate] Exited with code:', code);
      }
      caffeinateProcess = null;
    });

    console.log('[Caffeinate] Preventing idle sleep while the bot runs');
  } catch (error) {
    console.error('[Caffeinate] Failed to start:', error);
  }
}

export function allowSleep(): void {
  if (caffeinateProcess) {
    try {
      caffeinateProcess.kill();
    } catch {
      // Ignore errors when killing process
    }
    caffeinateProcess = null;
    console.log('[Caffeinate] Sleep prevention disabled');
  }
}

export function isPreventingSleep(): boolean {
  return caffeinateProcess !== null;
}
