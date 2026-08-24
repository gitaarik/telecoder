import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Api } from 'grammy';
import {
  resolveAdminsInChat,
  appendApproverLine,
  describeResponderRefusal,
  resetAdminNameCache,
} from '../../src/telegram/admin-mention.js';
import { EntityText } from '../../src/telegram/entities.js';

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3 and no ADMIN_USER_IDS,
// so the roster here is [1, 2, 3].
const CHAT = -1009990001;

function fakeApi(members: Record<number, { first_name?: string; last_name?: string; username?: string }>) {
  const getChatMember = vi.fn(async (_chatId: number, userId: number) => {
    const user = members[userId];
    if (!user) throw new Error('user not found');
    return { status: 'member', user: { id: userId, is_bot: false, ...user } };
  });
  return { api: { getChatMember } as unknown as Api, getChatMember };
}

describe('resolveAdminsInChat', () => {
  beforeEach(() => {
    resetAdminNameCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAdminNameCache();
  });

  it('joins first and last name', async () => {
    const { api } = fakeApi({ 1: { first_name: 'Rik', last_name: 'V' }, 2: {}, 3: {} });
    const admins = await resolveAdminsInChat(api, CHAT);
    expect(admins.find((a) => a.id === 1)?.name).toBe('Rik V');
  });

  it('falls back to the username when there is no name', async () => {
    const { api } = fakeApi({ 1: { username: 'rik' }, 2: {}, 3: {} });
    expect((await resolveAdminsInChat(api, CHAT)).find((a) => a.id === 1)?.name).toBe('rik');
  });

  it('drops an admin who is not in the chat rather than listing them', async () => {
    // Mentioning someone absent notifies nobody, so naming them would promise
    // an approver who cannot see the prompt.
    const { api } = fakeApi({ 1: { first_name: 'Rik' } });
    const admins = await resolveAdminsInChat(api, CHAT);
    expect(admins.map((a) => a.id)).toEqual([1]);
  });

  it('asks the API once per admin and serves repeats from cache', async () => {
    const { api, getChatMember } = fakeApi({ 1: { first_name: 'Rik' }, 2: { first_name: 'Ann' }, 3: { first_name: 'Sam' } });
    await resolveAdminsInChat(api, CHAT);
    await resolveAdminsInChat(api, CHAT);
    expect(getChatMember).toHaveBeenCalledTimes(3);
  });

  it('retries a miss once it expires, so a late-joining admin gets mentioned', async () => {
    vi.useFakeTimers();
    const members: Record<number, { first_name?: string }> = { 1: { first_name: 'Rik' } };
    const getChatMember = vi.fn(async (_c: number, userId: number) => {
      const user = members[userId];
      if (!user) throw new Error('not found');
      return { status: 'member', user: { id: userId, is_bot: false, ...user } };
    });
    const api = { getChatMember } as unknown as Api;

    expect((await resolveAdminsInChat(api, CHAT)).map((a) => a.id)).toEqual([1]);

    members[2] = { first_name: 'Ann' }; // Ann joins the group
    vi.advanceTimersByTime(11 * 60 * 1000);

    expect((await resolveAdminsInChat(api, CHAT)).map((a) => a.id)).toEqual([1, 2]);
  });
});

describe('appendApproverLine', () => {
  it('lists one admin', () => {
    const { text } = appendApproverLine(new EntityText(), [{ id: 1, name: 'Rik' }]).build();
    expect(text).toBe('Only Rik can approve this.');
  });

  it('joins two with "or"', () => {
    const { text } = appendApproverLine(new EntityText(), [
      { id: 1, name: 'Rik' },
      { id: 2, name: 'Ann' },
    ]).build();
    expect(text).toBe('Only Rik or Ann can approve this.');
  });

  it('commas the middle of a longer list', () => {
    const { text } = appendApproverLine(new EntityText(), [
      { id: 1, name: 'Rik' },
      { id: 2, name: 'Ann' },
      { id: 3, name: 'Sam' },
    ]).build();
    expect(text).toBe('Only Rik, Ann or Sam can approve this.');
  });

  it('still reads as a sentence with nobody resolved', () => {
    const { text } = appendApproverLine(new EntityText(), []).build();
    expect(text).toBe('Only an admin can approve this.');
  });
});

describe('describeResponderRefusal', () => {
  it('names the singular case', () => {
    expect(describeResponderRefusal([1])).toMatch(/admin/i);
  });

  it('handles an absent list without claiming an approver exists', () => {
    expect(describeResponderRefusal(undefined)).toBe('You cannot answer this question.');
  });
});
