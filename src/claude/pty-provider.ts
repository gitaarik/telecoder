import { spawn, type IPty } from 'node-pty';
import headless from '@xterm/headless';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { sessionManager } from './session-manager.js';
import { getWorkspaceRoot } from '../utils/workspace-guard.js';
import {
  getIpcPort,
  registerActiveTurn,
  registerIpcHandler,
  unregisterActiveTurn,
  type ActiveTurn,
} from './ipc-server.js';
// Side-effect import: registers /mcp/* IPC handlers that bridge the standalone
// MCP subprocess back to bot-side state (Telegram API, session topic, …).
import './mcp-bridge.js';
import { type AgentOptions, type AgentResponse, type Provider, type ProviderName, type ModelInfo, type AgentUsage, type LoopOptions, type EditDiffEvent, type ToolResultEvent } from '../providers/types.js';

const { Terminal } = headless;

// ---- Config from prototype --------------------------------------------------

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// dist/claude/pty-provider.js → sibling dist/bin/mcp-server.js
const PROVIDER_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_JS = path.resolve(PROVIDER_DIR, '../bin/mcp-server.js');

const COLS = 120;
const ROWS = 40;
const IDLE_MS = 1200;
/**
 * Short window we wait *after* the Stop hook fires before extracting the
 * screen. Stop fires when claude finishes the response, but the TUI is
 * still redrawing the input box at that point. Without a settle, we'd
 * sometimes capture a half-rendered screen. 200ms is enough in practice.
 */
const POST_STOP_SETTLE_MS = 200;
const MAX_TURN_MS = 5 * 60_000;
const STARTUP_MAX_MS = 15_000;

function resolveCwd(sessionKey: string): string {
  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }
  const cwd = session.workingDirectory;
  if (cwd && fs.existsSync(cwd)) return cwd;
  const fallback = process.env.HOME || process.cwd();
  console.warn(`[PtyProvider] Working directory does not exist: ${cwd}, falling back to ${fallback}`);
  return fallback;
}


interface PtySession {
  term: IPty;
  xterm: headless.Terminal;
  cwd: string;
  /**
   * Pre-minted UUID passed to `claude --session-id`. Used as the registry key
   * for hook event dispatch (the hook payload's `session_id` matches this).
   */
  claudeSessionId: string;
  lastChunkAt: number;
  endOfTurnResolver: ((text: string) => void) | null;
  endOfTurnRejector: ((err: Error) => void) | null;
  idleTimer: NodeJS.Timeout | null;
  hardTimer: NodeJS.Timeout | null;
  onProgress?: (progress: string) => void;
  lastScreenText: string;
  /**
   * True once the current turn's Stop hook has fired. While true, the
   * end-of-turn check uses POST_STOP_SETTLE_MS instead of IDLE_MS and stops
   * requiring the input prompt glyph to be visible (Stop is itself the
   * authoritative signal; the prompt-visible check was only a heuristic).
   */
  stopReceived: boolean;
}

/**
 * Build the `--settings` JSON we inject at spawn time. Each registered hook
 * runs a `curl` POST to our loopback IPC server; the hook command is wrapped
 * so it always exits 0 (so a transient IPC failure never blocks claude).
 *
 * Stop / SubagentStop are intentionally NOT registered here — Phase 2 will
 * use them as the end-of-turn signal. UserPromptSubmit is similarly deferred.
 */
function buildSettingsJson(ipcPort: number): string {
  const hookCommand = (eventName: string) =>
    `curl -s -X POST -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:${ipcPort}/hook/${eventName}' >/dev/null 2>&1; exit 0`;

  return JSON.stringify({
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('preToolUse') }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: hookCommand('postToolUse') }] }],
      PostToolUseFailure: [{ hooks: [{ type: 'command', command: hookCommand('postToolUseFailure') }] }],
      Stop: [{ hooks: [{ type: 'command', command: hookCommand('stop') }] }],
    },
  });
}

/**
 * Build the system-prompt suffix that tells claude about our MCP tools.
 * Without this, the MCP tools show up only as deferred-tool names (claude
 * sees `mcp__claudegram-tools__claudegram_fetch_reddit` but doesn't have
 * its description, so it'll often fall back to WebFetch/Bash for the same
 * task). Mentioning each tool with a description and a "prefer over X"
 * hint makes claude pick the right tool.
 *
 * Driven by the same CLAUDEGRAM_*_ENABLED env flags that gate tool
 * registration in src/bin/mcp-server.ts.
 */
function buildMcpToolsSystemPromptNote(): string {
  const tools: string[] = [
    '- mcp__claudegram-tools__claudegram_list_projects — list available workspace projects the user can switch to',
    '- mcp__claudegram-tools__claudegram_switch_project — switch the working directory to a different project (call list_projects first). The change takes effect on the next user query.',
    '- mcp__claudegram-tools__claudegram_send_file — send a file from the bot\'s filesystem (within the workspace or /tmp) to the user via Telegram. Use after creating files (reports, SVGs, images, etc.) to deliver them directly. Max 50MB.',
  ];
  if (config.REDDIT_ENABLED) {
    tools.push('- mcp__claudegram-tools__claudegram_fetch_reddit — fetch reddit content (subreddits, threads, user profiles). Use this for any reddit.com/r/<subreddit> or post URL; prefer over WebFetch.');
  }
  if (config.MEDIUM_ENABLED) {
    tools.push('- mcp__claudegram-tools__claudegram_fetch_medium — fetch a Medium article (bypasses paywall). Use for medium.com / towardsdatascience.com / etc. URLs; prefer over WebFetch.');
  }
  if (config.EXTRACT_ENABLED) {
    tools.push('- mcp__claudegram-tools__claudegram_extract_media — extract text/audio/video from YouTube/Instagram/TikTok URLs. Audio/video files are sent directly to the user; transcripts are returned as text. Use for any youtube.com/youtu.be/instagram.com/tiktok.com URL.');
  }
  if (config.TELEGRAPH_ENABLED) {
    tools.push('- mcp__claudegram-tools__claudegram_publish_telegraph — publish a markdown document as a Telegraph (telegra.ph) Instant View page; returns the URL.');
  }
  if (config.DYNAMIC_BOT_NAME) {
    tools.push('- mcp__claudegram-tools__claudegram_set_topic — update the conversation topic shown in the bot display name. Call proactively when the topic of work shifts. Empty string clears it. Keep topics 1-4 words.');
  }
  return [
    'You have access to Claudegram-specific MCP tools listed below. They are loaded lazily — call them directly when relevant; do not try to reproduce their behavior with WebFetch/Bash.',
    ...tools,
  ].join('\n');
}

/**
 * Build the env we hand to the spawned MCP subprocess via --mcp-config.
 * MCP server env is the controlled subset listed here — anything not present
 * won't be visible to the subprocess. We pass:
 *   - required routing info (CLAUDEGRAM_IPC_PORT, _CLAUDE_SESSION_ID,
 *     _WORKSPACE_ROOT)
 *   - PATH/HOME/NODE_ENV so node can find binaries and home-relative files
 *   - every CLAUDEGRAM_*-prefixed var from this process's env (feature flags
 *     like CLAUDEGRAM_REDDIT_ENABLED gate which tools register)
 */
function buildMcpEnv(required: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    NODE_ENV: process.env.NODE_ENV || '',
    // Translate the bot's parsed config flags into the CLAUDEGRAM_*_ENABLED
    // form the MCP subprocess gates on. The bot's own env vars are unprefixed
    // (REDDIT_ENABLED, MEDIUM_ENABLED, …) so we can't just pass through.
    CLAUDEGRAM_REDDIT_ENABLED: config.REDDIT_ENABLED ? 'true' : 'false',
    CLAUDEGRAM_MEDIUM_ENABLED: config.MEDIUM_ENABLED ? 'true' : 'false',
    CLAUDEGRAM_TELEGRAPH_ENABLED: config.TELEGRAPH_ENABLED ? 'true' : 'false',
    CLAUDEGRAM_EXTRACT_ENABLED: config.EXTRACT_ENABLED ? 'true' : 'false',
    CLAUDEGRAM_DYNAMIC_BOT_NAME: config.DYNAMIC_BOT_NAME ? 'true' : 'false',
    CLAUDEGRAM_REDDITFETCH_DEFAULT_LIMIT: String(config.REDDITFETCH_DEFAULT_LIMIT),
    CLAUDEGRAM_REDDITFETCH_DEFAULT_DEPTH: String(config.REDDITFETCH_DEFAULT_DEPTH),
    // Reddit credentials — the redditfetch module reads these from its own
    // process.env, so they need to be present in the subprocess env or
    // OAuth will fail with "Missing Reddit credentials".
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID || '',
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET || '',
    REDDIT_USERNAME: process.env.REDDIT_USERNAME || '',
    REDDIT_PASSWORD: process.env.REDDIT_PASSWORD || '',
    ...required,
  };
  // Any extra CLAUDEGRAM_*-prefixed vars that the bot's env carries (e.g.
  // user overrides not codified in config.ts) get passed through too.
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLAUDEGRAM_') && typeof v === 'string' && env[k] === undefined) {
      env[k] = v;
    }
  }
  return env;
}

/**
 * Build the `--mcp-config` JSON we inject at spawn time. claude will spawn the
 * referenced node script as a stdio MCP subprocess. The env we pass through is
 * what the subprocess uses to reach back to our loopback IPC server.
 */
function buildMcpConfigJson(env: Record<string, string>): string {
  return JSON.stringify({
    mcpServers: {
      'claudegram-tools': {
        command: 'node',
        args: [MCP_SERVER_JS],
        env,
      },
    },
  });
}

export class PtyProvider implements Provider {
  readonly name: ProviderName = 'claude';

  private sessions = new Map<string, PtySession>();

  async sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse> {
    const finalScreenText = await this._runPtyTurn(sessionKey, message, options);
    const assistantResponse = this._extractAssistantResponse(finalScreenText);

    return {
      text: assistantResponse,
      toolsUsed: [], // PTY provider does not have tool usage information
    };
  }

  private async _runPtyTurn(sessionKey: string, prompt: string, options?: AgentOptions): Promise<string> {
    const session = this._getOrCreateSession(sessionKey, options);

    // Bind the in-flight options to claude's session_id so hook callbacks
    // dispatched by the IPC server can find the right AgentOptions to fire.
    // onClaudeStop is the Stop hook bridge — flips stopReceived and re-arms
    // the idle timer with the shorter settle window so we don't wait the
    // full IDLE_MS if no more chunks arrive after Stop fires.
    const activeTurn: ActiveTurn = {
      sessionKey,
      options: options ?? {},
      onClaudeStop: () => {
        session.stopReceived = true;
        if (session.endOfTurnResolver) {
          if (session.idleTimer) clearTimeout(session.idleTimer);
          session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), POST_STOP_SETTLE_MS);
        }
      },
    };
    registerActiveTurn(session.claudeSessionId, activeTurn);

    try {
      await this._waitForReady(session, IDLE_MS, STARTUP_MAX_MS);

      // Snapshot the screen before submitting so the progress diff and the
      // end-of-turn extraction only see content produced by this turn — the
      // pty stays alive across turns to preserve conversation state, so the
      // buffer holds the cumulative history.
      session.lastScreenText = this._getScreenText(session);

      // Submit handling for claude's TUI input editor:
      //
      // claude v2.1.143 integrated an Nvim-style multi-line editor (the
      // status bar shows "ctrl+g to edit in Nvim"). Writing `prompt + '\r'`
      // in a single term.write produces a bulk-input that the editor seems
      // to treat as a paste — the CR/LF inside gets buffered as content
      // rather than firing the submit action, so our prompt would just sit
      // in the input box. Splitting the write into "type the chars" then a
      // brief settle then a separate "press Enter" makes the trailing CR
      // look like a real keystroke and triggers submit.
      session.term.write(prompt);
      await new Promise((r) => setTimeout(r, 100));
      session.term.write('\r');

      return await this._awaitEndOfTurn(session);
    } finally {
      unregisterActiveTurn(session.claudeSessionId);
    }
  }

  private _getOrCreateSession(sessionKey: string, options?: AgentOptions): PtySession {
    const requiredCwd = resolveCwd(sessionKey);
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      if (existing.cwd === requiredCwd) {
        // Reuse the live pty so claude keeps prior turns in context.
        existing.onProgress = options?.onProgress;
        return existing;
      }
      // Workspace changed under us — restart cleanly.
      this._cleanupSession(sessionKey);
    }

    const claudeSessionId = randomUUID();
    const ipcPort = getIpcPort();
    const settingsJson = buildSettingsJson(ipcPort);
    const mcpConfigJson = buildMcpConfigJson(buildMcpEnv({
      CLAUDEGRAM_IPC_PORT: String(ipcPort),
      CLAUDEGRAM_CLAUDE_SESSION_ID: claudeSessionId,
      // Workspace root for the MCP subprocess (used by list_projects). This is
      // the top-level dev directory (`config.WORKSPACE_DIR`), NOT the current
      // project cwd — list_projects needs to enumerate sibling projects.
      CLAUDEGRAM_WORKSPACE_ROOT: getWorkspaceRoot(),
    }));

    const args = [
      '--dangerously-skip-permissions',
      '--session-id', claudeSessionId,
      // Exclude user-level settings. This keeps PTY mode predictable —
      // most importantly it drops `editorMode: "vim"` which makes \r insert
      // a newline instead of submitting (we saw prompts pile up in the
      // multi-line buffer and never reach the model). Project + local
      // settings still load, as does our injected --settings JSON below.
      '--setting-sources', 'project,local',
      '--settings', settingsJson,
      // Spawn our standalone MCP server as a stdio subprocess. Strict mode
      // scopes MCP to *only* what we pass here — the user's globally
      // configured MCP servers don't load in PTY mode.
      '--mcp-config', mcpConfigJson,
      '--strict-mcp-config',
      // Make our MCP tools discoverable to claude. Without this the tool
      // names appear in claude's deferred-tools list but claude often picks
      // WebFetch/Bash for the same task because the deferred listing has
      // no descriptions.
      '--append-system-prompt', buildMcpToolsSystemPromptNote(),
    ];

    const term = spawn(CLAUDE_BIN, args, {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: requiredCwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const xterm = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 1000,
      allowProposedApi: true,
    });

    const session: PtySession = {
      term,
      xterm,
      cwd: requiredCwd,
      claudeSessionId,
      lastChunkAt: Date.now(),
      endOfTurnResolver: null,
      endOfTurnRejector: null,
      idleTimer: null,
      hardTimer: null,
      onProgress: options?.onProgress,
      lastScreenText: '',
      stopReceived: false,
    };

    term.onData((chunk: string) => this._onData(session, chunk));

    term.onExit(({ exitCode, signal }) => {
      if (session.endOfTurnRejector) {
        session.endOfTurnRejector(new Error(`claude exited (code=${exitCode}, signal=${signal}) mid-turn`));
      }
      // Identity check: /clear or a workspace switch synchronously kills
      // this term, removes us from the map, and may immediately spawn a
      // replacement at the same sessionKey. By the time *this* late onExit
      // fires, the replacement is the live session — don't wipe it out.
      if (this.sessions.get(sessionKey) === session) {
        this.sessions.delete(sessionKey);
      }
    });

    this.sessions.set(sessionKey, session);
    return session;
  }

  private _onData(session: PtySession, chunk: string) {
    session.lastChunkAt = Date.now();
    session.xterm.write(chunk);

    if (session.onProgress) {
        const newScreenText = this._getScreenText(session);
        if(newScreenText.length > session.lastScreenText.length) {
            const diff = newScreenText.substring(session.lastScreenText.length);
            // We only care about assistant output, not user prompts or UI elements
            const cleanDiff = diff.replace(/^●\s*/, '').replace('❯', '').trim();
            if(cleanDiff.length > 0) {
                 session.onProgress(cleanDiff);
            }
        }
        session.lastScreenText = newScreenText;
    }

    if (session.endOfTurnResolver) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      const idleMs = session.stopReceived ? POST_STOP_SETTLE_MS : IDLE_MS;
      session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), idleMs);
    }
  }

  private _checkEndOfTurn(session: PtySession) {
    if (!session.endOfTurnResolver) return;

    const idleMs = session.stopReceived ? POST_STOP_SETTLE_MS : IDLE_MS;
    const sinceLast = Date.now() - session.lastChunkAt;
    const isIdle = sinceLast >= idleMs;

    // Stop hook fired → Stop itself is the authoritative end-of-turn signal,
    // we just wait for a brief settle. Otherwise fall back to the legacy
    // heuristic (idle + prompt glyph visible).
    const canResolve = session.stopReceived
      ? isIdle
      : isIdle && this._isPromptVisible(session);

    if (canResolve) {
      const resolved = session.endOfTurnResolver;
      session.endOfTurnResolver = null;
      session.endOfTurnRejector = null;
      if (session.hardTimer) clearTimeout(session.hardTimer);
      resolved(this._getScreenText(session));
    } else {
      const remaining = Math.max(50, idleMs - sinceLast);
      session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), remaining);
    }
  }

  private _isPromptVisible(session: PtySession): boolean {
    // ❯ appears in claude's input box. We use includes() rather than
    // startsWith() because the box-drawing chrome wraps the line as
    // `│ ❯ <typed text> │`, which trims to a string that doesn't *start*
    // with ❯. claude's own assistant output uses ● for bullets, not ❯,
    // so false positives are unlikely.
    return this._getScreenText(session).includes('❯');
  }

  private _awaitEndOfTurn(session: PtySession): Promise<string> {
    return new Promise((resolve, reject) => {
      // Intentionally NOT resetting xterm / lastScreenText: the pty is shared
      // across turns, and _runPtyTurn snapshotted lastScreenText right before
      // writing the prompt so the diff & extraction logic see only new content.
      // stopReceived MUST be reset — it's per-turn state and the previous turn
      // left it true.
      session.stopReceived = false;
      session.endOfTurnResolver = resolve;
      session.endOfTurnRejector = reject;
      session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), IDLE_MS);
      session.hardTimer = setTimeout(() => {
        if (session.endOfTurnRejector) {
          const r = session.endOfTurnRejector;
          session.endOfTurnResolver = null;
          session.endOfTurnRejector = null;
          r(new Error(`turn exceeded ${MAX_TURN_MS}ms`));
        }
      }, MAX_TURN_MS);
    });
  }

  /**
   * Wait until claude is actually ready to receive a prompt: stdout has been
   * idle for `idleMs` AND the input prompt glyph is visible on the rendered
   * screen. Stdout-idle alone is unsafe — claude's startup pauses (plugin
   * loading, settings parse) can exceed idleMs before the input box is drawn,
   * so a prompt written then gets silently consumed by the startup flow.
   * Caps at `capMs` so we never hang forever; logs a warning if the cap is
   * hit and proceeds anyway (better than freezing the bot).
   */
  private async _waitForReady(session: PtySession, idleMs: number, capMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < capMs) {
      const since = Date.now() - session.lastChunkAt;
      if (since >= idleMs && this._isPromptVisible(session)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    console.warn(`[PtyProvider] _waitForReady cap reached (${capMs}ms) without confirmed input prompt; proceeding anyway`);
  }

  private _getScreenText(session: PtySession): string {
    const buffer = session.xterm.buffer.active;
    let text = '';
    for (let i = 0; i < buffer.length; i++) {
      text += buffer.getLine(i)?.translateToString(true) + '\n';
    }
    return text.replace(/\n+$/, ''); // Trim trailing newlines
  }

  private _extractAssistantResponse(screenText: string): string {
    const lines = screenText.split('\n');
    const lastAssistantLine = lines.map((line, i) => [line, i] as const).filter(([line]) => line.includes('●')).pop();
    if (!lastAssistantLine) {
      const promptIndex = lines.findIndex(line => line.includes('❯'));
      if (promptIndex > 0) return lines.slice(0, promptIndex).join('\n').trim();
      return screenText.trim();
    }

    const responseLines = lines.slice(lastAssistantLine[1]);
    const stopIndex = responseLines.findIndex((line, i) => i > 0 && this._isChromeLine(line));
    const contentLines = stopIndex !== -1 ? responseLines.slice(0, stopIndex) : responseLines;

    return contentLines
      .map(line => line.replace(/^●\s*/, ''))
      .join('\n')
      .trim();
  }

  // A line is considered TUI chrome (footer, input box, separator, prompt) and
  // marks the end of the assistant's response region.
  private _isChromeLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('✻')) return true;                  // "Brewed for Xs" timer
    if (/^[╭╰╮╯]/.test(trimmed)) return true;                  // input-box corners
    if (/^│\s/.test(trimmed) || trimmed.includes('❯')) return true; // input box body / prompt glyph
    if (/^[─━═]{3,}$/.test(trimmed)) return true;              // horizontal separators
    return false;
  }

  private _cleanupSession(sessionKey: string) {
    const session = this.sessions.get(sessionKey);
    if(session) {
      try {
        session.term.kill();
      } catch (e) {
        // ignore
      }
      if(session.idleTimer) clearTimeout(session.idleTimer);
      if(session.hardTimer) clearTimeout(session.hardTimer);
      this.sessions.delete(sessionKey);
    }
  }

  async sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse> {
    return Promise.reject(new Error('Loop mode is not yet implemented for the PtyProvider.'));
  }

  clearConversation(sessionKey: string): void {
    this._cleanupSession(sessionKey);
    console.log(`[PtyProvider] Cleared conversation for session ${sessionKey}`);
  }

  setModel(chatId: number, model: string): void {
    console.log(`[PtyProvider] Setting model to ${model} for chat ${chatId} is not supported.`);
  }

  getModel(chatId: number): string {
    return 'claude-opus-4-7'; // Default
  }

  clearModel(chatId: number): void {
    // No-op
  }

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    return undefined;
  }

  isDangerousMode(): boolean {
    return true;
  }

  async getAvailableModels(chatId: number): Promise<ModelInfo[]> {
    return Promise.resolve([
      { id: 'claude-opus-4-7', label: 'Opus 4.7 (via PTY)', description: 'Claude Code CLI' }
    ]);
  }
}

// ---- Hook → AgentOptions callback bridge ------------------------------------
//
// The handlers below run inside the IPC server when claude-spawned hook curls
// reach us. They translate hook payloads into the SDK-shaped callbacks the bot
// already implements (onToolStart / onToolEnd / onToolResult / onEditDiff), so
// PTY mode lights up the same verbose UI as SDK mode.
//
// Callbacks are fire-and-forget — the hook command blocks claude until the
// HTTP POST returns, so we ack fast and let the bot's Telegram calls run on
// their own microtasks. Errors are logged, never rethrown into claude.

function fireAndForget(label: string, fn: (() => Promise<unknown> | unknown) | undefined): void {
  if (!fn) return;
  void Promise.resolve()
    .then(() => fn())
    .catch(err => console.error(`[PTY hook] ${label} threw:`, err));
}

/**
 * Pick the model-facing string out of a hook payload's `tool_response`.
 *
 * SDK mode delivers tool results as the *serialized* form the model sees
 * (Read → just the file content, Bash → stdout+stderr text). Hook payloads
 * instead give us claude's internal structured object:
 *   Read → { type: 'text', file: { filePath, content } }
 *   Bash → { stdout, stderr, exit_code, … }
 *
 * We unwrap the common shapes so PTY mode renders tool results the same way
 * SDK mode does. Unknown shapes fall back to a JSON dump — better than
 * nothing for diagnostics, even if it's ugly.
 */
function extractToolResponseContent(toolResponse: unknown): string {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse !== 'object') return String(toolResponse);

  const obj = toolResponse as Record<string, unknown>;

  // Read → unwrap file.content
  if (obj.file && typeof obj.file === 'object') {
    const file = obj.file as Record<string, unknown>;
    if (typeof file.content === 'string') return file.content;
  }

  // Bash → combine stdout + stderr (matches what the model sees)
  if ('stdout' in obj || 'stderr' in obj) {
    const parts: string[] = [];
    if (typeof obj.stdout === 'string' && obj.stdout) parts.push(obj.stdout);
    if (typeof obj.stderr === 'string' && obj.stderr) parts.push(obj.stderr);
    return parts.join('\n').trim();
  }

  // Common single-field shapes
  for (const key of ['content', 'result', 'output', 'text'] as const) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }

  // Unknown shape — JSON-dump as a last resort so something shows up
  try { return JSON.stringify(obj); }
  catch { return String(obj); }
}

registerIpcHandler('/hook/preToolUse', (turn, body) => {
  const toolName = String(body.tool_name ?? 'unknown');
  const toolInput = (body.tool_input ?? {}) as Record<string, unknown>;
  fireAndForget('onToolStart', () => turn.options.onToolStart?.(toolName, toolInput));
  return { ok: true };
});

registerIpcHandler('/hook/postToolUse', (turn, body) => {
  const toolName = String(body.tool_name ?? 'unknown');
  const toolInput = (body.tool_input ?? {}) as Record<string, unknown>;
  const toolUseId = String(body.tool_use_id ?? '');

  fireAndForget('onToolEnd', () => turn.options.onToolEnd?.());

  if (toolName === 'Edit' || toolName === 'Write') {
    // Successful Edit/Write — surface the diff so the bot shows before/after.
    const event: EditDiffEvent = {
      toolUseId,
      toolName,
      filePath: String(toolInput.file_path ?? ''),
      oldString: toolName === 'Edit' ? String(toolInput.old_string ?? '') : undefined,
      newString: toolName === 'Edit'
        ? String(toolInput.new_string ?? '')
        : String(toolInput.content ?? ''),
    };
    fireAndForget('onEditDiff', () => turn.options.onEditDiff?.(event));
  } else {
    const event: ToolResultEvent = {
      toolUseId,
      toolName,
      content: extractToolResponseContent(body.tool_response),
      isError: false,
    };
    fireAndForget('onToolResult', () => turn.options.onToolResult?.(event));
  }
  return { ok: true };
});

registerIpcHandler('/hook/postToolUseFailure', (turn, body) => {
  const toolName = String(body.tool_name ?? 'unknown');
  const toolUseId = String(body.tool_use_id ?? '');

  fireAndForget('onToolEnd', () => turn.options.onToolEnd?.());
  const event: ToolResultEvent = {
    toolUseId,
    toolName,
    content: extractToolResponseContent(body.tool_response),
    isError: true,
  };
  fireAndForget('onToolResult', () => turn.options.onToolResult?.(event));
  return { ok: true };
});

// Stop fires when claude finishes responding. PtyProvider's onClaudeStop sets
// stopReceived on the live pty session so end-of-turn detection switches to
// the short settle window and stops requiring the input prompt to be visible.
registerIpcHandler('/hook/stop', (turn) => {
  turn.onClaudeStop?.();
  return { ok: true };
});
