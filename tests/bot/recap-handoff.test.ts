/**
 * /recap and /handoff replay the conversation from the session log, an
 * exchange at a time. What Claude Code writes around a prompt — a /compact's
 * records, a note in the user's place, the tags around a paste — is part of
 * neither side of one.
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
function chatWithTranscript(command: string) {
  const chat = chatId++;
  const project = path.join(home, `project-${chat}`);
  fs.mkdirSync(project);
  const sessionId = `talk-${chat}`;
  const file = sessionJsonlPath(project, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TRANSCRIPT.join('\n') + '\n');
  sessionManager.createSession(String(chat), project);
  sessionManager.setClaudeSessionId(String(chat), sessionId);

  const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
  const ctx = { chat: { id: chat }, message: { text: command }, reply } as unknown as Context;
  return { ctx, reply, project };
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
