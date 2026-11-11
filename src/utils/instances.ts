/**
 * Read instances.json so any running worker can enumerate its sibling bots
 * (name + botId). The launcher exports the resolved config path through
 * TELECODER_INSTANCES_CONFIG so workers don't have to reproduce its
 * --config flag handling.
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { stripJsonComments, expandName, withInstanceAdded, type ResolvedInstance } from './instance-config.js';
import { legacyEnv } from './legacy-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/utils/instances.ts → projectRoot; dist/utils/instances.js → projectRoot
const projectRoot = path.resolve(__dirname, '..', '..');

export interface BotInstance {
  name: string;
  botId: string;
}

interface RawEntry {
  name: string;
  token?: string;
  tokens?: string[];
}

interface RawConfig {
  instances?: RawEntry[];
}

let cached: BotInstance[] | null = null;
let cachedAtMs = 0;
const CACHE_TTL_MS = 5_000;

function configPath(): string {
  return legacyEnv('INSTANCES_CONFIG') || path.join(projectRoot, 'instances.json');
}

/**
 * Read instances.json and return one entry per configured bot. Short-lived
 * cache so a chat session that lists bots repeatedly doesn't hammer the disk.
 */
export function listAllBots(): BotInstance[] {
  const now = Date.now();
  if (cached && now - cachedAtMs < CACHE_TTL_MS) return cached;

  const cfgPath = configPath();
  if (!existsSync(cfgPath)) {
    cached = [];
    cachedAtMs = now;
    return cached;
  }

  let parsed: RawConfig;
  try {
    const raw = readFileSync(cfgPath, 'utf-8');
    parsed = JSON.parse(stripJsonComments(raw)) as RawConfig;
  } catch (err) {
    console.warn('[Instances] Failed to read instances.json:', err instanceof Error ? err.message : err);
    cached = [];
    cachedAtMs = now;
    return cached;
  }

  const out: BotInstance[] = [];
  for (const entry of parsed.instances ?? []) {
    if (entry.tokens?.length) {
      const total = entry.tokens.length;
      entry.tokens.forEach((token, i) => {
        const botId = token.split(':')[0];
        if (!botId) return;
        out.push({ name: expandName(entry.name, i + 1, total), botId });
      });
    } else if (entry.token) {
      const botId = entry.token.split(':')[0];
      if (!botId) continue;
      out.push({ name: entry.name, botId });
    }
  }

  cached = out;
  cachedAtMs = now;
  return cached;
}

/**
 * Bots other than this one. `selfBotId` defaults to the current worker's
 * BOT_ID derived from its token.
 */
export function listSiblingBots(selfBotId: string): BotInstance[] {
  return listAllBots().filter((b) => b.botId !== selfBotId);
}

/** Resolve a name to its botId, case-insensitive. Used by /accept etc. */
export function findBotByName(name: string): BotInstance | undefined {
  const lower = name.toLowerCase();
  return listAllBots().find((b) => b.name.toLowerCase() === lower);
}

export function findBotById(botId: string): BotInstance | undefined {
  return listAllBots().find((b) => b.botId === botId);
}

/**
 * Add a bot to instances.json, which the launcher watches: it starts the bot
 * a few seconds later. Written to a temporary file and renamed into place, so
 * the launcher never reads half a file. Returns the name it got, which has a
 * number after it if another bot had the name already. Throws
 * InstancesConfigError when the file can't take it as it stands.
 */
export function addInstance(entry: ResolvedInstance): string {
  const cfgPath = configPath();
  const { text, name } = withInstanceAdded(readFileSync(cfgPath, 'utf-8'), entry);
  const tmp = `${cfgPath}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, cfgPath);
  cached = null;
  return name;
}
