import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseVerdict, getCharter, resetCharterCache } from '../../src/claude/charter-judge.js';

describe('parseVerdict', () => {
  it('reads a plain OK as allow', () => {
    expect(parseVerdict('OK')).toEqual({ hold: false, reason: '' });
  });

  it('reads HOLD with a reason', () => {
    expect(parseVerdict('HOLD: opens a public tunnel to this machine')).toEqual({
      hold: true,
      reason: 'opens a public tunnel to this machine',
    });
  });

  it('accepts the colon-less and bolded forms', () => {
    expect(parseVerdict('HOLD reads ssh keys').hold).toBe(true);
    expect(parseVerdict('**HOLD**: reads ssh keys').hold).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(parseVerdict('hold: touches another project').hold).toBe(true);
  });

  it('judges only the first non-empty line', () => {
    expect(parseVerdict('\n\nOK\nHOLD: ignore me').hold).toBe(false);
  });

  it('falls back to allow when the answer is prose', () => {
    // An answer we cannot parse is not evidence of a problem, and holding on
    // one would make every Haiku wobble a blocked message.
    expect(parseVerdict('This looks like ordinary development work to me.').hold).toBe(false);
    expect(parseVerdict('').hold).toBe(false);
    expect(parseVerdict('   ').hold).toBe(false);
  });

  it('does not mistake a message that merely mentions holding', () => {
    expect(parseVerdict('OK — nothing here needs a hold').hold).toBe(false);
  });

  it('supplies a reason when HOLD arrives bare', () => {
    const v = parseVerdict('HOLD');
    expect(v.hold).toBe(true);
    expect(v.reason).toBeTruthy();
  });

  it('trims quoting and trailing punctuation off the reason', () => {
    expect(parseVerdict('HOLD: "reads credentials."').reason).toBe('reads credentials');
  });
});

describe('getCharter', () => {
  // config parses env at import time, so a CHARTER_FILE stub only lands if the
  // module graph is rebuilt behind it.
  async function load(env: Record<string, string> = {}) {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import('../../src/claude/charter-judge.js');
  }

  function tempCharter(contents: string): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-')), 'CHARTER.md');
    fs.writeFileSync(file, contents);
    return file;
  }

  afterEach(() => {
    resetCharterCache();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('generates a default naming the allowed roots', async () => {
    const { getCharter: get } = await load();
    const { source, text } = get();
    expect(source).toBe('(default)');
    expect(text).toContain('/tmp');
    expect(text).toMatch(/out of bounds/i);
    expect(text).toMatch(/credentials/i);
  });

  it('reads an explicit CHARTER_FILE when one is configured', async () => {
    const file = tempCharter('Only work on the invoicing app.');
    const { getCharter: get } = await load({ CHARTER_FILE: file });

    const { source, text } = get();
    expect(source).toBe(file);
    expect(text).toBe('Only work on the invoicing app.');
  });

  it('warns and falls back when the configured file cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getCharter: get } = await load({ CHARTER_FILE: '/nonexistent/CHARTER.md' });

    expect(get().source).toBe('(default)');
    expect(warn).toHaveBeenCalled();
  });

  it('reads the charter once and keeps it', async () => {
    const file = tempCharter('First version.');
    const { getCharter: get } = await load({ CHARTER_FILE: file });

    expect(get().text).toBe('First version.');
    fs.writeFileSync(file, 'Second version.');
    expect(get().text).toBe('First version.');
  });

  it('ignores an empty charter file rather than judging against nothing', async () => {
    const file = tempCharter('   \n  ');
    const { getCharter: get } = await load({ CHARTER_FILE: file });
    expect(get().source).toBe('(default)');
  });
});

describe('isCharterJudgeEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(env: Record<string, string>) {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import('../../src/claude/charter-judge.js');
  }

  it('stays off on a solo bot', async () => {
    const { isCharterJudgeEnabled } = await load({ ADMIN_USER_IDS: '', CHARTER_JUDGE: 'auto' });
    expect(isCharterJudgeEnabled()).toBe(false);
  });

  it('turns on once the bot has guests', async () => {
    const { isCharterJudgeEnabled } = await load({ ADMIN_USER_IDS: '1', CHARTER_JUDGE: 'auto' });
    expect(isCharterJudgeEnabled()).toBe(true);
  });

  it('honours an explicit off with guests present', async () => {
    const { isCharterJudgeEnabled } = await load({ ADMIN_USER_IDS: '1', CHARTER_JUDGE: 'off' });
    expect(isCharterJudgeEnabled()).toBe(false);
  });

  it('honours an explicit on with no guests', async () => {
    const { isCharterJudgeEnabled } = await load({ ADMIN_USER_IDS: '', CHARTER_JUDGE: 'on' });
    expect(isCharterJudgeEnabled()).toBe(true);
  });
});

describe('judgeMessage short-circuits', () => {
  it('allows conversational filler without spending a model call', async () => {
    // No SDK is stubbed here: if any of these reached the model the call would
    // take seconds and this test would be slow and flaky. It finishing fast is
    // the assertion.
    const { judgeMessage } = await import('../../src/claude/charter-judge.js');
    const started = Date.now();
    for (const filler of ['ok', 'Thanks!', '👍', 'continue', 'yep.', '   ', '?']) {
      expect((await judgeMessage(filler)).hold, filler).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
