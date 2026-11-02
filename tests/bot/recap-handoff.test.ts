/**
 * /recap and /handoff replay the conversation from the session log, an
 * exchange at a time. What Claude Code writes around a prompt — a /compact's
 * records, a note in the user's place, the tags around a paste — is part of
 * neither side of one.
 *
 * /recap then ends the way a turn does, with the context and the status line.
 *
 * Drives the real handlers against transcripts written under a scratch home,
 * so nothing here touches the real ~/.claude or ~/.claudegram.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-recap-'));
process.env.TELECODER_TEST_HOME = home;

const { handleRecap, handleHandoff } = await import('../../src/bot/handlers/command/session.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');
const { messageSender } = await import('../../src/telegram/message-sender.js');
const { userPreferences } = await import('../../src/providers/user-preferences.js');
const { clearConversation } = await import('../../src/providers/provider-router.js');

// No Telegraph page or upload: the handoff file on disk is what's checked.
vi.spyOn(messageSender, 'sendMarkdownFile').mockResolvedValue(true);

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

let uuid = 0;
/** A transcript record, the way Claude Code writes one. */
const rec = (type: 'user' | 'assistant', text: string) => JSON.stringify({
  type,
  uuid: `r${uuid++}`,
  sessionId: 'whichever',
  message: { role: type, content: [{ type: 'text', text }] },
});

/** A reply with the usage Claude Code records on it: `context` tokens, nearly all of them cache reads. */
const replyWithUsage = (text: string, context: number) => JSON.stringify({
  type: 'assistant',
  uuid: `r${uuid++}`,
  sessionId: 'whichever',
  message: {
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 2, output_tokens: 320, cache_read_input_tokens: context - 322, cache_creation_input_tokens: 0 },
  },
});

function writeLog(project: string, sessionId: string, lines: string[]): void {
  const file = sessionJsonlPath(project, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** A prompt, a /compact, an interrupted paste, and the prompt after it. */
const TRANSCRIPT = [
  rec('user', 'Plan the parser'), rec('assistant', 'Two stages.'),
  rec('user', '/compact'),
  rec('user', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
  rec('user', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>'),
  rec('user', '<pasted_content id="a43f">\nBuild log:\nall green\n</pasted_content id="a43f">'),
  rec('user', '[Request interrupted by user]'),
  rec('user', 'Ship it'), rec('assistant', 'Shipped.'),
];

let chatId = 300;
/** A chat whose session has TRANSCRIPT as its log, and a reply that records what it's sent. */
function chatWithTranscript(command: string, lines: string[] = TRANSCRIPT) {
  const chat = chatId++;
  const project = path.join(home, `project-${chat}`);
  fs.mkdirSync(project);
  const sessionId = `talk-${chat}`;
  writeLog(project, sessionId, lines);
  sessionManager.createSession(String(chat), project);
  sessionManager.setClaudeSessionId(String(chat), sessionId);

  const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
  const ctx = { chat: { id: chat }, message: { text: command }, reply } as unknown as Context;
  return { ctx, reply, project, chat };
}

describe('/recap', () => {
  it('shows each exchange with only what you sent', async () => {
    const { ctx, reply } = chatWithTranscript('/recap');
    await handleRecap(ctx);
    const yours = reply.mock.calls.map(([text]) => text).filter((text) => text.startsWith('>*You:*'));
    expect(yours).toEqual([
      '>*You:* Plan the parser',
      '>*You:* Build log: all green Ship it',
    ]);
  });

  describe('ends the way a turn does', () => {
    const CONVERSATION = [
      rec('user', 'Plan the parser'), replyWithUsage('Two stages.', 300_000),
      rec('user', 'Ship it'), replyWithUsage('Shipped.', 540_000),
    ];

    /** The chat as yours is set up: the PTY, and everything a turn can end with on show. */
    function showAll(chat: number): void {
      userPreferences.setMethod(chat, 'pty');
      userPreferences.setVerbosity(chat, 'verbose');
      userPreferences.setShowStatusLine(chat, true);
      userPreferences.setShowPromptInStatusLine(chat, true);
    }

    it('with the status line and the context in it, after the last reply', async () => {
      const { ctx, reply, chat } = chatWithTranscript('/recap', CONVERSATION);
      showAll(chat);
      await handleRecap(ctx);

      const sent = reply.mock.calls.map(([text]) => text);
      const lastReply = sent.findIndex((text) => text.includes('Shipped'));
      const [statusLine] = sent.slice(lastReply + 1);
      expect(sent).toHaveLength(lastReply + 2);
      expect(statusLine).toContain('_▸ Plan the parser_\n_▸ Ship it_');
      expect(statusLine).toContain('54% context');
    });

    it('with the figure of the point a jump landed on, not the one last shown', async () => {
      const { ctx, reply, chat, project } = chatWithTranscript('/recap', CONVERSATION);
      showAll(chat);
      await handleRecap(ctx);

      // What a fork or a /tree jump does: a log of its own, and the provider's state dropped.
      writeLog(project, `branch-${chat}`, CONVERSATION.slice(0, 2));
      sessionManager.setClaudeSessionId(String(chat), `branch-${chat}`);
      clearConversation(String(chat));
      reply.mockClear();
      await handleRecap(ctx);

      const sent = reply.mock.calls.map(([text]) => text);
      expect(sent.at(-1)).toContain('_▸ Plan the parser_');
      expect(sent.at(-1)).not.toContain('Ship it');
      expect(sent.at(-1)).toContain('30% context');
    });

    it('with nothing more when the chat turned both off', async () => {
      const { ctx, reply, chat } = chatWithTranscript('/recap', CONVERSATION);
      userPreferences.setMethod(chat, 'pty');
      userPreferences.setVerbosity(chat, 'quiet');
      userPreferences.setShowStatusLine(chat, false);
      await handleRecap(ctx);

      expect(reply.mock.calls.at(-1)![0]).toContain('Shipped');
    });
  });
});

describe('/handoff', () => {
  it('writes each exchange with only what you sent, paste lines intact', async () => {
    const { ctx, project } = chatWithTranscript('/handoff');
    await handleHandoff(ctx);
    const dir = path.join(project, '.claudegram', 'handoffs');
    const [file] = fs.readdirSync(dir);
    const md = fs.readFileSync(path.join(dir, file!), 'utf-8');
    const users = md.split('### User\n\n').slice(1).map((part) => part.split('\n\n### Assistant')[0]);
    expect(users).toEqual([
      'Plan the parser',
      'Build log:\nall green\n\nShip it',
    ]);
  });
});
