/**
 * /transcribe and /extract — pulling text and media out of uploads and links.
 *
 * Grouped because both turn an inbound blob or URL into something Telegram can
 * show, and both lean on the same download-limit and staleness guards.
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
import {
  detectPlatform,
  platformLabel,
  isValidUrl,
  extractMedia,
  cleanupExtractResult,
  type ExtractMode,
  type ExtractResult,
  type SubtitleFormat,
} from '../../../media/extract.js';
import { sanitizeError, sanitizePath } from '../../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
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

// ── /extract command ───────────────────────────────────────────────

// Store pending extract URLs keyed by sessionKey so the callback knows what to process
const pendingExtractUrls = new Map<string, string>();
const pendingExtractTimestamps = new Map<string, number>();
const EXTRACT_URL_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Drop URLs the user never acted on. .unref() so it doesn't hold the process
// open at shutdown.
const extractCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of pendingExtractTimestamps.entries()) {
    if (now - timestamp > EXTRACT_URL_TTL_MS) {
      pendingExtractUrls.delete(key);
      pendingExtractTimestamps.delete(key);
      console.log(`[cleanup] Removed stale pendingExtractUrls for ${key}`);
    }
  }
}, 60_000);
extractCleanup.unref();


export async function handleExtract(ctx: Context): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `\u{1F4E5} *Extract Media*\n\n` +
      `Extract text, audio, or video from a URL\\.\n\n` +
      `*Supported platforms:*\n` +
      `\u{25B6}\u{FE0F} YouTube\n` +
      `\u{1F4F7} Instagram\n` +
      `\u{1F3B5} TikTok\n\n` +
      `\u{1F447} _Paste a URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://youtube.com/watch?v=...',
          selective: true,
        },
      }
    );
    return;
  }

  await showExtractMenu(ctx, args);
}

export async function showExtractMenu(ctx: Context, url: string): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  if (!isValidUrl(url)) {
    await ctx.reply('\u{274C} Invalid URL\\. Please provide a valid link\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    await ctx.reply(
      '\u{26A0}\u{FE0F} Unsupported platform\\. Supported: YouTube, Instagram, TikTok\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const label = platformLabel(platform);

  // Store URL for callback (with timestamp for cleanup)
  pendingExtractUrls.set(sessionKey, url);
  pendingExtractTimestamps.set(sessionKey, Date.now());

  await ctx.reply(
    `\u{1F4E5} *Extract from ${esc(label)}*\n\n` +
    `\`${esc(url.length > 60 ? url.slice(0, 57) + '...' : url)}\`\n\n` +
    `What do you want?`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '\u{1F4DD} Text', callback_data: 'extract:text' },
            { text: '\u{1F3A7} Audio', callback_data: 'extract:audio' },
          ],
          [
            { text: '\u{1F3AC} Video', callback_data: 'extract:video' },
            { text: '\u{2728} All', callback_data: 'extract:all' },
          ],
        ],
      },
    }
  );
}

export async function handleExtractCallback(ctx: Context): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await ctx.answerCallbackQuery({ text: 'Feature disabled' });
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const data = ctx.callbackQuery?.data;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!data || !keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  // Handle subtitle format selection (extract:subfmt:<format>)
  if (data.startsWith('extract:subfmt:')) {
    const subtitleFormat = data.replace('extract:subfmt:', '') as SubtitleFormat;
    if (!['text', 'srt', 'vtt'].includes(subtitleFormat)) return;

    await ctx.answerCallbackQuery();

    const url = pendingExtractUrls.get(sessionKey);
    if (!url) {
      await ctx.reply('\u{26A0}\u{FE0F} Session expired\\. Please send the URL again with `/extract`\\.', {
        parse_mode: 'MarkdownV2',
      });
      return;
    }
    pendingExtractUrls.delete(sessionKey);
    pendingExtractTimestamps.delete(sessionKey);

    // Remove the subtitle format menu
    try {
      const menuMsgId = ctx.callbackQuery?.message?.message_id;
      if (menuMsgId) await ctx.api.deleteMessage(chatId, menuMsgId);
    } catch (e) {
      console.debug('[extract] Failed to delete menu message:', e instanceof Error ? e.message : e);
    }

    await executeExtract(ctx, url, 'text', subtitleFormat);
    return;
  }

  const mode = data.replace('extract:', '') as ExtractMode;
  if (!['text', 'audio', 'video', 'all'].includes(mode)) return;

  await ctx.answerCallbackQuery();

  const url = pendingExtractUrls.get(sessionKey);
  if (!url) {
    await ctx.reply('\u{26A0}\u{FE0F} Session expired\\. Please send the URL again with `/extract`\\.', {
      parse_mode: 'MarkdownV2',
    });
    return;
  }

  // YouTube + Text → show subtitle format submenu (keep URL pending)
  const platform = detectPlatform(url);
  if (mode === 'text' && platform === 'youtube') {
    try {
      await ctx.editMessageText(
        `\u{1F4DD} *Subtitle Format*\n\n` +
        `How would you like the transcript?`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '\u{1F4DD} Plain Text', callback_data: 'extract:subfmt:text' },
              ],
              [
                { text: '\u{1F4CB} SRT', callback_data: 'extract:subfmt:srt' },
                { text: '\u{1F4C4} VTT', callback_data: 'extract:subfmt:vtt' },
              ],
            ],
          },
        }
      );
    } catch {
      // If edit fails, send new message
      await ctx.reply(
        `\u{1F4DD} *Subtitle Format*\n\nHow would you like the transcript?`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '\u{1F4DD} Plain Text', callback_data: 'extract:subfmt:text' },
              ],
              [
                { text: '\u{1F4CB} SRT', callback_data: 'extract:subfmt:srt' },
                { text: '\u{1F4C4} VTT', callback_data: 'extract:subfmt:vtt' },
              ],
            ],
          },
        }
      );
    }
    return;
  }

  pendingExtractUrls.delete(sessionKey);
  pendingExtractTimestamps.delete(sessionKey);

  // Remove the menu message
  try {
    const menuMsgId = ctx.callbackQuery?.message?.message_id;
    if (menuMsgId) {
      await ctx.api.deleteMessage(chatId, menuMsgId);
    }
  } catch (e) {
    console.debug('[extract] Failed to delete menu message:', e instanceof Error ? e.message : e);
  }

  await executeExtract(ctx, url, mode);
}

export async function executeExtract(ctx: Context, url: string, mode: ExtractMode, subtitleFormat?: SubtitleFormat): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const ackMsg = await ctx.reply('\u{1F4E5} Processing...', { parse_mode: undefined });

  const updateAck = async (text: string) => {
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, text, { parse_mode: undefined });
    } catch (e) {
      // Update can fail if message was deleted or content unchanged
      console.debug('[extract] Failed to update ack message:', e instanceof Error ? e.message : e);
    }
  };

  let result: ExtractResult | null = null;

  try {
    result = await extractMedia({
      url,
      mode,
      subtitleFormat,
      onProgress: (msg) => updateAck(msg),
    });

    // Delete ack message
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[extract] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    // Send results
    const platform = platformLabel(result.platform);
    const title = result.title || 'Untitled';
    const durationStr = result.duration
      ? ` (${Math.floor(result.duration / 60)}:${String(Math.floor(result.duration % 60)).padStart(2, '0')})`
      : '';

    // Header
    const header = `\u{1F4E5} *${esc(platform)}*: ${esc(title)}${esc(durationStr)}`;

    // Send video if available
    if (result.videoPath && fs.existsSync(result.videoPath)) {
      try {
        await ctx.replyWithChatAction('upload_video');
        await ctx.replyWithVideo(new InputFile(result.videoPath), {
          caption: `\u{1F3AC} ${title}${durationStr}`,
          supports_streaming: true,
        });
      } catch (videoSendErr) {
        console.warn('[extract] Failed to send video:', videoSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Video file could not be sent (may be too large).', { parse_mode: undefined });
      }
    }

    // Send audio if requested (and not already handled by video)
    if (result.audioPath && fs.existsSync(result.audioPath) && (mode === 'audio' || mode === 'all')) {
      try {
        await ctx.replyWithChatAction('upload_voice');
        await ctx.replyWithAudio(new InputFile(result.audioPath), {
          title: title,
          caption: `\u{1F3A7} ${title}${durationStr}`,
        });
      } catch (audioSendErr) {
        console.warn('[extract] Failed to send audio:', audioSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Audio file could not be sent.', { parse_mode: undefined });
      }
    }

    // Send subtitle file (SRT/VTT) if available
    if (result.subtitlePath && result.subtitleFormat && fs.existsSync(result.subtitlePath)) {
      const ext = result.subtitleFormat; // 'srt' or 'vtt'
      const safeTitle = title.replace(/[^a-zA-Z0-9]/g, '_');
      const fileName = `${safeTitle}.${ext}`;
      try {
        const inputFile = new InputFile(fs.readFileSync(result.subtitlePath), fileName);
        await ctx.replyWithDocument(inputFile, {
          caption: `\u{1F4DD} ${ext.toUpperCase()} subtitles for: ${title}${durationStr}`,
        });
      } catch (subSendErr) {
        console.warn('[extract] Failed to send subtitle file:', subSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Subtitle file could not be sent.', { parse_mode: undefined });
      }
    }

    // Send transcript (plain text from Whisper or YouTube VTT→text)
    if (result.transcript) {
      if (result.transcript.length <= config.TRANSCRIBE_FILE_THRESHOLD_CHARS) {
        await ctx.reply(`${header}\n\n${esc(result.transcript)}`, {
          parse_mode: 'MarkdownV2',
        });
      } else {
        // Send as .txt file
        const tmpPath = path.join(os.tmpdir(), `extract_transcript_${Date.now()}.txt`);
        try {
          fs.writeFileSync(tmpPath, result.transcript, { encoding: 'utf-8', mode: 0o600 });
          const inputFile = new InputFile(fs.readFileSync(tmpPath), `${title.replace(/[^a-zA-Z0-9]/g, '_')}_transcript.txt`);
          await ctx.replyWithDocument(inputFile, {
            caption: `\u{1F4DD} Transcript (${result.transcript.length} chars)`,
          });
        } finally {
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch (e) {
            console.warn(`[extract] Cleanup failed for ${sanitizePath(tmpPath)}:`, sanitizeError(e));
          }
        }
      }
    } else if ((mode === 'text' || mode === 'all') && !result.subtitlePath) {
      // Transcript was expected but empty and no subtitle file was sent either
      await ctx.reply('\u{26A0}\u{FE0F} No speech detected in the audio.', { parse_mode: undefined });
    }

    // Show any warnings
    for (const warning of result.warnings) {
      await ctx.reply(`\u{26A0}\u{FE0F} ${warning}`, { parse_mode: undefined });
    }

    // Success summary for non-text modes when no transcript was sent
    if (mode !== 'text' && !result.transcript) {
      await ctx.reply(header, { parse_mode: 'MarkdownV2' });
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[extract] Error:', sanitizeError(error));
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `\u{274C} ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await ctx.reply(`\u{274C} Extraction failed: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (result) {
      cleanupExtractResult(result);
    }
  }
}
