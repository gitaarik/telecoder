/**
 * The live status bubble a turn edits while it runs.
 *
 * It used to go out as plain text, so a running Bash command was a run-on
 * wall of pipes and `$(...)` under the timer. The command now sits in a
 * `bash` code block, sent as an entity so nothing in it can break a parse.
 */

import { describe, it, expect } from 'vitest';
import type { MessageEntity } from 'grammy/types';
import { renderStatusBubble, type StatusBubbleView } from '../../src/telegram/message-sender.js';

const view = (over: Partial<StatusBubbleView> = {}): StatusBubbleView => ({
  awaitingAnswer: false,
  operation: null,
  spinnerIndex: 0,
  elapsedMs: 0,
  tip: null,
  footer: '',
  ...over,
});

/** The text an entity covers, by the UTF-16 offsets Telegram reads. */
const covered = (text: string, e: MessageEntity) => text.slice(e.offset, e.offset + e.length);

// The loop from the bug report: quotes, `$(...)`, a tab escape and pipes.
const LOOP = `for i in $(seq 1 20); do p=0; for n in 79 80; do c=$(gh pr checks $n -R gitaarik/sjs-ops 2>&1 | awk -F'\\t' '{print $2}' | grep -c "pending"); p=$((p+c)); done; [ "$p" = "0" ] && break; sleep 30; done`;

describe('renderStatusBubble', () => {
  it('puts a running Bash command in a bash code block under the header', () => {
    const { text, entities } = renderStatusBubble(view({
      operation: { name: 'Bash', commandBlock: LOOP },
      elapsedMs: 58_000,
    }));

    expect(text.split('\n')[0]).toBe('⏳ 💻 Running [58s]');
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: 'pre', language: 'bash' });
    // Exact despite the two-unit 💻 ahead of it, and the command verbatim —
    // no `$ ` prompt and no MarkdownV2 escaping.
    expect(covered(text, entities[0])).toBe(LOOP);
  });

  it('keeps a multi-line command whole inside the block', () => {
    const command = 'cd /tmp/x\nnpm test 2>&1 | tail -5';
    const { text, entities } = renderStatusBubble(view({ operation: { name: 'Bash', commandBlock: command } }));
    expect(covered(text, entities[0])).toBe(command);
  });

  it('starts the tip and the background footer on lines of their own below the block', () => {
    const { text, entities } = renderStatusBubble(view({
      operation: { name: 'Bash', commandBlock: 'npm test' },
      tip: 'Use /btw to ask a side question',
      footer: '🔄 2 tasks running in background',
    }));

    const blockEnd = entities[0].offset + entities[0].length;
    expect(text.slice(blockEnd)).toBe(
      '\n  ⎿ 💡 Use /btw to ask a side question\n\n🔄 2 tasks running in background',
    );
  });

  it('leaves a non-Bash tool on one plain line with its detail', () => {
    const { text, entities } = renderStatusBubble(view({
      operation: { name: 'Read', detail: 'src/config.ts' },
      elapsedMs: 12_000,
    }));
    expect(text).toBe('⏳ 📖 Reading → src/config.ts [12s]');
    expect(entities).toEqual([]);
  });

  it('shows the thinking line while no tool is running', () => {
    const { text, entities } = renderStatusBubble(view());
    expect(text).toMatch(/^⏳ 💭 \S+\.\.\.$/);
    expect(entities).toEqual([]);
  });

  it('points at a pending question instead of the command or the tip', () => {
    const { text, entities } = renderStatusBubble(view({
      awaitingAnswer: true,
      operation: { name: 'Bash', commandBlock: 'npm test' },
      tip: 'Use /btw to ask a side question',
    }));
    expect(text).toBe('⏸️ Waiting for your answer — see the question below ↓');
    expect(entities).toEqual([]);
  });
});
