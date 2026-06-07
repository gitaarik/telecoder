import * as fs from 'fs';
import * as os from 'os';
import { sessionHistory, SessionHistoryEntry } from './session-history.js';

/**
 * Resolve a stored working directory to a valid path on this system.
 * Handles cross-OS portability (e.g. /Users/x saved on macOS, running on Linux).
 */
function resolveWorkingDirectory(storedPath: string): string {
  // If it exists, use as-is
  if (fs.existsSync(storedPath)) return storedPath;

  // Try remapping: replace the stored home prefix with the current $HOME
  // e.g. /Users/player3vsgpt/foo → /home/player3vsgpt/foo
  const home = os.homedir();
  const homePrefixes = ['/Users/', '/home/'];
  for (const prefix of homePrefixes) {
    if (storedPath.startsWith(prefix)) {
      // Extract everything after the username segment
      const rest = storedPath.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      const remapped = slashIdx === -1 ? home : `${home}${rest.slice(slashIdx)}`;
      if (fs.existsSync(remapped)) return remapped;
    }
  }

  // Last resort: fall back to $HOME
  return home;
}

export interface Session {
  conversationId: string;
  claudeSessionId?: string;
  /** Provider backend that created `claudeSessionId` (claude / ccr / opencode).
   * Lets the agent refuse to resume a session on a different backend. */
  ownerProvider?: string;
  workingDirectory: string;
  createdAt: Date;
  lastActivity: Date;
}

class SessionManager {
  private sessions: Map<string, Session> = new Map();
  // Tracks the last assistant text we successfully relayed to Telegram per
  // sessionKey. Compared against the JSONL's latest assistant turn to detect
  // gaps introduced by extractor edge cases (pure tool-call turns, lossy
  // screen-scrape fallback, early end-of-turn before JSONL flush). In-memory
  // only — after a restart we assume "caught up to nothing" so /sync will
  // surface the most recent turn, which is the safer default.
  private lastRelayedAssistantText: Map<string, string> = new Map();

  getSession(sessionKey: string): Session | undefined {
    return this.sessions.get(sessionKey);
  }

  getLastRelayedAssistantText(sessionKey: string): string {
    return this.lastRelayedAssistantText.get(sessionKey) ?? '';
  }

  setLastRelayedAssistantText(sessionKey: string, text: string): void {
    this.lastRelayedAssistantText.set(sessionKey, text);
  }

  createSession(sessionKey: string, workingDirectory: string, conversationId?: string): Session {
    const resolved = resolveWorkingDirectory(workingDirectory);
    const session: Session = {
      conversationId: conversationId || this.generateConversationId(),
      claudeSessionId: undefined,
      workingDirectory: resolved,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(sessionKey, session);

    // Persist to history
    sessionHistory.saveSession(sessionKey, session.conversationId, resolved, '', session.claudeSessionId);

    return session;
  }

  updateActivity(sessionKey: string, messagePreview?: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.lastActivity = new Date();

      // Update history with last message preview
      if (messagePreview) {
        sessionHistory.updateLastMessage(sessionKey, session.conversationId, messagePreview);
      }
    }
  }

  updateLastAssistantMessage(sessionKey: string, preview: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      sessionHistory.updateLastAssistantMessage(sessionKey, session.conversationId, preview);
    }
  }

  clearLastAssistantPreview(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      sessionHistory.clearLastAssistantPreview(sessionKey, session.conversationId);
    }
  }

  setWorkingDirectory(sessionKey: string, directory: string): Session {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      if (existing.workingDirectory === directory) {
        existing.lastActivity = new Date();
        sessionHistory.saveSession(
          sessionKey,
          existing.conversationId,
          directory,
          '',
          existing.claudeSessionId,
        );
        return existing;
      }
      // Different directory: start a new conversation. The Agent SDK session
      // is bound to the original cwd, so we mint a fresh conversationId and
      // leave the prior history entry intact for "back to previous project".
      return this.createSession(sessionKey, directory);
    }
    return this.createSession(sessionKey, directory);
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.lastRelayedAssistantText.delete(sessionKey);
    // Note: We don't clear history here - history is for resuming past sessions
  }

  resumeSession(sessionKey: string, conversationId: string): Session | undefined {
    const historyEntry = sessionHistory.getSessionByConversationId(sessionKey, conversationId);
    if (!historyEntry) {
      return undefined;
    }

    const resolvedPath = resolveWorkingDirectory(historyEntry.projectPath);
    const session: Session = {
      conversationId: historyEntry.conversationId,
      claudeSessionId: historyEntry.claudeSessionId,
      ownerProvider: historyEntry.ownerProvider,
      workingDirectory: resolvedPath,
      createdAt: new Date(historyEntry.createdAt),
      lastActivity: new Date(),
    };
    this.sessions.set(sessionKey, session);

    // Update history activity (with resolved path)
    sessionHistory.saveSession(sessionKey, conversationId, resolvedPath, historyEntry.lastMessagePreview, historyEntry.claudeSessionId);

    return session;
  }

  resumeLastSession(sessionKey: string): Session | undefined {
    const lastEntry = sessionHistory.getLastSession(sessionKey);
    if (!lastEntry) {
      return undefined;
    }

    return this.resumeSession(sessionKey, lastEntry.conversationId);
  }

  /** Return the in-memory session if present; otherwise transparently restore
   * the last session from disk if it's recent enough. Lets handlers recover
   * from unplanned restarts without forcing the user to type /continue. */
  getOrRestoreSession(
    sessionKey: string,
    maxAgeMs: number = 60 * 60 * 1000,
  ): { session: Session | undefined; restored: boolean } {
    const existing = this.sessions.get(sessionKey);
    if (existing) return { session: existing, restored: false };

    const lastEntry = sessionHistory.getLastSession(sessionKey);
    if (!lastEntry) return { session: undefined, restored: false };

    const age = Date.now() - new Date(lastEntry.lastActivity).getTime();
    if (age < 0 || age > maxAgeMs) return { session: undefined, restored: false };

    const session = this.resumeLastSession(sessionKey);
    return { session, restored: !!session };
  }

  getSessionHistory(sessionKey: string, limit: number = 5): SessionHistoryEntry[] {
    return sessionHistory.getHistory(sessionKey, limit);
  }

  setClaudeSessionId(sessionKey: string, claudeSessionId: string, ownerProvider?: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.claudeSessionId = claudeSessionId;
    // Pin ownership the first time a session id is established. Don't overwrite
    // a known owner on subsequent turns of the same session.
    if (ownerProvider && !session.ownerProvider) {
      session.ownerProvider = ownerProvider;
    }
    session.lastActivity = new Date();
    sessionHistory.updateClaudeSessionId(
      sessionKey,
      session.conversationId,
      claudeSessionId,
      session.ownerProvider,
    );
  }

  /**
   * Start a fresh conversation in the same project, preserving the prior
   * entry in session history so the user can return to it. Used by /clear,
   * which must actually sever the SDK session — the existing
   * `claudeSessionId` would otherwise be re-used on the next message and the
   * Anthropic-side conversation history would persist server-side.
   */
  startNewConversation(sessionKey: string): Session | undefined {
    const existing = this.sessions.get(sessionKey);
    if (!existing) return undefined;
    const fresh: Session = {
      conversationId: this.generateConversationId(),
      claudeSessionId: undefined,
      workingDirectory: existing.workingDirectory,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(sessionKey, fresh);
    this.lastRelayedAssistantText.delete(sessionKey);
    sessionHistory.saveSession(sessionKey, fresh.conversationId, fresh.workingDirectory, '', undefined);
    return fresh;
  }

  private generateConversationId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export const sessionManager = new SessionManager();
