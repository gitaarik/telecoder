/**
 * The fork tree is read off the transcripts: a fork is its source's records up
 * to the fork point, ids intact, so which transcript split from which — and
 * where — is in the files themselves.
 *
 * Transcripts are written under a scratch home, the way loadFork writes them:
 * a copy of the source's lines, carried on with records of its own.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-tree-data-'));
process.env.TELECODER_TEST_HOME = home;
const PROJECT = path.join(home, 'project');
fs.mkdirSync(PROJECT);

const {
  treeOf,
  treeByRoot,
  forkedConversations,
  preorder,
  nodeWhereEnds,
  transcriptUpTo,
  promptsIn,
} = await import('../../src/claude/fork-tree.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

let clock = 0;
/** A record with a uuid, stamped a minute after the last one written. */
const rec = (uuid: string, type: 'user' | 'assistant', text: string) => JSON.stringify({
  type,
  uuid,
  timestamp: new Date(Date.UTC(2026, 8, 24, 10, clock++)).toISOString(),
  sessionId: 'whichever',
  message: { role: type, content: [{ type: 'text', text }] },
});
/** A line Claude Code writes that is not part of the conversation. */
const BOOKKEEPING = JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'whichever' });

const write = (sessionId: string, lines: string[]) => {
  const file = sessionJsonlPath(PROJECT, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

// The conversation, in the order it happened:
const u1 = rec('u1', 'user', 'Plan the parser');
const a1 = rec('a1', 'assistant', 'Two stages: tokenize, then parse.');
const u2 = rec('u2', 'user', 'Split it');
const a2 = rec('a2', 'assistant', 'Split.');
// A branch taken after "Split", carried on with tests…
const u3 = rec('u3', 'user', 'Add tests');
const a3 = rec('a3', 'assistant', 'Added.');
// …while the original went on to docs…
const u4 = rec('u4', 'user', 'Write docs');
const a4 = rec('a4', 'assistant', 'Written.');
// …and a branch from the very first answer tried something else.
const u5 = rec('u5', 'user', 'Try a regex instead');
const a5 = rec('a5', 'assistant', 'Regex version.');

write('original', [BOOKKEEPING, u1, a1, u2, a2, u4, a4]);
write('tests', [BOOKKEEPING, u1, a1, u2, a2, u3, a3]);
// The same point copied again and never taken further.
write('copy', [BOOKKEEPING, u1, a1, u2, a2]);
write('regex', [BOOKKEEPING, u1, a1, u5, a5]);
// A conversation of its own, never forked.
write('unrelated', [BOOKKEEPING, rec('x1', 'user', 'Something else'), rec('x2', 'assistant', 'Sure.')]);

describe('treeOf', () => {
  it('arranges the transcripts by where each split off', () => {
    const tree = treeOf(PROJECT, 'tests')!;
    expect(tree.rootId).toBe('u1');
    expect([...tree.transcripts.keys()].sort()).toEqual(['copy', 'original', 'regex', 'tests']);

    const shape = preorder(tree).map((node) => ({
      id: node.id,
      prompts: node.prompts,
      endsHere: node.endsHere,
      children: node.children.map((c) => c.id),
    }));
    expect(shape).toEqual([
      { id: 'a1', prompts: ['Plan the parser'], endsHere: [], children: ['a2', 'a5'] },
      { id: 'a2', prompts: ['Split it'], endsHere: ['copy'], children: ['a3', 'a4'] },
      { id: 'a3', prompts: ['Add tests'], endsHere: ['tests'], children: [] },
      { id: 'a4', prompts: ['Write docs'], endsHere: ['original'], children: [] },
      { id: 'a5', prompts: ['Try a regex instead'], endsHere: ['regex'], children: [] },
    ]);
  });

  it('finds where each transcript ends', () => {
    const tree = treeOf(PROJECT, 'original')!;
    expect(nodeWhereEnds(tree, 'copy')?.id).toBe('a2');
    expect(nodeWhereEnds(tree, 'original')?.id).toBe('a4');
  });

  it('is just the one transcript for a conversation never forked', () => {
    const tree = treeOf(PROJECT, 'unrelated')!;
    expect([...tree.transcripts.keys()]).toEqual(['unrelated']);
    expect(preorder(tree)).toHaveLength(1);
  });

  it('picks up what a transcript added since it was last read', () => {
    const file = write('growing', [BOOKKEEPING, u1, a1, u5]);
    expect(nodeWhereEnds(treeOf(PROJECT, 'growing')!, 'growing')?.prompts).toEqual(['Try a regex instead']);

    fs.appendFileSync(file, [a5, rec('u6', 'user', 'Benchmark it'), rec('a6', 'assistant', 'Faster.')].join('\n') + '\n');
    const node = nodeWhereEnds(treeOf(PROJECT, 'growing')!, 'growing')!;
    expect(node.prompts).toEqual(['Benchmark it']);
    expect(node.parent?.id).toBe('a5');
    fs.rmSync(file);
  });
});

describe('transcriptUpTo', () => {
  it('cuts the transcript at a point, lines Claude Code wrote around the records included', () => {
    const tree = treeOf(PROJECT, 'original')!;
    const split = preorder(tree).find((node) => node.id === 'a2')!;
    expect(transcriptUpTo(tree, split)).toBe([BOOKKEEPING, u1, a1, u2, a2].join('\n') + '\n');
  });
});

describe('finding trees', () => {
  it('lists only conversations that were forked', () => {
    const forked = forkedConversations(PROJECT);
    expect(forked.map((c) => [c.rootId, c.sessionIds.length])).toEqual([['u1', 4]]);
  });

  it('finds a tree by the start of its root uuid, as a button carries it', () => {
    expect(treeByRoot(PROJECT, 'u1')?.transcripts.size).toBe(4);
    expect(treeByRoot(PROJECT, 'nope')).toBeUndefined();
  });

  it('tells apart two trees whose roots start alike, by the point a button is for', () => {
    // A project of its own, so these don't join the trees above.
    const other = path.join(home, 'other-project');
    fs.mkdirSync(other);
    const put = (sessionId: string, records: string[]) => {
      const file = sessionJsonlPath(other, sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, records.join('\n') + '\n');
    };
    // Roots sharing their first 8 characters — all a button has room for.
    put('first', [rec('samepfx-1', 'user', 'One'), rec('p1', 'assistant', 'A.')]);
    put('second', [rec('samepfx-2', 'user', 'Two'), rec('p2', 'assistant', 'B.')]);
    put('second-fork', [rec('samepfx-2', 'user', 'Two'), rec('p2', 'assistant', 'B.'), rec('p3', 'user', 'More'), rec('p4', 'assistant', 'C.')]);

    expect(treeByRoot(other, 'samepfx-', 'p4')?.rootId).toBe('samepfx-2');
    expect(treeByRoot(other, 'samepfx-', 'p1')?.rootId).toBe('samepfx-1');
  });

  it('reads the prompts a transcript holds', () => {
    expect(promptsIn(PROJECT, 'regex')).toEqual(['Plan the parser', 'Try a regex instead']);
  });
});
