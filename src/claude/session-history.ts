import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';

// Zod schema for session history entry
const sessionHistoryEntrySchema = z.object({
  conversationId: z.string(),
  claudeSessionId: z.string().optional(),
  // Which provider backend (claude / ccr) created this Claude
  // session. Used to refuse cross-backend resumes — a session whose thinking
  // blocks were minted by DeepSeek-via-CCR can't be replayed against the real
  // Anthropic API. Optional for backward compatibility with pre-existing files.
  ownerProvider: z.string().optional(),
  projectPath: z.string(),
  projectName: z.string(),
  lastMessagePreview: z.string(),
  lastAssistantPreview: z.string().optional(),
  topic: z.string().optional(),
  createdAt: z.string(),
  lastActivity: z.string(),
  // Startup continue/fresh prompt bookkeeping. `startupPromptedAt` records the
  // `lastActivity` value we last posted (or refreshed) a prompt for, so a bot
  // restart inside the same idle window doesn't stack a second prompt. It only
  // re-arms when a genuine new turn moves `lastActivity`. `startupPromptMessageId`
  // is the Telegram id of that still-standing prompt — kept so we can refresh
  // its "last active Xh ago" text in place across restarts, and cleared once the
  // user answers so we don't resurrect the buttons on a message they acted on.
  startupPromptedAt: z.string().optional(),
  startupPromptMessageId: z.number().optional(),
});

// Zod schema for the full session history file
const sessionHistoryDataSchema = z.object({
  sessions: z.record(z.string(), z.array(sessionHistoryEntrySchema)),
});

export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>;

interface SessionHistoryData {
  sessions: Record<string, SessionHistoryEntry[]>; // sessionKey -> history entries
}

const HISTORY_DIR = getStateDir();
const DEFAULT_HISTORY_FILE = path.join(HISTORY_DIR, 'sessions.json');
const MAX_HISTORY_PER_CHAT = 20;
// Cap stored previews at 50KB so multi-chunk content survives a reload intact
// (Telegram allows 4096 chars/message — the restore flow chunks). Applies to
// both the user's last prompt and the assistant's last response.
const MAX_PREVIEW_CHARS = 50_000;

class SessionHistory {
  private data: SessionHistoryData = { sessions: {} };
  private historyFile: string = DEFAULT_HISTORY_FILE;

  constructor() {
    this.ensureDirectory();
    this.load();
  }

  /**
   * Scope session history to a specific bot instance. Call early in startup
   * before any sessions are created. Migrates from the shared sessions.json
   * if a per-bot file doesn't exist yet.
   */
  initForBot(botId: string): void {
    const perBotFile = path.join(HISTORY_DIR, `sessions-${botId}.json`);
    if (perBotFile === this.historyFile) return; // already initialized

    this.historyFile = perBotFile;

    if (fs.existsSync(perBotFile)) {
      // Per-bot file exists, load it
      this.load();
    } else if (fs.existsSync(DEFAULT_HISTORY_FILE)) {
      // First run with per-bot scoping: copy shared file as starting point
      try {
        fs.copyFileSync(DEFAULT_HISTORY_FILE, perBotFile);
        console.log(`[SessionHistory] Migrated shared sessions.json → sessions-${botId}.json`);
      } catch {
        // If copy fails, start fresh
      }
      this.load();
    }
  }

  private ensureDirectory(): void {
    ensureStateDir(HISTORY_DIR, 'SessionHistory');
  }

  private load(): void {
    const loaded = readJsonFile(this.historyFile, sessionHistoryDataSchema, 'SessionHistory');
    // Keep string keys as-is (supports both "12345" and "12345:42" formats)
    this.data = { sessions: { ...(loaded?.sessions ?? {}) } };
    // Files written before history was kept most-recently-used first are in
    // creation order, where a conversation you went back to sits below newer
    // ones. `lastActivity` is only ever moved by using a conversation, so
    // sorting on it puts one of those files back in the order it would have
    // had. For a file already in that order this is a no-op.
    for (const history of Object.values(this.data.sessions)) {
      history.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    }
  }

  private save(): void {
    writeJsonFile(this.historyFile, this.data, 'SessionHistory');
  }

  saveSession(
    sessionKey: string,
    conversationId: string,
    projectPath: string,
    lastMessagePreview: string = '',
    claudeSessionId?: string,
    ownerProvider?: string
  ): void {
    if (!this.data.sessions[sessionKey]) {
      this.data.sessions[sessionKey] = [];
    }

    const history = this.data.sessions[sessionKey];
    const projectName = path.basename(projectPath);

    // Check if this conversation already exists
    const existingIndex = history.findIndex(
      (entry) => entry.conversationId === conversationId
    );

    const existingEntry = existingIndex >= 0 ? history[existingIndex] : undefined;
    const entry: SessionHistoryEntry = {
      conversationId,
      claudeSessionId: claudeSessionId ?? existingEntry?.claudeSessionId,
      ownerProvider: ownerProvider ?? existingEntry?.ownerProvider,
      projectPath,
      projectName,
      lastMessagePreview: lastMessagePreview.substring(0, MAX_PREVIEW_CHARS),
      lastAssistantPreview: existingEntry?.lastAssistantPreview,
      topic: existingEntry?.topic,
      createdAt:
        existingIndex >= 0
          ? history[existingIndex].createdAt
          : new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };

    // The entry saved is always the conversation the chat is now in — a new
    // one, or one it went back to — so it goes to the front. Everything that
    // wants "the current conversation" reads index 0: the topic, the startup
    // prompt, and the restore after a restart. Left where it was, a
    // conversation you went back to wrote its topic onto the newest one and
    // lost the restore to it. The cap below then drops whichever was used
    // longest ago, rather than whichever was started first.
    if (existingIndex >= 0) history.splice(existingIndex, 1);
    history.unshift(entry);

    // Keep only recent history
    if (history.length > MAX_HISTORY_PER_CHAT) {
      this.data.sessions[sessionKey] = history.slice(0, MAX_HISTORY_PER_CHAT);
    }

    this.save();
  }

  getHistory(sessionKey: string, limit: number = 5): SessionHistoryEntry[] {
    const history = this.data.sessions[sessionKey] || [];
    return history.slice(0, limit);
  }

  getLastSession(sessionKey: string): SessionHistoryEntry | undefined {
    const history = this.data.sessions[sessionKey];
    return history?.[0];
  }

  /**
   * Most recent entry that actually carries a claudeSessionId — i.e. one that
   * can be resumed against Claude. History is newest-first, so `find` returns
   * the latest resumable entry. Skips past "stub" entries left by conversations
   * that never finished init (a query interrupted by a rebuild, an aborted
   * /clear), which would otherwise mask a healthy session sitting one slot back.
   */
  getLastResumableSession(sessionKey: string): SessionHistoryEntry | undefined {
    const history = this.data.sessions[sessionKey];
    return history?.find((entry) => !!entry.claudeSessionId);
  }

  getSessionByConversationId(
    sessionKey: string,
    conversationId: string
  ): SessionHistoryEntry | undefined {
    const history = this.data.sessions[sessionKey] || [];
    return history.find((entry) => entry.conversationId === conversationId);
  }

  getAllActiveSessions(): Map<string, SessionHistoryEntry> {
    const active = new Map<string, SessionHistoryEntry>();
    for (const [key, history] of Object.entries(this.data.sessions)) {
      if (history.length > 0) {
        active.set(key, history[0]);
      }
    }
    return active;
  }

  updateLastMessage(sessionKey: string, conversationId: string, preview: string): void {
    const history = this.data.sessions[sessionKey];
    if (!history) return;

    const entry = history.find((e) => e.conversationId === conversationId);
    if (entry) {
      entry.lastMessagePreview = preview.substring(0, MAX_PREVIEW_CHARS);
      entry.lastActivity = new Date().toISOString();
      this.save();
    }
  }

  updateLastAssistantMessage(sessionKey: string, conversationId: string, preview: string): void {
    const history = this.data.sessions[sessionKey];
    if (!history) return;

    const entry = history.find((e) => e.conversationId === conversationId);
    if (entry) {
      entry.lastAssistantPreview = preview.substring(0, MAX_PREVIEW_CHARS);
      entry.lastActivity = new Date().toISOString();
      this.save();
    }
  }

  clearLastAssistantPreview(sessionKey: string, conversationId: string): void {
    const history = this.data.sessions[sessionKey];
    if (!history) return;

    const entry = history.find((e) => e.conversationId === conversationId);
    if (entry) {
      entry.lastAssistantPreview = undefined;
      this.save();
    }
  }

  updateTopic(sessionKey: string, topic: string | undefined): void {
    const history = this.data.sessions[sessionKey];
    if (!history || history.length === 0) return;

    // Update the most recent entry (index 0)
    history[0].topic = topic || undefined;
    this.save();
  }

  updateClaudeSessionId(
    sessionKey: string,
    conversationId: string,
    claudeSessionId: string,
    ownerProvider?: string,
  ): void {
    const history = this.data.sessions[sessionKey];
    if (!history) return;

    const entry = history.find((e) => e.conversationId === conversationId);
    if (entry) {
      entry.claudeSessionId = claudeSessionId;
      if (ownerProvider) entry.ownerProvider = ownerProvider;
      entry.lastActivity = new Date().toISOString();
      this.save();
    }
  }

  /**
   * Record that the startup continue/fresh prompt was posted for the active
   * entry's current `lastActivity`. Does NOT touch `lastActivity` itself, so the
   * marker stays valid until a real turn moves it — at which point the prompt
   * naturally re-arms for the next idle period.
   */
  markStartupPrompted(sessionKey: string, messageId: number): void {
    const entry = this.data.sessions[sessionKey]?.[0];
    if (!entry) return;
    entry.startupPromptedAt = entry.lastActivity;
    entry.startupPromptMessageId = messageId;
    this.save();
  }

  /**
   * Treat the active session as freshly engaged: bump `lastActivity` to now and
   * drop any standing startup-prompt marker. Used when the user explicitly
   * resumes via the startup prompt, so the session falls back into the silent
   * restore window and stays warm across restarts.
   */
  touchActivity(sessionKey: string): void {
    const entry = this.data.sessions[sessionKey]?.[0];
    if (!entry) return;
    entry.lastActivity = new Date().toISOString();
    entry.startupPromptedAt = undefined;
    entry.startupPromptMessageId = undefined;
    this.save();
  }

  /**
   * The user answered (or dismissed) the startup prompt. Keep the "prompted for
   * this activity" marker so restarts stay quiet, but drop the message id so we
   * don't try to refresh — and thereby re-arm the buttons on — a message they've
   * already acted on.
   */
  resolveStartupPrompt(sessionKey: string): void {
    const entry = this.data.sessions[sessionKey]?.[0];
    if (!entry) return;
    entry.startupPromptedAt = entry.lastActivity;
    entry.startupPromptMessageId = undefined;
    this.save();
  }

  clearHistory(sessionKey: string): void {
    delete this.data.sessions[sessionKey];
    this.save();
  }

  /** Every chat of this bot whose history holds the Claude session `claudeSessionId`. */
  findByClaudeSessionId(claudeSessionId: string): Array<{ sessionKey: string; entry: SessionHistoryEntry }> {
    const found: Array<{ sessionKey: string; entry: SessionHistoryEntry }> = [];
    for (const [sessionKey, history] of Object.entries(this.data.sessions)) {
      for (const entry of history) {
        if (entry.claudeSessionId === claudeSessionId) found.push({ sessionKey, entry });
      }
    }
    return found;
  }
}

export const sessionHistory = new SessionHistory();

/** A chat whose history holds a conversation — in this bot, or in a sibling. */
export interface HistoryOwner {
  botId: string;
  sessionKey: string;
  entry: SessionHistoryEntry;
}

/**
 * Every chat history on this machine holding one of `claudeSessionIds`, keyed
 * by session id: this bot's, from memory, and each sibling's, from the file it
 * keeps next to ours. A sibling's file is only as fresh as its last save,
 * which is every change it makes.
 *
 * The shared sessions.json that predates per-bot files is left out: every bot
 * copied it as its starting point, so what it lists is either in a bot's own
 * file too, or long gone from all of them.
 */
export function findHistoryOwners(claudeSessionIds: string[], selfBotId: string): Map<string, HistoryOwner[]> {
  const wanted = new Set(claudeSessionIds);
  const owners = new Map<string, HistoryOwner[]>();
  const add = (owner: HistoryOwner) => {
    const id = owner.entry.claudeSessionId;
    if (!id || !wanted.has(id)) return;
    const list = owners.get(id);
    if (list) list.push(owner);
    else owners.set(id, [owner]);
  };

  for (const id of wanted) {
    for (const { sessionKey, entry } of sessionHistory.findByClaudeSessionId(id)) {
      add({ botId: selfBotId, sessionKey, entry });
    }
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(HISTORY_DIR);
  } catch {
    // No state dir means no sibling has saved anything yet.
  }
  for (const name of names) {
    const botId = /^sessions-(.+)\.json$/.exec(name)?.[1];
    if (!botId || botId === selfBotId) continue;
    const data = readJsonFile(path.join(HISTORY_DIR, name), sessionHistoryDataSchema, 'SessionHistory');
    for (const [sessionKey, history] of Object.entries(data?.sessions ?? {})) {
      for (const entry of history) add({ botId, sessionKey, entry });
    }
  }
  return owners;
}
