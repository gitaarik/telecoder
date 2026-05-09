/**
 * Out-of-band topic summarizer using Haiku.
 *
 * Fires alongside the main agent turn to derive a two-part topic phrase
 * for the status line: a stable GENERAL part (the broader feature/area)
 * and a CURRENT part (the specific task in this turn). The previous
 * GENERAL is fed back into the prompt so Haiku can keep it sticky
 * across consecutive messages and only change it when the user pivots.
 *
 * Uses settingSources:[] and allowedTools:[] so it bypasses plugins,
 * MCP servers, and hooks entirely — making it immune to the SDK's
 * tool-deferral mode that can degrade the existing model-driven
 * auto-topic mechanism when many user-level tools are loaded.
 *
 * Auth piggybacks on the same Claude executable the main bot uses, so no
 * extra API key, account, or subscription is required.
 */

import { query, type SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { resolveBundledClaudeBin } from '../utils/resolve-claude-bin.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const TOPIC_TIMEOUT_MS = 10_000;
const MAX_INPUT_CHARS = 1500;

// Display delimiter between GENERAL and CURRENT in the stored topic.
// The status line renders the topic as-is, so this also doubles as the
// rendered separator. Kept in sync with the prompt below.
export const TOPIC_PART_SEPARATOR = ' · ';

// Trivial replies that don't carry topical content. Skip the Haiku call so we
// don't overwrite a perfectly good prior topic with garbage like "ok".
const TRIVIAL_MESSAGE_RE =
  /^(ok|okay|yes|yeah|yep|yup|no|nope|nah|thanks|thx|ty|cool|sure|nice|great|sounds good|got it|alright|done|next|continue|go|stop|wait|hmm|huh|lol|haha|👍|👌|✅|🙏|❤️|🎉)[.!?]*$/i;

function buildInstructions(previousTopic?: string): string {
  const previousLine = previousTopic
    ? `Previous topic was: "${previousTopic}"\n` +
      '- Keep GENERAL the same unless the user has clearly pivoted to a different feature/area.\n' +
      '- If the latest message is a meta-question, acknowledgment, or has no concrete task, keep the previous CURRENT too.\n\n'
    : '';
  return (
    'You are a topic summarizer. Output format is strict: "GENERAL | CURRENT".\n' +
    '- GENERAL: the broader feature/area being worked on. Stable across messages. Concise.\n' +
    '- CURRENT: the specific task in this latest message. Be as descriptive as needed.\n' +
    'Output ONLY the topic line. NO chat, NO acknowledgment, NO explanation, NO quotes, NO prefix.\n' +
    'The pipe character "|" MUST appear exactly once, separating the two parts.\n\n' +
    'Good output:\n' +
    'Dark mode | Fixing toggle animation glitch\n' +
    'Auth bug | Adding rate limit to login endpoint\n' +
    'PR review | Reading test coverage report\n\n' +
    'Bad output (do NOT do any of these):\n' +
    '"Understood, I\'ll continue with..." (chat reply)\n' +
    'Dark mode (missing CURRENT)\n' +
    'Fixing the bug. (missing GENERAL and pipe)\n\n' +
    previousLine +
    'User message:\n'
  );
}

/**
 * Summarize a user message into a two-part topic via Haiku.
 * Returns the combined "general · current" string. Returns undefined if
 * Haiku doesn't follow the format — caller keeps the prior topic in that
 * case rather than overwriting it with garbage. Pass the full previous
 * topic so Haiku can keep GENERAL stable and reuse CURRENT for
 * meta/acknowledgment messages.
 */
export async function summarizeTopicWithHaiku(
  userMessage: string,
  previousTopic?: string,
): Promise<string | undefined> {
  const trimmed = userMessage.trim();
  if (trimmed.length < 3) return undefined;
  if (TRIVIAL_MESSAGE_RE.test(trimmed)) return undefined;

  const input = trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOPIC_TIMEOUT_MS);

  try {
    const response = query({
      prompt: buildInstructions(previousTopic) + input,
      options: {
        model: HAIKU_MODEL,
        // Bypass project AND user settings — no plugins, MCP, or hooks. Keeps
        // the call deferral-proof and cheap.
        settingSources: [] as SettingSource[],
        allowedTools: [],
        abortController: controller,
        includePartialMessages: false,
        ...(() => {
          if (!config.CLAUDE_USE_BUNDLED_EXECUTABLE) {
            return { pathToClaudeCodeExecutable: config.CLAUDE_EXECUTABLE_PATH };
          }
          const bundled = resolveBundledClaudeBin();
          return bundled ? { pathToClaudeCodeExecutable: bundled } : {};
        })(),
      },
    });

    let collected = '';
    for await (const message of response) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') collected += block.text;
        }
      }
      if (message.type === 'result') break;
    }

    return sanitizeTwoPartTopic(collected);
  } catch (err) {
    if (controller.signal.aborted) return undefined;
    console.debug('[AutoTopic] Haiku side-call failed:', err instanceof Error ? err.message : err);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function cleanPart(raw: string): string | undefined {
  const cleaned = raw
    .trim()
    .replace(/^["'`*_]+|["'`*_]+$/g, '')
    .replace(/[.!?,:;]+$/g, '')
    .trim();
  return cleaned || undefined;
}

function sanitizeTwoPartTopic(raw: string): string | undefined {
  const firstLine = raw.trim().split(/\n/)[0]?.trim() ?? '';
  if (!firstLine) return undefined;

  // Strict: require the pipe. If Haiku didn't follow the format we'd rather
  // skip this turn (keeping the prior topic) than render conversational prose.
  const pipeIdx = firstLine.indexOf('|');
  if (pipeIdx < 0) return undefined;

  const general = cleanPart(firstLine.slice(0, pipeIdx));
  const current = cleanPart(firstLine.slice(pipeIdx + 1));
  if (!general || !current) return undefined;
  return `${general}${TOPIC_PART_SEPARATOR}${current}`;
}
