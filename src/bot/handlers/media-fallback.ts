import { Context } from 'grammy';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';

/**
 * Telegram caps what a bot may *download* at 20MB. `getFile` itself fails with
 * "file is too big" past that, so no bot-side setting can raise it — the guard
 * exists to turn an opaque Telegram 400 into an explanation.
 *
 * Not to be confused with the 50MB *send* limit in mcp-bridge.ts: outbound and
 * inbound are separate budgets, and inbound is the tighter one. Only a
 * self-hosted Bot API server in --local mode lifts this.
 */
export const TELEGRAM_DOWNLOAD_LIMIT_MB = 20;

export function exceedsDownloadLimit(fileSizeBytes?: number): boolean {
  return (fileSizeBytes ?? 0) / (1024 * 1024) > TELEGRAM_DOWNLOAD_LIMIT_MB;
}

/** ` (172.0MB)`, MarkdownV2-escaped — or empty when Telegram omitted the size. */
function sizeSuffix(fileSizeBytes?: number): string {
  const mb = (fileSizeBytes ?? 0) / (1024 * 1024);
  return mb > 0 ? ` \\(${esc(mb.toFixed(1))}MB\\)` : '';
}

/**
 * Explain that a file is past Telegram's download ceiling. Every inbound media
 * path should call this instead of letting `getFile` throw, so the user learns
 * the limit is Telegram's rather than a bug here.
 */
export async function replyTooLargeToFetch(
  ctx: Context,
  kindTitle: string,
  fileSizeBytes?: number
): Promise<void> {
  // Log the answer, not just the drops. The original bug was invisible in the
  // logs precisely because nothing recorded a decision, and "user reports
  // nothing arrived" is unfalsifiable without a line to point at.
  console.log(`[Media] ${kindTitle} over the ${TELEGRAM_DOWNLOAD_LIMIT_MB}MB fetch limit `
    + `(${((fileSizeBytes ?? 0) / (1024 * 1024)).toFixed(1)}MB) — explained to user`);
  await ctx.reply(
    `❌ *${esc(kindTitle)} too large*${sizeSuffix(fileSizeBytes)}\n\n`
    + `Telegram caps bot downloads at ${TELEGRAM_DOWNLOAD_LIMIT_MB}MB, so I can't fetch this one `
    + `no matter how the bot is configured\\.\n\n`
    + `Re\\-encode it smaller, or — if the file is already on this machine — send me its path instead\\.`,
    { parse_mode: 'MarkdownV2' }
  );
}

/**
 * A bare audio upload. Transcription is opt-in via /transcribe, so rather than
 * dropping the file we say so; silence here read as "the bot is broken".
 */
export async function replyBareAudio(ctx: Context, fileSizeBytes?: number): Promise<void> {
  if (exceedsDownloadLimit(fileSizeBytes)) {
    await replyTooLargeToFetch(ctx, 'Audio file', fileSizeBytes);
    return;
  }
  console.log('[Media] Bare audio upload — pointed user at /transcribe');
  await ctx.reply(
    `🎵 *Audio received*${sizeSuffix(fileSizeBytes)}\n\n`
    + `I don't read audio files on their own\\. To transcribe this, run /transcribe `
    + `and reply to the prompt with the same file\\.`,
    { parse_mode: 'MarkdownV2' }
  );
}

/**
 * Video, video notes and GIFs have no ingestion path at all. Previously these
 * updates matched no handler whatsoever and vanished without a trace.
 */
export async function replyUnsupportedVideo(ctx: Context, fileSizeBytes?: number): Promise<void> {
  if (exceedsDownloadLimit(fileSizeBytes)) {
    await replyTooLargeToFetch(ctx, 'Video', fileSizeBytes);
    return;
  }
  console.log('[Media] Video upload — unsupported, told user');
  await ctx.reply(
    `🎬 *Video isn't supported*${sizeSuffix(fileSizeBytes)}\n\n`
    + `I can't read video files\\. Extract the audio and send that via /transcribe, `
    + `or point me at the file's path if it's already on this machine\\.`,
    { parse_mode: 'MarkdownV2' }
  );
}

/**
 * Stale/duplicate gate, shared by every path that now *answers* instead of
 * returning silently. Skipping it would mean a restart replying to each video
 * and mp3 sent while the bot was down — noisier than the bug being fixed.
 *
 * Claims the message id on success, so callers must not delegate to another
 * handler that runs its own dedup afterwards.
 */
function claimsMediaMessage(ctx: Context, label: string): boolean {
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  if (!messageId || !messageDate) return false;

  if (isStaleMessage(messageDate)) {
    console.log(`[Media] Ignoring stale ${label} ${messageId}`);
    return false;
  }
  if (isDuplicate(messageId)) {
    console.log(`[Media] Ignoring duplicate ${label} ${messageId}`);
    return false;
  }
  markProcessed(messageId);
  return true;
}

/**
 * Entry point for `message:video` / `message:video_note` / `message:animation`,
 * none of which had a handler before.
 */
export async function handleUnsupportedVideo(ctx: Context): Promise<void> {
  if (!claimsMediaMessage(ctx, 'video')) return;

  const media = ctx.message?.video ?? ctx.message?.video_note ?? ctx.message?.animation;
  await replyUnsupportedVideo(ctx, media?.file_size);
}

/**
 * Entry point for audio/video sent as a *document* — the path a 172MB mp3 takes
 * when Telegram declines to treat it as playable audio.
 */
export async function handleUnsupportedMediaDocument(ctx: Context): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc || !claimsMediaMessage(ctx, 'media document')) return;

  if (doc.mime_type?.startsWith('video/')) {
    await replyUnsupportedVideo(ctx, doc.file_size);
    return;
  }
  await replyBareAudio(ctx, doc.file_size);
}
