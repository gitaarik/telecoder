import { startIpcServer } from '../claude/ipc-server.js';
import { Bot, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { MessageEntity } from 'grammy/types';
import { autoRetry } from '@grammyjs/auto-retry';
import { sequentialize } from '@grammyjs/runner';
import { telegramClientOptions, telegramProxyUrl } from '../telegram/client-options.js';
import { redactSecrets } from '../utils/sanitize.js';
import { config } from '../config.js';
import { buildSessionKey } from '../utils/session-key.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { adminOnly, adminOrApproverOnly } from './middleware/admin-only.js';
import {
  trackQueuedMessage,
  holdQueuedMessage,
  handleQueuedCallback,
  handleEditedMessage,
  handleLater,
  handleSteer,
  initParkedMessages,
  setQueuedDiverters,
} from './middleware/queued-messages.js';
import {
  handleStart,
  handleClear,
  handleClearCallback,
  handleProject,
  handleProjectCallback,
  handleStatus,
  handlePermissionMode,
  handlePermissionModeCallback,
  handleSuggestions,
  handleSuggestionsCallback,
  handleBotStatus,
  handleVersion,
  handleRestartBot,
  handleRestartBotCallback,
  handleRestartCallback,
  handleStartupCallback,
  handleCost,
  handleUpdate,
  handleUpdateCallback,
  handleCancel,
  handleCommands,
  handleModelCommand,
  handleModelCallback,
  handlePrefsScopeCallback,
  handleProviderCommand,
  handleProviderCallback,
  handleProviderSwitchCallback,
  handleCcrCommand,
  handleResume,
  handleResumeCallback,
  handleRecap,
  handleSync,
  handlePermissions,
  handleProjectCommands,
  handleTerminal,
  handleFile,
  handleStatusLine,
  handleStatusLineCallback,
  handleBotName,
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
} from './handlers/command.handler.js';
import { handleMessage } from './handlers/message.handler.js';
import { handleSchedule, handleSchedules, handleUnschedule } from './handlers/schedule.handler.js';
import { handleForkCallback, handleAcceptCommand, handleDeclineCommand, handleForkCommand, handleSpinoffCommand, forkPastRunningTurnIntoThread } from './handlers/fork.handler.js';
import { askBtw } from './handlers/command/btw.js';
import { handleNewBot, handleManagedBotCreated } from './handlers/newbot.handler.js';
import { handleTreeCommand, handleTreeCallback } from './handlers/tree.handler.js';
import { handlePromptsCommand, handlePromptsCallback } from './handlers/prompts.handler.js';
import {
  handleAllow,
  handleDeny,
  handleUsers,
  handleMembers,
  handleAccessCallback,
} from './handlers/command/access.js';
import { handleAutoApprove } from './handlers/command/auto-approve.js';
import { handleSuggestionTapCallback } from './handlers/suggestion.handler.js';
import { handleVoice } from './handlers/voice.handler.js';
import { handlePhoto, handleImageDocument, handleTextDocument } from './handlers/photo.handler.js';
import {
  handleUnsupportedVideo,
  handleUnsupportedAudio,
  handleUnsupportedMediaDocument,
} from './handlers/media-fallback.js';
import { createBatchMiddleware } from './middleware/message-batcher.js';
import { countUpdatesInFlight } from '../restart-when-idle.js';
import {
  resolvePendingQuestion,
  getQuestionResponders,
  getQuestionOptionLabel,
  questionOwnerCloses,
  appendAnsweredFooter,
  buildAnswerConfirmation,
} from '../claude/ask-user.js';
import { describeResponderRefusal } from '../telegram/admin-mention.js';
import { handleAskUserFormCallback } from '../claude/ask-user-form.js';
import { groupMentionMiddleware } from './middleware/group-mention.middleware.js';
import { groupRoleMiddleware } from './middleware/group-role.middleware.js';
import { trackForceReplyPrompts } from '../telegram/force-reply-tracker.js';
import { initThreadTitles } from '../telegram/thread-titles.js';
import { watchForDeletedThreads } from './deleted-threads.js';
import { startPtyIdleReaper } from '../claude/pty-idle-reaper.js';
import { handleDeleteThread, handleDeleteThreadCallback } from './handlers/command/thread.js';
import { initThreadsSetup } from '../telegram/threads-setup.js';
import { resolvePendingPoll } from '../claude/poll-user.js';
import { captureSecretMessages, handleSecretCallback } from '../claude/secret-request.js';
import { registerBotCommandName } from '../claude/command-parser.js';
import { buildCommandMenu, setCommandCatalog } from './command-catalog.js';
import { handleCommandFixCallback, initCommandFallback } from './handlers/command-fallback.js';
import { withRunningNote } from './handlers/running-note.js';
import { isCheckout } from '../utils/install-mode.js';

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

  // Read the label before resolving — resolving drops the entry. It comes from
  // the registry rather than off the tapped button because the button may be a
  // bare letter: a keyboard whose labels are too wide for Telegram renders as
  // `A` `B` `C` with the full text in the message body, and "✅ Answered: A"
  // is not an answer anyone can read back later.
  const optionLabel = getQuestionOptionLabel(id, idx);
  const ownerCloses = questionOwnerCloses(id);
  const outcome = resolvePendingQuestion(id, idx, ctx.from?.id);
  if (outcome === 'expired') {
    await ctx.answerCallbackQuery({ text: 'This question already expired.' });
    // A question that timed out is closed by whoever was waiting on it, but a
    // restart forgets every open question without touching its message. Take
    // the keyboard down so it stops looking answerable. Text left alone: a
    // quick second tap on a question just answered lands here too, and its
    // "✅ Answered" footer must survive.
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // Already gone, or the message can't be edited — nothing left to do.
    }
    return;
  }
  if (outcome === 'forbidden') {
    // Leave the keyboard up — the people who *can* answer still need it.
    await ctx.answerCallbackQuery({
      text: describeResponderRefusal(getQuestionResponders(id), ctx.from?.id),
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery();

  // A question its asker keeps re-posting over the same message (the memory
  // guard's "Check again") is the asker's to mark up and close; an "Answered"
  // footer here would race its next edit.
  if (ownerCloses) return;

  const message = ctx.callbackQuery?.message as
    | { text?: string; entities?: MessageEntity[]; message_id?: number }
    | undefined;
  const answerText = optionLabel ?? `option ${idx + 1}`;

  // Strip the keyboard so the user can't tap again, and mark the chosen option
  // in place so the question doesn't read as unanswered.
  //
  // Plain text: the label is model-supplied and may contain unbalanced
  // Markdown punctuation (underscores in URL params, stray asterisks, …)
  // which would 400 the edit. A question that went out with entities — a
  // relayed dialog, a permission prompt — gets them back, or the edit strips
  // it to plain text; the footer only appends, so their offsets still hold.
  try {
    const answered = appendAnsweredFooter(message?.text ?? '', answerText);
    if (answered === null) await ctx.editMessageReplyMarkup();
    else if (!message?.entities) await ctx.editMessageText(answered);
    else {
      // An entity Telegram balks at the second time round — a mention it no
      // longer allows — shouldn't cost the footer as well.
      await ctx.editMessageText(answered, { entities: message.entities })
        .catch(() => ctx.editMessageText(answered));
    }
  } catch {
    // Edit may fail if the message changed shape. Losing the footer is
    // cosmetic; leaving a live keyboard on a resolved question is not, so
    // retry the keyboard removal on its own.
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // Non-fatal — a second tap is rejected by resolvePendingQuestion anyway.
    }
  }

  // The answer also goes out as its own message. See buildAnswerConfirmation:
  // an edit is silent, anonymous, and buried at the bottom of a long question,
  // so the choice never really lands in the conversation. Replying to the
  // question keeps the two linked even when several questions are open at once.
  try {
    await ctx.reply(
      buildAnswerConfirmation(answerText, {
        isPrivate: ctx.chat?.type === 'private',
        who: ctx.from?.first_name,
      }),
      message?.message_id === undefined
        ? undefined
        : { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } },
    );
  } catch {
    // Non-fatal — the in-place footer above already recorded the choice.
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

/**
 * `botInfo` is what the startup token check already fetched (see
 * startup/verify-token.ts). Handing it in makes `bot.init()` a no-op instead
 * of a second getMe.
 */
export async function createBot(botInfo?: UserFromGetMe): Promise<Bot> {
  // Start the IPC server for hook callbacks and the standalone MCP subprocess.
  // Awaited so the bound port is known before anything else tries to spawn a
  // subprocess that needs to reach us.
  await startIpcServer();

  // Support an HTTP or HTTPS proxy for the Telegram API (useful in restricted networks)
  const proxyUrl = telegramProxyUrl();
  if (proxyUrl) {
    // A proxy URL can carry a user and password.
    console.log(`[Bot] Using proxy: ${redactSecrets(proxyUrl)}`);
  }

  const bot = new Bot(config.TELEGRAM_BOT_TOKEN, {
    botInfo,
    client: telegramClientOptions(),
  });

  // Note which messages are ForceReply prompts, so a reply answering one still
  // reaches the handlers in a group that otherwise requires an @mention.
  trackForceReplyPrompts(bot);

  // Telegram says nothing when a thread is deleted, but a send into one fails:
  // take that as the news, and end the session the thread had.
  watchForDeletedThreads(bot);
  // And end PTY claudes left idle, a thread deleted by hand among them.
  startPtyIdleReaper();

  // Auto-retry on transient network errors (ECONNRESET, socket hang up, etc.)
  // Also handles 429 rate limits by respecting Telegram's retry_after
  bot.api.config.use(autoRetry({
    maxRetryAttempts: 5,
    maxDelaySeconds: 60, // Cap retry delay at 60 seconds (will retry sooner rather than wait 900s)
    rethrowInternalServerErrors: false, // Retry on 5xx errors
  }));

  // Register command menu for autocomplete (non-blocking). The list lives in
  // command-catalog.ts, where /commands <search> and the typo fallback read it.
  const commandList = buildCommandMenu();
  setCommandCatalog(commandList);

  bot.api.setMyCommands(commandList).then(() => {
    console.log('📋 Command menu registered');
  }).catch((err) => {
    console.warn('⚠️ Failed to register commands:', err.message);
  });

  // Before everything else, so /rebuildbot's "when idle" sees an update from
  // the moment it arrives until its reply has gone out.
  bot.use(countUpdatesInFlight);

  // Apply auth middleware to all updates
  bot.use(authMiddleware);

  // Note who named each private-chat thread, from the notices passing by, so a
  // name the user chose is never replaced by the session topic.
  initThreadTitles(bot);

  // A project bot made by /newbot starts without threads, which only its owner
  // can turn on: tell them how, with the first message they send it.
  initThreadsSetup(bot);

  // In groups, ignore messages that aren't addressed to the bot, so people can
  // talk to each other without triggering a turn. Runs before the command
  // handlers below because they'd otherwise answer a `/status@other_bot`
  // aimed at a different bot in the same group.
  bot.use(groupMentionMiddleware);

  // Of the people an allow-listed group lets in, which ones may actually drive
  // the agent. Runs after the mention gate so a spectator talking to the humans
  // is never answered, and before every command handler below.
  //
  // Handles are learned upstream in authMiddleware, which records everyone the
  // group sees — spectators included — so `/allow @someone` resolves for people
  // who have only ever talked to the other humans.
  bot.use(groupRoleMiddleware);

  // A message answering telecoder_request_secret comes out of the stream
  // here, deleted from the chat before anything below can batch it, queue it
  // or hand it to the agent. The turn that asked is blocked on the answer, so
  // the answer can't wait in line behind it either. Commands pass, so /cancel
  // still works.
  bot.use(captureSecretMessages);

  // Register through `cmd` rather than `bot.command` directly so the set of
  // names TeleCoder claims stays discoverable at runtime. Registration order
  // and placement relative to sequentialize are unchanged — `cmd` calls
  // `bot.command` immediately. /projectcommands uses the recorded names to
  // report which native Claude Code commands this bot shadows.
  const cmd = (
    name: string,
    handler: Parameters<typeof bot.command>[1],
    opts?: { forwardsToAgent?: boolean },
  ): void => {
    registerBotCommandName(name, opts?.forwardsToAgent);
    bot.command(name, handler);
  };

  // These commands fire BEFORE sequentialize so they bypass per-chat ordering.
  // This lets them interrupt, inspect, or restart even when a query is hung.
  cmd('cancel', handleCancel);
  cmd('stop', handleCancel); // alias — natural expectation for "stop the current turn"
  cmd('ping', withRunningNote(handleBotStatus)); // alias — the health check people reach for first
  cmd('status', withRunningNote(handleStatus));
  cmd('version', withRunningNote(handleVersion));
  // Lifecycle and transport are admin-only: they act on every session in the
  // bot, not just the caller's.
  cmd('restartbot', adminOnly(handleRestartBot));
  cmd('rebuildbot', adminOnly(handleRebuild));
  // Access control is admin-only and bypasses sequentialize: a stranger
  // typically turns up mid-turn, and an admin should be able to wave them in
  // without waiting for whatever the group is already running to finish.
  cmd('allow', adminOnly(handleAllow));
  cmd('deny', adminOnly(handleDeny));
  cmd('users', adminOnly(handleUsers));
  cmd('btw', withRunningNote(handleBtw)); // Side question — must bypass queue to work mid-task
  cmd('spinoff', handleSpinoffCommand); // Splits a task off into a new thread — bypasses the queue so it works mid-task
  // Deletes the thread it's sent in, stopping its turn — bypasses the queue so a
  // busy thread can still be deleted. Admin-only: in a group it takes everyone's
  // messages with it.
  cmd('deletethread', adminOnly(handleDeleteThread));
  // Sets an idea aside for after the turn, so it can't wait behind that turn. And
  // with nothing running, it's the one message that doesn't start one.
  cmd('later', withRunningNote(handleLater));
  // Stops the turn and sends a message in its place, so it can't wait behind that turn.
  cmd('steer', handleSteer);
  // Read-only, with nothing a running turn could be disturbed by, so they answer
  // mid-turn rather than after it: a fixed list, a look at the bot process, a
  // re-read of the transcript, and one that asks a probe of its own rather
  // than the live session. Anything that changes the session
  // or starts a turn stays behind sequentialize below.
  cmd('commands', withRunningNote(handleCommands));
  cmd('botstatus', withRunningNote(handleBotStatus));
  cmd('recap', withRunningNote(handleRecap));
  cmd('projectcommands', handleProjectCommands);
  cmd('tasks', handleTasks); // Read-only; must bypass queue so it works mid-stream
  cmd('cost', withRunningNote(handleCost)); // Read-only probe + a peek at the live TUI panel; bypasses the queue so it answers mid-turn
  cmd('shells', withRunningNote(handleShells)); // Lists/kills OS-level bg processes; must bypass queue to rescue hung sessions
  cmd('members', handleMembers);
  // /sync exists for the "I think a reply went missing" scenario, which by
  // definition includes hung or sluggish turns — gating it on sequentialize
  // would queue it behind the very turn the user wants to inspect.
  cmd('sync', handleSync);
  // /tree and /prompts are read-only until a button is tapped, so they answer
  // mid-turn — "what did I just ask?" comes up while a long turn runs — and the
  // buttons that switch conversations refuse while a reply is running.
  cmd('tree', handleTreeCommand);
  cmd('prompts', withRunningNote(handlePromptsCommand));
  // Display preferences: each only flips a stored setting that a turn reads
  // when it starts, so changing one mid-turn applies from the next turn and
  // has no reason to wait for this one. Their menu buttons likewise.
  cmd('statusline', handleStatusLine);
  cmd('verbosity', handleVerbosity);
  cmd('suggestions', handleSuggestions);
  bot.callbackQuery(/^statusline:/, handleStatusLineCallback);
  bot.callbackQuery(/^verbosity:/, handleVerbosityCallback);
  bot.callbackQuery(/^sugg:/, handleSuggestionsCallback);
  // The same goes for the permission mode, which a turn applies as it starts,
  // and for the bot's and the thread's names.
  // /mode was the streaming toggle's name until this landed, and was kept as
  // an alias for exactly as long as nothing better wanted it. Permission mode
  // is what people were always going to mean by it.
  cmd('mode', adminOnly(handlePermissionMode));
  cmd('botname', adminOnly(handleBotName));
  cmd('topic', handleTopic);
  bot.callbackQuery(/^permmode:/, adminOnly(handlePermissionModeCallback));
  // An auto-approve window matters most mid-turn: that's when the prompts it
  // answers are turning up, and closing one can't wait for the turn either.
  // Admins *and* approvers: opening a window is a decision about prompts, not
  // a power over the bot, so it sits with the people who answer them.
  cmd('autoapprove', adminOrApproverOnly(handleAutoApprove));
  cmd('permissions', adminOnly(handlePermissions));
  // Nothing here touches the session: a welcome text, a file sent from disk,
  // and a new bot, which is a process of its own.
  cmd('start', handleStart);
  cmd('file', handleFile);
  // Creating a bot adds a process to the launcher and a token to instances.json.
  cmd('newbot', adminOnly(handleNewBot));
  // Schedule commands bypass sequentialize so they remain responsive even
  // when a scheduled-fire turn is already running (the cap-enforcing create,
  // the list, and the remove all need to work mid-stream).
  cmd('schedule', handleSchedule);
  cmd('schedules', handleSchedules);
  cmd('unschedule', handleUnschedule);
  // /tasks inline-keyboard buttons (view/back/refresh) also need to bypass
  // sequentialize so they're responsive while a stream is active.
  bot.callbackQuery(/^tasks:/, handleTasksCallback);
  // /shells kill buttons must also bypass sequentialize — the whole point is to
  // rescue a session whose current turn is hung waiting on a bg shell.
  bot.callbackQuery(/^shells:/, handleShellsCallback);
  // "Did you mean" buttons under a mistyped command. Before sequentialize: the
  // tap only re-sends the message, which then waits its turn like any other.
  bot.callbackQuery(/^cmdfix:/, handleCommandFixCallback);
  bot.callbackQuery(/^delthread:/, adminOnly(handleDeleteThreadCallback));
  // telecoder_ask_user button taps MUST bypass sequentialize: the agent
  // query is mid-flight and waiting on this exact tap to complete the tool
  // call. If the callback got queued, it'd deadlock behind the query that's
  // waiting for it.
  bot.callbackQuery(/^q:/, handleAskUserCallback);
  // A multi-question form's option, jump and Submit buttons, for the same reason.
  bot.callbackQuery(/^qf:/, handleAskUserFormCallback);
  // The Cancel button under a secret request, for the same reason.
  bot.callbackQuery(/^secret:/, handleSecretCallback);
  // /fork callbacks bypass sequentialize too: the user often taps Fork on a
  // past message while a turn is running. Picker UI is non-destructive (it
  // just shows another message), and accept/decline operate on file state,
  // not the live agent, so they don't need to wait in line.
  bot.callbackQuery(/^fork:/, handleForkCallback);
  // /tree's buttons likewise: opening a point only redraws the message, and
  // carrying on a branch or branching from a point checks for a running reply
  // itself, so a tap mid-turn gets an answer instead of waiting in line.
  bot.callbackQuery(/^tree:/, handleTreeCallback);
  // /prompts' buttons for the same reasons: opening a prompt only redraws the
  // message, and branching from one checks for a running reply itself.
  bot.callbackQuery(/^prompts:/, handlePromptsCallback);
  // "Take back" and "Ask me after" on a queued message: the turn it's waiting
  // behind is exactly what these have to get past.
  bot.callbackQuery(/^queued:/, handleQueuedCallback);
  // An edit to a message that's still waiting has to land before the wait ends,
  // so it can't wait in line itself.
  bot.on('edited_message', handleEditedMessage);
  initParkedMessages(bot);
  initCommandFallback(bot);
  setQueuedDiverters({ btw: askBtw, fork: forkPastRunningTurnIntoThread });
  // Menu buttons for /restartbot and /rebuildbot must bypass sequentialize
  // for the same reason their parent commands do: users tap these precisely
  // when the bot is hung, so the callback can't be queued behind the stuck
  // request.
  // Access cards: same reasoning as the commands above — the card lands while
  // a turn is running, and it is the fastest way to answer it.
  bot.callbackQuery(/^access:/, adminOnly(handleAccessCallback));
  bot.callbackQuery(/^restartbot:/, adminOnly(handleRestartBotCallback));
  bot.callbackQuery(/^rebuild:/, adminOnly(handleRebuildCallback));

  // Batch consecutive text messages BEFORE sequentialize.
  // When Telegram splits a long paste into multiple messages, this combines
  // them into a single prompt. Must run before sequentialize because that
  // middleware serializes same-session updates (preventing concurrent batching).
  bot.use(createBatchMiddleware());

  // Sequentialize: same-chat updates are processed in order.
  // This runs AFTER /cancel so cancel bypasses it.
  //
  // It's also where a message waits while a turn runs, so the two either side
  // of it tell the sender so and let them take the message back. They have to
  // stay wrapped around it: see middleware/queued-messages.ts.
  bot.use(trackQueuedMessage);
  bot.use(sequentialize(getSequentializeKey));
  bot.use(holdQueuedMessage);

  // Bot command handlers (sequentialized per chat)
  cmd('clear', handleClear);
  // Admin-only now that a group can hold contributors: repointing the bot
  // moves everyone's session, and /terminal and /permissions reach the
  // guardrails rather than the conversation.
  cmd('project', adminOnly(handleProject));
  // /compact is a native Claude Code slash command, not a bot command — route it
  // through the normal message pipeline (handleMessage), which forwards it to
  // the active provider; the pty runs the real compaction and reports the token
  // reduction. Registering it here (rather than relying on fall-through to the
  // text handler) makes dispatch explicit and lets grammY match the group-chat
  // `/compact@BotName` form.
  cmd('compact', handleMessage, { forwardsToAgent: true });
  // /context is Claude Code's own, routed the same way: the chat's claude
  // reports what fills its context window, MCP tools and skills included,
  // and the reply is the markdown copy of that report it logs (see
  // commandReplyIn). Like any prompt, it waits for a running turn.
  cmd('context', handleMessage, { forwardsToAgent: true });
  cmd('update', adminOnly(handleUpdate));

  cmd('model', handleModelCommand);
  cmd('effort', handleEffort);
  if (config.CCR_ENABLED) {
    cmd('provider', adminOnly(handleProviderCommand));
  }
  if (config.CCR_ENABLED) {
    cmd('ccr', adminOnly(handleCcrCommand));
  }
  // Session resume commands
  cmd('resume', handleResume);

  // Fork: /fork forks from current state; /accept and /decline are the
  // slash-command equivalents of the target-side inline buttons.
  cmd('fork', handleForkCommand);
  cmd('accept', handleAcceptCommand);
  cmd('decline', handleDeclineCommand);

  // The command line that carries a session on in a terminal. Not /teleport:
  // that name is Claude Code's own (send a session to the cloud, or resume one
  // from claude.ai), and a bot command of that name would keep it out of reach.
  cmd('terminal', adminOnly(handleTerminal));


  // Callback query handler for inline keyboards
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('resume:')) {
      await handleResumeCallback(ctx);
    } else if (data.startsWith('provider_switch:')) {
      await adminOnly(handleProviderSwitchCallback)(ctx);
    } else if (data.startsWith('provider:')) {
      await adminOnly(handleProviderCallback)(ctx);
    } else if (data.startsWith('pscope:') || data.startsWith('prefs_all:')) {
      await handlePrefsScopeCallback(ctx);
    } else if (data.startsWith('model:')) {
      await handleModelCallback(ctx);
    } else if (data.startsWith('clear:')) {
      await handleClearCallback(ctx);
    } else if (data.startsWith('project:')) {
      await adminOnly(handleProjectCallback)(ctx);
    } else if (data.startsWith('restart:')) {
      await handleRestartCallback(ctx);
    } else if (data.startsWith('startup:')) {
      await handleStartupCallback(ctx);
    } else if (data.startsWith('update:')) {
      await adminOnly(handleUpdateCallback)(ctx);
    } else if (data.startsWith('effort:')) {
      await handleEffortCallback(ctx);
    } else if (data.startsWith('sgt:')) {
      await handleSuggestionTapCallback(ctx);
    }
    // Note: `tasks:` callback queries are handled by the pre-sequentialize
    // bot.callbackQuery handler above so they remain responsive mid-stream.
  });

  // Resolve pending telecoder_poll_user MCP calls on first vote. Must be
  // registered before the catch-all paths so the poll_answer update reaches
  // us; non-anonymous polls only fire poll_answer for non-anonymous voting,
  // which is required for the resolve-on-first-vote semantics to work.
  bot.on('poll_answer', async (ctx) => {
    const pa = ctx.pollAnswer;
    if (!pa) return;
    const resolved = resolvePendingPoll(pa.poll_id, pa.option_ids);
    if (!resolved) {
      // Not a TeleCoder-tracked poll — ignore (could be a user-created poll
      // in the same chat).
    }
  });

  // The bot a /newbot button created. The handler checks for an admin itself,
  // and quietly: anyone with a t.me/newbot link can create one.
  bot.on('message:managed_bot_created', handleManagedBotCreated);

  // Handle voice messages
  bot.on('message:voice', handleVoice);

  // Audio files (music, recordings — not voice notes) have no ingestion path;
  // the handler says so rather than dropping them.
  bot.on('message:audio', handleUnsupportedAudio);

  // Handle images
  bot.on('message:photo', handlePhoto);

  // Handle documents: route by MIME type
  //   image/*         → image vision
  //   audio/*, video/* → explained as unsupported
  //   anything else   → read as text/PDF/etc.
  bot.on('message:document', async (ctx) => {
    const doc = ctx.message?.document;
    const mime = doc?.mime_type ?? '';

    if (mime.startsWith('image/')) {
      await handleImageDocument(ctx);
      return;
    }

    // Audio and video documents have no ingestion path, but say so rather than
    // dropping them. This used to be a bare `return`: an mp3 sent as a file
    // produced no reply, no log line, nothing — indistinguishable from the bot
    // being down. Everything else (PDF, text, code, CSV, …) goes to the
    // document reader.
    if (mime.startsWith('video/') || mime.startsWith('audio/')) {
      await handleUnsupportedMediaDocument(ctx);
      return;
    }
    await handleTextDocument(ctx);
  });

  // Video, round video notes and GIFs — no handler matched these at all
  // before, so they fell through the whole chain silently.
  bot.on('message:video', handleUnsupportedVideo);
  bot.on('message:video_note', handleUnsupportedVideo);
  bot.on('message:animation', handleUnsupportedVideo);

  // Handle regular text messages
  bot.on('message:text', handleMessage);

  // Error handler
  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}
