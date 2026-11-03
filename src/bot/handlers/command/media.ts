/**
 * /transcribe — turning an uploaded voice note or audio file into text, behind
 * the same download-limit and staleness guards as the other upload handlers.
 */

import { Context, InputFile } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../../../config.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { isDuplicate, markProcessed } from '../../../telegram/deduplication.js';
import { isStaleMessage } from '../../middleware/stale-filter.js';
import { replyBareAudio, exceedsDownloadLimit, replyTooLargeToFetch } from '../media-fallback.js';
import { transcribeFile, downloadTelegramAudio } from '../../../audio/transcribe.js';
import { sanitizeError, sanitizePath } from '../../../utils/sanitize.js';
import { replyFeatureDisabled } from './shared.js';

// ── /transcribe command ────────────────────────────────────────────

/**
 * Send a transcript as text (short) or .txt document (long).
 * Exported so voice.handler.ts can reuse it for the ForceReply path.
 */
export async function sendTranscriptResult(ctx: Context, transcript: string): Promise<void> {
  if (transcript.length <= config.TRANSCRIBE_FILE_THRESHOLD_CHARS) {
    await messageSender.sendMessage(ctx, transcript);
  } else {
    const tmpPath = path.join(os.tmpdir(), `telecoder_transcript_${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmpPath, transcript, { encoding: 'utf-8', mode: 0o600 });
      const inputFile = new InputFile(fs.readFileSync(tmpPath), 'transcript.txt');
      await ctx.replyWithDocument(inputFile, {
        caption: `🎤 Transcript (${transcript.length} chars)`,
      });
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (e) {
        console.warn(`[transcribe] Cleanup failed for ${sanitizePath(tmpPath)}:`, sanitizeError(e));
      }
    }
  }
}

/**
 * Download a Telegram file by file_id → transcribe → send result.
 * Shared helper for reply-to and ForceReply paths.
 */
async function transcribeAndSend(
  ctx: Context,
  fileId: string,
  mimeHint?: string,
  fileSizeBytes?: number
): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Check before the ack, not after: getFile rejects anything over Telegram's
  // download ceiling, and the bare 400 that comes back reads like a bot fault.
  if (exceedsDownloadLimit(fileSizeBytes)) {
    await replyTooLargeToFetch(ctx, 'Audio file', fileSizeBytes);
    return;
  }

  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });
  let tempFilePath: string | null = null;

  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram did not return file_path.');

    const ext = mimeHint?.includes('ogg') ? '.ogg'
      : mimeHint?.includes('mp3') ? '.mp3'
      : mimeHint?.includes('wav') ? '.wav'
      : mimeHint?.includes('mp4') ? '.m4a'
      : '.oga';
    tempFilePath = path.join(os.tmpdir(), `telecoder_transcribe_${Date.now()}${ext}`);

    await downloadTelegramAudio(config.TELEGRAM_BOT_TOKEN, file.file_path, tempFilePath);

    const buf = fs.readFileSync(tempFilePath);
    if (!buf.length) throw new Error('Downloaded empty audio file.');

    const transcript = await transcribeFile(tempFilePath);

    // Remove ack
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[Transcribe] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    await sendTranscriptResult(ctx, transcript);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Transcribe] Error:', sanitizeError(error));
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `❌ ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await ctx.reply(`❌ Transcription error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        console.warn(`[Transcribe] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
}

export async function handleTranscribe(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  // Path A: reply to a voice/audio/audio-document message
  const reply = ctx.message?.reply_to_message;
  if (reply) {
    const voice = (reply as { voice?: { file_id: string; mime_type?: string } }).voice;
    const audio = (reply as { audio?: { file_id: string; mime_type?: string } }).audio;
    const doc = (reply as { document?: { file_id: string; mime_type?: string } }).document;

    const fileId = voice?.file_id
      || audio?.file_id
      || (doc?.mime_type?.startsWith('audio/') ? doc.file_id : null);
    const mime = voice?.mime_type || audio?.mime_type || doc?.mime_type;

    if (fileId) {
      await transcribeAndSend(ctx, fileId, mime);
      return;
    }
  }

  // Path B: no audio attached — send ForceReply prompt
  await ctx.reply(
    '🎤 *Transcribe Audio*\n\n_Send a voice note or audio file:_',
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Send a voice note or audio file',
        selective: true,
      },
    }
  );
}

/**
 * Handle audio messages (message:audio) sent as reply to the Transcribe ForceReply.
 */
export async function handleTranscribeAudio(ctx: Context): Promise<void> {
  const audio = ctx.message?.audio;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  if (!audio || !messageId || !messageDate) return;

  // Guard before replying to anything. This handler used to return silently on
  // every path, so it never needed these; now that it answers, a restart would
  // otherwise respond to every audio file sent while the bot was down.
  if (isStaleMessage(messageDate)) {
    console.log(`[Transcribe] Ignoring stale audio ${messageId}`);
    return;
  }
  if (isDuplicate(messageId)) {
    console.log(`[Transcribe] Ignoring duplicate audio ${messageId}`);
    return;
  }
  markProcessed(messageId);

  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  // Transcription is opt-in: the file has to be a reply to the /transcribe
  // ForceReply prompt. A bare audio upload isn't a transcribe request, but it
  // isn't nothing either — tell the user how to ask for one.
  const replyTo = ctx.message?.reply_to_message;
  const replyText = replyTo?.from?.is_bot ? ((replyTo as { text?: string }).text || '') : '';
  if (!replyText.includes('Transcribe Audio')) {
    await replyBareAudio(ctx, audio.file_size);
    return;
  }

  await transcribeAndSend(ctx, audio.file_id, audio.mime_type, audio.file_size);
}

/**
 * Handle document messages with audio MIME sent as reply to the Transcribe ForceReply.
 */
export async function handleTranscribeDocument(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo || !replyTo.from?.is_bot) return;
  const replyText = (replyTo as { text?: string }).text || '';
  if (!replyText.includes('Transcribe Audio')) return;

  const doc = ctx.message?.document;
  if (!doc || !doc.mime_type?.startsWith('audio/')) return;

  await transcribeAndSend(ctx, doc.file_id, doc.mime_type, doc.file_size);
}
