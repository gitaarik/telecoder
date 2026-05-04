/**
 * Out-of-band topic summarizer using Haiku.
 *
 * Fires alongside the main agent turn to derive a 1-4 word topic label
 * from the user's message. Uses settingSources:[] and allowedTools:[]
 * so it bypasses plugins, MCP servers, and hooks entirely — making it
 * immune to the SDK's tool-deferral mode that can degrade the existing
 * model-driven auto-topic mechanism when many user-level tools are loaded.
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

// Trivial replies that don't carry topical content. Skip the Haiku call so we
// don't overwrite a perfectly good prior topic with garbage like "ok".
const TRIVIAL_MESSAGE_RE =
  /^(ok|okay|yes|yeah|yep|yup|no|nope|nah|thanks|thx|ty|cool|sure|nice|great|sounds good|got it|alright|done|next|continue|go|stop|wait|hmm|huh|lol|haha|👍|👌|✅|🙏|❤️|🎉)[.!?]*$/i;

const TOPIC_INSTRUCTIONS =
  'Reply with ONLY a 1-4 word lowercase topic label summarizing the user message below for a small UI tab. ' +
  'No punctuation, no quotes, no prefix, no explanation. ' +
  'Examples: "auth bug", "CI fix", "dark mode", "PR review".\n\n' +
  'User message:\n';

/**
 * Summarize a user message into a short topic label using Haiku.
 * Returns undefined on timeout, error, or empty/garbage output.
 */
export async function summarizeTopicWithHaiku(userMessage: string): Promise<string | undefined> {
  const trimmed = userMessage.trim();
  if (trimmed.length < 3) return undefined;
  if (TRIVIAL_MESSAGE_RE.test(trimmed)) return undefined;

  const input = trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOPIC_TIMEOUT_MS);

  try {
    const response = query({
      prompt: TOPIC_INSTRUCTIONS + input,
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

    return sanitizeTopic(collected);
  } catch (err) {
    if (controller.signal.aborted) return undefined;
    console.debug('[AutoTopic] Haiku side-call failed:', err instanceof Error ? err.message : err);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeTopic(raw: string): string | undefined {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^["'`*_]+|["'`*_]+$/g, '')
    .split(/\n/)[0]
    .trim()
    .replace(/[.!?,:;]+$/g, '')
    .trim();
  if (!cleaned) return undefined;
  const words = cleaned.split(/\s+/).slice(0, 4);
  const joined = words.join(' ').slice(0, 40);
  return joined || undefined;
}
