/**
 * /tree — the branches of a forked conversation, drawn in one message, and a
 * way back to any point in them.
 *
 * The tree is read off the transcripts (see fork-tree.ts), so it holds every
 * branch still on disk: ones handed to sibling bots, and ones long gone from
 * /resume. The message draws it whole, each point keyed by a letter the way
 * /resume keys its sessions, and the buttons are just the letters. A letter
 * opens its point — the exchange it ends on, and what can be done from there:
 *
 *   ▶️ Carry on this branch   the end of a branch: go back to it
 *   🌱 New branch from here    any point: start another branch from it
 *
 * Carrying on only ever resumes a branch this chat's own /resume holds. Any
 * other branch is carried on as a copy: that another chat or bot has it, or
 * that none does any more, says nothing about whether something — a sibling,
 * a terminal — has it open, and two writers would interleave one transcript.
 * The copy ends where the branch does, so the tree still draws one branch end.
 *
 * Callback data has to fit in 64 bytes, and a uuid takes 36, so a point's
 * button names its tree by the first 8 characters of the tree's root:
 *
 *   tree:show                 🌳 on a banner: send the current tree
 *   tree:f:<rootId>           show a tree in this message
 *   tree:n:<root8>:<nodeId>   open a point
 *   tree:c:<root8>:<nodeId>   carry on the branch ending at that point
 *   tree:b:<root8>:<nodeId>   start a new branch from that point
 *
 * Every tap re-reads the tree, so a message sent before the conversation moved
 * on still acts on what is on disk now. A point is its last record's uuid,
 * which a transcript that only ever grows never takes back.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { BOT_ID, config } from '../../config.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { findBotById } from '../../utils/instances.js';
import { sessionManager } from '../../claude/session-manager.js';
import { findHistoryOwners, sessionHistory, type HistoryOwner } from '../../claude/session-history.js';
import { isProcessing } from '../../claude/request-queue.js';
import { countJsonlLines } from '../../claude/message-offsets.js';
import { lastAssistantTurnText, lastExchangeIn, sessionJsonlPath } from '../../claude/session-jsonl.js';
import type { PendingFork } from '../../claude/pending-forks.js';
import {
  forkedConversations,
  nodeById,
  nodeWhereEnds,
  preorder,
  promptsIn,
  transcriptUpTo,
  treeByRoot,
  treeOf,
  type ForkNode,
  type ForkTree,
} from '../../claude/fork-tree.js';
import { clearConversation } from '../../providers/provider-router.js';
import { escapeMarkdownV2 as esc, escapeMarkdownV2Code } from '../../telegram/markdown.js';
import {
  buildLetterKeyboard,
  buildLetteredKeyboard,
  letteredOptionLines,
  optionLetter,
} from '../../telegram/lettered-options.js';
import { restoreTopicAndRefreshBotName, getSessionTopic } from './command.handler.js';
import { formatTimeAgo } from './command/shared.js';
import { promptLabel } from './command/session.js';
import { NO_PROJECT_MESSAGE } from './session-guard.js';
import {
  LEFT_ABOVE,
  buildBackOnBranchMarker,
  loadFork,
  oneLine,
  plainMarker,
  postMarker,
  replyQuote,
} from './fork.handler.js';

type Keyboard = { text: string; callback_data: string }[][];

interface View {
  text: string;
  keyboard: Keyboard;
}

/**
 * How far a line of the drawn tree may run. It sits in a code block so the
 * branches line up, and a phone wraps a code block's lines — which would break
 * them apart — somewhere past this.
 */
const TREE_LINE_WIDTH = 32;

/** The fewest characters a label is cut to, however deep its point sits. */
const MIN_LABEL_LEN = 8;

/** Points one message draws. Past this the rest are counted, not drawn. */
const MAX_TREE_NODES = 40;

/** How much of a point's label its own view spells out. */
const NODE_TITLE_LEN = 60;

/** How far the prompt a point ends on may run on its one line. */
const NODE_PROMPT_LEN = 160;

/**
 * How much of the reply a point ends on its view shows. Less than a banner
 * gets: this is a menu, read before choosing, and the whole reply is one tap
 * away in the conversation it belongs to.
 */
const NODE_REPLY_LEN = 1200;

/** Forked conversations the list offers when there is no tree to show. */
const MAX_LISTED_TREES = 8;

/** How much of a conversation's name the list spells out. */
const LIST_LABEL_LEN = 80;

/** The first 8 characters of a tree's root: enough to find it among one project's trees. */
const rootKey = (tree: ForkTree) => tree.rootId.slice(0, 8);

// ── Labels ───────────────────────────────────────────────────────────────

/** A point's name: the first prompt in its stretch that was a turn. */
function nodeLabel(node: ForkNode): string {
  for (const prompt of node.prompts) {
    const label = promptLabel(prompt);
    if (label) return label;
  }
  // A stretch with no prompt of its own carries on the reply above it.
  return '…';
}

/** Turns taken in a point's own stretch — prompts, not commands. */
function turnsIn(node: ForkNode): number {
  return node.prompts.filter((prompt) => promptLabel(prompt) !== undefined).length;
}

/** `text` cut to `max` characters, counting an emoji as one. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

// ── The tree ─────────────────────────────────────────────────────────────

/**
 * The branch lines leading to a point: a connector for the point itself, and
 * a rail for every ancestor between it and the root that has a sibling still
 * to come below.
 */
function connectorsOf(node: ForkNode): string {
  let out = '';
  let own = true;
  for (let n = node; n.parent; n = n.parent) {
    const last = n.parent.children.at(-1) === n;
    out = (own ? (last ? '└' : '├') : (last ? ' ' : '│')) + out;
    own = false;
  }
  return out;
}

function treeLine(node: ForkNode, letter: string, isHere: boolean): string {
  const prefix = `${connectorsOf(node)}${letter} `;
  const mark = isHere ? ' 📍' : node.endsHere.length > 0 ? ' ▸' : '';
  const suffix = ` ·${turnsIn(node)}${mark}`;
  const room = Math.max(MIN_LABEL_LEN, TREE_LINE_WIDTH - Array.from(prefix + suffix).length);
  return `${prefix}${cut(nodeLabel(node), room)}${suffix}`;
}

/**
 * A tree drawn whole, a letter per point, with a button per letter. 📍 marks
 * where `hereSessionId` ends — the chat's conversation, or with `leftOff`, the
 * one it left off in before a restart dropped it.
 */
export function renderTree(tree: ForkTree, hereSessionId?: string, leftOff = false): View {
  const nodes = preorder(tree);
  const shown = nodes.slice(0, MAX_TREE_NODES);
  const here = hereSessionId ? nodeWhereEnds(tree, hereSessionId) : undefined;
  const ends = nodes.filter((node) => node.endsHere.length > 0).length;

  const drawn = shown.map((node, i) => treeLine(node, optionLetter(i), node === here));
  const hidden = nodes.length - shown.length;

  const text = [
    `🌳 *${esc(path.basename(tree.projectPath))}* — ${ends} ${ends === 1 ? 'branch' : 'branches'}`,
    '```',
    ...drawn.map(escapeMarkdownV2Code),
    '```',
    ...(hidden > 0 ? [esc(`${hidden} more ${hidden === 1 ? 'point isn’t' : 'points aren’t'} drawn.`)] : []),
    `_${esc(`·N turns · ▸ branch end${here ? ` · 📍 ${leftOff ? 'where this chat left off' : 'you are here'}` : ''}`)}_`,
    esc('Tap a letter to open that point.'),
  ].join('\n');

  const keyboard = buildLetterKeyboard(shown.map((node) => `tree:n:${rootKey(tree)}:${node.id}`));
  return { text, keyboard };
}

/**
 * What choosing "carry on" does with a branch end, worked out once so the
 * point's view can say it before the tap does it.
 */
type CarryOn =
  /** The chat is on this branch already. */
  | { kind: 'here' }
  /** It's in this chat's /resume: go back to it. */
  | { kind: 'resume'; sessionId: string; owner: HistoryOwner }
  /**
   * Another chat or bot holds it, or none does any more: carry on a copy here,
   * and leave that one as it is (see the top of this file for why).
   */
  | { kind: 'copy'; sessionId: string; owner?: HistoryOwner };

function carryOnAt(node: ForkNode, sessionKey: string, hereSessionId?: string): CarryOn | undefined {
  const ends = node.endsHere;
  if (ends.length === 0) return undefined;
  if (hereSessionId && ends.includes(hereSessionId)) return { kind: 'here' };

  const owners = findHistoryOwners(ends, BOT_ID);
  for (const sessionId of ends) {
    const mine = owners.get(sessionId)?.find((o) => o.botId === BOT_ID && o.sessionKey === sessionKey);
    if (mine) return { kind: 'resume', sessionId, owner: mine };
  }
  const sessionId = ends[0]!;
  return { kind: 'copy', sessionId, owner: owners.get(sessionId)?.[0] };
}

/** Where a branch end is, and so what carrying it on will do — for the point's view. */
function describeCarryOn(carry: CarryOn): string {
  switch (carry.kind) {
    case 'here':
      return '📍 You are on this branch.';
    case 'resume':
      return "It's in this chat's /resume.";
    case 'copy': {
      if (!carry.owner) {
        return "No chat's /resume has it any more. Carrying it on here makes a copy; the original stays as it is.";
      }
      const where = carry.owner.botId === BOT_ID
        ? 'another chat with this bot'
        : (findBotById(carry.owner.botId)?.name ?? 'another bot');
      return `It lives in ${where} — carrying it on here makes a copy, and that one stays as it is.`;
    }
  }
}

/** "D", "D and H", "D, H and I". */
function listLetters(letters: string[]): string {
  return letters.length <= 1 ? letters.join('') : `${letters.slice(0, -1).join(', ')} and ${letters.at(-1)}`;
}

/** One point of a tree: the exchange it ends on, and what can be done from it. */
export function renderNode(tree: ForkTree, node: ForkNode, sessionKey: string, hereSessionId?: string): View {
  const nodes = preorder(tree);
  const letterOf = (n: ForkNode) => optionLetter(nodes.indexOf(n));
  const carry = carryOnAt(node, sessionKey, hereSessionId);
  const turns = turnsIn(node);

  const facts = [`${turns} ${turns === 1 ? 'turn' : 'turns'}`];
  if (node.endsHere.length > 0) {
    facts.push('branch end');
    const mtimeMs = tree.transcripts.get(node.endsHere[0]!)?.mtimeMs;
    if (mtimeMs) facts.push(`last active ${formatTimeAgo(new Date(mtimeMs))}`);
  }

  const upTo = transcriptUpTo(tree, node);
  const exchange = upTo ? lastExchangeIn(upTo) : undefined;

  const text = [
    `🌳 *${esc(letterOf(node))}* · ${esc(cut(nodeLabel(node), NODE_TITLE_LEN))}`,
    `_${esc(facts.join(' · '))}_`,
    ...(carry ? [esc(describeCarryOn(carry))] : []),
    ...(node.children.length > 0 ? [esc(`Splits into ${listLetters(node.children.map(letterOf))}.`)] : []),
    ...(exchange
      ? [
          '',
          `*You:* ${esc(oneLine(promptLabel(exchange.user) ?? exchange.user, NODE_PROMPT_LEN))}`,
          // Cut without pointing at /recap: that shows the chat's conversation,
          // which this point may not be on.
          ...replyQuote(exchange.assistant, NODE_REPLY_LEN, null),
        ]
      : []),
  ].join('\n');

  const ref = `${rootKey(tree)}:${node.id}`;
  const keyboard: Keyboard = [
    ...(carry && carry.kind !== 'here' ? [[{ text: '▶️ Carry on this branch', callback_data: `tree:c:${ref}` }]] : []),
    [{ text: '🌱 New branch from here', callback_data: `tree:b:${ref}` }],
    [{ text: '⬅️ Back to the tree', callback_data: `tree:f:${tree.rootId}` }],
  ];
  return { text, keyboard };
}

/**
 * The forked conversations in a project, for when there is no tree to show —
 * the chat is on one that was never forked, or on none at all.
 */
export function renderTreeList(projectPath: string, intro?: string): View {
  const project = esc(path.basename(projectPath));
  const conversations = forkedConversations(projectPath).slice(0, MAX_LISTED_TREES);
  if (conversations.length === 0) {
    return {
      text: [
        ...(intro ? [esc(intro), ''] : []),
        `🌳 No conversation in *${project}* has been forked yet\\.`,
        '',
        esc('Tap 🍴 Fork under a reply to branch one.'),
      ].join('\n'),
      keyboard: [],
    };
  }

  const options = conversations.map((c) => ({
    label: cut(promptsIn(projectPath, c.sessionIds[0]!).map(promptLabel).find(Boolean) ?? 'Untitled', LIST_LABEL_LEN),
    description: `${c.sessionIds.length} branches · ${formatTimeAgo(new Date(c.lastActiveMs))}`,
  }));
  return {
    text: [
      ...(intro ? [esc(intro), ''] : []),
      `🌳 *Forked conversations* · ${project}`,
      '',
      ...letteredOptionLines(options).map((line) => esc(line)),
    ].join('\n'),
    keyboard: buildLetteredKeyboard(
      options.map((o, i) => ({ label: o.label, callbackData: `tree:f:${conversations[i]!.rootId}` })),
    ),
  };
}

/**
 * Where the chat is: the conversation it's on — or, when a restart dropped
 * that and nothing has brought it back, the one it left off in (`live` false).
 *
 * Only ever read. Drawing a tree mustn't load a conversation behind the
 * chat's back: after a restart, a standing "Start fresh" counts on nothing
 * being loaded, and the next message would otherwise land in whatever was.
 */
function whereChatIs(sessionKey: string): { projectPath: string; sessionId?: string; live: boolean } | undefined {
  const session = sessionManager.getSession(sessionKey);
  if (session) return { projectPath: session.workingDirectory, sessionId: session.claudeSessionId, live: true };
  const last = sessionHistory.getLastSession(sessionKey);
  return last ? { projectPath: last.projectPath, sessionId: last.claudeSessionId, live: false } : undefined;
}

/** The tree the chat is in, or the list of trees when it isn't in one. */
function currentView(sessionKey: string): View | undefined {
  const where = whereChatIs(sessionKey);
  if (!where) return undefined;
  const tree = where.sessionId ? treeOf(where.projectPath, where.sessionId) : undefined;
  if (tree && tree.transcripts.size > 1) return renderTree(tree, where.sessionId, !where.live);
  const intro = !where.sessionId
    ? undefined
    : where.live
      ? "This conversation hasn't been forked yet."
      : "The conversation this chat left off in hasn't been forked.";
  return renderTreeList(where.projectPath, intro);
}

// ── Commands and taps ────────────────────────────────────────────────────

export async function handleTreeCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const view = currentView(keyInfo.sessionKey);
  if (!view) {
    await ctx.reply(NO_PROJECT_MESSAGE, { parse_mode: 'MarkdownV2' });
    return;
  }
  await sendView(ctx, view, 'reply');
}

export async function handleTreeCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!data || !keyInfo) return;
  const { sessionKey } = keyInfo;
  const [, action, rootId, nodeId] = data.split(':');

  try {
    if (action === 'show') {
      // Answered first: the first tree a bot draws reads the project's
      // transcripts, and the button shouldn't sit spinning meanwhile.
      await ctx.answerCallbackQuery();
      const view = currentView(sessionKey);
      if (!view) {
        await ctx.reply(NO_PROJECT_MESSAGE, { parse_mode: 'MarkdownV2' });
        return;
      }
      await sendView(ctx, view, 'reply');
      return;
    }

    const where = whereChatIs(sessionKey);
    const tree = where && rootId ? treeByRoot(where.projectPath, rootId, nodeId) : undefined;
    if (!where || !tree) {
      await ctx.answerCallbackQuery({ text: "That tree isn't in this chat's project any more — send /tree again." });
      return;
    }
    // The branch the chat is on, for "you're on it already". A conversation a
    // restart left unloaded isn't one the chat is on.
    const here = where.live ? where.sessionId : undefined;

    if (action === 'f') {
      await ctx.answerCallbackQuery();
      await sendView(ctx, renderTree(tree, where.sessionId, !where.live), 'edit');
      return;
    }

    const node = nodeId ? nodeById(tree, nodeId) : undefined;
    if (!node) {
      await ctx.answerCallbackQuery({ text: "That point isn't in the tree any more — send /tree again." });
      return;
    }
    if (action === 'n') {
      await ctx.answerCallbackQuery();
      await sendView(ctx, renderNode(tree, node, sessionKey, here), 'edit');
    } else if (action === 'c') {
      await onCarryOn(ctx, sessionKey, tree, node, here);
    } else if (action === 'b') {
      await onBranch(ctx, sessionKey, tree, node, here);
    } else {
      await ctx.answerCallbackQuery({ text: 'Unknown tree action.' });
    }
  } catch (err) {
    console.error('[Tree] callback failed:', sanitizeError(err));
    try {
      await ctx.answerCallbackQuery({ text: 'That failed — see bot logs.' });
    } catch { /* already answered */ }
  }
}

/**
 * Send `view` as a reply, or put it in place of the tapped message. A view
 * Telegram won't parse goes out as plain text instead, so a formatting slip
 * costs the formatting and not the tree.
 */
async function sendView(ctx: Context, view: View, how: 'reply' | 'edit'): Promise<void> {
  const reply_markup = { inline_keyboard: view.keyboard };
  const send = (text: string, parse_mode?: 'MarkdownV2') => how === 'edit'
    ? ctx.editMessageText(text, { parse_mode, reply_markup })
    : ctx.reply(text, { parse_mode, reply_markup });
  try {
    await send(view.text, 'MarkdownV2');
  } catch (err) {
    // "message is not modified": the same view, tapped again. Nothing to do.
    if (err instanceof Error && err.message.includes('not modified')) return;
    console.error('[Tree] MarkdownV2 send failed, falling back to plain text:', sanitizeError(err));
    await send(plainView(view.text));
  }
}

/** A view as plain text: the tree's code fences dropped, then unmarked like a banner. */
function plainView(text: string): string {
  return plainMarker(text.split('\n').filter((line) => line !== '```').join('\n'));
}

/**
 * Switching conversations under a running reply would cut it off, so the
 * switches wait for it. Says so on the button and returns true when busy.
 */
async function refuseWhileBusy(ctx: Context, sessionKey: string): Promise<boolean> {
  if (!isProcessing(sessionKey)) return false;
  await ctx.answerCallbackQuery({
    text: 'A reply is still running here — wait for it to finish, or /cancel it, then tap again.',
    show_alert: true,
  });
  return true;
}

async function onCarryOn(
  ctx: Context,
  sessionKey: string,
  tree: ForkTree,
  node: ForkNode,
  here: string | undefined,
): Promise<void> {
  const carry = carryOnAt(node, sessionKey, here);
  if (!carry) {
    await ctx.answerCallbackQuery({ text: 'No branch ends at that point.' });
    return;
  }
  if (carry.kind === 'here') {
    await ctx.answerCallbackQuery({ text: "You're on this branch already." });
    return;
  }
  if (await refuseWhileBusy(ctx, sessionKey)) return;

  if (carry.kind === 'copy') {
    const copied = await branchFrom(ctx, sessionKey, tree, node, carry.owner);
    await ctx.answerCallbackQuery({ text: copied ? 'Carried on as a copy.' : "That branch's transcript is gone from disk." });
    return;
  }

  // Back to a conversation in this chat's /resume — what /resume itself does.
  if (!sessionManager.resumeSession(sessionKey, carry.owner.entry.conversationId)) {
    await ctx.answerCallbackQuery({ text: "That branch isn't in this chat's /resume any more — send /tree again." });
    return;
  }
  clearConversation(sessionKey);
  await restoreTopicAndRefreshBotName(ctx, sessionKey, carry.owner.entry.topic);

  const file = sessionJsonlPath(tree.projectPath, carry.sessionId);
  let jsonl = '';
  try {
    jsonl = fs.readFileSync(file, 'utf-8');
  } catch { /* the banner just goes without the exchange */ }
  await postMarker(
    ctx,
    sessionKey,
    buildBackOnBranchMarker({ projectPath: tree.projectPath, topic: getSessionTopic(sessionKey), jsonl }),
    { claudeSessionId: carry.sessionId, projectPath: tree.projectPath, lineCount: countJsonlLines(file) },
  );
  await ctx.answerCallbackQuery({ text: 'Back on that branch.' });
}

async function onBranch(
  ctx: Context,
  sessionKey: string,
  tree: ForkTree,
  node: ForkNode,
  here: string | undefined,
): Promise<void> {
  if (await refuseWhileBusy(ctx, sessionKey)) return;
  // The topic of the branch this point is on: the chat's own, when the chat
  // is on it, else whichever history last had one of its transcripts open.
  const owners = findHistoryOwners(node.sessionIds, BOT_ID);
  const latest = [...owners.values()].flat()
    .sort((a, b) => b.entry.lastActivity.localeCompare(a.entry.lastActivity))[0];
  const topic = here && node.sessionIds.includes(here) ? getSessionTopic(sessionKey) : latest?.entry.topic;

  if (!(await branchFrom(ctx, sessionKey, tree, node, undefined, topic))) {
    await ctx.answerCallbackQuery({ text: "That point's transcript is gone from disk." });
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Branched.' });
}

/**
 * Start a conversation in this chat from the transcript cut at `node`: a fork,
 * loaded straight away. From another bot's branch it is named as that bot's,
 * so the banner says where it came from. False if the transcript is gone.
 */
async function branchFrom(
  ctx: Context,
  sessionKey: string,
  tree: ForkTree,
  node: ForkNode,
  owner?: HistoryOwner,
  topic: string | undefined = owner?.entry.topic,
): Promise<boolean> {
  const jsonl = transcriptUpTo(tree, node);
  if (!jsonl) return false;

  const fromOtherBot = owner && owner.botId !== BOT_ID;
  const fork: PendingFork = {
    fromBotName: fromOtherBot ? (findBotById(owner.botId)?.name ?? 'another bot') : config.BOT_NAME,
    fromBotId: fromOtherBot ? owner.botId : BOT_ID,
    fromChatId: ctx.chat?.id,
    projectPath: tree.projectPath,
    jsonl,
    topic,
    assistantPreview: lastAssistantTurnText(jsonl)?.substring(0, 200),
    createdAt: new Date().toISOString(),
  };
  await loadFork(ctx, sessionKey, fork, { above: LEFT_ABOVE });
  return true;
}
