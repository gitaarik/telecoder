/**
 * How much memory the machine has left, read the way the kernel means it.
 *
 * Node's os.freemem() is "MemFree": what nobody has touched. On Linux that is
 * nearly always small, because the kernel keeps every page it can as file
 * cache and gives it back on demand. "MemAvailable" is the kernel's own
 * estimate of what a new process can have without swapping, and the number
 * `free -m` prints under "available". That is the one that says whether
 * another claude fits.
 */

import fs from 'fs';
import os from 'os';

export interface MemoryReading {
  totalMB: number;
  /** What a new process can claim without pushing the machine into swap. */
  availableMB: number;
  swapTotalMB: number;
  swapUsedMB: number;
}

const KB_PER_MB = 1024;

/** Parse the text of /proc/meminfo. Exported for tests. */
export function parseMeminfo(text: string): MemoryReading | null {
  const kb = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb.set(m[1]!, Number(m[2]));
  }
  const total = kb.get('MemTotal');
  const available = kb.get('MemAvailable');
  if (total === undefined || available === undefined) return null;
  const swapTotal = kb.get('SwapTotal') ?? 0;
  const swapFree = kb.get('SwapFree') ?? swapTotal;
  return {
    totalMB: Math.round(total / KB_PER_MB),
    availableMB: Math.round(available / KB_PER_MB),
    swapTotalMB: Math.round(swapTotal / KB_PER_MB),
    swapUsedMB: Math.round((swapTotal - swapFree) / KB_PER_MB),
  };
}

/**
 * The machine's memory right now, or null when it can't be read. Off Linux
 * there is no MemAvailable; os.freemem() stands in, which errs on the side of
 * looking tight.
 */
export function readMemory(): MemoryReading | null {
  try {
    const parsed = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (parsed) return parsed;
  } catch {
    // not Linux, or /proc unreadable
  }
  const total = os.totalmem();
  const free = os.freemem();
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    totalMB: Math.round(total / 1024 / 1024),
    availableMB: Math.round(free / 1024 / 1024),
    swapTotalMB: 0,
    swapUsedMB: 0,
  };
}
