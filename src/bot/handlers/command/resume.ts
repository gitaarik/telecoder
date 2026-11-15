/**
 * /resume, the way Claude Code's own /resume works: every conversation Claude
 * Code has on disk for this project, newest first — from a terminal, another
 * bot or this chat alike — with a toggle to every project, `/resume <words>`
 * to search them, and `/resume <session id>` to open one directly.
 *
 * Picking one that another Claude process still has open starts a copy, as
 * Claude Code does, so two writers never append to one transcript. Picking
 * one another backend wrote (DeepSeek via CCR, or Claude while on CCR) goes on
 * as a new session that starts with a recap: the old one's thinking blocks
 * can't be replayed across backends.
 *
 * The `resume:<conversationId>` callback of the older, history-based picker is
 * still what the ↩️ Back button sends; session.ts handles it.
 */

import { Context } from 'grammy';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BOT_ID } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { sessionHistory, allHistoryOwners, type HistoryOwner } from '../../../claude/session-history.js';
import { detectOwnerProvider, rewriteJsonlSessionId } from '../../../claude/session-jsonl.js';
import {
  findSession,
  isSessionId,
  isSessionOpenElsewhere,
  listSessions,
  matchesQuery,
  type ScannedSession,
} from '../../../claude/session-scan.js';
import { setPendingCarryOver } from '../../../claude/carry-over.js';
import { isProcessing } from '../../../claude/request-queue.js';
import { clearConversation, getActiveProviderName } from '../../../providers/provider-router.js';
import { buildCarryOverPreamble } from '../../../providers/provider-switch.js';
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { buildLetteredKeyboard, letteredOptionLines } from '../../../telegram/lettered-options.js';
import { cutLabel, promptLabel } from '../../../telegram/prompt-label.js';
import { editCallbackMessage, replyFormatted } from '../../../telegram/send.js';
import { taskListDisplay } from '../../../telegram/task-list.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { formatTimeAgo, parseCallback, projectStatusSuffix, replyMd, resumeCommandMessage } from './shared.js';
import { restoreTopic } from './topic.js';
import { sendView, type Keyboard, type View } from '../view.js';
import { resumeHistoryEntry, sendRecapHint } from './session.js';

/** Sessions per page: letters A–H, short enough to read on a phone. */
const PAGE_SIZE = 8;
const MAX_NAME_CHARS = 90;

type Scope = 'p' | 'a';

// ── The picker ───────────────────────────────────────────────────────────

/** One line of the picker. */
export interface PickerEntry {
  sessionId: string;
  name: string;
  mtimeMs: number;
  /** Short notes after the age: `current`, `open elsewhere`, `via CCR`. */
  marks: string[];
}

export interface PickerPage {
  heading: string;
  entries: PickerEntry[];
  /** Page number and scope for the ◀ ▶ buttons; absent for a search. */
  paging?: { scope: Scope; page: number; more: boolean };
  /** The button that switches between this project and every project. */
  toggle?: { label: string; scope: Scope };
  /** A line under the list. */
  footer?: string;
}

export function buildResumePicker(p: PickerPage): View {
  const options = p.entries.map((e) => ({
    label: e.name,
    description: [formatTimeAgo(new Date(e.mtimeMs)), ...e.marks].join(' · '),
  }));

  const text = new EntityText().add('📜 ').bold(p.heading).add('\n\n').add(letteredOptionLines(options).join('\n'));
  if (p.paging && (p.paging.page > 0 || p.paging.more)) text.add(`\n\nPage ${p.paging.page + 1}`);
  if (p.footer) text.add('\n\n').italic(p.footer);

  const keyboard: Keyboard = buildLetteredKeyboard(
    p.entries.map((e) => ({ label: e.name, callbackData: `resume:s:${e.sessionId}` })),
  );
  const nav: Keyboard[number] = [];
  if (p.paging && p.paging.page > 0) {
    nav.push({ text: '◀ Newer', callback_data: `resume:l:${p.paging.scope}:${p.paging.page - 1}` });
  }
  if (p.paging?.more) {
    nav.push({ text: 'Older ▶', callback_data: `resume:l:${p.paging.scope}:${p.paging.page + 1}` });
  }
  if (nav.length) keyboard.push(nav);
  if (p.toggle) keyboard.push([{ text: p.toggle.label, callback_data: `resume:l:${p.toggle.scope}:0` }]);

  return { text: text.build(), keyboard };
}

/** The newest TeleCoder topic any chat gave each conversation. */
function topicsById(owners: Map<string, HistoryOwner[]>): Map<string, string> {
  const topics = new Map<string, string>();
  for (const [id, list] of owners) {
    const latest = list
      .filter((o) => o.entry.topic)
      .sort((a, b) => b.entry.lastActivity.localeCompare(a.entry.lastActivity))[0];
    if (latest?.entry.topic) topics.set(id, latest.entry.topic);
  }
  return topics;
}

/** What a session is called: a /rename, then a chat's topic, then Claude Code's title, then the first prompt. */
function titleOf(s: ScannedSession, topics: Map<string, string>): string {
  const firstPrompt = s.firstPrompt ? promptLabel(s.firstPrompt) : undefined;
  return s.customTitle ?? topics.get(s.sessionId) ?? s.aiTitle ?? firstPrompt ?? 'Untitled';
}

function isForeignModel(model: string | undefined): boolean {
  return model !== undefined && !model.startsWith('claude-');
}

function toEntry(
  s: ScannedSession,
  topics: Map<string, string>,
  withProject: boolean,
  currentId: string | undefined,
): PickerEntry {
  const title = titleOf(s, topics);
  const name = withProject ? `${path.basename(s.projectPath)} · ${title}` : title;
  const marks: string[] = [];
  if (s.sessionId === currentId) marks.push('current');
  else if (isSessionOpenElsewhere(s.sessionId)) marks.push('open elsewhere');
  if (isForeignModel(s.lastModel)) marks.push('via CCR');
  return { sessionId: s.sessionId, name: cutLabel(name, MAX_NAME_CHARS), mtimeMs: s.mtimeMs, marks };
}

/** The picker for `scope` at `page`, or undefined when there is nothing to list. */
function listView(sessionKey: string, scope: Scope, page: number): View | undefined {
  const session = sessionManager.getSession(sessionKey);
  const projectPath = scope === 'p' ? session?.workingDirectory : undefined;
  const owners = allHistoryOwners(BOT_ID);
  const { sessions, more } = listSessions({
    projectPath,
    knownIds: new Set(owners.keys()),
    offset: page * PAGE_SIZE,
    limit: PAGE_SIZE,
  });
  if (sessions.length === 0 && page === 0) return undefined;

  const topics = topicsById(owners);
  const projectName = projectPath ? path.basename(projectPath) : undefined;
  return buildResumePicker({
    heading: projectName ? `Sessions in ${projectName}` : 'Sessions in all projects',
    entries: sessions.map((s) => toEntry(s, topics, !projectPath, session?.claudeSessionId)),
    paging: { scope: projectPath ? 'p' : 'a', page, more },
    toggle: projectPath
      ? { label: '🌐 All projects', scope: 'a' }
      : session ? { label: `📁 Only ${path.basename(session.workingDirectory)}`, scope: 'p' } : undefined,
  });
}

// ── /resume ──────────────────────────────────────────────────────────────

export async function handleResume(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  // After a restart the chat's project is only on disk; it decides the scope.
  const { session } = sessionManager.getOrRestoreSession(sessionKey);
  const arg = (ctx.message?.text ?? '').split(' ').slice(1).join(' ').trim();

  if (!arg) {
    const view = listView(sessionKey, session ? 'p' : 'a', 0) ?? (session ? listView(sessionKey, 'a', 0) : undefined);
    if (!view) {
      await replyMd(ctx, 'ℹ️ No conversations to resume yet.\n\nUse `/project <name>` to start one.');
      return;
    }
    await sendView(ctx, view, 'reply');
    return;
  }

  if (isSessionId(arg)) {
    const found = findSession(arg, session?.workingDirectory);
    if (!found) {
      await replyMd(ctx, `ℹ️ No session \`${arg}\` on this machine.`);
      return;
    }
    await resumeScanned(ctx, sessionKey, found);
    return;
  }

  await searchSessions(ctx, sessionKey, arg);
}

/**
 * `/resume <words>`: this project's sessions whose title or first prompt has
 * every word, or every project's when none here do. One match opens straight
 * away, as `claude --resume <name>` does.
 */
async function searchSessions(ctx: Context, sessionKey: string, query: string): Promise<void> {
  const session = sessionManager.getSession(sessionKey);
  const owners = allHistoryOwners(BOT_ID);
  const knownIds = new Set(owners.keys());
  const topics = topicsById(owners);
  const match = (s: ScannedSession) => matchesQuery(s, query, topics.get(s.sessionId));

  const search = (projectPath?: string) => listSessions({ projectPath, knownIds, match, offset: 0, limit: PAGE_SIZE });
  let projectPath = session?.workingDirectory;
  let found = projectPath ? search(projectPath) : { sessions: [], more: false };
  if (found.sessions.length === 0) {
    projectPath = undefined;
    found = search();
  }

  if (found.sessions.length === 0) {
    await replyFormatted(ctx, new EntityText().add('ℹ️ No session matches “').add(query).add('”.').build());
    return;
  }
  if (found.sessions.length === 1) {
    await resumeScanned(ctx, sessionKey, found.sessions[0]!);
    return;
  }

  await sendView(ctx, buildResumePicker({
    heading: `Sessions matching “${query}”` + (projectPath ? ` in ${path.basename(projectPath)}` : ''),
    entries: found.sessions.map((s) => toEntry(s, topics, !projectPath, session?.claudeSessionId)),
    footer: found.more ? `Showing the newest ${PAGE_SIZE}. Add words to narrow it down.` : undefined,
  }), 'reply');
}

export async function handleResumeCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'resume:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const list = /^resume:l:([pa]):(\d+)$/.exec(data);
  if (list) {
    const view = listView(sessionKey, list[1] as Scope, Number(list[2]));
    if (!view) {
      await ctx.answerCallbackQuery({ text: 'Nothing more to list.' });
      return;
    }
    await sendView(ctx, view, 'edit');
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith('resume:s:')) {
    const id = data.slice('resume:s:'.length);
    const found = findSession(id, sessionManager.getSession(sessionKey)?.workingDirectory);
    if (!found) {
      await ctx.answerCallbackQuery({ text: "That session's transcript is gone from disk." });
      return;
    }
    await resumeScanned(ctx, sessionKey, found);
    return;
  }

  await resumeHistoryEntry(ctx, sessionKey, data.slice('resume:'.length));
}

// ── Opening one ──────────────────────────────────────────────────────────

const BACKEND_NAMES: Record<string, string> = { claude: 'Claude', ccr: 'CCR' };

/**
 * A copy of a transcript under a fresh id, for a session another process is
 * still writing to. A line it was halfway through writing is left out.
 */
function copyTranscript(s: ScannedSession): string | undefined {
  try {
    let raw = fs.readFileSync(s.file, 'utf-8');
    if (!raw.endsWith('\n')) raw = raw.slice(0, raw.lastIndexOf('\n') + 1);
    const newId = crypto.randomUUID();
    // Beside the original: Claude Code names the directory, and encodes more
    // of a path's characters than sessionJsonlPath does.
    const target = path.join(path.dirname(s.file), `${newId}.jsonl`);
    fs.writeFileSync(target, rewriteJsonlSessionId(raw, newId), { mode: 0o600 });
    return newId;
  } catch (err) {
    console.error('[Resume] Could not copy transcript:', err);
    return undefined;
  }
}

/** Answer a button tap, or reply to the command. */
async function tell(ctx: Context, text: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text, show_alert: text.length > 60 });
  else await ctx.reply(text);
}

async function resumeScanned(ctx: Context, sessionKey: string, s: ScannedSession): Promise<void> {
  const current = sessionManager.getSession(sessionKey);
  if (current?.claudeSessionId === s.sessionId) {
    await tell(ctx, "You're already in this conversation.");
    return;
  }
  if (isProcessing(sessionKey)) {
    await tell(ctx, 'A reply is still running here — wait for it to finish, or /cancel it, then try again.');
    return;
  }
  if (!fs.existsSync(s.projectPath)) {
    await tell(ctx, `That conversation ran in ${s.projectPath}, which no longer exists.`);
    return;
  }

  const notes: string[] = [];
  let sessionId = s.sessionId;
  if (isSessionOpenElsewhere(s.sessionId)) {
    const copyId = copyTranscript(s);
    if (!copyId) {
      await tell(ctx, 'That session is open in another Claude Code process, and copying it failed.');
      return;
    }
    // Claude Code's own wording for the same case.
    notes.push(`Session ${s.sessionId} is open in another Claude Code process, so this started a copy as ${copyId}. The original conversation is unchanged.`);
    sessionId = copyId;
  }

  // This chat's own entry brings back its conversation and topic; any other
  // chat's or bot's topic is the next best name for it.
  const own = sessionHistory.findByClaudeSessionId(sessionId).find((o) => o.sessionKey === sessionKey)?.entry;
  let topic: string | undefined;
  if (own) {
    sessionManager.resumeSession(sessionKey, own.conversationId);
    topic = own.topic;
  } else {
    if (current && current.workingDirectory === s.projectPath) sessionManager.startNewConversation(sessionKey);
    else sessionManager.setWorkingDirectory(sessionKey, s.projectPath);
    topic = topicsById(allHistoryOwners(BOT_ID)).get(s.sessionId);
  }
  topic ??= s.customTitle ?? s.aiTitle;

  const owner = own?.ownerProvider ?? detectOwnerProvider(s.file);
  sessionManager.setClaudeSessionId(sessionKey, sessionId, owner);
  // Drops the live process and in-memory state of the conversation this chat
  // was in, so the next turn resumes the one just picked. After
  // setClaudeSessionId, which it leaves alone.
  clearConversation(sessionKey);

  const provider = getActiveProviderName(sessionKey);
  let carriedOver = false;
  if (owner && owner !== provider) {
    const preamble = buildCarryOverPreamble(sessionKey);
    if (preamble) setPendingCarryOver(sessionKey, preamble);
    sessionManager.startNewConversation(sessionKey);
    carriedOver = true;
    notes.push(
      `This conversation ran on ${BACKEND_NAMES[owner] ?? owner} and this chat is on ${BACKEND_NAMES[provider] ?? provider}, ` +
      `which can't replay its thinking. It goes on as a new session that starts with a recap of the last exchanges. ` +
      `To continue it as it is, switch with /provider ${owner} and resume it again.`,
    );
  }

  restoreTopic(sessionKey, topic);

  const message = new EntityText()
    .add('✅ Resumed ').bold(topic ?? sessionId)
    .add('\n\nWorking directory: ').code(s.projectPath)
    .append(projectStatusSuffix(sessionKey));
  for (const note of notes) message.add('\n\n').italic(note);
  const text: EntityMessage = message.build();

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: 'Session resumed!' });
    await editCallbackMessage(ctx, text);
  } else {
    await replyFormatted(ctx, text);
  }
  if (carriedOver) return;

  await replyFormatted(ctx, resumeCommandMessage(sessionId));
  await taskListDisplay.showRestored(ctx.api, sessionKey, sessionId);
  await sendRecapHint(ctx, sessionKey);
}
