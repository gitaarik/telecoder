import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';
import { spawn, type ChildProcess } from 'child_process';

// Transcripts, the session registry and the chat histories all resolve under
// os.homedir(); one scratch home for the file, set before anything loads.
const home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-resume-'));
process.env.TELECODER_TEST_HOME = home;
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

let provider = 'claude';
const clearConversation = vi.fn();
vi.mock('../../src/providers/provider-router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/provider-router.js')>()),
  clearConversation: (k: string) => clearConversation(k),
  getActiveProviderName: () => provider,
}));
const restoreTopic = vi.fn();
vi.mock('../../src/bot/handlers/command/topic.js', () => ({
  restoreTopicAndRefreshBotName: (_ctx: unknown, key: string, topic?: string) => restoreTopic(key, topic),
}));
vi.mock('../../src/telegram/task-list.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/telegram/task-list.js')>();
  actual.taskListDisplay.showRestored = async () => false;
  return actual;
});
const replies: string[] = [];
vi.mock('../../src/telegram/send.js', () => ({
  replyFormatted: async (_ctx: unknown, text: string | { text: string }) => { replies.push(typeof text === 'string' ? text : text.text); },
  editCallbackMessage: async (_ctx: unknown, text: string | { text: string }) => { replies.push(typeof text === 'string' ? text : text.text); },
  replyMarkdown: async () => {},
}));

const { handleResume } = await import('../../src/bot/handlers/command/resume.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { withPendingCarryOver } = await import('../../src/claude/carry-over.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

let n = 0;
function project(): string {
  const dir = path.join(home, 'work', `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function transcript(projectPath: string, model: string, title: string): string {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const dir = path.join(home, '.claude', 'projects', projectPath.replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const records = [
    { type: 'user', cwd: projectPath, entrypoint: 'cli', sessionId: id, uuid: 'u1', message: { role: 'user', content: 'what is 17*23?' } },
    { type: 'assistant', sessionId: id, uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', model, content: [{ type: 'text', text: '391' }] } },
    { type: 'ai-title', aiTitle: title, sessionId: id },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return id;
}

function ctx(text: string, chatId: number) {
  return {
    chat: { id: chatId },
    message: { text },
    reply: async (t: string) => { replies.push(t); },
  } as never;
}

beforeEach(() => {
  provider = 'claude';
  replies.length = 0;
  clearConversation.mockClear();
  restoreTopic.mockClear();
});

describe('/resume <session id>', () => {
  it("opens a terminal session in its project, under Claude Code's title", async () => {
    const dir = project();
    const id = transcript(dir, 'claude-opus-5-5', 'Multiplying numbers');
    await handleResume(ctx(`/resume ${id}`, 101));

    const session = sessionManager.getSession('101')!;
    expect(session.claudeSessionId).toBe(id);
    expect(session.workingDirectory).toBe(dir);
    expect(session.ownerProvider).toBe('claude');
    expect(clearConversation).toHaveBeenCalledWith('101');
    expect(restoreTopic).toHaveBeenCalledWith('101', 'Multiplying numbers');
    expect(replies[0]).toContain('✅ Resumed Multiplying numbers');
    expect(replies).toContain(`claude --resume ${id}`);
  });

  it('starts a copy of a session another process has open, and leaves the original alone', async () => {
    const dir = project();
    const id = transcript(dir, 'claude-opus-5-5', 'Busy elsewhere');
    const original = fs.readFileSync(path.join(home, '.claude', 'projects', dir.replace(/\//g, '-'), `${id}.jsonl`), 'utf-8');
    const holder: ChildProcess = spawn('sleep', ['30']);
    try {
      fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'sessions', `${holder.pid}.json`), JSON.stringify({ pid: holder.pid, sessionId: id }));

      await handleResume(ctx(`/resume ${id}`, 102));
    } finally {
      holder.kill();
    }

    const copyId = sessionManager.getSession('102')!.claudeSessionId!;
    expect(copyId).not.toBe(id);
    const tDir = path.join(home, '.claude', 'projects', dir.replace(/\//g, '-'));
    const copy = fs.readFileSync(path.join(tDir, `${copyId}.jsonl`), 'utf-8');
    expect(copy).toContain(`"sessionId":"${copyId}"`);
    expect(copy).not.toContain(id);
    expect(fs.readFileSync(path.join(tDir, `${id}.jsonl`), 'utf-8')).toBe(original);
    expect(replies[0]).toContain(`Session ${id} is open in another Claude Code process, so this started a copy as ${copyId}.`);
  });

  it('goes on from a CCR session as a new session with a recap, when the chat is on Claude', async () => {
    const dir = project();
    const id = transcript(dir, 'deepseek-flash', 'Routed through CCR');
    await handleResume(ctx(`/resume ${id}`, 103));

    expect(sessionManager.getSession('103')!.claudeSessionId).toBeUndefined();
    expect(replies[0]).toContain('This conversation ran on CCR and this chat is on Claude');
    const next = withPendingCarryOver('103', 'go on');
    expect(next).toContain('391');
    expect(next.endsWith('go on')).toBe(true);
  });

  it('continues that same CCR session as it is when the chat is on CCR', async () => {
    provider = 'ccr';
    const dir = project();
    const id = transcript(dir, 'deepseek-flash', 'Still on CCR');
    await handleResume(ctx(`/resume ${id}`, 104));
    expect(sessionManager.getSession('104')!.claudeSessionId).toBe(id);
    expect(sessionManager.getSession('104')!.ownerProvider).toBe('ccr');
  });
});

describe('/resume <words>', () => {
  it('opens the one match straight away', async () => {
    const dir = project();
    transcript(dir, 'claude-opus-5-5', 'Quarterly invoices');
    const id = transcript(dir, 'claude-opus-5-5', 'Garden irrigation timer');
    await handleResume(ctx('/resume irrigation', 105));
    expect(sessionManager.getSession('105')!.claudeSessionId).toBe(id);
  });

  it('says so when nothing matches', async () => {
    await handleResume(ctx('/resume zebra-crossing-xyz', 106));
    expect(replies[0]).toContain('No session matches “zebra-crossing-xyz”');
  });
});
