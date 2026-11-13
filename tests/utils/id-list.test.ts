import { describe, it, expect } from 'vitest';
import { parseIdList, PLACEHOLDER_USER_ID } from '../../src/utils/id-list.js';

describe('parseIdList', () => {
  it('parses comma-separated ids, ignoring spaces and empty entries', () => {
    expect(parseIdList('ALLOWED_USER_IDS', ' 111, 222 ,,333 ')).toEqual({ ok: true, ids: [111, 222, 333] });
  });

  it('returns an empty list for an empty string', () => {
    expect(parseIdList('ADMIN_USER_IDS', '')).toEqual({ ok: true, ids: [] });
  });

  it('accepts negative group ids', () => {
    expect(parseIdList('ALLOWED_GROUP_IDS', '-1001234567890', 'group')).toEqual({ ok: true, ids: [-1001234567890] });
  });

  it('rejects a @username with a plain-language explanation', () => {
    const result = parseIdList('ALLOWED_USER_IDS', '111,@alice');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ALLOWED_USER_IDS contains "@alice", which is not a number');
    expect(result.error).toContain('usernames');
    expect(result.error).toContain('numeric Telegram user id');
    expect(result.error).toContain('@userinfobot');
  });

  it('rejects other non-numeric entries, including partial numbers', () => {
    expect(parseIdList('ADMIN_USER_IDS', 'abc').ok).toBe(false);
    expect(parseIdList('ADMIN_USER_IDS', '123abc').ok).toBe(false);
    expect(parseIdList('ADMIN_USER_IDS', '1.5').ok).toBe(false);
  });

  it('refuses the .env.example placeholder', () => {
    const result = parseIdList('ALLOWED_USER_IDS', `${PLACEHOLDER_USER_ID}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('example value from .env.example');
  });

  it('does not treat the placeholder digits as special in a group id', () => {
    expect(parseIdList('ALLOWED_GROUP_IDS', '-123456789', 'group').ok).toBe(true);
  });
});
