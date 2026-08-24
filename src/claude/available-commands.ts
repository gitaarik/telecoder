/**
 * What slash commands and skills a working directory actually offers.
 *
 * Claude Code reports this on the SDK init message — `slash_commands` (every
 * name the CLI will accept, built-ins and plugin commands and
 * `.claude/commands/` alike) and `skills` (the subset backed by a skill, e.g.
 * `code-review`). There is no CLI flag that prints either list, and the
 * session JSONL doesn't carry them, so the init message is the only source.
 *
 * SDK-mode turns record it for free. PTY-mode sessions never produce an init
 * message, so `probeAvailableCommands` spawns a throwaway headless process to
 * fetch one. The probe runs `/usage` — a command the CLI answers locally, with
 * no model call and no cost — and we kill the process the moment init arrives.
 */

import { spawn } from 'child_process';
import { sanitizeError } from '../utils/sanitize.js';

export interface AvailableCommands {
  /** Every slash command name the CLI accepts, without the leading `/`. */
  slashCommands: string[];
  /** The subset of `slashCommands` backed by a skill. */
  skills: string[];
  /** When this snapshot was taken. */
  recordedAtMs: number;
}

/**
 * Cached per (binary, working directory) rather than per session: the answer
 * depends on the project's `.claude/`, its plugins and the CLI build, none of
 * which vary between two chats pointed at the same directory — but the two
 * modes do not share a binary. SDK mode runs the bundled CLI from
 * node_modules, PTY mode runs whatever `claude` is on PATH, and their command
 * sets drift apart between releases (2.1.140 has no `/code-review`; 2.1.241
 * does). Listing one mode's commands while the other is active would name
 * commands that do not exist.
 */
const cache = new Map<string, AvailableCommands>();

function cacheKey(executable: string, workingDirectory: string): string {
  return `${executable}\u0000${workingDirectory}`;
}

/** Re-probe rather than serve a snapshot older than this. */
const STALE_AFTER_MS = 30 * 60 * 1000;

/** How long to wait for the probe's init line before giving up. */
const PROBE_TIMEOUT_MS = 20_000;

/** In-flight probes, so N concurrent /projectcommands spawn one process. */
const inFlight = new Map<string, Promise<AvailableCommands | undefined>>();

/** Record what an SDK init message reported for `workingDirectory`. */
export function recordAvailableCommands(
  workingDirectory: string,
  executable: string,
  slashCommands: string[] | undefined,
  skills: string[] | undefined,
): void {
  if (!workingDirectory || !Array.isArray(slashCommands)) return;
  cache.set(cacheKey(executable, workingDirectory), {
    slashCommands: [...slashCommands],
    skills: Array.isArray(skills) ? [...skills] : [],
    recordedAtMs: Date.now(),
  });
}

/** Cached snapshot for `workingDirectory` under `executable`, if recent. */
export function getCachedAvailableCommands(
  workingDirectory: string,
  executable: string,
): AvailableCommands | undefined {
  const hit = cache.get(cacheKey(executable, workingDirectory));
  if (!hit) return undefined;
  return Date.now() - hit.recordedAtMs > STALE_AFTER_MS ? undefined : hit;
}

/**
 * The cached snapshot, probing for one if the cache is cold or stale.
 * Resolves to undefined when the probe fails — callers fall back to whatever
 * they can list without it.
 */
export async function getAvailableCommands(
  workingDirectory: string,
  executable: string,
): Promise<AvailableCommands | undefined> {
  const cached = getCachedAvailableCommands(workingDirectory, executable);
  if (cached) return cached;

  const key = cacheKey(executable, workingDirectory);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const probe = probeAvailableCommands(workingDirectory, executable)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, probe);
  return probe;
}

/**
 * Spawn a headless CLI, read the init message, kill it. Costs nothing: the
 * prompt is a locally-handled slash command, and we send SIGTERM as soon as
 * the first line parses.
 */
async function probeAvailableCommands(
  workingDirectory: string,
  executable: string,
): Promise<AvailableCommands | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';

    const finish = (result: AvailableCommands | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve(result);
    };

    const child = spawn(
      executable,
      ['-p', '/usage', '--output-format', 'stream-json', '--verbose'],
      { cwd: workingDirectory, stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const timer = setTimeout(() => {
      console.warn(`[AvailableCommands] probe timed out after ${PROBE_TIMEOUT_MS}ms`);
      finish(undefined);
    }, PROBE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let msg: { subtype?: string; slash_commands?: string[]; skills?: string[] };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not our line — the CLI can print other things first
        }
        if (msg.subtype !== 'init') continue;
        recordAvailableCommands(workingDirectory, executable, msg.slash_commands, msg.skills);
        finish(getCachedAvailableCommands(workingDirectory, executable));
        return;
      }
    });

    child.on('error', (err) => {
      console.warn(`[AvailableCommands] probe failed to spawn: ${sanitizeError(err)}`);
      finish(undefined);
    });

    child.on('close', () => finish(undefined));
  });
}

/**
 * Split a snapshot into the groups worth showing separately.
 *
 * `slash_commands` is a flat list; `skills` marks which of them are skills,
 * and a `plugin:command` name marks a plugin's. Whatever is left is a CLI
 * built-in (`clear`, `compact`, `model`, …).
 */
export function groupAvailableCommands(snapshot: AvailableCommands): {
  skills: string[];
  plugins: string[];
  builtIns: string[];
} {
  const skillSet = new Set(snapshot.skills);
  const skills: string[] = [];
  const plugins: string[] = [];
  const builtIns: string[] = [];

  for (const name of snapshot.slashCommands) {
    if (name.includes(':')) plugins.push(name);
    else if (skillSet.has(name)) skills.push(name);
    else builtIns.push(name);
  }

  return {
    skills: skills.sort(),
    plugins: plugins.sort(),
    builtIns: builtIns.sort(),
  };
}
