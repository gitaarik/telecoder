/**
 * Reddit and Medium fetch commands.
 *
 * Both live here because they share one expiry sweep: the pending-result maps
 * that back their inline "File / Chat / Both" pickers are swept by a single
 * timer, so splitting them would mean either two timers or a shared module
 * holding just the maps.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { sendToAgent } from '../../../providers/provider-router.js';
import { queueRequest, setAbortController } from '../../../claude/request-queue.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { createTelegraphPage } from '../../../telegram/telegraph.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { maybeSendVoiceReply } from '../../../tts/voice-reply.js';
import { executeVReddit } from '../../../reddit/vreddit.js';
import { redditFetchBoth, type RedditFetchOptions } from '../../../reddit/redditfetch.js';
import { isMediumUrl, fetchMediumArticle, FreediumArticle } from '../../../medium/freedium.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { replyMd, replyFeatureDisabled, parseCallback } from './shared.js';
import { getStreamingMode } from './streaming-mode.js';

/**
 * Tokenize a user-provided argument string, preserving quoted substrings.
 * Returns an array of individual arguments safe for execFile.
 */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"| '([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

type RedditFormat = 'markdown' | 'json';

function parseRedditArgs(tokens: string[]): {
  cleanTokens: string[];
  format: RedditFormat | null;
  hadOutputFlag: boolean;
} {
  const cleanTokens: string[] = [];
  let format: RedditFormat | null = null;
  let hadOutputFlag = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-o' || token === '--output') {
      hadOutputFlag = true;
      i++; // skip value
      continue;
    }

    if ((token === '-f' || token === '--format') && tokens[i + 1]) {
      const next = tokens[i + 1] as RedditFormat;
      if (next === 'json' || next === 'markdown') {
        format = next;
      }
      i++; // skip value, don't push to cleanTokens (handled here)
      continue;
    }

    cleanTokens.push(token);
  }

  return { cleanTokens, format, hadOutputFlag };
}

function ensureRedditOutputDir(ctx: Context): string {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const session = keyInfo ? sessionManager.getSession(keyInfo.sessionKey) : null;
  const baseDir = session ? session.workingDirectory : process.cwd();
  const dir = path.join(baseDir, '.claudegram', 'reddit');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function buildRedditOutputPath(ctx: Context, tokens: string[]): string {
  const dir = ensureRedditOutputDir(ctx);
  const raw = tokens[0] || 'reddit';
  const slug = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'reddit';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `reddit_${slug}_${stamp}.json`);
}

function slugFromUrl(input: string): string {
  const cleaned = input.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return cleaned.slice(0, 60) || 'medium';
}

function ensureMediumOutputDir(ctx: Context, url: string): string {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const session = keyInfo ? sessionManager.getSession(keyInfo.sessionKey) : null;
  const baseDir = session ? session.workingDirectory : process.cwd();
  const slug = slugFromUrl(url);
  const dir = path.join(baseDir, '.claudegram', 'medium', slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}


// Pending Reddit fetch results keyed by messageId, with 5-min TTL.
// Keyed by messageId (not chatId) so concurrent fetches don't overwrite each other.
const pendingRedditResults = new Map<number, {
  chatId: number;
  output: string;
  jsonOutput: string;
  targets: string[];
  options: RedditFetchOptions;
  format: RedditFormat | null;
  hadOutputFlag: boolean;
  expiresAt: number;
}>();
const REDDIT_RESULT_TTL_MS = 5 * 60 * 1000;

/**
 * Execute native Reddit fetch, cache the result, and show an inline picker
 * so the user can choose File / Chat / Both.
 * Exported so message.handler.ts can reuse it for ForceReply flow.
 */
export async function executeRedditFetch(
  ctx: Context,
  args: string
): Promise<void> {
  if (!config.REDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit');
    return;
  }

  await ctx.replyWithChatAction('typing');

  const tokens = tokenizeArgs(args);
  const { cleanTokens, format, hadOutputFlag } = parseRedditArgs(tokens);

  // Extract targets and options from cleanTokens
  const targets: string[] = [];
  const options: RedditFetchOptions = {
    format: format || 'markdown',
    limit: config.REDDITFETCH_DEFAULT_LIMIT,
    depth: config.REDDITFETCH_DEFAULT_DEPTH,
  };

  const VALID_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best']);
  const VALID_TIMES = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);

  for (let i = 0; i < cleanTokens.length; i++) {
    const token = cleanTokens[i];
    if (token === '--sort' && cleanTokens[i + 1]) {
      const val = cleanTokens[++i];
      if (VALID_SORTS.has(val)) options.sort = val;
    } else if (token === '--limit' && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = parsed;
    } else if ((token === '-l') && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = parsed;
    } else if (token === '--depth' && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.depth = parsed;
    } else if (token === '--time' && cleanTokens[i + 1]) {
      const val = cleanTokens[++i];
      if (VALID_TIMES.has(val)) options.timeFilter = val;
    } else {
      targets.push(token);
    }
  }

  if (targets.length === 0) {
    await replyMd(ctx, '❌ No target specified\\. Example: `/reddit r/ClaudeAI` or `/reddit <post\\-url>`');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    // Fetch both formats in a single API call to avoid double-dipping
    const { markdown: output, json: jsonOutput } = await redditFetchBoth(targets, options);

    if (!output.trim()) {
      await replyMd(ctx, '❌ No results returned\\.');
      return;
    }

    // Build a short preview for the picker message
    const charCount = output.length;
    const targetLabel = targets.join(', ');
    const previewSnippet = output.length > 200
      ? output.slice(0, 200).trimEnd() + '...'
      : output;

    const previewText =
      `📡 *Reddit Fetch*\n` +
      `Target: \`${esc(targetLabel)}\`\n` +
      `Size: _${charCount} chars_\n\n` +
      `${esc(previewSnippet)}\n\n` +
      `_Choose how to consume this content:_`;

    const msg = await ctx.reply(previewText, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📄 File', callback_data: 'reddit_action:file' },
            { text: '💬 Chat', callback_data: 'reddit_action:chat' },
            { text: '📄💬 Both', callback_data: 'reddit_action:both' },
          ],
        ],
      },
    });

    // Cache both formats for callback handling (keyed by messageId)
    pendingRedditResults.set(msg.message_id, {
      chatId,
      output,
      jsonOutput,
      targets,
      options,
      format,
      hadOutputFlag,
      expiresAt: Date.now() + REDDIT_RESULT_TTL_MS,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    let userMessage: string;

    if (errorMessage.includes('Missing Reddit credentials') || errorMessage.includes('REDDIT_CLIENT_ID')) {
      userMessage = "❌ Reddit credentials not configured\\.\n\nSet `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` in TeleCoder's `\\.env` file\\.";
    } else if (errorMessage.includes('timed out') || errorMessage.includes('AbortError')) {
      userMessage = '❌ Reddit fetch timed out\\.';
    } else {
      userMessage = `❌ Reddit fetch failed: ${esc(sanitizeError(errorMessage).substring(0, 300))}`;
    }

    await replyMd(ctx, userMessage);
  }
}

/**
 * Handle inline keyboard callbacks for Reddit action picker (File / Chat / Both).
 */
export async function handleRedditActionCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'reddit_action:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const action = data.replace('reddit_action:', '');

  // Look up pending result by messageId (keyed by picker message ID)
  const callbackMsgId = ctx.callbackQuery?.message?.message_id;
  if (!callbackMsgId) return;
  const pending = pendingRedditResults.get(callbackMsgId);
  if (!pending || Date.now() > pending.expiresAt) {
    if (callbackMsgId) pendingRedditResults.delete(callbackMsgId);
    await ctx.answerCallbackQuery({ text: 'Result expired. Please fetch again.' });
    return;
  }

  await ctx.answerCallbackQuery();

  const { output, jsonOutput, targets, format, hadOutputFlag } = pending;
  const doFile = action === 'file' || action === 'both';
  const doChat = action === 'chat' || action === 'both';

  try {
    // ── File mode ──────────────────────────────────────────────────
    if (doFile) {
      // Large thread JSON fallback (uses cached JSON, no second API call)
      if (!format && output.length > config.REDDITFETCH_JSON_THRESHOLD_CHARS) {
        try {
          const outputPath = buildRedditOutputPath(ctx, targets);
          fs.writeFileSync(outputPath, jsonOutput, { encoding: 'utf-8', mode: 0o600 });

          const sent = await messageSender.sendDocument(
            ctx,
            outputPath,
            `📎 Reddit JSON saved: ${path.basename(outputPath)}`
          );

          const displayPath = `.claudegram/reddit/${path.basename(outputPath)}`;
          const notice = sent
            ? `Large thread detected \\(${output.length} chars\\) — sent JSON file for structured review\\.`
            : `Large thread detected \\(${output.length} chars\\) — JSON saved at \`${esc(displayPath)}\`\\.`;

          await replyMd(ctx, notice);
        } catch (jsonError) {
          console.error('[Reddit] JSON fallback failed:', jsonError);
          await messageSender.sendMessage(ctx, output);
        }
      } else {
        await messageSender.sendMessage(ctx, output);
      }

      if (hadOutputFlag) {
        await replyMd(ctx, 'ℹ️ Note: `-o/--output` is ignored in this picker flow\\. JSON is saved automatically for large threads\\.');
      }
    }

    // ── Chat mode ──────────────────────────────────────────────────
    if (doChat) {
      const session = sessionManager.getSession(sessionKey);
      if (!session) {
        await replyMd(ctx, '⚠️ No project set\\. Use `/project` first to enable Chat mode\\.');
      } else {
        // 1. Save content to disk
        const dir = ensureRedditOutputDir(ctx);
        const slug = (targets[0] || 'reddit').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const mdPath = path.join(dir, `reddit_${slug}_${stamp}.md`);
        fs.writeFileSync(mdPath, output, { encoding: 'utf-8', mode: 0o600 });

        // 2. Build prompt with inline content (truncated for large results)
        const CHAT_INLINE_LIMIT = 3000;
        const truncated = output.length > CHAT_INLINE_LIMIT;
        const inlineContent = truncated
          ? output.slice(0, CHAT_INLINE_LIMIT).trimEnd()
          : output;

        // Use relative display path to avoid leaking absolute server paths in conversation
        const displayPath = `.claudegram/reddit/${path.basename(mdPath)}`;

        let prompt = `I just fetched Reddit content and saved it to ${displayPath}. Here's the content:\n\n${inlineContent}`;
        if (truncated) {
          prompt += `\n\n[Content truncated — full content (${output.length} chars) is saved at ${displayPath}.]`;
        }
        prompt += '\n\nPlease summarize the key points and let me know if you have any questions.';

        // 3. Queue a streaming response
        try {
          await queueRequest(sessionKey, prompt, async () => {
            if (getStreamingMode() === 'streaming') {
              await messageSender.startStreaming(ctx);
              const abortController = new AbortController();
              setAbortController(sessionKey, abortController);
              try {
                const response = await sendToAgent(sessionKey, prompt, {
                  onProgress: (progressText) => {
                    messageSender.updateStream(ctx, progressText);
                  },
                  abortController,
                });
                await messageSender.finishStreaming(ctx, response.text);
                await maybeSendVoiceReply(ctx, response.text);
              } catch (error) {
                await messageSender.cancelStreaming(ctx, error as Error);
                throw error;
              }
            } else {
              await ctx.replyWithChatAction('typing');
              const abortController = new AbortController();
              setAbortController(sessionKey, abortController);
              const response = await sendToAgent(sessionKey, prompt, { abortController });
              await messageSender.sendMessage(ctx, response.text);
              await maybeSendVoiceReply(ctx, response.text);
            }
          });
        } catch (error) {
          if ((error as Error).message !== 'Queue cleared') {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await replyMd(ctx, `❌ Chat failed: ${esc(errorMessage)}`);
          }
        }
      }
    }

    // Edit the original picker message to show what was selected
    const actionLabel = action === 'file' ? '📄 File' : action === 'chat' ? '💬 Chat' : '📄💬 Both';
    try {
      const targetLabel = targets.join(', ');
      await ctx.editMessageText(
        `📡 *Reddit Fetch* — ${esc(actionLabel)}\n` +
        `Target: \`${esc(targetLabel)}\` · ${output.length} chars`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch { /* ignore edit failure */ }

    // Clean up
    pendingRedditResults.delete(callbackMsgId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Action failed: ${esc(message.substring(0, 300))}`);
    pendingRedditResults.delete(callbackMsgId);
  }
}

// Pending Freedium results keyed by sessionKey, with 5-min TTL
const pendingMediumResults = new Map<string, { article: FreediumArticle; messageId: number; expiresAt: number }>();
const MEDIUM_RESULT_TTL_MS = 5 * 60 * 1000;

// Periodic cleanup of expired pending results to prevent memory leaks.
// .unref() so this timer doesn't prevent graceful process shutdown.
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [msgId, entry] of pendingRedditResults) {
    if (now > entry.expiresAt) pendingRedditResults.delete(msgId);
  }
  for (const [key, entry] of pendingMediumResults) {
    if (now > entry.expiresAt) pendingMediumResults.delete(key);
  }
}, REDDIT_RESULT_TTL_MS);
_cleanupInterval.unref();

/**
 * Fetch a Medium article via Freedium and present inline action buttons.
 */
export async function executeMediumFetch(
  ctx: Context,
  args: string
): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  await ctx.replyWithChatAction('typing');

  const url = args.trim().split(/\s+/)[0];

  if (!url) {
    await replyMd(ctx, '❌ Missing URL\\. Example: `/medium https://medium.com/...`');
    return;
  }

  if (!isMediumUrl(url)) {
    await replyMd(ctx, '❌ Not a recognized Medium URL\\.\n\nSupported: medium\\.com, towardsdatascience\\.com, and other known Medium publication domains\\.');
    return;
  }

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  try {
    const article = await fetchMediumArticle(url);

    // Build preview: title + author + first ~200 chars of markdown
    const preview = article.markdown.length > 200
      ? article.markdown.slice(0, 200).trimEnd() + '...'
      : article.markdown;

    const previewText =
      `📰 *${esc(article.title)}*\n` +
      `_by ${esc(article.author)}_\n\n` +
      `${esc(preview)}\n\n` +
      `_${article.markdown.length} chars — choose an action:_`;

    // Build inline keyboard based on Telegraph availability
    const inlineKeyboard = config.TELEGRAPH_ENABLED
      ? [
          [
            { text: '📄 Telegraph', callback_data: 'medium:telegraph' },
            { text: '💾 Save .md', callback_data: 'medium:save' },
            { text: '📄💾 Both', callback_data: 'medium:both' },
          ],
        ]
      : [
          [
            { text: '💬 Send to Chat', callback_data: 'medium:chat' },
            { text: '💾 Save .md', callback_data: 'medium:save' },
            { text: '💬💾 Both', callback_data: 'medium:chatboth' },
          ],
        ];

    const msg = await ctx.reply(previewText, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: inlineKeyboard },
    });

    // Store result for callback handling
    pendingMediumResults.set(sessionKey, {
      article,
      messageId: msg.message_id,
      expiresAt: Date.now() + MEDIUM_RESULT_TTL_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Medium fetch failed: ${esc(message.substring(0, 300))}`);
  }
}

/**
 * Handle inline keyboard callbacks for Medium article actions.
 */
export async function handleMediumCallback(ctx: Context): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await ctx.answerCallbackQuery({ text: 'Feature disabled' });
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  const cb = parseCallback(ctx, 'medium:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const action = data.replace('medium:', '');

  // Look up pending result
  const pending = pendingMediumResults.get(sessionKey);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingMediumResults.delete(sessionKey);
    await ctx.answerCallbackQuery({ text: 'Result expired. Please fetch again.' });
    return;
  }

  const { article } = pending;
  await ctx.answerCallbackQuery();

  const doTelegraph = action === 'telegraph' || action === 'both';
  const doChat = action === 'chat' || action === 'chatboth';
  const doSave = action === 'save' || action === 'both' || action === 'chatboth';

  let telegraphUrl: string | null = null;
  let mdPath: string | null = null;

  try {
    if (doTelegraph) {
      telegraphUrl = await createTelegraphPage(article.title, article.markdown);
    }

    if (doSave) {
      const outputDir = ensureMediumOutputDir(ctx, article.url);
      const slug = slugFromUrl(article.url);
      mdPath = path.join(outputDir, `${slug}.md`);
      fs.writeFileSync(mdPath, article.markdown, { encoding: 'utf-8', mode: 0o600 });
    }

    // Build result message
    let resultText = `📰 *${esc(article.title)}*\n_by ${esc(article.author)}_\n\n`;

    if (telegraphUrl) {
      resultText += `📄 [Open in Instant View](${esc(telegraphUrl)})\n`;
    }
    if (doChat) {
      resultText += `💬 Sending to chat\\.\\.\\.\n`;
    }
    if (mdPath) {
      resultText += `💾 Markdown saved \\(${article.markdown.length} chars\\)`;
    }

    // Edit the original message to show results
    try {
      await ctx.editMessageText(resultText, { parse_mode: 'MarkdownV2' });
    } catch {
      // If edit fails (e.g. message too old), send new message
      await replyMd(ctx, resultText);
    }

    // Send content to chat if requested (inline messages)
    if (doChat) {
      await messageSender.sendMessage(ctx, article.markdown);
    }

    // Send .md file as document
    if (mdPath) {
      await messageSender.sendDocument(ctx, mdPath, `📎 ${path.basename(mdPath)}`);
    }

    // Clean up pending result
    pendingMediumResults.delete(sessionKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Action failed: ${esc(message.substring(0, 300))}`);
  }
}

export async function handleMedium(ctx: Context): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `📰 *Medium Fetch*\n\n` +
      `Fetch a Medium article via Freedium and convert to Markdown\\.\n\n` +
      `*Examples:*\n` +
      `• \`https://medium.com/@user/post\\-id\`\n` +
      `• \`https://towardsdatascience.com/some\\-article\`\n\n` +
      `👇 _Paste a Medium article URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://medium.com/@user/post-id',
          selective: true,
        },
      }
    );
    return;
  }

  await executeMediumFetch(ctx, args);
}

export async function handleReddit(ctx: Context): Promise<void> {
  if (!config.REDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `📡 *Reddit Fetch*\n\n` +
      `Fetch posts, subreddits, or user profiles from Reddit\\.\n\n` +
      `*Examples:*\n` +
      `• \`r/ClaudeAI \\-\\-sort new \\-\\-limit 5\`\n` +
      `• \`1lmkfhf\` \\(post ID\\)\n` +
      `• \`u/username \\-\\-limit 5\`\n` +
      `• \`r/LocalLLaMA \\-\\-sort top \\-\\-time week\`\n\n` +
      `👇 _Enter your Reddit target:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'r/ClaudeAI --sort new --limit 10',
          selective: true,
        },
      }
    );
    return;
  }

  await executeRedditFetch(ctx, args);
}

export async function handleVReddit(ctx: Context): Promise<void> {
  if (!config.VREDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit video');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `🎬 *Reddit Video*\n\n` +
      `Download a Reddit\\-hosted video from a post URL\\.\n\n` +
      `*Examples:*\n` +
      `• \`https://www.reddit.com/r/sub/comments/abc123/title/\`\n` +
      `• \`https://www.reddit.com/r/sub/s/shareCode\`\n` +
      `• \`https://redd.it/abc123\`\n\n` +
      `👇 _Paste a Reddit post URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://www.reddit.com/r/sub/comments/abc123/',
          selective: true,
        },
      }
    );
    return;
  }

  await executeVReddit(ctx, args);
}

