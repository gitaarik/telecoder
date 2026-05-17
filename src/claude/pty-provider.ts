import { spawn, type IPty } from 'node-pty';
import headless from '@xterm/headless';
import * as fs from 'fs';
import { sessionManager } from './session-manager.js';
import { type AgentOptions, type AgentResponse, type Provider, type ProviderName, type ModelInfo, type AgentUsage, type LoopOptions } from '../providers/types.js';

const { Terminal } = headless;

// ---- Config from prototype --------------------------------------------------

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const COLS = 120;
const ROWS = 40;
const IDLE_MS = 1200;
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
  lastChunkAt: number;
  endOfTurnResolver: ((text: string) => void) | null;
  endOfTurnRejector: ((err: Error) => void) | null;
  idleTimer: NodeJS.Timeout | null;
  hardTimer: NodeJS.Timeout | null;
  onProgress?: (progress: string) => void;
  lastScreenText: string;
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

    await this._waitForIdle(session, IDLE_MS, STARTUP_MAX_MS);

    // Snapshot the screen before submitting so the progress diff and the
    // end-of-turn extraction only see content produced by this turn — the
    // pty stays alive across turns to preserve conversation state, so the
    // buffer holds the cumulative history.
    session.lastScreenText = this._getScreenText(session);

    session.term.write(prompt + '\r');

    return this._awaitEndOfTurn(session);
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

    const args = ['--dangerously-skip-permissions'];

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
      lastChunkAt: Date.now(),
      endOfTurnResolver: null,
      endOfTurnRejector: null,
      idleTimer: null,
      hardTimer: null,
      onProgress: options?.onProgress,
      lastScreenText: '',
    };

    term.onData((chunk: string) => this._onData(session, chunk));

    term.onExit(({ exitCode, signal }) => {
      if (session.endOfTurnRejector) {
        session.endOfTurnRejector(new Error(`claude exited (code=${exitCode}, signal=${signal}) mid-turn`));
      }
      this.sessions.delete(sessionKey);
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
      session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), IDLE_MS);
    }
  }

  private _checkEndOfTurn(session: PtySession) {
    const screenText = this._getScreenText(session);
    const lines = screenText.split('\n');

    const isIdle = (Date.now() - session.lastChunkAt) >= IDLE_MS;
    const isPromptVisible = lines.some(line => line.trim().startsWith('❯'));

    if (!session.endOfTurnResolver) return;

    if (isIdle && isPromptVisible) {
      const resolved = session.endOfTurnResolver;
      session.endOfTurnResolver = null;
      session.endOfTurnRejector = null;
      if (session.hardTimer) clearTimeout(session.hardTimer);
      resolved(screenText);
    } else {
      const remaining = isIdle ? IDLE_MS : IDLE_MS - (Date.now() - session.lastChunkAt);
      session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), remaining);
    }
  }

  private _awaitEndOfTurn(session: PtySession): Promise<string> {
    return new Promise((resolve, reject) => {
      // Intentionally NOT resetting xterm / lastScreenText: the pty is shared
      // across turns, and _runPtyTurn snapshotted lastScreenText right before
      // writing the prompt so the diff & extraction logic see only new content.
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

  private async _waitForIdle(session: PtySession, idleMs: number, capMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < capMs) {
      const since = Date.now() - session.lastChunkAt;
      if (since >= idleMs) return;
      await new Promise((r) => setTimeout(r, Math.max(50, idleMs - since)));
    }
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
