/**
 * The note a pty spawn appends to claude's system prompt.
 *
 * A long or multi-line Telegram message reaches the model inside
 * `<pasted_content>` tags, and left to the CLI's own rule the model reads it as
 * text copied from somewhere else and waits for a confirmation tap before
 * acting on it. The note that says otherwise only works if it reaches the
 * spawn, which passes one `--append-system-prompt` value: so it has to travel
 * in that value beside the tool list, and it has to name the tag the CLI
 * actually writes.
 */
import { describe, it, expect } from 'vitest';

const {
	buildMcpToolsSystemPromptNote,
	buildPtySystemPromptNote,
	PASTED_MESSAGE_NOTE,
} = await import('../../src/claude/pty-spawn-config.js');

describe('buildPtySystemPromptNote', () => {
	it('carries the tool list and then the pasted-message note', () => {
		const note = buildPtySystemPromptNote();
		expect(note.startsWith(buildMcpToolsSystemPromptNote())).toBe(true);
		expect(note.endsWith(PASTED_MESSAGE_NOTE)).toBe(true);
	});

	it('names the tag claude wraps a collapsed paste in', () => {
		expect(PASTED_MESSAGE_NOTE).toContain('<pasted_content>');
	});
});
