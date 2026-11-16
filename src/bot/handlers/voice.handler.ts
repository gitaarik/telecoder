import { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../../config.js';
import { sendToAgent } from '../../providers/provider-router.js';
import { messageSender } from '../../telegram/message-sender.js';
import { closeTurn, relayCatchUpIfMissed } from './message/turn-notify.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';
import { queueRequest } from '../../claude/request-queue.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { transcribeFile } from '../../audio/transcribe.js';
import { sendTranscriptResult } from './command.handler.js';
import { downloadFileSecure, getTelegramFileUrl } from '../../utils/download.js';
import { sanitizeError, sanitizePath } from '../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { requireSession } from './session-guard.js';
import { replyFeatureDisabled, replyVoiceNotSetUp } from './command/shared.js';
import { repliedForceReplyFlow } from '../../telegram/force-reply-tracker.js';
import { progressCallbacks, withStreamingTurn } from '../../telegram/streaming-turn.js';

export async function handleVoice(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const voice = ctx.message?.voice;

  if (!keyInfo || !messageId || !messageDate || !voice) return;
  const { chatId, sessionKey } = keyInfo;

  // Stale/duplicate filters
  if (isStaleMessage(messageDate)) {
    console.log(`[Voice] Ignoring stale voice message ${messageId}`);
    return;
  }
  if (isDuplicate(messageId)) {
    console.log(`[Voice] Ignoring duplicate voice message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // TRANSCRIBE_ENABLED=false turns off voice notes as well as /transcribe:
  // both go through the same transcription.
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Voice transcription');
    return;
  }
  // No Groq key, the common state after declining voice in `telecoder init`:
  // say how to turn it on, instead of an ack and then a raw "not configured" error.
  if (!config.GROQ_API_KEY) {
    await replyVoiceNotSetUp(ctx);
    return;
  }

  // An answer to /transcribe's prompt is transcribed and nothing more.
  if (repliedForceReplyFlow(ctx) === 'transcribe') {
    await handleTranscribeOnly(ctx, chatId, messageId, voice);
    return;
  }

  // Check session — fall back to disk if the bot restarted recently.
  const session = await requireSession(ctx, sessionKey);
  if (!session) return;

  // Check file size
  const fileSizeBytes = voice.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  if (fileSizeMB > config.VOICE_MAX_FILE_SIZE_MB) {
    await ctx.reply(
      `❌ Voice note too large (${fileSizeMB.toFixed(1)}MB).\n\nPlease send shorter notes (max ${config.VOICE_MAX_FILE_SIZE_MB}MB).`,
    );
    return;
  }

  // Acknowledge receipt
  const ackMsg = await ctx.reply('🎤 Transcribing...');

  let tempFilePath: string | null = null;

  try {
    // Download voice file from Telegram (with retry for transient network errors)
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      throw new Error('Telegram did not provide a file path.');
    }
    const fileUrl = getTelegramFileUrl(config.TELEGRAM_BOT_TOKEN, file.file_path);

    // In-process fetch: the token-bearing URL never reaches a process argument list.
    const ext = voice.mime_type?.includes('ogg') ? '.ogg' : '.oga';
    tempFilePath = path.join(os.tmpdir(), `telecoder_voice_${messageId}${ext}`);

    await downloadFileSecure(fileUrl, tempFilePath);

    const audioBuffer = fs.readFileSync(tempFilePath);
    if (!audioBuffer.length) {
      throw new Error('Downloaded empty voice file.');
    }

    console.log(`[Voice] Downloaded ${fileSizeMB.toFixed(1)}MB to ${tempFilePath}`);

    // Transcribe using Groq Whisper API (native TypeScript)
    const transcript = await transcribeFile(tempFilePath);

    console.log(`[Voice] Transcript received (${transcript.length} chars)`);

    // Show full transcript if configured (uses smart Telegram chunking)
    if (config.VOICE_SHOW_TRANSCRIPT) {
      try {
        await ctx.api.editMessageText(chatId, ackMsg.message_id, '🎤 Transcript received.');
      } catch {
        try {
          await ctx.api.deleteMessage(chatId, ackMsg.message_id);
        } catch (e) {
          // Telegram message deletion can fail if already deleted or expired
          console.debug('[Voice] Failed to delete ack message:', e instanceof Error ? e.message : e);
        }
      }

      await messageSender.sendMessage(ctx, `👤 ${transcript}`);
    } else {
      // Remove ack message
      try {
        await ctx.api.deleteMessage(chatId, ackMsg.message_id);
      } catch (e) {
        console.debug('[Voice] Failed to delete ack message:', e instanceof Error ? e.message : e);
      }
    }

    // Feed transcript into agent
    await queueRequest(sessionKey, transcript, async () => {
      await withStreamingTurn(ctx, sessionKey, transcript, async (abortController) => {
        const response = await sendToAgent(sessionKey, transcript, {
          ...progressCallbacks(ctx),
          abortController,
          telegramCtx: ctx,
        });

        await messageSender.finishStreaming(ctx, response.text);
        await relayCatchUpIfMissed(ctx, sessionKey, response.text || '');
        await maybeSendVoiceReply(ctx, response.text);
        await closeTurn(ctx, sessionKey, response, transcript);
      });
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;

    const errorMessage = sanitizeError(error);
    console.error('[Voice] Error:', errorMessage);

    // Try to update ack message with error
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `❌ ${errorMessage}`);
    } catch {
      await ctx.reply(`❌ Voice error: ${errorMessage}`);
    }
  } finally {
    // Clean up temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`[Voice] Cleaned up ${sanitizePath(tempFilePath)}`);
      } catch (e) {
        console.warn(`[Voice] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
}

/**
 * Transcribe-only flow: voice note sent as reply to "Transcribe Audio" ForceReply.
 * Does NOT send transcript to the Claude agent.
 */
async function handleTranscribeOnly(
  ctx: Context,
  chatId: number,
  messageId: number,
  voice: { file_id: string; file_size?: number; mime_type?: string }
): Promise<void> {
  const ackMsg = await ctx.reply('🎤 Transcribing...');

  let tempFilePath: string | null = null;

  try {
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      throw new Error('Telegram did not provide a file path.');
    }
    const fileUrl = getTelegramFileUrl(config.TELEGRAM_BOT_TOKEN, file.file_path);

    const ext = voice.mime_type?.includes('ogg') ? '.ogg' : '.oga';
    tempFilePath = path.join(os.tmpdir(), `telecoder_transcribe_${messageId}${ext}`);

    await downloadFileSecure(fileUrl, tempFilePath);

    const audioBuffer = fs.readFileSync(tempFilePath);
    if (!audioBuffer.length) {
      throw new Error('Downloaded empty voice file.');
    }

    const transcript = await transcribeFile(tempFilePath);

    // Remove ack
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[Transcribe] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    await sendTranscriptResult(ctx, transcript);
  } catch (error) {
    const errorMessage = sanitizeError(error);
    console.error('[Transcribe] Voice ForceReply error:', errorMessage);
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `❌ ${errorMessage}`);
    } catch {
      await ctx.reply(`❌ Transcription error: ${errorMessage}`);
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
