/**
 * Claudegram standalone MCP server.
 *
 * Spawned by `claude --mcp-config` when running under PtyProvider, communicates
 * over stdio. Tools that need bot-side context (Telegram send_file / ask_user /
 * set_topic, …) POST to the main bot process's loopback IPC server; tools that
 * are pure local work (list_projects, fetch_reddit, fetch_medium, …) run inline.
 *
 * Env vars set by PtyProvider when spawning this process:
 *   CLAUDEGRAM_IPC_PORT          loopback IPC server port
 *   CLAUDEGRAM_CLAUDE_SESSION_ID claude's session_id; used as the IPC routing key
 *   CLAUDEGRAM_WORKSPACE_ROOT    workspace root for security checks
 *   CLAUDEGRAM_REDDIT_ENABLED    feature flag for fetch_reddit
 *   CLAUDEGRAM_MEDIUM_ENABLED    feature flag for fetch_medium
 *   CLAUDEGRAM_TELEGRAPH_ENABLED feature flag for publish_telegraph
 *   CLAUDEGRAM_REDDITFETCH_DEFAULT_LIMIT, CLAUDEGRAM_REDDITFETCH_DEFAULT_DEPTH
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

const workspaceRoot = process.env.CLAUDEGRAM_WORKSPACE_ROOT || path.resolve(process.cwd());
const ipcPort = process.env.CLAUDEGRAM_IPC_PORT;
const claudeSessionId = process.env.CLAUDEGRAM_CLAUDE_SESSION_ID || '';

/**
 * POST a JSON payload to the bot's loopback IPC server. claude's session_id
 * is appended automatically so the IPC server can route to the right active
 * turn. Throws on non-2xx so the calling tool can surface a useful error.
 *
 * Deliberately `node:http` rather than `fetch`. claudegram_ask_user and
 * claudegram_poll_user are long polls: the bot holds the request open — sending
 * no response headers at all — for up to 10 minutes while it waits for a
 * Telegram button tap. undici, which backs global fetch, enforces a 5-minute
 * `headersTimeout` that can only be lifted with a custom dispatcher, so every
 * question left unanswered for 5 minutes died as an opaque `fetch failed`
 * (UND_ERR_HEADERS_TIMEOUT) instead of the intended graceful 10-minute "user
 * did not respond" — and the model, seeing a tool error, tended to re-ask and
 * post a second keyboard while the first was still live.
 *
 * `http.request` applies no timeout unless asked, which puts the deadline back
 * with the layers that actually know it: the bot's own 10-minute question timer
 * (see createPendingQuestion), with claude's MCP_TOOL_TIMEOUT (15 min, set by
 * PtyProvider) as the outer backstop. The server side already disables its own
 * timeouts for the same reason — see startIpcServer.
 */
function ipc<T = unknown>(routePath: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!ipcPort) return Promise.reject(new Error('CLAUDEGRAM_IPC_PORT not set; cannot reach bot'));
  const body = JSON.stringify({ session_id: claudeSessionId, ...payload });

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(ipcPort),
        path: routePath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`IPC ${routePath} → HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch {
            reject(new Error(`IPC ${routePath} → malformed JSON response`));
          }
        });
        res.on('error', (err: Error) => reject(new Error(`IPC ${routePath} → ${err.message}`)));
      },
    );

    // Name the actual failure rather than fetch's opaque "fetch failed". The
    // common one is ECONNREFUSED: the bot restarted (new port) while this pty
    // and its MCP subprocess kept running against the old one.
    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(`IPC ${routePath} → ${err.code ?? err.message}`));
    });
    req.end(body);
  });
}

// ── Constants ────────────────────────────────────────────────────────
const REDDIT_MAX_CHARS = 50_000;

// Lazy imports — keep startup fast, and only load modules whose tool is
// actually present in this configuration.
async function importReddit() {
  return import('../reddit/redditfetch.js');
}
async function importMedium() {
  return import('../medium/freedium.js');
}
async function importTelegraph() {
  return import('../telegram/telegraph.js');
}

const server = new McpServer({
  name: 'claudegram-tools',
  version: '1.0.0',
});

// ── claudegram_list_projects (no IPC, no flag — always on) ───────────
server.tool(
  'claudegram_list_projects',
  'List all available projects in the workspace directory. Use this to see what projects the user can switch to.',
  {},
  async () => {
    try {
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
        content: [{
          type: 'text' as const,
          text: `Error listing projects: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

// ── claudegram_fetch_reddit ──────────────────────────────────────────
if (process.env.CLAUDEGRAM_REDDIT_ENABLED === 'true') {
  server.tool(
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
        const defaultLimit = parseInt(process.env.CLAUDEGRAM_REDDITFETCH_DEFAULT_LIMIT || '10', 10);
        const defaultDepth = parseInt(process.env.CLAUDEGRAM_REDDITFETCH_DEFAULT_DEPTH || '5', 10);
        const result = await redditFetch([target], {
          format: 'markdown',
          sort: sort || 'hot',
          limit: limit || defaultLimit,
          depth: depth || defaultDepth,
          timeFilter: time_filter,
        });
        const truncated = result.length > REDDIT_MAX_CHARS
          ? result.substring(0, REDDIT_MAX_CHARS) + '\n\n[... truncated — content exceeded 50k chars]'
          : result;
        return { content: [{ type: 'text' as const, text: truncated }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Reddit fetch error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

// ── claudegram_fetch_medium ──────────────────────────────────────────
if (process.env.CLAUDEGRAM_MEDIUM_ENABLED === 'true') {
  server.tool(
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
    },
  );
}

// ── claudegram_ask_user (IPC: long-poll on Telegram button tap) ──────
server.tool(
  'claudegram_ask_user',
  'Ask the user a multiple-choice question via a Telegram inline keyboard. Use when you need a clear decision from the user (e.g. picking between approaches, confirming a destructive action, choosing among options) instead of free-text. Pauses the agent loop until the user taps a button or 10 minutes pass. Keep the question short and the options crisp — labels must be ≤ 60 chars. Prefer this over the built-in AskUserQuestion when interacting through claudegram. IMPORTANT: `context` is required and carries everything the user needs to decide (the comparison, trade-offs, findings, rationale) — it renders in the SAME message as the buttons. Do NOT write that explanation as prose before calling this tool: text you emit before an ask_user call is not delivered to the user until after they answer, so they would be choosing blind.',
  {
    question: z.string().describe('The question to display to the user. Keep concise (1-2 sentences).'),
    context: z
      .string()
      .min(1)
      .describe('Required. The multi-line explanation shown above the buttons in the same message (e.g. a comparison table, trade-offs, findings the user needs to make an informed choice). Put decision-relevant detail here, not in prose before the call — that prose is not shown until after the user answers. If the choice genuinely needs no explanation, restate what each option will do.'),
    options: z
      .array(
        z.object({
          label: z.string().describe('Short button label shown in Telegram. Must be ≤ 60 chars.'),
          description: z.string().optional().describe('Optional one-line context shown in the question body.'),
        })
      )
      .min(2)
      .max(8)
      .describe('Between 2 and 8 options for the user to choose from.'),
  },
  async ({ question, context, options }) => {
    try {
      const result = await ipc<{ success: boolean; message: string }>('/mcp/ask_user', { question, context, options });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Ask-user error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ── claudegram_switch_project (IPC: updates session workdir) ─────────
server.tool(
  'claudegram_switch_project',
  'Switch the working directory to a different project. The change takes effect on the next query. Use claudegram_list_projects first to see available projects.',
  {
    project_name: z.string().describe('Name of the project directory to switch to'),
  },
  async ({ project_name }) => {
    try {
      const result = await ipc<{ success: boolean; message: string }>('/mcp/switch_project', { project_name });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Switch project error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ── claudegram_extract_media (IPC: yt-dlp + Telegram upload on bot side) ─
if (process.env.CLAUDEGRAM_EXTRACT_ENABLED === 'true') {
  server.tool(
    'claudegram_extract_media',
    'Extract text transcripts, audio, or video from YouTube, Instagram, and TikTok URLs. Audio/video files are sent directly to the user via Telegram. Transcripts are returned as text.',
    {
      url: z.string().describe('URL of the video (YouTube, Instagram, or TikTok)'),
      mode: z.enum(['text', 'audio', 'video', 'all']).describe('What to extract: "text" for transcript, "audio" for MP3, "video" for MP4, "all" for everything'),
    },
    async ({ url, mode }) => {
      try {
        const result = await ipc<{ success: boolean; message: string }>('/mcp/extract_media', { url, mode });
        return {
          content: [{ type: 'text' as const, text: result.message }],
          isError: !result.success,
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Extract media error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

// ── claudegram_send_file (IPC: needs bot for Telegram sendDocument) ──
server.tool(
  'claudegram_send_file',
  'Send a file from the server to the user via Telegram. The file must be within the current working directory or /tmp. Use this after creating files (SVGs, images, reports, etc.) to deliver them directly to the user. Maximum file size: 50MB.',
  {
    file_path: z.string().describe('Absolute or workspace-relative path to the file to send.'),
    caption: z.string().optional().describe('Optional caption to display with the file in Telegram.'),
  },
  async ({ file_path, caption }) => {
    try {
      const result = await ipc<{ success: boolean; message: string }>('/mcp/send_file', { file_path, caption });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `File send error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ── claudegram_set_topic (IPC: needs bot for Telegram setMyName) ─────
if (process.env.CLAUDEGRAM_DYNAMIC_BOT_NAME === 'true') {
  server.tool(
    'claudegram_set_topic',
    'Update the conversation topic shown in the bot display name. Call this proactively when the work topic changes. Pass an empty string to clear. Keep topics very short (1-4 words, e.g. "auth refactor", "CI fix", "dark mode").',
    {
      topic: z.string().describe('Short topic label (1-4 words). Empty string to clear.'),
    },
    async ({ topic }) => {
      try {
        const result = await ipc<{ success: boolean; message?: string; displayName?: string }>('/mcp/set_topic', { topic });
        return {
          content: [{
            type: 'text' as const,
            text: result.message || (result.success ? `Topic set to "${topic}".` : 'Topic update failed.'),
          }],
          isError: !result.success,
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `set_topic error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

// ── claudegram_publish_telegraph ─────────────────────────────────────
if (process.env.CLAUDEGRAM_TELEGRAPH_ENABLED === 'true') {
  server.tool(
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
        return { content: [{ type: 'text' as const, text: `Telegraph page created: ${url}` }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Telegraph error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

// ── claudegram_poll_user (IPC: Telegram poll) ────────────────────────
server.tool(
  'claudegram_poll_user',
  'Ask the user (or a group) a question via a Telegram poll. Prefer this over claudegram_ask_user when (a) multiple chat members should vote, (b) you want vote counts shown alongside, or (c) you need multi-select. Polls are non-anonymous (vote identities visible). Resolves on the first vote — for multi-select, the snapshot at that moment is returned. 2-10 options.',
  {
    question: z.string().describe('The poll question. ≤ 300 chars (Telegram cap).'),
    options: z.array(z.string()).min(2).max(10).describe('Poll options. Each ≤ 100 chars.'),
    allows_multiple_answers: z.boolean().optional().describe('Whether voters can pick more than one option. Default false.'),
  },
  async ({ question, options, allows_multiple_answers }) => {
    try {
      const result = await ipc<{ success: boolean; message: string }>('/mcp/poll_user', {
        question,
        options,
        allows_multiple_answers: !!allows_multiple_answers,
      });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Poll error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ── claudegram_loop (IPC: registers an interval schedule) ────────────
server.tool(
  'claudegram_loop',
  'Schedule a prompt to re-fire on a fixed interval, pinging the user via Telegram each time. Use for "every N minutes/hours, do X" tasks (poll a status, check a metric, remind me). The first fire is one interval from now, NOT immediately. Returns the schedule id. Hard caps: 60s minimum interval, default 50 fires (max 500), 10 schedules per chat.',
  {
    prompt: z.string().describe('Exact prompt to re-fire on each tick. Write it as a complete instruction — the model receives it with no extra context beyond your current session.'),
    interval_seconds: z.number().int().min(60).describe('How often to fire, in seconds. Must be ≥ 60.'),
    max_runs: z.number().int().min(1).max(500).optional().describe('Cap on total fires. Default 50, ceiling 500. Schedule auto-disables after the cap is hit.'),
    label: z.string().optional().describe('Short human-readable title shown in the "🔔 Scheduled" header (≤ 60 chars recommended).'),
  },
  async ({ prompt, interval_seconds, max_runs, label }) => {
    try {
      const result = await ipc<{ success: boolean; message: string }>('/mcp/schedule_loop', {
        prompt,
        interval_seconds,
        max_runs,
        label,
      });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Loop schedule error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ── claudegram_schedule (IPC: registers a cron-based schedule) ───────
server.tool(
  'claudegram_schedule',
  'Schedule a prompt to fire on a cron expression (e.g. "0 9 * * *" for daily 9am). Use for time-of-day or day-of-week tasks (morning standup, weekly summary, end-of-day report). 5-field cron only (minute hour day-of-month month day-of-week). Returns the schedule id. Same caps as claudegram_loop.',
  {
    prompt: z.string().describe('Exact prompt to fire on each scheduled time.'),
    cron_expression: z.string().describe('5-field cron expression. Examples: "0 9 * * *" (daily 9am), "0 9 * * 1-5" (weekdays 9am), "*/15 * * * *" (every 15 min on the dot — note: subject to the same 60s minimum).'),
    max_runs: z.number().int().min(1).max(500).optional().describe('Cap on total fires. Default 50, ceiling 500.'),
    label: z.string().optional().describe('Short human-readable title shown in the "🔔 Scheduled" header.'),
  },
  async ({ prompt, cron_expression, max_runs, label }) => {
    try {
      const result = await ipc<{ success: boolean; message: string }>('/mcp/schedule_cron', {
        prompt,
        cron_expression,
        max_runs,
        label,
      });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Cron schedule error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ── claudegram_list_schedules (IPC: read-only) ───────────────────────
server.tool(
  'claudegram_list_schedules',
  'List active schedules for the current chat. Returns each schedule\'s id, type, cadence, run count, and prompt preview. Use before creating a new schedule to check existing ones, or to find an id to cancel.',
  {},
  async () => {
    try {
      const result = await ipc<{ success: boolean; message: string }>('/mcp/schedule_list', {});
      return {
        content: [{ type: 'text' as const, text: result.message }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `List schedules error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ── claudegram_cancel_schedule (IPC: remove a schedule by id) ────────
server.tool(
  'claudegram_cancel_schedule',
  'Cancel and remove a scheduled task by id. Get the id from claudegram_list_schedules.',
  {
    id: z.string().describe('The schedule id (looks like sch_xxxxxxxx_xxxxxx).'),
  },
  async ({ id }) => {
    try {
      const result = await ipc<{ success: boolean; message: string }>('/mcp/schedule_cancel', { id });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Cancel schedule error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[claudegram-mcp] connected via stdio (workspace=${workspaceRoot})`);
}

main().catch((err) => {
  console.error('[claudegram-mcp] fatal:', err);
  process.exit(1);
});
