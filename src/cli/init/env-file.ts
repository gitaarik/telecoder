/**
 * Reading, writing and backing up the .env `telecoder init` produces.
 *
 * A fresh file holds only what the wizard asked about, under a header pointing
 * at .env.example for everything else. Editing an existing file changes the
 * lines for the keys that changed and leaves every other line — comments,
 * settings the wizard never asks about — exactly as it was.
 *
 * The file is written 0600 in a 0700 directory: it holds the bot token.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A value of undefined removes the key. */
export type EnvUpdates = Record<string, string | undefined>;

export const ENV_HEADER = [
  '# TeleCoder configuration, written by `telecoder init`.',
  '#',
  '# Only the settings the wizard asked about are here; everything else runs on',
  '# its default. Every setting, with what it does, is listed in .env.example',
  '# (in the package, or https://github.com/gitaarik/telecoder/blob/main/.env.example)',
  '# and in the Configuration Reference: https://telecoder.dev',
  '# Run `telecoder init` again to change these, or edit this file by hand.',
];

/** Quote a value only when dotenv would otherwise misread it. */
export function formatValue(value: string): string {
  if (value === '' || /^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderEnv(values: Record<string, string>): string {
  const lines = [...ENV_HEADER, ''];
  for (const [key, value] of Object.entries(values)) lines.push(`${key}=${formatValue(value)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Apply `updates` to the text of an existing .env: replace the first active
 * `KEY=` line of each key (dropping any later duplicates, which would win),
 * remove the lines of keys set to undefined, and append keys not there yet.
 */
export function updateEnvText(text: string, updates: EnvUpdates): string {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (key === undefined || !Object.hasOwn(updates, key)) {
      out.push(line);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    const value = updates[key];
    if (value !== undefined) out.push(`${key}=${formatValue(value)}`);
  }
  const added = Object.entries(updates).filter(([key, value]) => !done.has(key) && value !== undefined);
  if (added.length) {
    if (out.length && out.at(-1)?.trim() !== '') out.push('');
    for (const [key, value] of added) out.push(`${key}=${formatValue(value as string)}`);
  }
  return `${out.join('\n')}\n`;
}

/** `.env.bak-20261113-142501`: sorts by time, and says what it was. */
export function backupName(file: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${file}.bak-${stamp}`;
}

/** Copy `file` aside, keeping it private. Returns the backup's path. */
export function backupFile(file: string, now?: Date): string {
  const backup = backupName(file, now);
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  return backup;
}

/**
 * Write the .env privately. The directory is created 0700; an existing one is
 * tightened to 0700 only when it is the config home TeleCoder made (not a
 * source checkout, whose directory other things live in).
 */
export function writeEnvFile(file: string, content: string, { ownDir }: { ownDir: boolean }): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (ownDir) fs.chmodSync(dir, 0o700);
  // Write beside it and rename, so a crash never leaves half a config — and
  // create it 0600 so the token is never readable, not even for a moment.
  const tmp = path.join(dir, `.env.init-${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
