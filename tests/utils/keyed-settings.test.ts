import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { createKeyedSettings } from '../../src/utils/keyed-settings.js';
import { BOT_ID } from '../../src/config.js';

interface Demo {
  enabled: boolean;
  voice: string;
}

describe('createKeyedSettings', () => {
  let dir: string;
  let defaultEnabled: boolean;

  const entrySchema = z.object({
    enabled: z.boolean().optional(),
    voice: z.string().optional(),
  });

  /** Each store stands in for one bot's process: its own copy of the entries, on a shared state dir. */
  const make = (botId = 'bot-1') =>
    createKeyedSettings<Demo>({
      file: 'demo.json',
      label: 'Demo',
      dir,
      botId,
      entrySchema,
      normalize: (stored) => ({
        enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : defaultEnabled,
        voice: typeof stored?.voice === 'string' && stored.voice.length > 0 ? stored.voice : 'fallback',
      }),
    });

  const ownFile = (botId = 'bot-1') => path.join(dir, `demo-${botId}.json`);
  const sharedFile = () => path.join(dir, 'demo.json');
  const contents = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
  const fileContents = () => contents(ownFile());
  const write = (file: string, settings: unknown) => fs.writeFileSync(file, JSON.stringify({ settings }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-ks-'));
    defaultEnabled = false;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns normalized defaults for an unknown key', () => {
    expect(make().get('chat:1')).toEqual({ enabled: false, voice: 'fallback' });
  });

  it('does not write anything just for reading', () => {
    make().get('chat:1');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps tracking the env default until the key is explicitly set', () => {
    const store = make();
    expect(store.get('chat:1').enabled).toBe(false);

    // Simulates an operator flipping the config default between reads: a key
    // that never opted in must follow it rather than freeze the old value.
    defaultEnabled = true;
    expect(store.get('chat:1').enabled).toBe(true);

    store.update('chat:1', { enabled: false });
    defaultEnabled = true;
    expect(store.get('chat:1').enabled).toBe(false);
  });

  it('persists an update and reloads it in a fresh store', () => {
    make().update('chat:1', { voice: 'nova' });
    expect(make().get('chat:1')).toEqual({ enabled: false, voice: 'nova' });
  });

  it('merges patches instead of replacing the entry', () => {
    const store = make();
    store.update('chat:1', { voice: 'nova' });
    store.update('chat:1', { enabled: true });
    expect(store.get('chat:1')).toEqual({ enabled: true, voice: 'nova' });
  });

  it('keeps entries for different keys separate', () => {
    const store = make();
    store.update('chat:1', { voice: 'nova' });
    store.update('chat:2', { voice: 'echo' });
    expect(store.get('chat:1').voice).toBe('nova');
    expect(store.get('chat:2').voice).toBe('echo');
    expect(Object.keys(fileContents().settings)).toEqual(['chat:1', 'chat:2']);
  });

  it('writes the { settings: { key: entry } } shape the old stores used', () => {
    make().update('chat:1', { enabled: true, voice: 'nova' });
    expect(fileContents()).toEqual({ settings: { 'chat:1': { enabled: true, voice: 'nova' } } });
  });

  it('reads a file written by the previous hand-rolled implementation', () => {
    write(ownFile(), { 'chat:7': { enabled: true, voice: 'shimmer' } });
    expect(make().get('chat:7')).toEqual({ enabled: true, voice: 'shimmer' });
  });

  it('normalizes partial entries loaded from disk', () => {
    write(ownFile(), { 'chat:7': { enabled: true } });
    expect(make().get('chat:7')).toEqual({ enabled: true, voice: 'fallback' });
  });

  it('starts fresh when the file fails validation', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    write(ownFile(), { 'chat:7': { enabled: 'yes please' } });
    expect(make().get('chat:7')).toEqual({ enabled: false, voice: 'fallback' });
  });

  it('rejects an empty key', () => {
    expect(() => make().get('')).toThrow(/Invalid settings key/);
    expect(() => make().update('', { enabled: true })).toThrow(/Invalid settings key/);
  });

  it('creates the state directory on first write', () => {
    const nested = path.join(dir, 'fresh');
    const store = createKeyedSettings<Demo>({
      file: 'demo.json',
      label: 'Demo',
      dir: nested,
      entrySchema,
      normalize: () => ({ enabled: false, voice: 'fallback' }),
    });
    store.update('chat:1', { enabled: true });
    expect(fs.existsSync(path.join(nested, `demo-${BOT_ID}.json`))).toBe(true);
  });

  describe('with several bots on one state directory', () => {
    it("keeps a setting when another bot saves a different one for the same chat", () => {
      const first = make('bot-1');
      const second = make('bot-2');
      first.update('chat:1', { voice: 'nova' });
      second.update('chat:1', { enabled: true });
      expect(make('bot-1').get('chat:1').voice).toBe('nova');
    });

    it('keeps a setting when another bot saves one for a different chat', () => {
      const first = make('bot-1');
      const second = make('bot-2');
      first.update('chat:1', { voice: 'nova' });
      second.update('chat:2', { voice: 'echo' });
      expect(make('bot-1').get('chat:1').voice).toBe('nova');
    });

    it('leaves a setting with the bot it was set on', () => {
      make('bot-1').update('chat:1', { voice: 'nova' });
      expect(make('bot-2').get('chat:1').voice).toBe('fallback');
    });
  });

  describe('on the first start after settings became per-bot', () => {
    it('inherits what the shared file holds, so nothing resets', () => {
      write(sharedFile(), { 'chat:7': { enabled: true, voice: 'shimmer' } });
      expect(make().get('chat:7')).toEqual({ enabled: true, voice: 'shimmer' });
    });

    it('gives every bot its own copy and leaves the shared file as it was', () => {
      write(sharedFile(), { 'chat:7': { voice: 'shimmer' } });
      const before = fs.readFileSync(sharedFile(), 'utf-8');

      make('bot-1');
      make('bot-2');

      expect(contents(ownFile('bot-1'))).toEqual({ settings: { 'chat:7': { voice: 'shimmer' } } });
      expect(contents(ownFile('bot-2'))).toEqual({ settings: { 'chat:7': { voice: 'shimmer' } } });
      expect(fs.readFileSync(sharedFile(), 'utf-8')).toBe(before);
    });

    it('no longer needs the shared file afterwards', () => {
      write(sharedFile(), { 'chat:7': { voice: 'shimmer' } });
      make();
      fs.rmSync(sharedFile());
      expect(make().get('chat:7').voice).toBe('shimmer');
    });

    it('keeps a field nobody chose following its default', () => {
      write(sharedFile(), { 'chat:7': { voice: 'shimmer' } });
      make();
      defaultEnabled = true;
      expect(make().get('chat:7')).toEqual({ enabled: true, voice: 'shimmer' });
    });

    it("doesn't go back to the shared file once the bot has its own", () => {
      write(sharedFile(), { 'chat:7': { voice: 'shimmer' } });
      make();
      write(sharedFile(), { 'chat:7': { voice: 'echo' } });
      expect(make().get('chat:7').voice).toBe('shimmer');
    });

    it("doesn't fall back to the shared file when the bot's own is unreadable", () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      write(sharedFile(), { 'chat:7': { voice: 'shimmer' } });
      write(ownFile(), { 'chat:7': { enabled: 'yes please' } });
      expect(make().get('chat:7').voice).toBe('fallback');
    });
  });
});
