import type { Bot } from 'grammy';
import { parseSessionKey } from '../utils/session-key.js';
import { convertToTelegramMarkdown } from '../telegram/markdown.js';

/**
 * One-shot relay of Claude Code's startup update banner. Claude prints a
 * notice at the top of its TUI when a newer version is available (or when
 * the auto-updater just installed one): "Update available! Run: claude update"
 * or "Successfully updated to version X. Restart to apply changes." These
 * only show during the first render of the TUI, so in PTY mode we scrape the
 * rendered xterm screen right after _waitForReady and forward whichever
 * banner we find to Telegram.
 *
 * Dedupes per (sessionKey, banner) so respawning the PTY mid-bot-lifetime
 * (e.g. /clear) doesn't re-post the same notice.
 */

let botRef: Bot | null = null;
const reported = new Set<string>();

export function setUpdateBannerRelayBot(bot: Bot): void {
  botRef = bot;
}

export async function relayUpdateBanner(sessionKey: string, banner: string): Promise<void> {
  if (!botRef) return;
  const dedupeKey = `${sessionKey}::${banner}`;
  if (reported.has(dedupeKey)) return;
  reported.add(dedupeKey);

  const { chatId, threadId } = parseSessionKey(sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
  const text = `🔔 Claude Code: ${banner}`;
  const converted = convertToTelegramMarkdown(text);
  try {
    await botRef.api.sendMessage(chatId, converted, { ...threadOpts, parse_mode: 'MarkdownV2' });
  } catch {
    try {
      await botRef.api.sendMessage(chatId, text, threadOpts);
    } catch (err) {
      console.error('[UpdateBanner] send failed:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Scan rendered PTY screen text for Claude Code's update banner. The exact
 * phrasings in the v2.1.150 binary are:
 *   - "Update available! Run: claude update"  (manual update, autoUpdates=false)
 *   - "Update available: <details>"           (variant used in some flows)
 *   - "Successfully updated to version X. Restart to apply changes."
 *                                              (autoUpdates=true post-install)
 *
 * Returns a short user-facing summary string, or null if no banner is on
 * screen. We intentionally collapse multi-line TUI rendering into one line —
 * claude wraps the notice inside box-drawing chrome that the xterm buffer
 * preserves, and rebuilding the layout for Telegram is more brittle than
 * just lifting the essential phrase.
 */
export function scrapeUpdateBanner(screenText: string): string | null {
  // "Successfully updated to version X.Y.Z" — the auto-update success path.
  // Capture the version so we can include it in the Telegram notice.
  const updated = screenText.match(/Successfully updated to version\s+(\S+?)\.?\s*(?:Restart to apply[^\n]*)?/i);
  if (updated) {
    const version = updated[1].replace(/[.\s]+$/, '');
    return `updated to v${version} — restart bot to apply`;
  }

  // "Update available! Run: claude update" — the manual-update path.
  if (/Update available!\s*Run:?/i.test(screenText)) {
    return "update available — run `claude update`";
  }

  // "Update available: <X>" — variant, capture trailing detail if short.
  const avail = screenText.match(/Update available:\s*([^\n│]{1,80})/i);
  if (avail) {
    return `update available: ${avail[1].trim()}`;
  }

  return null;
}
