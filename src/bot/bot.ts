import { startIpcServer } from '../claude/ipc-server.js';
import { Bot, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { sequentialize } from '@grammyjs/runner';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../config.js';
import { buildSessionKey } from '../utils/session-key.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import {
  handleStart,
  handleClear,
  handleClearCallback,
  handleProject,
  handleNewProject,
  handleProjectCallback,
  handleStatus,
  handleMode,
  handleModeCallback,
  handleTTS,
  handleTTSCallback,
  handleTelegraph,
  handleTelegraphCallback,
  handleSuggestions,
  handleSuggestionsCallback,
  handleBotStatus,
  handleRestartBot,
  handleRestartBotCallback,
  handleRestartCallback,
  handleStartupCallback,
  handleContext,
  handleUpdate,
  handleUpdateCallback,
  handlePing,
  handleCancel,
  handleCommands,
  handleModelCommand,
  handleModelCallback,
  handleProviderCommand,
  handleProviderCallback,
  handleProviderSwitchCallback,
  handleCcrCommand,
  handlePlan,
  handleExplore,
  handleResume,
  handleResumeCallback,
  handleContinue,
  handleRecap,
  handleSync,
  handleHandoff,
  handlePermissions,
  handleProjectCommands,
  handleLoop,
  handleSessions,
  handleTeleport,
  handleFile,
  handleReddit,
  handleVReddit,
  handleMedium,
  handleMediumCallback,
  handleTerminalUI,
  handleTerminalUICallback,
  handleStatusLine,
  handleStatusLineCallback,
  handleTranscribe,
  handleTranscribeAudio,
  handleTranscribeDocument,
  handleExtract,
  handleExtractCallback,
  handleRedditActionCallback,
  handleBotName,
  handleBotNameCallback,
  handleTopic,
  handleRebuild,
  handleRebuildCallback,
  handleBtw,
  handleEffort,
  handleEffortCallback,
  handleTasks,
  handleTasksCallback,
  handleShells,
  handleShellsCallback,
  handleVerbosity,
  handleVerbosityCallback,
  handleMethodCommand,
  handleMethodCallback,
} from './handlers/command.handler.js';
import { handleMessage, handleCcrThrottleCallback } from './handlers/message.handler.js';
import { handleSchedule, handleSchedules, handleUnschedule } from './handlers/schedule.handler.js';
import { handleForkCallback, handleAcceptCommand, handleDeclineCommand, handleForkCommand } from './handlers/fork.handler.js';
import { handleSuggestionTapCallback } from './handlers/suggestion.handler.js';
import { handleVoice } from './handlers/voice.handler.js';
import { handlePhoto, handleImageDocument, handleTextDocument } from './handlers/photo.handler.js';
import { createBatchMiddleware } from './middleware/message-batcher.js';
import { resolvePendingQuestion } from '../claude/ask-user.js';
import { resolvePendingPoll } from '../claude/poll-user.js';

// Resolve sequentialize constraint: same-chat updates are ordered,
// but /cancel is registered BEFORE this middleware so it bypasses it.
async function handleAskUserCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  const parts = data.split(':');
  if (parts.length !== 3) return;
  const [, id, idxStr] = parts;
  const idx = parseInt(idxStr, 10);
  if (Number.isNaN(idx)) return;

  const resolved = resolvePendingQuestion(id, idx);
  if (!resolved) {
    await ctx.answerCallbackQuery({ text: 'This question already expired.' });
    return;
  }

  await ctx.answerCallbackQuery();
  // Strip the keyboard so the user can't tap again, leave the question text
  // visible with a footer showing what they picked.
  try {
    const original = (ctx.callbackQuery?.message as { text?: string } | undefined)?.text ?? '';
    const buttonText = (ctx.callbackQuery?.message as { reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> } } | undefined)
      ?.reply_markup?.inline_keyboard?.[idx]?.[0]?.text ?? `option ${idx + 1}`;
    // Plain text: buttonText is model-supplied and may contain unbalanced
    // Markdown punctuation (underscores in URL params, stray asterisks, …)
    // which would 400 the edit. The try/catch below would swallow it, but
    // we'd rather just show the confirmation reliably.
    await ctx.editMessageText(`${original}\n\n✅ You picked: ${buttonText}`);
  } catch {
    // Edit may fail if message changed shape — non-fatal.
  }
}

function getSequentializeKey(ctx: Context): string | undefined {
  const chatId = ctx.chat?.id;
  if (!chatId) return undefined;
  const msg = (ctx.message ?? ctx.callbackQuery?.message) as
    | { is_topic_message?: boolean; message_thread_id?: number }
    | undefined;
  const threadId = msg?.is_topic_message ? msg.message_thread_id : undefined;
  return buildSessionKey(chatId, threadId);
}

export async function createBot(): Promise<Bot> {
  // Start the IPC server for hook callbacks and the standalone MCP subprocess.
  // Awaited so the bound port is known before anything else tries to spawn a
  // subprocess that needs to reach us.
  await startIpcServer();

  // Support HTTP/HTTPS/SOCKS proxy for Telegram API (useful in restricted networks)
  const proxyUrl = config.TELEGRAM_PROXY_URL
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;

  const baseFetchConfig = proxyUrl
    ? { agent: new HttpsProxyAgent(proxyUrl) }
    : undefined;

  if (proxyUrl) {
    console.log(`[Bot] Using proxy: ${proxyUrl}`);
  }

  const bot = new Bot(config.TELEGRAM_BOT_TOKEN, {
    client: {
      // Default is 500s which causes long hangs on network interruptions.
      // 60s is enough for long polling (30s) + file uploads while recovering
      // from stuck connections much faster.
      timeoutSeconds: 60,
      baseFetchConfig,
    },
  });

  // Auto-retry on transient network errors (ECONNRESET, socket hang up, etc.)
  // Also handles 429 rate limits by respecting Telegram's retry_after
  bot.api.config.use(autoRetry({
    maxRetryAttempts: 5,
    maxDelaySeconds: 60, // Cap retry delay at 60 seconds (will retry sooner rather than wait 900s)
    rethrowInternalServerErrors: false, // Retry on 5xx errors
  }));

  // Register command menu for autocomplete (non-blocking)
  const commandList = [
    { command: 'start', description: '🚀 Show help and getting started' },
    { command: 'project', description: '📁 Set working directory' },
    { command: 'newproject', description: '📁 Create a new project' },
    { command: 'status', description: '📊 Show current session status' },
    { command: 'clear', description: '🗑️ Clear conversation history' },
    { command: 'cancel', description: '⏹️ Cancel current request' },
    { command: 'resume', description: '▶️ Resume a session' },
    { command: 'continue', description: '▶️ Continue last session' },
    { command: 'botstatus', description: '🩺 Show bot process status' },
    { command: 'restartbot', description: '🔁 Restart the bot' },
    { command: 'rebuildbot', description: '🔄 Rebuild and restart with session restore' },
    { command: 'context', description: '🧠 Show Claude context usage' },
    { command: 'update', description: '⬆️ Update the Claude Code CLI' },
    { command: 'plan', description: '📋 Start planning mode' },
    { command: 'explore', description: '🔍 Explore codebase' },
    { command: 'loop', description: '🔄 Run in loop mode' },
    { command: 'sessions', description: '📚 View saved sessions' },
    { command: 'fork', description: '🍴 Fork this conversation to another bot' },
    { command: 'accept', description: '📦 Accept a pending fork from another bot' },
    { command: 'decline', description: '🚫 Discard a pending fork' },
    { command: 'recap', description: '📋 Recap last messages of current session' },
    { command: 'sync', description: '📨 Resend any missed reply from the session log' },
    { command: 'handoff', description: '📦 Export the session as a markdown handoff document' },
    { command: 'schedule', description: '🔔 Schedule a recurring prompt (e.g. every 1h, daily 9am)' },
    { command: 'schedules', description: '🔔 List active scheduled tasks' },
    { command: 'unschedule', description: '🔕 Remove a scheduled task by id' },
    { command: 'projectcommands', description: '📜 List slash commands from .claude/commands/' },
    { command: 'permissions', description: '🔐 Show the permission-gate state and guarded patterns' },
    { command: 'teleport', description: '🚀 Move session to terminal' },
    ...(config.REDDIT_ENABLED ? [{ command: 'reddit', description: '📡 Fetch Reddit posts & subreddits' }] : []),
    ...(config.VREDDIT_ENABLED ? [{ command: 'vreddit', description: '🎬 Download Reddit video from post URL' }] : []),
    ...(config.MEDIUM_ENABLED ? [{ command: 'medium', description: '📰 Fetch Medium articles' }] : []),
    ...(config.TRANSCRIBE_ENABLED ? [{ command: 'transcribe', description: '🎤 Transcribe audio to text' }] : []),
    ...(config.EXTRACT_ENABLED ? [{ command: 'extract', description: '📥 Extract text/audio/video from URL' }] : []),
    { command: 'file', description: '📎 Download a file from project' },
    { command: 'telegraph', description: '📄 View markdown with Instant View' },
    { command: 'suggestions', description: '💡 Toggle predicted next-prompt buttons' },
    { command: 'model', description: '🤖 Switch AI model' },
    { command: 'effort', description: '🎯 Set reasoning effort level' },
    { command: 'verbosity', description: '🎚️ Set verbosity tier (quiet/normal/verbose/debug)' },
    { command: 'method', description: '🛰️ Switch Claude transport (SDK / PTY)' },
    { command: 'btw', description: '💬 Side question without interrupting' },
    { command: 'tasks', description: '🔄 List active background tasks' },
    { command: 'shells', description: '🔍 List & kill background shells (PTY mode)' },
    ...(config.OPENCODE_ENABLED || config.CCR_ENABLED ? [{ command: 'provider', description: '🔌 Switch AI provider' }] : []),
    ...(config.CCR_ENABLED ? [{ command: 'ccr', description: '🔌 Toggle CCR routing (alt providers)' }] : []),
    { command: 'mode', description: '⚙️ Toggle streaming mode' },
    { command: 'terminalui', description: '🖥️ Toggle terminal-style display' },
    { command: 'statusline', description: '📍 Toggle per-turn status line' },
    { command: 'botname', description: '✏️ Toggle dynamic bot name' },
    { command: 'topic', description: '💬 Set current work topic in bot name' },
    { command: 'tts', description: '🔊 Toggle voice replies' },
    { command: 'ping', description: '🏓 Check if bot is responsive' },
    { command: 'commands', description: '📜 List all commands' },
  ];

  bot.api.setMyCommands(commandList).then(() => {
    console.log('📋 Command menu registered');
  }).catch((err) => {
    console.warn('⚠️ Failed to register commands:', err.message);
  });

  // Apply auth middleware to all updates
  bot.use(authMiddleware);

  // These commands fire BEFORE sequentialize so they bypass per-chat ordering.
  // This lets them interrupt, inspect, or restart even when a query is hung.
  bot.command('cancel', handleCancel);
  bot.command('stop', handleCancel); // alias — natural expectation for "stop the current turn"
  bot.command('ping', handlePing);
  bot.command('status', handleStatus);
  bot.command('restartbot', handleRestartBot);
  bot.command('rebuildbot', handleRebuild);
  bot.command('btw', handleBtw); // Side question — must bypass queue to work mid-task
  bot.command('tasks', handleTasks); // Read-only; must bypass queue so it works mid-stream
  bot.command('shells', handleShells); // Lists/kills OS-level bg processes; must bypass queue to rescue hung sessions
  // /sync exists for the "I think a reply went missing" scenario, which by
  // definition includes hung or sluggish turns — gating it on sequentialize
  // would queue it behind the very turn the user wants to inspect.
  bot.command('sync', handleSync);
  bot.command('handoff', handleHandoff);
  // Schedule commands bypass sequentialize so they remain responsive even
  // when a scheduled-fire turn is already running (the cap-enforcing create,
  // the list, and the remove all need to work mid-stream).
  bot.command('schedule', handleSchedule);
  bot.command('schedules', handleSchedules);
  bot.command('unschedule', handleUnschedule);
  // /tasks inline-keyboard buttons (view/back/refresh) also need to bypass
  // sequentialize so they're responsive while a stream is active.
  bot.callbackQuery(/^tasks:/, handleTasksCallback);
  // /shells kill buttons must also bypass sequentialize — the whole point is to
  // rescue a session whose current turn is hung waiting on a bg shell.
  bot.callbackQuery(/^shells:/, handleShellsCallback);
  // claudegram_ask_user button taps MUST bypass sequentialize: the agent
  // query is mid-flight and waiting on this exact tap to complete the tool
  // call. If the callback got queued, it'd deadlock behind the query that's
  // waiting for it.
  bot.callbackQuery(/^q:/, handleAskUserCallback);
  // /fork callbacks bypass sequentialize too: the user often taps Fork on a
  // past message while a turn is running. Picker UI is non-destructive (it
  // just shows another message), and accept/decline operate on file state,
  // not the live agent, so they don't need to wait in line.
  bot.callbackQuery(/^fork:/, handleForkCallback);
  // Menu buttons for /restartbot and /rebuildbot must bypass sequentialize
  // for the same reason their parent commands do: users tap these precisely
  // when the bot is hung, so the callback can't be queued behind the stuck
  // request.
  bot.callbackQuery(/^restartbot:/, handleRestartBotCallback);
  bot.callbackQuery(/^rebuild:/, handleRebuildCallback);

  // Batch consecutive text messages BEFORE sequentialize.
  // When Telegram splits a long paste into multiple messages, this combines
  // them into a single prompt. Must run before sequentialize because that
  // middleware serializes same-session updates (preventing concurrent batching).
  bot.use(createBatchMiddleware());

  // Sequentialize: same-chat updates are processed in order.
  // This runs AFTER /cancel so cancel bypasses it.
  bot.use(sequentialize(getSequentializeKey));

  // Bot command handlers (sequentialized per chat)
  bot.command('start', handleStart);
  bot.command('clear', handleClear);
  bot.command('project', handleProject);
  bot.command('newproject', handleNewProject);
  bot.command('mode', handleMode);
  bot.command('terminalui', handleTerminalUI);
  bot.command('statusline', handleStatusLine);
  bot.command('botname', handleBotName);
  bot.command('topic', handleTopic);
  bot.command('tts', handleTTS);
  bot.command('botstatus', handleBotStatus);
  bot.command('context', handleContext);
  bot.command('update', handleUpdate);

  bot.command('commands', handleCommands);
  bot.command('model', handleModelCommand);
  bot.command('effort', handleEffort);
  bot.command('verbosity', handleVerbosity);
  bot.command('method', handleMethodCommand);
  if (config.OPENCODE_ENABLED || config.CCR_ENABLED) {
    bot.command('provider', handleProviderCommand);
  }
  if (config.CCR_ENABLED) {
    bot.command('ccr', handleCcrCommand);
  }
  bot.command('plan', handlePlan);
  bot.command('explore', handleExplore);

  // Session resume commands
  bot.command('resume', handleResume);
  bot.command('continue', handleContinue);
  bot.command('sessions', handleSessions);
  bot.command('recap', handleRecap);

  // Fork: /fork forks from current state; /accept and /decline are the
  // slash-command equivalents of the target-side inline buttons.
  bot.command('fork', handleForkCommand);
  bot.command('accept', handleAcceptCommand);
  bot.command('decline', handleDeclineCommand);

  // Loop mode
  bot.command('loop', handleLoop);
  bot.command('projectcommands', handleProjectCommands);
  bot.command('permissions', handlePermissions);

  // Teleport to terminal
  bot.command('teleport', handleTeleport);

  // File commands
  bot.command('file', handleFile);
  bot.command('telegraph', handleTelegraph);
  bot.command('suggestions', handleSuggestions);

  // Reddit
  if (config.REDDIT_ENABLED) {
    bot.command('reddit', handleReddit);
  }
  if (config.VREDDIT_ENABLED) {
    bot.command('vreddit', handleVReddit);
  }
  if (config.MEDIUM_ENABLED) {
    bot.command('medium', handleMedium);
  }

  // Transcribe
  if (config.TRANSCRIBE_ENABLED) {
    bot.command('transcribe', handleTranscribe);
  }

  // Media extraction
  if (config.EXTRACT_ENABLED) {
    bot.command('extract', handleExtract);
  }

  // Callback query handler for inline keyboards
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('resume:')) {
      await handleResumeCallback(ctx);
    } else if (data.startsWith('provider_switch:')) {
      await handleProviderSwitchCallback(ctx);
    } else if (data.startsWith('provider:')) {
      await handleProviderCallback(ctx);
    } else if (data.startsWith('model:')) {
      await handleModelCallback(ctx);
    } else if (data.startsWith('mode:')) {
      await handleModeCallback(ctx);
    } else if (data.startsWith('terminalui:')) {
      await handleTerminalUICallback(ctx);
    } else if (data.startsWith('statusline:')) {
      await handleStatusLineCallback(ctx);
    } else if (data.startsWith('botname:')) {
      await handleBotNameCallback(ctx);
    } else if (data.startsWith('tts:')) {
      await handleTTSCallback(ctx);
    } else if (data.startsWith('telegraph:')) {
      await handleTelegraphCallback(ctx);
    } else if (data.startsWith('sugg:')) {
      await handleSuggestionsCallback(ctx);
    } else if (data.startsWith('clear:')) {
      await handleClearCallback(ctx);
    } else if (data.startsWith('project:')) {
      await handleProjectCallback(ctx);
    } else if (data.startsWith('medium:')) {
      await handleMediumCallback(ctx);
    } else if (data.startsWith('extract:')) {
      await handleExtractCallback(ctx);
    } else if (data.startsWith('reddit_action:')) {
      await handleRedditActionCallback(ctx);
    } else if (data.startsWith('restart:')) {
      await handleRestartCallback(ctx);
    } else if (data.startsWith('startup:')) {
      await handleStartupCallback(ctx);
    } else if (data.startsWith('update:')) {
      await handleUpdateCallback(ctx);
    } else if (data.startsWith('effort:')) {
      await handleEffortCallback(ctx);
    } else if (data.startsWith('verbosity:')) {
      await handleVerbosityCallback(ctx);
    } else if (data.startsWith('method:')) {
      await handleMethodCallback(ctx);
    } else if (data.startsWith('ccr_throttle:')) {
      await handleCcrThrottleCallback(ctx);
    } else if (data.startsWith('sgt:')) {
      await handleSuggestionTapCallback(ctx);
    }
    // Note: `tasks:` callback queries are handled by the pre-sequentialize
    // bot.callbackQuery handler above so they remain responsive mid-stream.
  });

  // Resolve pending claudegram_poll_user MCP calls on first vote. Must be
  // registered before the catch-all paths so the poll_answer update reaches
  // us; non-anonymous polls only fire poll_answer for non-anonymous voting,
  // which is required for the resolve-on-first-vote semantics to work.
  bot.on('poll_answer', async (ctx) => {
    const pa = ctx.pollAnswer;
    if (!pa) return;
    const resolved = resolvePendingPoll(pa.poll_id, pa.option_ids);
    if (!resolved) {
      // Not a claudegram-tracked poll — ignore (could be a user-created poll
      // in the same chat).
    }
  });

  // Handle voice messages
  bot.on('message:voice', handleVoice);

  // Handle audio messages (music/audio files - separate from voice notes)
  bot.on('message:audio', handleTranscribeAudio);

  // Handle images
  bot.on('message:photo', handlePhoto);

  // Handle documents: route by MIME type
  //   audio/* (replying to transcribe prompt) → transcribe
  //   image/*                                  → image vision
  //   anything else                            → read as text/PDF/etc.
  bot.on('message:document', async (ctx) => {
    const doc = ctx.message?.document;
    const mime = doc?.mime_type ?? '';

    // Try transcribe-document path first (audio MIME + reply to ForceReply)
    const replyTo = ctx.message?.reply_to_message;
    if (replyTo && replyTo.from?.is_bot && mime.startsWith('audio/')) {
      const replyText = (replyTo as { text?: string }).text || '';
      if (replyText.includes('Transcribe Audio')) {
        await handleTranscribeDocument(ctx);
        return;
      }
    }

    if (mime.startsWith('image/')) {
      await handleImageDocument(ctx);
      return;
    }

    // Skip audio that isn't being transcribed — voice/audio messages have
    // their own dedicated handlers, so a stray audio document here is likely
    // not meant for the agent. Everything else (PDF, text, code, CSV, …)
    // goes to the document reader.
    if (mime.startsWith('audio/') || mime.startsWith('video/')) return;
    await handleTextDocument(ctx);
  });

  // Handle regular text messages
  bot.on('message:text', handleMessage);

  // Error handler
  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}
