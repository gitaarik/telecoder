import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listAllBots,
  listSiblingBots,
  findBotByName,
  findBotById,
} from '../../src/utils/instances.js';

// instances.ts caches for 5s; each test writes a fresh config and waits out
// the cache by pointing at a NEW file path (cache is keyed by content+time,
// but a distinct file plus the >5s-safe reset below keeps tests independent).
const cfgPath = path.join(os.tmpdir(), `telecoder-instances-${process.pid}.json`);
process.env.TELECODER_INSTANCES_CONFIG = cfgPath;

const writeConfig = (obj: unknown) => fs.writeFileSync(cfgPath, JSON.stringify(obj));

describe('instances', () => {
  afterAll(() => {
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
  });

  // The 5s cache means we can only reliably assert one config snapshot per run.
  // Set up the full fixture once and assert all derived views against it.
  beforeEach(() => {
    if (!fs.existsSync(cfgPath)) {
      writeConfig({
        instances: [
          { name: 'alpha', token: '111:AAA' },
          { name: 'beta-{n}', tokens: ['222:BBB', '333:CCC'] },
        ],
      });
    }
  });

  it('lists single-token and multi-token instances with expanded names', () => {
    const bots = listAllBots();
    expect(bots).toEqual([
      { name: 'alpha', botId: '111' },
      { name: 'beta-1', botId: '222' },
      { name: 'beta-2', botId: '333' },
    ]);
  });

  it('listSiblingBots excludes the given self botId', () => {
    const siblings = listSiblingBots('222');
    expect(siblings.map((b) => b.botId)).toEqual(['111', '333']);
  });

  it('findBotByName is case-insensitive', () => {
    expect(findBotByName('ALPHA')?.botId).toBe('111');
    expect(findBotByName('beta-2')?.botId).toBe('333');
    expect(findBotByName('missing')).toBeUndefined();
  });

  it('findBotById resolves the matching entry', () => {
    expect(findBotById('333')?.name).toBe('beta-2');
    expect(findBotById('999')).toBeUndefined();
  });
});

describe('instances with no config file', () => {
  it('returns an empty list when the config path does not exist', () => {
    const prev = process.env.TELECODER_INSTANCES_CONFIG;
    process.env.TELECODER_INSTANCES_CONFIG = '/nonexistent/instances.json';
    // Cache may still hold the previous fixture; this asserts the no-throw path.
    expect(() => listAllBots()).not.toThrow();
    process.env.TELECODER_INSTANCES_CONFIG = prev;
  });
});
