/**
 * /model, /provider and /ccr — choosing which backend answers.
 *
 * Kept together because the model list is provider-scoped: switching provider
 * changes what /model can offer, and both changes need the same pty restart.
 */

import { Context } from 'grammy';
import { config } from '../../../config.js';
import {
  getModel,
  clearModel,
  getActiveProviderName,
  setActiveProvider,
  getAvailableProviders,
  getAvailableModels,
  type ProviderName,
} from '../../../providers/provider-router.js';
import { isPassthroughModelId, isPremiumModel, PREMIUM_MODEL_ICON } from '../../../claude/model-catalog.js';
import { switchProvider, switchRequiresConfirm } from '../../../providers/provider-switch.js';
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { replyFormatted, editCallbackMessage } from '../../../telegram/send.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { userPreferences } from '../../../providers/user-preferences.js';
import { replyMd, parseCallback } from './shared.js';
import {
  parseScopeArg,
  isBareLevelWord,
  scopeSite,
  applyAtLevel,
  describeSource,
  levelHelp,
  EVERYWHERE_ADMIN_ONLY,
} from './prefs-scope.js';
import { resolveLevel } from './all-view.js';

export async function handleModelCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  // Aliases are all lowercase, but a hand-typed full ID may not be — match
  // case-insensitively, then pass the original through so vendor-cased IDs
  // reach the CLI intact.
  const { value: rawArg, level: explicitLevel } = parseScopeArg(text.split(' ').slice(1).join(' '));
  const args = rawArg.toLowerCase();

  const providerName = getActiveProviderName(sessionKey);
  const models = await getAvailableModels(sessionKey);
  const validIds = models.map(m => m.id);
  const site = scopeSite(ctx);

  if (!args) {
    const currentModel = getModel(sessionKey);
    const asked = userPreferences.getModel(sessionKey);

    // Two per row — the alias list is long enough now (fable/opus/sonnet/haiku
    // plus opusplan, best and the [1m] variants) that one row each turns the
    // picker into a scroll on mobile.
    const buttons = models.map((m) => ({
      text: m.id === (asked ?? currentModel) ? `✓ ${m.label}` : m.label,
      callback_data: `model:${m.id}`,
    }));
    const keyboard: (typeof buttons)[] = [];
    for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(buttons.slice(i, i + 2));
    }

    const picker = new EntityText()
      .add('🤖 ').bold('Select Model').add(` (${providerName})`)
      .newline(2)
      .italic(`Current: ${currentModel}, ${describeSource(sessionKey, 'model')}`)
      .newline(2);
    models.forEach((m, i) => {
      if (i > 0) picker.newline();
      picker.add('• ').bold(m.label).add(` - ${m.description || ''}`);
    });
    picker.add('\n\nOr ').code('/model <full-id>').add(' to pin an exact release, e.g. ')
      .code('claude-opus-4-8').add('.');
    picker.append(levelHelp('model', 'sonnet', site));

    await replyFormatted(ctx, picker.build(), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  // A level word on its own has no model attached. Passthrough would
  // otherwise take it at face value and hand the CLI `--model all`, which is
  // a confusing way to learn the argument order.
  if (isBareLevelWord(args)) {
    await replyMd(
      ctx,
      `\`${args}\` says how far to apply a model, but it needs the model too.\n\n` +
        `Try \`/model sonnet ${args}\`, or /model to pick one.`,
    );
    return;
  }

  // Anything off the catalog is taken at face value — the CLI accepts a full
  // model name wherever it accepts an alias, and pinning an exact release is a
  // legitimate thing to want. We can't verify it, so say so rather than
  // pretending the choice was checked.
  const known = validIds.includes(args);
  if (!known && !isPassthroughModelId(rawArg)) {
    await replyFormatted(
      ctx,
      new EntityText()
        .add(`❌ "${rawArg}" isn't a usable model name.\n\n`)
        .add(`Aliases: ${validIds.join(', ')}\n`)
        .add('Or pass a full model ID (e.g. ').code('claude-opus-5').add(').')
        .build(),
    );
    return;
  }

  const level = resolveLevel(ctx, explicitLevel);
  if (level === 'all' && !site.admin) {
    await replyFormatted(ctx, new EntityText().add(`⛔ ${EVERYWHERE_ADMIN_ONLY}`).build());
    return;
  }

  const chosen = known ? args : rawArg;
  const { message, keyboard } = await applyAtLevel(ctx, {
    sessionKey, setting: 'model', value: chosen, label: chosen, level, site,
  });
  appendPremiumNote(message, chosen, providerName);
  if (!known) {
    message.add(
      "\n\n⚠️ Not a known alias — passed to the CLI as-is. If your install can't serve it, the next turn fails; /model to pick again.",
    );
  }
  await replyFormatted(ctx, message.build(), {
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function handleModelCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'model:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const model = data.replace('model:', '');

  // Validate against current provider's models
  const models = await getAvailableModels(sessionKey);
  const validIds = models.map(m => m.id);

  if (!validIds.includes(model)) {
    await ctx.answerCallbackQuery({ text: 'Invalid model' });
    return;
  }

  const modelInfo = models.find(m => m.id === model);
  const displayName = modelInfo?.label || model;
  const site = scopeSite(ctx);

  await ctx.answerCallbackQuery({ text: `Model set to ${displayName}!` });
  const { message, keyboard } = await applyAtLevel(ctx, {
    sessionKey, setting: 'model', value: model, label: displayName, level: resolveLevel(ctx, undefined), site,
  });
  appendPremiumNote(message, model, getActiveProviderName(sessionKey));
  await editCallbackMessage(ctx, message.build(), {
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

/**
 * Said once, when a premium model is picked: from then on the status line's
 * 💎 is the reminder, and it only works if it was explained here.
 */
function appendPremiumNote(confirmation: EntityText, model: string, provider: ProviderName): void {
  if (provider === 'ccr' || !isPremiumModel(model)) return;
  confirmation.newline(2).italic(
    `${PREMIUM_MODEL_ICON} ${model} costs more per turn than opus, so it uses up your plan's limits faster. ` +
      `The status line shows ${PREMIUM_MODEL_ICON} while it's on; /model opus to switch back.`,
  );
}

const PROVIDER_DESCRIPTIONS: Record<ProviderName, string> = {
  claude: 'Claude Code (Anthropic / Max)',
  ccr: 'Routed via Claude Code Router (alt providers)',
};

export async function handleProviderCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const providers = getAvailableProviders();
  const active = getActiveProviderName(sessionKey);

  const keyboard = providers.map((p) => {
    const label = p === active ? `✓ ${p}` : p;
    return [{ text: label, callback_data: `provider:${p}` }];
  });

  const picker = new EntityText()
    .add('🔌 ').bold('Select Provider')
    .newline(2)
    .italic(`Current: ${active}`)
    .newline(2);
  providers.forEach((p, i) => {
    if (i > 0) picker.newline();
    picker.add('• ').bold(p).add(` - ${PROVIDER_DESCRIPTIONS[p]}`);
  });

  await replyFormatted(ctx, picker.build(), {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

/**
 * Quick toggle between Claude (Max) and CCR. Designed for the common case of
 * "I'm throttled on Max, send subsequent messages through CCR instead."
 * Sticky — stays on CCR until the user toggles back.
 */
export async function handleCcrCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  if (!config.CCR_ENABLED) {
    await replyMd(
      ctx,
      '⚠️ CCR is not enabled. Set `CCR_ENABLED=true` in `.env` and restart the bot.',
    );
    return;
  }

  const active = getActiveProviderName(sessionKey);
  const next: ProviderName = active === 'ccr' ? 'claude' : 'ccr';

  // If a live session owned by the other backend would be abandoned, confirm
  // first (switching starts a fresh session — sessions can't cross backends).
  if (switchRequiresConfirm(sessionKey, next)) {
    await replyFormatted(ctx, buildSwitchConfirmText(sessionKey, next), {
      reply_markup: { inline_keyboard: buildSwitchConfirmKeyboard(next) },
    });
    return;
  }

  // switchProvider forks the session (clears the stale session_id and carries
  // over a summary) so the next message starts clean on the new backend.
  await switchProvider(sessionKey, next);
  // Clear model — Claude and CCR share labels but CCR's mapping is different.
  clearModel(sessionKey);

  const label = next === 'ccr' ? 'CCR (routed)' : 'Claude (Max)';
  await replyMd(ctx, `🔌 Switched provider to **${label}**.\n\n_Sticky — use /ccr again or /provider to switch back._`);
}

export async function handleProviderCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('provider:')) return;

  const provider = data.replace('provider:', '') as ProviderName;
  const providers = getAvailableProviders();

  if (!providers.includes(provider)) {
    await ctx.answerCallbackQuery({ text: 'Invalid provider' });
    return;
  }

  if (provider === getActiveProviderName(sessionKey)) {
    await ctx.answerCallbackQuery({ text: `Already using ${provider}` });
    return;
  }


  // If a live session owned by a different backend would be abandoned, confirm
  // first — switching starts a fresh session (sessions can't cross backends).
  if (switchRequiresConfirm(sessionKey, provider)) {
    await ctx.answerCallbackQuery();
    await editCallbackMessage(ctx, buildSwitchConfirmText(sessionKey, provider), {
      reply_markup: { inline_keyboard: buildSwitchConfirmKeyboard(provider) },
    });
    return;
  }

  // No live session (or already owned by target): switch transparently.
  await switchProvider(sessionKey, provider);
  clearModel(sessionKey); // Models differ between providers

  await ctx.answerCallbackQuery({ text: `Switched to ${provider}!` });
  await editCallbackMessage(
    ctx,
    new EntityText()
      .add('✅ Provider set to ').bold(provider)
      .newline(2)
      .italic(MODEL_CLEARED_NOTE)
      .build(),
  );
}

const MODEL_CLEARED_NOTE = 'Model selection cleared — use /model to pick a model.';

/** Confirmation body shown before a destructive provider switch. */
function buildSwitchConfirmText(sessionKey: string, target: ProviderName): EntityMessage {
  const current = getActiveProviderName(sessionKey);
  return new EntityText()
    .add('🔀 ').bold(`Switch to ${target}?`)
    .newline(2)
    .add('Your current conversation runs on ').bold(current)
    .add(". Sessions can't move between model backends, so I'll start a ")
    .bold('fresh session')
    .add(` on ${target} and carry over a short summary of this conversation for continuity.`)
    .newline(2)
    .add('Continue?')
    .build();
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
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

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

  await switchProvider(sessionKey, provider);
  clearModel(sessionKey);

  await ctx.answerCallbackQuery({ text: `Switched to ${provider}!` });
  await editCallbackMessage(
    ctx,
    new EntityText()
      .add('✅ Provider set to ').bold(provider)
      .add('. Started a fresh session with a summary of the previous conversation carried over.')
      .newline(2)
      .italic(MODEL_CLEARED_NOTE)
      .build(),
  );
}
