import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

// Zod schema for session history entry
const sessionHistoryEntrySchema = z.object({
  conversationId: z.string(),
  claudeSessionId: z.string().optional(),
  projectPath: z.string(),
  projectName: z.string(),
  lastMessagePreview: z.string(),
  lastAssistantPreview: z.string().optional(),
  topic: z.string().optional(),
  createdAt: z.string(),
  lastActivity: z.string(),
});

// Zod schema for the full session history file
const sessionHistoryDataSchema = z.object({
  sessions: z.record(z.string(), z.array(sessionHistoryEntrySchema)),
});

export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>;

interface SessionHistoryData {
  sessions: Record<string, SessionHistoryEntry[]>; // sessionKey -> history entries
}

const HISTORY_DIR = path.join(os.homedir(), '.claudegram');
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
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.historyFile)) {
        const content = fs.readFileSync(this.historyFile, 'utf-8');
        const parsed = JSON.parse(content);

        // Validate with Zod schema
        const result = sessionHistoryDataSchema.safeParse(parsed);
        if (result.success) {
          // Keep string keys as-is (supports both "12345" and "12345:42" formats)
          this.data = { sessions: {} };
          for (const [key, value] of Object.entries(result.data.sessions)) {
            this.data.sessions[key] = value;
          }
        } else {
          console.warn('[SessionHistory] Invalid data format, starting fresh:', result.error.message);
          this.data = { sessions: {} };
        }
      }
    } catch (error) {
      console.error('[SessionHistory] Failed to load:', error);
      this.data = { sessions: {} };
    }
  }

  private save(): void {
    try {
      atomicWriteFileSync(this.historyFile, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error('[SessionHistory] Failed to save:', error);
    }
  }

  saveSession(
    sessionKey: string,
    conversationId: string,
    projectPath: string,
    lastMessagePreview: string = '',
    claudeSessionId?: string
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

    if (existingIndex >= 0) {
      // Update existing entry
      history[existingIndex] = entry;
    } else {
      // Add new entry at the beginning
      history.unshift(entry);
    }

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

  updateClaudeSessionId(sessionKey: string, conversationId: string, claudeSessionId: string): void {
    const history = this.data.sessions[sessionKey];
    if (!history) return;

    const entry = history.find((e) => e.conversationId === conversationId);
    if (entry) {
      entry.claudeSessionId = claudeSessionId;
      entry.lastActivity = new Date().toISOString();
      this.save();
    }
  }

  clearHistory(sessionKey: string): void {
    delete this.data.sessions[sessionKey];
    this.save();
  }
}

export const sessionHistory = new SessionHistory();
