import * as fs from 'fs';

const CLK_TCK = 100;

export interface ProcInfo {
  pid: number;
  ppid: number;
  cmd: string;
  argv: string[];
  ageSec: number;
}

export function getDirectChildren(pid: number): number[] {
  let tids: string[];
  try {
    tids = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const out = new Set<number>();
  for (const tid of tids) {
    try {
      const content = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8');
      for (const part of content.trim().split(/\s+/)) {
        if (!part) continue;
        const child = Number.parseInt(part, 10);
        if (Number.isFinite(child)) out.add(child);
      }
    } catch { /* tid raced away */ }
  }
  return [...out].sort((a, b) => a - b);
}

export function getDescendantPids(rootPid: number): number[] {
  const out: number[] = [];
  const queue: number[] = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const child of getDirectChildren(cur)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export function describeProcess(pid: number): ProcInfo | undefined {
  let argvRaw: Buffer;
  let statRaw: string;
  try {
    argvRaw = fs.readFileSync(`/proc/${pid}/cmdline`);
    statRaw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  const argv = argvRaw.toString('utf8').split('\0').filter(Boolean);
  if (argv.length === 0) return undefined;

  // /proc/<pid>/stat: "<pid> (<comm>) <state> <ppid> ..."
  // comm can contain spaces and parens, so split after the LAST ')'.
  const lastParen = statRaw.lastIndexOf(')');
  const fields = statRaw.substring(lastParen + 2).split(' ');
  const ppid = Number.parseInt(fields[1], 10) || 0;
  // starttime is stat field 22 (1-indexed). After dropping pid, comm, and the
  // post-')' state field, the offset into `fields` is 19.
  const startTimeTicks = Number.parseInt(fields[19], 10);

  let ageSec = 0;
  try {
    const uptimeSec = Number.parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    if (Number.isFinite(startTimeTicks) && Number.isFinite(uptimeSec)) {
      ageSec = Math.max(0, Math.round(uptimeSec - startTimeTicks / CLK_TCK));
    }
  } catch { /* keep 0 */ }

  return { pid, ppid, cmd: argv.join(' '), argv, ageSec };
}

export function isDescendantOf(rootPid: number, candidatePid: number): boolean {
  if (rootPid === candidatePid) return false;
  let cur = candidatePid;
  for (let i = 0; i < 64; i++) {
    const info = describeProcess(cur);
    if (!info || info.ppid <= 1) return false;
    if (info.ppid === rootPid) return true;
    cur = info.ppid;
  }
  return false;
}

export function killTree(rootPid: number, signal: NodeJS.Signals = 'SIGTERM'): number {
  // Leaves first — otherwise the kernel reparents live grandchildren to init
  // before we get to them.
  const targets = [...getDescendantPids(rootPid), rootPid].reverse();
  let killed = 0;
  for (const pid of targets) {
    try {
      process.kill(pid, signal);
      killed++;
    } catch { /* already gone or no perms */ }
  }
  return killed;
}
