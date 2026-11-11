import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';
import { spawn, type ChildProcess } from 'child_process';

// Transcripts resolve under os.homedir(); point it at a scratch home.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

const { listSessions, scanTranscript, isListable, isSessionOpenElsewhere, matchesQuery, findSession } =
  await import('../../src/claude/session-scan.js');
const { detectOwnerProvider } = await import('../../src/claude/session-jsonl.js');

const PROJECT = '/work/app';
const OTHER = '/work/other';
let home: string;
let n = 0;

function id(): string {
  n++;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function write(project: string, records: object[], mtimeSecAgo = 0, sessionId = id()): string {
  const dir = path.join(home, '.claude', 'projects', project.replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = Date.now() / 1000 - mtimeSecAgo;
  fs.utimesSync(file, t, t);
  return sessionId;
}

const prompt = (text: string, cwd = PROJECT, entrypoint = 'cli') =>
  ({ type: 'user', cwd, entrypoint, message: { role: 'user', content: text } });
const reply = (model: string, signature?: string) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    model,
    content: [
      ...(signature !== undefined ? [{ type: 'thinking', thinking: 'hm', signature }] : []),
      { type: 'text', text: 'ok' },
    ],
  },
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-scan-'));
  process.env.TELECODER_TEST_HOME = home;
});

afterEach(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const list = (opts: Partial<Parameters<typeof listSessions>[0]> = {}) =>
  listSessions({ projectPath: PROJECT, knownIds: new Set(), offset: 0, limit: 10, ...opts });

describe('listSessions', () => {
  it('lists the sessions Claude Code would, newest first', () => {
    const older = write(PROJECT, [prompt('first one'), reply('claude-opus-5-5')], 60);
    const newer = write(PROJECT, [prompt('second one'), reply('claude-opus-5-5')], 10);
    expect(list().sessions.map((s) => s.sessionId)).toEqual([newer, older]);
  });

  it('leaves out SDK and daemon runs, unless a TeleCoder chat knows the session', () => {
    const sdk = write(PROJECT, [prompt('You are a topic summarizer', PROJECT, 'sdk-ts')]);
    write(PROJECT, [{ ...prompt('bg'), sessionKind: 'daemon' }]);
    expect(list().sessions).toEqual([]);
    expect(list({ knownIds: new Set([sdk]) }).sessions.map((s) => s.sessionId)).toEqual([sdk]);
  });

  it('leaves out a session nobody said anything in', () => {
    write(PROJECT, [{ type: 'queue-operation', cwd: PROJECT, entrypoint: 'cli' }]);
    expect(list().sessions).toEqual([]);
  });

  it("keeps another project's sessions out of this project's list, and in the all-projects one", () => {
    write(PROJECT, [prompt('here')]);
    write(OTHER, [prompt('there', OTHER)]);
    expect(list().sessions).toHaveLength(1);
    expect(list({ projectPath: undefined }).sessions).toHaveLength(2);
  });

  it('pages, and says when there is more', () => {
    for (let i = 0; i < 5; i++) write(PROJECT, [prompt(`p${i}`)], i);
    const first = list({ limit: 2 });
    expect(first.more).toBe(true);
    const last = list({ offset: 4, limit: 2 });
    expect(last.sessions.map((s) => s.firstPrompt)).toEqual(['p4']);
    expect(last.more).toBe(false);
  });
});

describe('scanTranscript', () => {
  it('takes the last title of each kind, and the newest model', () => {
    const sid = write(PROJECT, [
      prompt('hello'),
      { type: 'ai-title', aiTitle: 'Early title' },
      reply('claude-opus-5-5'),
      { type: 'ai-title', aiTitle: 'Later title' },
      { type: 'custom-title', customTitle: 'Named by me' },
      reply('deepseek-flash'),
    ]);
    const s = findSession(sid, PROJECT)!;
    expect(s.aiTitle).toBe('Later title');
    expect(s.customTitle).toBe('Named by me');
    expect(s.lastModel).toBe('deepseek-flash');
    expect(s.firstPrompt).toBe('hello');
    expect(s.projectPath).toBe(PROJECT);
  });

  it('finds the title at the end of a transcript too long to read whole', () => {
    const filler = { type: 'attachment', text: 'x'.repeat(1000) };
    const sid = write(PROJECT, [prompt('start'), ...Array(300).fill(filler), { type: 'ai-title', aiTitle: 'At the end' }]);
    const s = findSession(sid)!;
    expect(s.firstPrompt).toBe('start');
    expect(s.aiTitle).toBe('At the end');
  });

  it("doesn't take a slash command or a meta record for the first prompt", () => {
    const sid = write(PROJECT, [
      { ...prompt('<local-command-caveat>x</local-command-caveat>'), isMeta: true },
      prompt('/model opus'),
      prompt('the real question'),
    ]);
    expect(findSession(sid)!.firstPrompt).toBe('the real question');
  });

  it('ignores a file that is not a session transcript', () => {
    const dir = path.join(home, '.claude', 'projects', '-work-app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.jsonl'), JSON.stringify(prompt('x')) + '\n');
    expect(scanTranscript(path.join(dir, 'notes.jsonl'))).toBeNull();
  });
});

describe('matchesQuery', () => {
  it('needs every word, in any title, the first prompt or the extra name', () => {
    const s = { sessionId: 'x', file: '', projectPath: PROJECT, mtimeMs: 0, aiTitle: 'Status line rework', firstPrompt: 'fix the bar' };
    expect(matchesQuery(s, 'status BAR')).toBe(true);
    expect(matchesQuery(s, 'status picker')).toBe(false);
    expect(matchesQuery(s, 'picker', 'resume picker topic')).toBe(true);
    expect(isListable(s, new Set())).toBe(true);
  });
});

describe('isSessionOpenElsewhere', () => {
  let child: ChildProcess | undefined;
  afterEach(() => child?.kill());

  const register = (pid: number, sessionId: string) => {
    const dir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, kind: 'interactive' }));
  };

  it('sees a session another live process registered', () => {
    child = spawn('sleep', ['30']);
    register(child.pid!, 'AAAAAAAA-0000-4000-8000-000000000001');
    expect(isSessionOpenElsewhere('aaaaaaaa-0000-4000-8000-000000000001')).toBe(true);
    expect(isSessionOpenElsewhere('aaaaaaaa-0000-4000-8000-000000000002')).toBe(false);
  });

  it('ignores this process and one that has exited', () => {
    register(process.pid, 'aaaaaaaa-0000-4000-8000-000000000003');
    register(2 ** 22 + 12345, 'aaaaaaaa-0000-4000-8000-000000000004');
    expect(isSessionOpenElsewhere('aaaaaaaa-0000-4000-8000-000000000003')).toBe(false);
    expect(isSessionOpenElsewhere('aaaaaaaa-0000-4000-8000-000000000004')).toBe(false);
  });
});

describe('detectOwnerProvider', () => {
  const owner = (records: object[]) => detectOwnerProvider(findSession(write(PROJECT, records))!.file);

  it("says Claude when every reply is Claude's", () => {
    expect(owner([prompt('q'), reply('claude-opus-5-5', 'EsIiCtABCBMYAipA' + 'x'.repeat(80))])).toBe('claude');
  });

  it('says CCR for a reply from another model, or a fabricated signature', () => {
    expect(owner([prompt('q'), reply('deepseek-flash')])).toBe('ccr');
    expect(owner([prompt('q'), reply('claude-opus-5-5', '1794414371295')])).toBe('ccr');
  });

  it("doesn't take a model a tool result names for the reply's", () => {
    expect(owner([prompt('q'), { type: 'user', toolUseResult: { model: 'gpt-6-astra' } }, reply('claude-opus-5-5')])).toBe('claude');
  });

  it('says nothing without a reply to tell by', () => {
    expect(owner([prompt('q')])).toBeUndefined();
  });
});
