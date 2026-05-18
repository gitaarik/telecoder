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

const workspaceRoot = process.env.CLAUDEGRAM_WORKSPACE_ROOT || path.resolve(process.cwd());
const ipcPort = process.env.CLAUDEGRAM_IPC_PORT;
const claudeSessionId = process.env.CLAUDEGRAM_CLAUDE_SESSION_ID || '';
const ipcUrl = ipcPort ? `http://127.0.0.1:${ipcPort}` : null;

/**
 * POST a JSON payload to the bot's loopback IPC server. claude's session_id
 * is appended automatically so the IPC server can route to the right active
 * turn. Throws on non-2xx so the calling tool can surface a useful error.
 */
async function ipc<T = unknown>(routePath: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!ipcUrl) throw new Error('CLAUDEGRAM_IPC_PORT not set; cannot reach bot');
  const res = await fetch(`${ipcUrl}${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: claudeSessionId, ...payload }),
  });
  if (!res.ok) {
    throw new Error(`IPC ${routePath} → HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[claudegram-mcp] connected via stdio (workspace=${workspaceRoot})`);
}

main().catch((err) => {
  console.error('[claudegram-mcp] fatal:', err);
  process.exit(1);
});
