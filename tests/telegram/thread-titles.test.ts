import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let stateDir: string;

vi.mock('../../src/utils/json-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/json-store.js')>();
  return { ...actual, getStateDir: () => stateDir };
});

const CHAT = 42;
const THREAD = 7;
const KEY = `${CHAT}:${THREAD}`;
const BOT_USER_ID = 999;

type Middleware = (ctx: unknown, next: () => Promise<void>) => unknown;

/** Fresh module, wired to a fake bot whose middleware we can feed messages. */
async function load() {
  vi.resetModules();
  const mod = await import('../../src/telegram/thread-titles.js');
  const editForumTopic = vi.fn().mockResolvedValue(true);
  let middleware: Middleware | undefined;
  const bot = { api: { editForumTopic }, use: (fn: Middleware) => { middleware = fn; } };
  mod.initThreadTitles(bot as never);

  const feed = async (message: Record<string, unknown>) => {
    const ctx = {
      me: { id: BOT_USER_ID },
      message: {
        chat: { id: CHAT },
        is_topic_message: true,
        message_thread_id: THREAD,
        from: { id: CHAT, is_bot: false },
        ...message,
      },
    };
    await middleware!(ctx, async () => {});
  };
  return { ...mod, editForumTopic, feed };
}

describe('thread titles', () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-titles-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('names a private thread after its topic', async () => {
    const t = await load();
    await t.feed({ text: 'hi', reply_to_message: { forum_topic_created: { name: 'New chat', is_name_implicit: true } } });

    t.syncThreadTitle(KEY, 'Thread naming');

    expect(t.editForumTopic).toHaveBeenCalledWith(CHAT, THREAD, { name: 'Thread naming' });
  });

  it('leaves group topics, plain chats and empty topics alone', async () => {
    const t = await load();

    t.syncThreadTitle('-100123:7', 'Group topic');
    t.syncThreadTitle(String(CHAT), 'No thread');
    t.syncThreadTitle(KEY, '   ');

    expect(t.editForumTopic).not.toHaveBeenCalled();
  });

  it('never renames a thread the user named when creating it', async () => {
    const t = await load();
    await t.feed({ text: 'hi', reply_to_message: { forum_topic_created: { name: 'Taxes' } } });

    t.syncThreadTitle(KEY, 'Something else');

    expect(t.editForumTopic).not.toHaveBeenCalled();
    expect(t.namesThread(KEY)).toBe(false);
  });

  it('stops renaming once the user renames the thread, across a restart', async () => {
    const t = await load();
    await t.feed({ forum_topic_edited: { name: 'Mine' } });

    t.syncThreadTitle(KEY, 'Topic');
    const reloaded = await load();
    reloaded.syncThreadTitle(KEY, 'Topic');

    expect(t.editForumTopic).not.toHaveBeenCalled();
    expect(reloaded.editForumTopic).not.toHaveBeenCalled();
  });

  it('does not take its own rename for the user\'s', async () => {
    const t = await load();
    t.syncThreadTitle(KEY, 'Topic');
    await vi.waitFor(() => expect(t.editForumTopic).toHaveBeenCalledTimes(1));
    await t.feed({ forum_topic_edited: { name: 'Topic' } });

    expect(t.namesThread(KEY)).toBe(true);
  });

  it('holds renames inside the cooldown and sends only the latest', async () => {
    vi.useFakeTimers();
    const t = await load();

    t.syncThreadTitle(KEY, 'First');
    t.syncThreadTitle(KEY, 'Second');
    t.syncThreadTitle(KEY, 'Third');
    expect(t.editForumTopic).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(t.editForumTopic).toHaveBeenCalledTimes(2);
    expect(t.editForumTopic).toHaveBeenLastCalledWith(CHAT, THREAD, { name: 'Third' });
  });

  it('does not resend the name the thread already has', async () => {
    vi.useFakeTimers();
    const t = await load();

    t.syncThreadTitle(KEY, 'Same');
    await vi.advanceTimersByTimeAsync(60_000);
    t.syncThreadTitle(KEY, 'Same');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(t.editForumTopic).toHaveBeenCalledTimes(1);
  });

  it("names a thread after the topic's first half, which holds still", async () => {
    const t = await load();

    t.syncThreadTitle(KEY, 'Thread naming · Shortening the names');

    expect(t.editForumTopic).toHaveBeenCalledWith(CHAT, THREAD, { name: 'Thread naming' });
  });

  it("keeps a forked thread's prefix through later renames", async () => {
    vi.useFakeTimers();
    const t = await load();
    t.adoptThread(KEY, '🍴 Thread naming', '🍴 ');

    // The topic it inherited gives the name it was created with: no rename.
    t.syncThreadTitle(KEY, 'Thread naming · Whatever came next');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.editForumTopic).not.toHaveBeenCalled();

    t.syncThreadTitle(KEY, 'Fork to thread · Testing it');
    expect(t.editForumTopic).toHaveBeenCalledWith(CHAT, THREAD, { name: '🍴 Fork to thread' });
  });
});
