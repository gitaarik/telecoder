import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let stateDir: string;

vi.mock('../../src/utils/json-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/json-store.js')>();
  return { ...actual, getStateDir: () => stateDir };
});

async function load() {
  vi.resetModules();
  return import('../../src/claude/in-flight-tracker.js');
}

describe('runAfterTurn', () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-inflight-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('runs once, when the turn in that session ends', async () => {
    const t = await load();
    const action = vi.fn();
    t.markInFlight('42:1', 'hi');
    t.markInFlight('42:2', 'hi');
    t.runAfterTurn('42:1', action);

    t.clearInFlight('42:2');
    expect(action).not.toHaveBeenCalled();

    t.clearInFlight('42:1');
    expect(action).toHaveBeenCalledTimes(1);
    t.markInFlight('42:1', 'again');
    t.clearInFlight('42:1');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest action for a session', async () => {
    const t = await load();
    const first = vi.fn();
    const second = vi.fn();
    t.runAfterTurn('42:1', first);
    t.runAfterTurn('42:1', second);

    t.clearInFlight('42:1');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clears the turn even when the action throws', async () => {
    const t = await load();
    t.markInFlight('42:1', 'hi');
    t.runAfterTurn('42:1', () => { throw new Error('boom'); });

    expect(() => t.clearInFlight('42:1')).not.toThrow();
    expect(t.isInFlight('42:1')).toBe(false);
  });
});
