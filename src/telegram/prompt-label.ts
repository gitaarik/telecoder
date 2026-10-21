/**
 * A prompt as TeleCoder shows it back: in /prompts, /recap and /handoff, on
 * the branches /tree draws, in the status line under an answer, and at the
 * bottom of the live action log.
 *
 * What the session log records as a prompt is often not what was typed: an
 * upload arrives wrapped in a note saying where the file landed, a paste in
 * the tags Claude Code puts around it, a reply under the quote it answers.
 * These undo that, so a prompt reads the way it was sent.
 *
 * Lives here rather than with the /prompts command it started in because the
 * action log needs it too, and that command's module imports the message
 * sender, which imports the action log.
 */

import { userTextKind } from '../claude/session-jsonl.js';

// An upload never reaches claude as the caption you typed. photo.handler wraps
// it in a note saying where the file landed and what to do with it, and that
// whole scaffold is what the transcript records — so replaying it verbatim
// buries the one line you actually wrote under six you didn't. Claude then
// makes it worse on the way in: it lifts every file path out of the note into
// an `[Image #N]` chip, leaving `Saved at:` and `  1.` pointing at nothing.
//
// Collapse those notes back to what the upload was: kind, name, caption.
const UPLOAD_CHIPS = /^(?:\[(?:Image|Pasted text) #\d+(?: \+\d+ lines)?\]\s*)+/;
const IMAGE_NOTE = 'User uploaded an image to the project.';
const FILE_NOTE = /^User uploaded a file: (.+)$/;
// The line each handler puts directly after the caption — the caption itself
// is a user-supplied string that may run over several lines.
const AFTER_CAPTION = /^(?:The image is attached as a vision input|Use the Read tool to read its contents)/;

function uploadCaption(lines: string[]): string | undefined {
  const start = lines.findIndex((l) => l.startsWith('Caption: '));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (AFTER_CAPTION.test(lines[i]!)) { end = i; break; }
  }
  const raw = lines.slice(start, end).join('\n').slice('Caption: '.length).trim();
  if (raw === '(none)') return undefined;
  return raw.replace(/^"/, '').replace(/"$/, '').trim() || undefined;
}

/**
 * Render an upload note as the upload it stands for, or return `text` unchanged
 * when it isn't one. Matching is anchored on the note's own first line, so a
 * prompt that merely quotes one is left alone.
 */
export function summarizeUserPrompt(text: string): string {
  const lines = text.replace(UPLOAD_CHIPS, '').split('\n');
  const first = lines[0]?.trim() ?? '';

  let label: string | undefined;
  if (first === IMAGE_NOTE) {
    label = '📷 Image';
  } else {
    const named = FILE_NOTE.exec(first);
    if (named) label = `📎 ${named[1]!.trim()}`;
  }
  if (!label) return text;

  const caption = uploadCaption(lines);
  return caption ? `${label} — ${caption}` : label;
}

/**
 * A prompt as a label: what the user asked, cleaned of what got wrapped
 * around it — or undefined when it wasn't a turn of the conversation at all,
 * but a command.
 *
 * /tree names a branch after the first prompt past a split, and the status
 * line lists the last few; on the evidence of real transcripts either is often
 * a paste, a reply quoted back, or a /compact. A paste keeps its text and
 * loses its tags; a quote gives way to the words the user wrote under it,
 * which say what the prompt asks rather than what it answers.
 */
export function promptLabel(raw: string): string | undefined {
  const text = raw.trim();
  if (userTextKind(text) !== 'prompt') return undefined;

  const unwrapped = summarizeUserPrompt(unwrapPaste(text));
  const lines = unwrapped.split('\n');
  const own = lines.filter((line) => !/^\s*>/.test(line)).join(' ');
  const quoted = lines.map((line) => line.replace(/^\s*>\s?/, '')).join(' ');
  const label = (own.trim() ? own : quoted)
    .replace(/\s+/g, ' ')
    .trim()
    // A prompt written as a list starts with its marker, which says nothing.
    .replace(/^(?:[-*•]|\d+[.)])\s+/, '');
  return label || undefined;
}

/**
 * `text` without the tags Claude Code wraps a long or multi-line paste in,
 * along with the line break it puts inside each, so a paste in the middle of a
 * turn keeps the blank line around it and gains no extra one.
 */
export function unwrapPaste(text: string): string {
  return text.replace(/<pasted_content[^>]*>\n?|\n?<\/pasted_content[^>]*>/g, '').trim();
}

/**
 * `label` cut to `max` characters, the cut marked with an ellipsis. Cut by
 * code point, so an emoji at the cut isn't split in half.
 */
export function cutLabel(label: string, max: number): string {
  const chars = Array.from(label);
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : label;
}
