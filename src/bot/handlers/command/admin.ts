/**
 * Bot lifecycle commands: /update, /botstatus, /restartbot, /rebuildbot.
 *
 * These are the handlers that act on the bot process itself rather than on a
 * conversation, so they are the only ones that touch botctl, the reload marker
 * and the build.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { isMainThread } from 'worker_threads';
import { config, getReloadMarkerPath } from '../../../config.js';
import { getModel } from '../../../providers/provider-router.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { replyMd, botctlExists, PROJECT_ROOT, BOTCTL_PATH } from './shared.js';

/** Write the reload marker so autoResumeAfterReload picks up sessions on restart. */
export function writeReloadMarker(): void {
  try {
    const markerDir = path.dirname(getReloadMarkerPath());
    if (!fs.existsSync(markerDir)) {
      fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(
      getReloadMarkerPath(),
      JSON.stringify({ timestamp: new Date().toISOString() }),
      { mode: 0o600 }
    );
  } catch (err) {
    console.error('[ReloadMarker] Failed to write marker file:', err);
  }
}

/** Send Continue/Resume inline buttons for manual session restore. */
export async function sendRestoreButtons(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  try {
    await ctx.api.sendMessage(chatId, '👇 Restore your session after restart:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '▶️ Continue', callback_data: 'restart:continue' },
            { text: '📜 Resume', callback_data: 'restart:resume' },
          ],
        ],
      },
    });
  } catch (e) {
    console.debug('[RestartBot] Failed to send restore buttons:', e instanceof Error ? e.message : e);
  }
}

async function getClaudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      config.CLAUDE_EXECUTABLE_PATH,
      ['--version'],
      { timeout: 10_000, maxBuffer: 64 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        const line = (stdout || stderr || '').trim().split('\n')[0]?.trim() ?? '';
        const match = line.match(/\d+\.\d+\.\d+\S*/);
        resolve(match ? match[0] : line || null);
      }
    );
  });
}

async function runClaudeUpdate(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      config.CLAUDE_EXECUTABLE_PATH,
      ['update'],
      {
        // `claude update` may download and install a new binary — give it room.
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message).trim();
          reject(new Error(message || 'Failed to run claude update'));
          return;
        }
        resolve((stdout || stderr || '').trim());
      }
    );
  });
}

export async function handleUpdate(ctx: Context): Promise<void> {
  const version = await getClaudeVersion();
  const prompt = version
    ? `⬆️ Update Claude Code? (currently ${version})`
    : '⬆️ Update Claude Code?';
  await ctx.reply(prompt, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Update', callback_data: 'update:confirm' },
          { text: '❌ Cancel', callback_data: 'update:cancel' },
        ],
      ],
    },
  });
}

export async function handleUpdateCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  // Remove the menu keyboard so it can't be tapped twice
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — message may have been edited or deleted
  }

  if (data === 'update:cancel') {
    await ctx.reply('❌ Update cancelled.');
    return;
  }
  if (data !== 'update:confirm') return;

  const chatId = ctx.chat?.id;
  const ack = await ctx.reply('⬆️ Updating Claude Code…', { parse_mode: undefined });

  try {
    const raw = await runClaudeUpdate();
    const body = raw || 'Update finished — no output.';
    await messageSender.sendMessage(ctx, `## ⬆️ Claude Code Update\n\n\`\`\`\n${body}\n\`\`\``);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const hint = /not found|enoent/i.test(message)
      ? '\n\nThe `claude` executable could not be found on PATH. Check `CLAUDE_EXECUTABLE_PATH`.'
      : /npm|installed via/i.test(message)
        ? '\n\nThis install may be managed by npm — update it there instead.'
        : '';
    await messageSender.sendMessage(ctx, `❌ Update failed:\n\n\`\`\`\n${message}\n\`\`\`${hint}`);
  } finally {
    if (chatId !== undefined) {
      try {
        await ctx.api.deleteMessage(chatId, ack.message_id);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

export async function handleBotStatus(ctx: Context): Promise<void> {
  const uptimeSec = process.uptime();
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = Math.floor(uptimeSec % 60);
  const uptimeStr = hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;

  const mode = config.BOT_MODE === 'prod' ? 'Production' : 'Development';
  const keyInfo = getSessionKeyFromCtx(ctx);
  const model = keyInfo ? getModel(keyInfo.chatId) : 'opus';
  const streaming = config.STREAMING_MODE || 'streaming';
  const pid = process.pid;
  const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1);

  const msg =
    `🟢 *${esc(config.BOT_NAME)} is running*\n\n` +
    `*Mode:* ${esc(mode)}\n` +
    `*Uptime:* ${esc(uptimeStr)}\n` +
    `*PID:* ${pid}\n` +
    `*Memory:* ${esc(memMB)} MB\n` +
    `*Model:* ${esc(model)}\n` +
    `*Streaming:* ${esc(streaming)}`;

  await replyMd(ctx, msg);
}

type RestartScope = 'one' | 'all';

async function performRestart(ctx: Context, scope: RestartScope): Promise<void> {
  // Multi-instance mode (worker thread) — restart via launcher, not shell script
  if (!isMainThread) {
    if (scope === 'all') {
      if (config.AUTO_RESTORE_SESSION) {
        await replyMd(ctx, '🔁 Restarting all bot instances\\.\n\n⏳ Sessions will be restored automatically\\.');
      } else {
        await replyMd(ctx, '🔁 Restarting all bot instances\\.\n\n⏳ Please wait ~10 seconds\\.');
        await sendRestoreButtons(ctx);
      }
      // Marker writing for sibling bots happens in the launcher — it has the
      // tokens to derive each bot's marker path. We can't write them here.
      const { requestRestartAll } = await import('../../../index.js');
      requestRestartAll(config.AUTO_RESTORE_SESSION);
      return;
    }

    if (config.AUTO_RESTORE_SESSION) {
      await replyMd(ctx, '🔁 Restarting this bot instance\\.\n\n⏳ Session will be restored automatically\\.');
      writeReloadMarker();
    } else {
      await replyMd(ctx, '🔁 Restarting this bot instance\\.\n\n⏳ Other bots will not be affected\\. Please wait ~10 seconds\\.');
      await sendRestoreButtons(ctx);
    }

    const { requestRestart } = await import('../../../index.js');
    requestRestart();
    return;
  }

  // Single-instance mode — use shell script to restart the whole process
  if (!botctlExists()) {
    await replyMd(ctx, '❌ Bot control script not found\\.\n\nExpected at `scripts/telecoder-botctl.sh`\\.');
    return;
  }

  if (config.AUTO_RESTORE_SESSION) {
    await replyMd(ctx, '🔁 Restarting bot\\.\n\n⏳ Session will be restored automatically\\.');
    writeReloadMarker();
  } else {
    await replyMd(ctx, '🔁 Restarting bot\\.\n\n⏳ Please wait at least *10\\-15 seconds* before checking status or resuming\\.');
    await sendRestoreButtons(ctx);
  }

  try {
    const child = spawn(
      BOTCTL_PATH,
      ['recover'],
      { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', env: { ...process.env, MODE: config.BOT_MODE } }
    );
    child.unref();
  } catch (error) {
    console.error('[BotCtl] Failed to restart:', sanitizeError(error));
  }
}

export async function handleRestartBot(ctx: Context): Promise<void> {
  const args = ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim();

  // Cross-bot restart: /restartbot <name> — direct, no menu
  if (args && !isMainThread && args.toLowerCase() !== 'all' && args.toLowerCase() !== 'one' && args.toLowerCase() !== 'this') {
    const { requestSiblingRestart } = await import('../../../index.js');
    const result = await requestSiblingRestart(args, config.AUTO_RESTORE_SESSION);
    if (result.success) {
      await replyMd(ctx, `🔁 Restarting *${esc(result.name ?? args)}*\\.\\.\\. it should be back in ~10 seconds\\.`);
    } else {
      await replyMd(ctx, `❌ Could not restart *${esc(args)}*: ${esc(result.reason ?? 'unknown error')}`);
    }
    return;
  }

  // Legacy direct invocations: /restartbot all | /restartbot one | /restartbot this
  if (args?.toLowerCase() === 'all') {
    await performRestart(ctx, 'all');
    return;
  }
  if (args?.toLowerCase() === 'one' || args?.toLowerCase() === 'this') {
    await performRestart(ctx, 'one');
    return;
  }

  // Single-instance mode: only one process exists, so just confirm.
  if (isMainThread) {
    await ctx.reply('🔁 Restart the bot?', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Restart', callback_data: 'restartbot:one' },
            { text: '❌ Cancel', callback_data: 'restartbot:cancel' },
          ],
        ],
      },
    });
    return;
  }

  // Multi-instance (worker) mode: offer this/all/cancel
  await ctx.reply('🔁 Restart which?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔧 This instance only', callback_data: 'restartbot:one' }],
        [{ text: '🌐 All instances', callback_data: 'restartbot:all' }],
        [{ text: '❌ Cancel', callback_data: 'restartbot:cancel' }],
      ],
    },
  });
}

export async function handleRestartBotCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  // Remove the menu keyboard so it can't be tapped twice
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — message may have been edited or deleted
  }

  if (data === 'restartbot:cancel') {
    await ctx.reply('❌ Restart cancelled.');
    return;
  }

  if (data === 'restartbot:all') {
    await performRestart(ctx, 'all');
    return;
  }

  if (data === 'restartbot:one') {
    await performRestart(ctx, 'one');
    return;
  }
}


type RebuildScope = 'one' | 'all';

/** Run the build without blocking the event loop. execSync would freeze this
 * worker for the whole build, and a worker that stops sending heartbeats for
 * 90s gets force-restarted by the launcher mid-build. */
function runBuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'npm',
      ['run', 'build'],
      { cwd: PROJECT_ROOT, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || 'Unknown build error').trim()));
          return;
        }
        resolve();
      }
    );
  });
}

async function performRebuild(ctx: Context, scope: RebuildScope): Promise<void> {
  // Step 1: Build
  await ctx.reply('🔨 Building...');

  try {
    await runBuild();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Build failed. Aborting reload.\n\n${message.slice(-500).slice(0, 400)}`);
    return;
  }

  // Step 2: Restart. For 'all', the launcher writes markers for every sibling
  // (we can't — markers live at per-bot paths keyed by each bot's token). For
  // 'one' and single-instance, write the local marker now.
  if (!isMainThread) {
    if (scope === 'all') {
      await ctx.reply('✅ Build succeeded. Restarting all instances...');
      const { requestRestartAll } = await import('../../../index.js');
      requestRestartAll(config.AUTO_RESTORE_SESSION);
    } else {
      if (config.AUTO_RESTORE_SESSION) writeReloadMarker();
      await ctx.reply('✅ Build succeeded. Restarting this instance...');
      if (!config.AUTO_RESTORE_SESSION) await sendRestoreButtons(ctx);
      const { requestRestart } = await import('../../../index.js');
      requestRestart();
    }
    return;
  }

  if (config.AUTO_RESTORE_SESSION) writeReloadMarker();

  // Single-instance mode (scope is moot — only one process)
  await ctx.reply('✅ Build succeeded. Restarting...');
  if (!config.AUTO_RESTORE_SESSION) await sendRestoreButtons(ctx);

  if (!botctlExists()) {
    await replyMd(ctx, 'Build OK but cannot restart: `scripts/telecoder\\-botctl\\.sh` not found\\.');
    return;
  }

  try {
    const child = spawn(
      BOTCTL_PATH,
      ['recover'],
      { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', env: { ...process.env, MODE: config.BOT_MODE } }
    );
    child.unref();
  } catch (error) {
    console.error('[Reload] Failed to restart via botctl:', sanitizeError(error));
  }
}

export async function handleRebuild(ctx: Context): Promise<void> {
  const args = ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim();

  // Legacy direct invocation: /rebuildbot all
  if (args?.toLowerCase() === 'all') {
    await performRebuild(ctx, 'all');
    return;
  }
  if (args?.toLowerCase() === 'one' || args?.toLowerCase() === 'this') {
    await performRebuild(ctx, 'one');
    return;
  }

  // Single-instance mode: only one process exists, so skip the this-vs-all
  // distinction and just confirm.
  if (isMainThread) {
    await ctx.reply('🔄 Rebuild and restart the bot?', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Rebuild', callback_data: 'rebuild:one' },
            { text: '❌ Cancel', callback_data: 'rebuild:cancel' },
          ],
        ],
      },
    });
    return;
  }

  // Multi-instance (worker) mode: offer this/all/cancel
  await ctx.reply('🔄 Rebuild and restart which?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔧 This instance only', callback_data: 'rebuild:one' }],
        [{ text: '🌐 All instances', callback_data: 'rebuild:all' }],
        [{ text: '❌ Cancel', callback_data: 'rebuild:cancel' }],
      ],
    },
  });
}

export async function handleRebuildCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  // Remove the menu keyboard so it can't be tapped twice
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — message may have been edited or deleted
  }

  if (data === 'rebuild:cancel') {
    await ctx.reply('❌ Rebuild cancelled.');
    return;
  }

  if (data === 'rebuild:all') {
    await performRebuild(ctx, 'all');
    return;
  }

  if (data === 'rebuild:one') {
    await performRebuild(ctx, 'one');
    return;
  }
}
