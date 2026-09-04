/**
 * MCP Tools — In-process MCP server factory for TeleCoder.
 *
 * Wraps existing standalone functions (reddit, medium, extract, telegraph,
 * project management) as MCP tools so Claude can invoke them automatically
 * based on conversation context instead of requiring explicit /commands.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { InputFile, type Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { sessionManager } from './session-manager.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../utils/workspace-guard.js';
import { setSessionTopic, clearTopicAndRefreshBotName } from '../bot/handlers/command/topic-store.js';
import { messageSender } from '../telegram/message-sender.js';
import { createPendingQuestion, buildAskUserMessageText, buildAskUserKeyboard } from './ask-user.js';
import { parseSessionKey } from '../utils/session-key.js';

// Lazy imports to avoid circular deps and unnecessary module loading
async function importReddit() {
  return import('../reddit/redditfetch.js');
}

async function importMedium() {
  return import('../medium/freedium.js');
}

async function importExtract() {
  return import('../media/extract.js');
}

async function importTelegraph() {
  return import('../telegram/telegraph.js');
}

// ── Types ────────────────────────────────────────────────────────────

export interface McpToolsContext {
  telegramCtx: Context;
  sessionKey: string;
}

// ── Constants ────────────────────────────────────────────────────────

const REDDIT_MAX_CHARS = 50_000;

// ── Factory ──────────────────────────────────────────────────────────

export function createTeleCoderMcpServer(
  toolsCtx: McpToolsContext
): McpSdkServerConfigWithInstance {
  const tools = buildToolList(toolsCtx);

  return createSdkMcpServer({
    name: 'claudegram-tools',
    version: '1.0.0',
    tools,
  });
}

function buildToolList(toolsCtx: McpToolsContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [
    listProjectsTool(toolsCtx),
    switchProjectTool(toolsCtx),
    sendFileTool(toolsCtx),
    askUserTool(toolsCtx),
  ];

  if (config.DYNAMIC_BOT_NAME) {
    tools.push(setTopicTool(toolsCtx));
  }

  if (config.REDDIT_ENABLED) {
    tools.push(fetchRedditTool(toolsCtx));
  }

  if (config.MEDIUM_ENABLED) {
    tools.push(fetchMediumTool(toolsCtx));
  }

  if (config.EXTRACT_ENABLED) {
    tools.push(extractMediaTool(toolsCtx));
  }

  if (config.TELEGRAPH_ENABLED) {
    tools.push(publishTelegraphTool(toolsCtx));
  }

  return tools;
}

// ── Tool Definitions ─────────────────────────────────────────────────

function listProjectsTool(_toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_list_projects',
    'List all available projects in the workspace directory. Use this to see what projects the user can switch to.',
    {},
    async () => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
        const projects = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name);

        return {
          content: [{
            type: 'text' as const,
            text: `Projects in ${workspaceRoot}:\n${projects.join('\n')}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing projects: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function switchProjectTool(toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_switch_project',
    'Switch the working directory to a different project. The change takes effect on the next query. Use claudegram_list_projects first to see available projects.',
    { project_name: z.string().describe('Name of the project directory to switch to') },
    async ({ project_name }) => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        const targetPath = path.resolve(workspaceRoot, project_name);

        if (!isPathWithinRoot(workspaceRoot, targetPath)) {
          return {
            content: [{ type: 'text' as const, text: `Error: Path must be within workspace root: ${workspaceRoot}` }],
            isError: true,
          };
        }

        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `Error: Project not found: ${project_name}` }],
            isError: true,
          };
        }

        sessionManager.setWorkingDirectory(toolsCtx.sessionKey, targetPath);
        await clearTopicAndRefreshBotName(toolsCtx.telegramCtx, toolsCtx.sessionKey);

        return {
          content: [{
            type: 'text' as const,
            text: `Switched to project: ${project_name} (${targetPath}). The new working directory will take effect on the next query.`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error switching project: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function fetchRedditTool(_toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_fetch_reddit',
    'Fetch Reddit content: subreddit listings, post threads with comments, or user profiles. Supports sort/time filters for subreddits. Returns markdown-formatted results.',
    {
      target: z.string().describe('Reddit target: r/<subreddit>, u/<username>, post URL, post ID, or share link'),
      sort: z.enum(['hot', 'new', 'top', 'rising']).optional().describe('Sort order (default: hot). Semantic mappings: "trending"→hot, "latest"→new, "best"→top'),
      limit: z.number().optional().describe('Number of posts to fetch (default: 10)'),
      time_filter: z.enum(['day', 'week', 'month', 'year', 'all']).optional().describe('Time filter for top sort. Semantic: "today"→day, "this week"→week'),
      depth: z.number().optional().describe('Comment depth for post threads (default: 5)'),
    },
    async ({ target, sort, limit, time_filter, depth }) => {
      try {
        const { redditFetch } = await importReddit();
        const result = await redditFetch([target], {
          format: 'markdown',
          sort: sort || 'hot',
          limit: limit || config.REDDITFETCH_DEFAULT_LIMIT,
          depth: depth || config.REDDITFETCH_DEFAULT_DEPTH,
          timeFilter: time_filter,
        });

        const truncated = result.length > REDDIT_MAX_CHARS
          ? result.substring(0, REDDIT_MAX_CHARS) + '\n\n[... truncated — content exceeded 50k chars]'
          : result;

        return {
          content: [{ type: 'text' as const, text: truncated }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Reddit fetch error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function fetchMediumTool(_toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_fetch_medium',
    'Fetch a Medium article via Freedium (bypasses paywall). Returns the article title, author, and full markdown content.',
    {
      url: z.string().describe('Medium article URL (medium.com, towardsdatascience.com, etc.)'),
    },
    async ({ url }) => {
      try {
        const { fetchMediumArticle, isMediumUrl } = await importMedium();

        if (!isMediumUrl(url)) {
          return {
            content: [{ type: 'text' as const, text: 'Error: URL does not appear to be a Medium article.' }],
            isError: true,
          };
        }

        const article = await fetchMediumArticle(url);

        return {
          content: [{
            type: 'text' as const,
            text: `# ${article.title}\n**By ${article.author}**\n\n${article.markdown}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Medium fetch error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function extractMediaTool(toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_extract_media',
    'Extract text transcripts, audio, or video from YouTube, Instagram, and TikTok URLs. Audio/video files are sent directly to the user via Telegram. Transcripts are returned as text.',
    {
      url: z.string().describe('URL of the video (YouTube, Instagram, or TikTok)'),
      mode: z.enum(['text', 'audio', 'video', 'all']).describe('What to extract: "text" for transcript, "audio" for MP3, "video" for MP4, "all" for everything'),
    },
    async ({ url, mode }) => {
      const { extractMedia, cleanupExtractResult } = await importExtract();
      let result: Awaited<ReturnType<typeof extractMedia>> | undefined;

      try {
        result = await extractMedia({ url, mode });

        const ctx = toolsCtx.telegramCtx;
        const parts: string[] = [];

        // Send media files to user via Telegram
        if (result.videoPath) {
          try {
            await ctx.replyWithVideo(new InputFile(result.videoPath), {
              caption: `📹 ${result.title}`,
            });
            parts.push('Video sent to user.');
          } catch (err) {
            parts.push(`Video send failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (result.audioPath && (mode === 'audio' || mode === 'all')) {
          try {
            await ctx.replyWithAudio(new InputFile(result.audioPath), {
              caption: `🎵 ${result.title}`,
            });
            parts.push('Audio sent to user.');
          } catch (err) {
            parts.push(`Audio send failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (result.transcript) {
          parts.push(`Transcript:\n\n${result.transcript}`);
        }

        if (result.warnings.length > 0) {
          parts.push(`Warnings: ${result.warnings.join('; ')}`);
        }

        if (parts.length === 0) {
          parts.push('Extraction completed but no content was produced.');
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Media extraction error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      } finally {
        if (result) {
          cleanupExtractResult(result);
        }
      }
    }
  );
}

const TELEGRAM_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function sendFileTool(toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_send_file',
    'Send a file from the server to the user via Telegram. The file must be within the current working directory or /tmp. Use this after creating files (SVGs, images, reports, etc.) to deliver them directly to the user. Maximum file size: 50MB.',
    {
      file_path: z.string().describe('Absolute or relative path to the file to send. Relative paths are resolved from the current working directory.'),
      caption: z.string().optional().describe('Optional caption to display with the file in Telegram'),
    },
    async ({ file_path, caption }) => {
      try {
        const ctx = toolsCtx.telegramCtx;
        const session = sessionManager.getSession(toolsCtx.sessionKey);

        if (!session) {
          return {
            content: [{ type: 'text' as const, text: 'Error: No active session.' }],
            isError: true,
          };
        }

        // Resolve relative paths against the session working directory
        const resolvedPath = path.isAbsolute(file_path)
          ? file_path
          : path.resolve(session.workingDirectory, file_path);

        // Security: validate the path is within allowed directories
        const workspaceRoot = getWorkspaceRoot();
        const inWorkspace = isPathWithinRoot(workspaceRoot, resolvedPath);
        const inTmp = isPathWithinRoot('/tmp', resolvedPath);

        if (!inWorkspace && !inTmp) {
          return {
            content: [{ type: 'text' as const, text: `Error: File path must be within the workspace (${workspaceRoot}) or /tmp. Access denied.` }],
            isError: true,
          };
        }

        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${path.basename(resolvedPath)}` }],
            isError: true,
          };
        }

        const stat = fs.statSync(resolvedPath);
        if (stat.isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `Error: Path is a directory, not a file: ${path.basename(resolvedPath)}` }],
            isError: true,
          };
        }

        if (stat.size > TELEGRAM_MAX_FILE_SIZE) {
          const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
          return {
            content: [{ type: 'text' as const, text: `Error: File too large (${sizeMB}MB). Telegram limit is 50MB.` }],
            isError: true,
          };
        }

        const fileName = path.basename(resolvedPath);
        const fileBuffer = fs.readFileSync(resolvedPath);
        const inputFile = new InputFile(fileBuffer, fileName);

        await ctx.replyWithDocument(inputFile, {
          caption: caption || undefined,
        });

        const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
        return {
          content: [{
            type: 'text' as const,
            text: `File sent to user: ${fileName} (${sizeMB}MB)`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `File send error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function setTopicTool(toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_set_topic',
    'Update the conversation topic shown in the status line. Call this proactively when the work topic changes. Pass an empty string to clear. Keep topics very short (1-4 words).',
    {
      topic: z.string().describe(
        'Short topic label (1-4 words, e.g. "auth refactor", "CI fix", "dark mode"). Empty string to clear.'
      ),
    },
    async ({ topic }) => {
      try {
        const { sessionKey } = toolsCtx;

        // The topic lives in the status line, not the Telegram bot display name
        // (which only carries BOT_NAME — project). So we update in-memory +
        // persistent topic state and DO NOT call setMyName. Telegram rate-limits
        // setMyName brutally — firing it on every proactive topic change is what
        // trips multi-hour 429 flood-waits. Mirrors the /topic command handler.
        const trimmedTopic = topic.trim();
        setSessionTopic(sessionKey, trimmedTopic);

        return {
          content: [{
            type: 'text' as const,
            text: trimmedTopic
              ? `Topic set to "${trimmedTopic}".`
              : 'Topic cleared.',
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to set topic: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );
}

function publishTelegraphTool(_toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_publish_telegraph',
    'Publish markdown content as a Telegraph (telegra.ph) Instant View page. Returns the URL. Useful for sharing long-form content as a readable link.',
    {
      title: z.string().describe('Page title'),
      markdown: z.string().describe('Markdown content for the page'),
    },
    async ({ title, markdown }) => {
      try {
        const { createTelegraphPage } = await importTelegraph();
        const url = await createTelegraphPage(title, markdown);

        if (!url) {
          return {
            content: [{ type: 'text' as const, text: 'Failed to create Telegraph page.' }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `Telegraph page created: ${url}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Telegraph error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}


function askUserTool(toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_ask_user',
    'Ask the user a multiple-choice question via a Telegram inline keyboard. Use when you need a clear decision from the user (e.g. picking between approaches, confirming a destructive action, choosing among options) instead of free-text. Pauses the agent loop until the user taps a button or 10 minutes pass. Keep the question short and the options crisp — a label of ≤ 25 chars stays on its button; anything longer makes the whole keyboard fall back to lettered buttons (A/B/C) with the full labels listed in the message body. IMPORTANT: `context` is required and carries everything the user needs to decide (the comparison, trade-offs, findings, rationale) — it renders in the SAME message as the buttons. Do NOT write that explanation as prose before calling this tool: text you emit before an ask_user call is not delivered to the user until after they answer, so they would be choosing blind.',
    {
      question: z.string().describe('The question to display to the user. Keep concise (1-2 sentences).'),
      context: z
        .string()
        .min(1)
        .describe('Required. The multi-line explanation shown above the buttons in the same message (e.g. a comparison table, trade-offs, findings the user needs to make an informed choice). Put decision-relevant detail here, not in prose before the call — that prose is not shown until after the user answers. If the choice genuinely needs no explanation, restate what each option will do.'),
      options: z
        .array(
          z.object({
            label: z.string().describe('Button label. ≤ 25 chars keeps the label on its own button; longer labels are still shown in full in the message body, keyed A/B/C. Keep it to one line either way.'),
            description: z.string().optional().describe('Optional one-line context shown in the question body.'),
          })
        )
        .min(2)
        .max(8)
        .describe('Between 2 and 8 options for the user to choose from.'),
    },
    async ({ question, context, options }) => {
      try {
        const ctx = toolsCtx.telegramCtx;
        if (!ctx?.chat?.id) {
          return {
            content: [{ type: 'text' as const, text: 'Error: no Telegram context available to ask the user.' }],
            isError: true,
          };
        }

        const optionLabels = options.map((o) => o.label);
        const { id, promise } = createPendingQuestion(optionLabels, undefined, toolsCtx.sessionKey);

        const messageText = buildAskUserMessageText(question, options, context);

        const keyboard = buildAskUserKeyboard(id, options);

        // Plain text (no parse_mode): model-supplied question/context/label/
        // description text can contain stray underscores, asterisks, or
        // backticks (e.g. URL params like `f_WT=2`) that break legacy Markdown
        // parsing — Telegram returns 400 and the tool fails with no useful
        // signal to the model. The body lists every option in full, keyed by
        // the letter on its button.
        // From the session key, not `ctx.message` — a turn started by a tapped
        // button carries a callback-query context with no `message`, which
        // would silently drop the thread and post into General.
        const threadId = parseSessionKey(toolsCtx.sessionKey).threadId;
        await ctx.api.sendMessage(ctx.chat.id, messageText, {
          reply_markup: { inline_keyboard: keyboard },
          ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        });
        await messageSender.noteQuestionPosted(ctx, toolsCtx.sessionKey);

        const answer = await promise;
        await messageSender.noteQuestionAnswered(ctx, toolsCtx.sessionKey);
        if (!answer) {
          return {
            content: [{ type: 'text' as const, text: 'User did not respond within 10 minutes. Proceed using your best judgment or ask again.' }],
            isError: false,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `User selected: ${answer.label}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Ask-user error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}
