import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { createKeyedSettings } from '../../src/utils/keyed-settings.js';

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

  const make = () =>
    createKeyedSettings<Demo>({
      file: 'demo.json',
      label: 'Demo',
      dir,
      entrySchema,
      normalize: (stored) => ({
        enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : defaultEnabled,
        voice: typeof stored?.voice === 'string' && stored.voice.length > 0 ? stored.voice : 'fallback',
      }),
    });

  const fileContents = () =>
    JSON.parse(fs.readFileSync(path.join(dir, 'demo.json'), 'utf-8'));

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
    expect(fs.existsSync(path.join(dir, 'demo.json'))).toBe(false);
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
    fs.writeFileSync(
      path.join(dir, 'demo.json'),
      JSON.stringify({ settings: { 'chat:7': { enabled: true, voice: 'shimmer' } } }),
    );
    expect(make().get('chat:7')).toEqual({ enabled: true, voice: 'shimmer' });
  });

  it('normalizes partial entries loaded from disk', () => {
    fs.writeFileSync(
      path.join(dir, 'demo.json'),
      JSON.stringify({ settings: { 'chat:7': { enabled: true } } }),
    );
    expect(make().get('chat:7')).toEqual({ enabled: true, voice: 'fallback' });
  });

  it('starts fresh when the file fails validation', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(dir, 'demo.json'),
      JSON.stringify({ settings: { 'chat:7': { enabled: 'yes please' } } }),
    );
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
    expect(fs.existsSync(path.join(nested, 'demo.json'))).toBe(true);
  });
});
