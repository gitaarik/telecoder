/**
 * /model, /provider and /ccr — choosing which backend answers.
 *
 * Kept together because the model list is provider-scoped: switching provider
 * changes what /model can offer, and both changes need the same pty restart.
 */

import { Context } from 'grammy';
import { config } from '../../../config.js';
import {
  setModel,
  getModel,
  clearModel,
  getActiveProviderName,
  setActiveProvider,
  getAvailableProviders,
  getAvailableModels,
  type ProviderName,
} from '../../../providers/provider-router.js';
import { switchProvider, switchRequiresConfirm } from '../../../providers/provider-switch.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { replyMd, parseCallback, restartPtyForSettingChange, PTY_RESTART_NOTE } from './shared.js';

export async function handleModelCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId } = keyInfo;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim().toLowerCase();

  const providerName = getActiveProviderName(chatId);
  const models = await getAvailableModels(chatId);
  const validIds = models.map(m => m.id);

  if (!args) {
    const currentModel = getModel(chatId);

    const keyboard = models.map((m) => {
      const isCurrent = m.id === currentModel;
      const label = isCurrent ? `✓ ${m.label}` : m.label;
      return [{ text: label, callback_data: `model:${m.id}` }];
    });

    const descriptions = models
      .map(m => `• *${esc(m.label)}* \\- ${esc(m.description || '')}`)
      .join('\n');

    await ctx.reply(
      `🤖 *Select Model* \\(${esc(providerName)}\\)\n\n_Current: ${esc(currentModel)}_\n\n${descriptions}`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: keyboard,
        },
      }
    );
    return;
  }

  if (!validIds.includes(args)) {
    await replyMd(ctx, `❌ Unknown model "${esc(args)}"\\.\n\nAvailable: ${validIds.join(', ')}`);
    return;
  }

  setModel(chatId, args);
  const restarted = restartPtyForSettingChange(chatId, keyInfo.sessionKey);
  await replyMd(ctx, `✅ Model set to *${esc(args)}*${restarted ? PTY_RESTART_NOTE : ''}`);
}

export async function handleModelCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'model:');
  if (!cb) return;
  const { chatId, sessionKey, data } = cb;

  const model = data.replace('model:', '');

  // Validate against current provider's models
  const models = await getAvailableModels(chatId);
  const validIds = models.map(m => m.id);

  if (!validIds.includes(model)) {
    await ctx.answerCallbackQuery({ text: 'Invalid model' });
    return;
  }

  setModel(chatId, model);
  const restarted = restartPtyForSettingChange(chatId, sessionKey);

  const modelInfo = models.find(m => m.id === model);
  const displayName = modelInfo?.label || model;

  await ctx.answerCallbackQuery({ text: `Model set to ${displayName}!` });
  await ctx.editMessageText(
    `✅ Model set to *${esc(displayName)}*${restarted ? PTY_RESTART_NOTE : ''}`,
    { parse_mode: 'MarkdownV2' }
  );
}

const PROVIDER_DESCRIPTIONS: Record<ProviderName, string> = {
  claude: '*claude* \\- Claude Code SDK \\(Anthropic / Max\\)',
  ccr: '*ccr* \\- Routed via Claude Code Router \\(alt providers\\)',
};

export async function handleProviderCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const providers = getAvailableProviders();
  const active = getActiveProviderName(chatId);

  const keyboard = providers.map((p) => {
    const label = p === active ? `✓ ${p}` : p;
    return [{ text: label, callback_data: `provider:${p}` }];
  });

  const descriptions = providers.map((p) => `• ${PROVIDER_DESCRIPTIONS[p]}`).join('\n');

  await ctx.reply(
    `🔌 *Select Provider*\n\n_Current: ${esc(active)}_\n\n${descriptions}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }
  );
}

/**
 * Quick toggle between Claude (Max) and CCR. Designed for the common case of
 * "I'm throttled on Max, send subsequent messages through CCR instead."
 * Sticky — stays on CCR until the user toggles back.
 */
export async function handleCcrCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (!config.CCR_ENABLED) {
    await replyMd(
      ctx,
      '⚠️ CCR is not enabled\\. Set `CCR_ENABLED=true` in `.env` and restart the bot\\.',
    );
    return;
  }

  const active = getActiveProviderName(chatId);
  const next: ProviderName = active === 'ccr' ? 'claude' : 'ccr';
  const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;

  // If a live session owned by the other backend would be abandoned, confirm
  // first (switching starts a fresh session — sessions can't cross backends).
  if (sessionKey && switchRequiresConfirm(sessionKey, next)) {
    await ctx.reply(buildSwitchConfirmText(chatId, next), {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: buildSwitchConfirmKeyboard(next) },
    });
    return;
  }

  // switchProvider forks the session (clears the stale session_id and carries
  // over a summary) so the next message starts clean on the new backend.
  if (sessionKey) {
    await switchProvider(sessionKey, chatId, next);
  } else {
    await setActiveProvider(chatId, next);
  }
  // Clear model — Claude and CCR share labels but CCR's mapping is different.
  clearModel(chatId);

  const label = next === 'ccr' ? 'CCR \\(routed\\)' : 'Claude \\(Max\\)';
  await replyMd(ctx, `🔌 Switched provider to *${label}*\\.\n\n_Sticky — use /ccr again or /provider to switch back\\._`);
}

export async function handleProviderCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('provider:')) return;

  const provider = data.replace('provider:', '') as ProviderName;
  const providers = getAvailableProviders();

  if (!providers.includes(provider)) {
    await ctx.answerCallbackQuery({ text: 'Invalid provider' });
    return;
  }

  if (provider === getActiveProviderName(chatId)) {
    await ctx.answerCallbackQuery({ text: `Already using ${provider}` });
    return;
  }

  const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;

  // If a live session owned by a different backend would be abandoned, confirm
  // first — switching starts a fresh session (sessions can't cross backends).
  if (sessionKey && switchRequiresConfirm(sessionKey, provider)) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(buildSwitchConfirmText(chatId, provider), {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: buildSwitchConfirmKeyboard(provider) },
    });
    return;
  }

  // No live session (or already owned by target): switch transparently.
  if (sessionKey) {
    await switchProvider(sessionKey, chatId, provider);
  } else {
    await setActiveProvider(chatId, provider);
  }
  clearModel(chatId); // Models differ between providers

  await ctx.answerCallbackQuery({ text: `Switched to ${provider}!` });
  await ctx.editMessageText(
    `✅ Provider set to *${esc(provider)}*\n\n_Model selection cleared \\— use /model to pick a model\\._`,
    { parse_mode: 'MarkdownV2' }
  );
}

/** MarkdownV2 confirmation body shown before a destructive provider switch. */
function buildSwitchConfirmText(chatId: number, target: ProviderName): string {
  const current = getActiveProviderName(chatId);
  return (
    `🔀 *Switch to ${esc(target)}?*\n\n` +
    `Your current conversation runs on *${esc(current)}*\\. Sessions can't move ` +
    `between model backends, so I'll start a *fresh session* on ${esc(target)} and ` +
    `carry over a short summary of this conversation for continuity\\.\n\n` +
    `Continue?`
  );
}

function buildSwitchConfirmKeyboard(target: ProviderName) {
  return [
    [
      { text: '✓ Switch & carry over', callback_data: `provider_switch:${target}` },
      { text: '✗ Cancel', callback_data: 'provider_switch:cancel' },
    ],
  ];
}

/** Handles the confirm/cancel buttons from a provider-switch prompt. */
export async function handleProviderSwitchCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('provider_switch:')) return;
  const target = data.replace('provider_switch:', '');

  if (target === 'cancel') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    return;
  }

  const providers = getAvailableProviders();
  if (!providers.includes(target as ProviderName)) {
    await ctx.answerCallbackQuery({ text: 'Invalid provider' });
    return;
  }
  const provider = target as ProviderName;

  const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
  if (sessionKey) {
    await switchProvider(sessionKey, chatId, provider);
  } else {
    await setActiveProvider(chatId, provider);
  }
  clearModel(chatId);

  await ctx.answerCallbackQuery({ text: `Switched to ${provider}!` });
  await ctx.editMessageText(
    `✅ Provider set to *${esc(provider)}*\\. Started a fresh session with a summary of the previous conversation carried over\\.\n\n_Model selection cleared \\— use /model to pick a model\\._`,
    { parse_mode: 'MarkdownV2' }
  );
}
