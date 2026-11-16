/**
 * /project and the inline project browser.
 *
 * Owns the paginated directory-browser state, the favorites screen, and the
 * switching logic that rewires a session to a new working directory.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { clearConversation } from '../../../providers/provider-router.js';
import { prewarmClaude } from '../../../claude/prewarm.js';
import { projectFavorites } from '../../../providers/project-favorites.js';
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { replyFormatted, editCallbackMessage } from '../../../telegram/send.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../../../utils/workspace-guard.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { sendForceReplyPrompt } from '../../../telegram/force-reply-tracker.js';
import {
  parseCallback,
  projectStatusSuffix,
  resumeCommandMessage,
  withBackToPrevious,
} from './shared.js';
import { clearTopic } from './topic.js';

const PROJECT_BROWSER_PAGE_SIZE = 8;

type ProjectBrowserState = {
  root: string;
  current: string;
  page: number;
};

const projectBrowserState = new Map<string, ProjectBrowserState>();

const PROJECT_BROWSER_TTL_MS = 30 * 60 * 1000; // 30 minutes
const projectBrowserTimestamps = new Map<string, number>();

// Drop browser state the user abandoned. .unref() so it doesn't hold the
// process open at shutdown.
const projectBrowserCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of projectBrowserTimestamps.entries()) {
    if (now - timestamp > PROJECT_BROWSER_TTL_MS) {
      projectBrowserState.delete(key);
      projectBrowserTimestamps.delete(key);
      console.log(`[cleanup] Removed stale projectBrowserState for ${key}`);
    }
  }
}, 60_000);
projectBrowserCleanup.unref();


async function selectProjectFromCallback(ctx: Context, sessionKey: string, projectPath: string): Promise<void> {
  sessionManager.setWorkingDirectory(sessionKey, projectPath);
  clearConversation(sessionKey);
  clearTopic(sessionKey);

  const state = getProjectState(sessionKey);
  state.current = projectPath;
  state.page = 0;

  const newConv = sessionManager.getSession(sessionKey)?.conversationId;
  const back = withBackToPrevious(
    projectOpenedMessage('✅ Project: ', path.basename(projectPath), sessionKey),
    sessionKey,
    newConv,
  );

  await editCallbackMessage(ctx, back.text, back.options);

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyFormatted(ctx, resumeCommandMessage(s.claudeSessionId));
  }
  void prewarmClaude(ctx, sessionKey);
}

/** "<lead><name>", the chat-now line and the project status block. */
function projectOpenedMessage(lead: string, name: string, sessionKey: string): EntityMessage {
  return new EntityText()
    .add(lead).bold(name)
    .add('\n\nYou can now chat with Claude about this project!')
    .append(projectStatusSuffix(sessionKey))
    .build();
}

export async function handleProjectCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'project:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const state = getProjectState(sessionKey);
  const action = data.split(':')[1] || '';

  if (action === 'manual') {
    await ctx.answerCallbackQuery();
    await sendProjectManualPrompt(ctx);
    return;
  }

  if (action === 'favorites') {
    await ctx.answerCallbackQuery();
    await sendFavoritesScreen(ctx, sessionKey, true);
    return;
  }

  if (action === 'browse') {
    syncProjectStateToSession(sessionKey);
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'fav-add-here') {
    const added = projectFavorites.add(sessionKey, state.current);
    await ctx.answerCallbackQuery({ text: added ? '⭐ Added to favorites' : 'Already a favorite' });
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'fav-del-here') {
    const removed = projectFavorites.remove(sessionKey, state.current);
    await ctx.answerCallbackQuery({ text: removed ? 'Removed from favorites' : 'Not in favorites' });
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'fav-add-current') {
    const session = sessionManager.getSession(sessionKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'No current project' });
      return;
    }
    const added = projectFavorites.add(sessionKey, session.workingDirectory);
    await ctx.answerCallbackQuery({ text: added ? '⭐ Added to favorites' : 'Already a favorite' });
    await sendFavoritesScreen(ctx, sessionKey, true);
    return;
  }

  if (action === 'fav-use') {
    const indexPart = data.split(':')[2];
    const index = Number.parseInt(indexPart || '', 10);
    if (Number.isNaN(index)) {
      await ctx.answerCallbackQuery({ text: 'Invalid selection' });
      return;
    }
    const favorites = projectFavorites.list(sessionKey);
    const fav = favorites[index];
    if (!fav) {
      await ctx.answerCallbackQuery({ text: 'Selection expired' });
      await sendFavoritesScreen(ctx, sessionKey, true);
      return;
    }
    if (!fs.existsSync(fav.path) || !fs.statSync(fav.path).isDirectory()) {
      await ctx.answerCallbackQuery({ text: 'Path no longer exists', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Project set' });
    await selectProjectFromCallback(ctx, sessionKey, fav.path);
    return;
  }

  if (action === 'fav-del') {
    const indexPart = data.split(':')[2];
    const index = Number.parseInt(indexPart || '', 10);
    if (Number.isNaN(index)) {
      await ctx.answerCallbackQuery({ text: 'Invalid selection' });
      return;
    }
    const favorites = projectFavorites.list(sessionKey);
    const fav = favorites[index];
    if (!fav) {
      await ctx.answerCallbackQuery({ text: 'Selection expired' });
      await sendFavoritesScreen(ctx, sessionKey, true);
      return;
    }
    projectFavorites.remove(sessionKey, fav.path);
    await ctx.answerCallbackQuery({ text: 'Removed' });
    await sendFavoritesScreen(ctx, sessionKey, true);
    return;
  }

  if (action === 'use') {
    await ctx.answerCallbackQuery({ text: 'Project set' });
    await selectProjectFromCallback(ctx, sessionKey, state.current);
    return;
  }

  if (action === 'up') {
    const parent = path.dirname(state.current);
    if (isWithinRoot(state.root, parent)) {
      state.current = parent;
      state.page = 0;
    }
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'page') {
    const direction = data.split(':')[2];
    if (direction === 'next') state.page += 1;
    if (direction === 'prev') state.page = Math.max(0, state.page - 1);
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'refresh') {
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'open') {
    const indexPart = data.split(':')[2];
    const index = Number.parseInt(indexPart || '', 10);
    if (Number.isNaN(index)) {
      await ctx.answerCallbackQuery({ text: 'Invalid selection' });
      return;
    }
    const entries = listDirectories(state.current);
    const selected = entries[index];
    if (!selected) {
      await ctx.answerCallbackQuery({ text: 'Selection expired' });
      await sendProjectBrowser(ctx, sessionKey, state, true);
      return;
    }
    const nextPath = path.join(state.current, selected);
    // Resolve symlinks before checking boundaries
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(nextPath);
    } catch {
      await ctx.answerCallbackQuery({ text: 'Path not accessible' });
      return;
    }
    if (!isWithinRoot(state.root, resolvedPath)) {
      await ctx.answerCallbackQuery({ text: 'Outside workspace' });
      return;
    }
    state.current = resolvedPath;
    state.page = 0;
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }
}

function getProjectRoot(): string {
  return getWorkspaceRoot();
}

// Use shared isPathWithinRoot from workspace-guard for symlink-safe path validation
const isWithinRoot = isPathWithinRoot;

function listDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function shortenName(name: string, maxLength: number = 24): string {
  if (name.length <= maxLength) return name;
  return `${name.slice(0, maxLength - 1)}…`;
}

function buildProjectBrowserText(state: ProjectBrowserState, totalDirs: number, totalPages: number): EntityMessage {
  const pageNumber = totalPages === 0 ? 1 : state.page + 1;

  return new EntityText()
    .add('📁 ').bold('Project Browser')
    .add('\n\n').bold('Current:').add(' ').code(state.current)
    .newline().bold('Folders:').add(` ${totalDirs}`)
    .newline().bold('Page:').add(` ${pageNumber}/${Math.max(totalPages, 1)}`)
    .add('\n\nSelect a folder below, or use the current folder.')
    .build();
}

function buildProjectBrowserKeyboard(state: ProjectBrowserState, entries: string[], totalPages: number, sessionKey: string): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const rows: { text: string; callback_data: string }[][] = [];
  const pageOffset = state.page * PROJECT_BROWSER_PAGE_SIZE;

  for (let i = 0; i < entries.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    const first = entries[i];
    const second = entries[i + 1];

    if (first) {
      const index = pageOffset + i;
      row.push({ text: `📁 ${shortenName(first)}`, callback_data: `project:open:${index}` });
    }
    if (second) {
      const index = pageOffset + i + 1;
      row.push({ text: `📁 ${shortenName(second)}`, callback_data: `project:open:${index}` });
    }
    if (row.length > 0) rows.push(row);
  }

  const navRow: { text: string; callback_data: string }[] = [];
  if (state.current !== state.root) {
    navRow.push({ text: '⬆️ Up', callback_data: 'project:up' });
  }
  navRow.push({ text: '✅ Use this folder', callback_data: 'project:use' });
  const isFav = projectFavorites.has(sessionKey, state.current);
  navRow.push({
    text: isFav ? '★ Unfavorite' : '⭐ Favorite',
    callback_data: isFav ? 'project:fav-del-here' : 'project:fav-add-here',
  });
  rows.push(navRow);

  const utilRow: { text: string; callback_data: string }[] = [
    { text: '⭐ Favorites', callback_data: 'project:favorites' },
    { text: '✍️ Enter path', callback_data: 'project:manual' },
  ];
  rows.push(utilRow);

  const pageRow: { text: string; callback_data: string }[] = [];
  if (state.page > 0) {
    pageRow.push({ text: '◀️ Prev', callback_data: 'project:page:prev' });
  }
  if (state.page < totalPages - 1) {
    pageRow.push({ text: 'Next ▶️', callback_data: 'project:page:next' });
  }
  if (pageRow.length > 0) {
    rows.push(pageRow);
  }

  rows.push([{ text: '🔄 Refresh', callback_data: 'project:refresh' }]);

  return { inline_keyboard: rows };
}

async function sendProjectBrowser(ctx: Context, sessionKey: string, state: ProjectBrowserState, edit: boolean): Promise<void> {
  const allEntries = listDirectories(state.current);
  const totalPages = Math.max(1, Math.ceil(allEntries.length / PROJECT_BROWSER_PAGE_SIZE));
  const page = Math.min(Math.max(state.page, 0), totalPages - 1);
  state.page = page;

  const pageEntries = allEntries.slice(page * PROJECT_BROWSER_PAGE_SIZE, (page + 1) * PROJECT_BROWSER_PAGE_SIZE);
  const text = buildProjectBrowserText(state, allEntries.length, totalPages);
  const replyMarkup = buildProjectBrowserKeyboard(state, pageEntries, totalPages, sessionKey);

  if (edit) {
    try {
      await editCallbackMessage(ctx, text, { reply_markup: replyMarkup });
      return;
    } catch {
      // fall through to send new message
    }
  }

  await replyFormatted(ctx, text, { reply_markup: replyMarkup });
}

const FAVORITES_DISPLAY_MAX = 12;

function buildFavoritesScreen(sessionKey: string): { text: EntityMessage; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  const favorites = projectFavorites.list(sessionKey).slice(0, FAVORITES_DISPLAY_MAX);
  const session = sessionManager.getSession(sessionKey);
  const currentPath = session?.workingDirectory;
  const currentIsFav = currentPath ? projectFavorites.has(sessionKey, currentPath) : false;

  const text = new EntityText().add('⭐ ').bold('Project Favorites');
  if (currentPath) {
    text.add('\n\n').bold('Current:').add(' ').code(currentPath);
  }
  text.add('\n\n').italic(
    favorites.length === 0
      ? 'No favorites yet. Browse the workspace or enter a path, then tap ⭐ to save it here.'
      : 'Pick a favorite, or use the buttons below.',
  );

  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < favorites.length; i++) {
    const fav = favorites[i];
    const name = path.basename(fav.path) || fav.path;
    rows.push([
      { text: `📁 ${shortenName(name, 28)}`, callback_data: `project:fav-use:${i}` },
      { text: '🗑️', callback_data: `project:fav-del:${i}` },
    ]);
  }

  const actionRow: { text: string; callback_data: string }[] = [];
  if (currentPath && !currentIsFav) {
    actionRow.push({ text: '⭐ Add current', callback_data: 'project:fav-add-current' });
  }
  actionRow.push({ text: '🗂️ Browse', callback_data: 'project:browse' });
  actionRow.push({ text: '✍️ Enter path', callback_data: 'project:manual' });
  rows.push(actionRow);

  return { text: text.build(), reply_markup: { inline_keyboard: rows } };
}

async function sendFavoritesScreen(ctx: Context, sessionKey: string, edit: boolean): Promise<void> {
  const { text, reply_markup } = buildFavoritesScreen(sessionKey);
  if (edit) {
    try {
      await editCallbackMessage(ctx, text, { reply_markup });
      return;
    } catch {
      // fall through
    }
  }
  await replyFormatted(ctx, text, { reply_markup });
}

async function sendProjectManualPrompt(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const session = sessionManager.getSession(sessionKey);
  const prompt = new EntityText().add('📁 ').bold('Set Project Directory');
  if (session) {
    prompt.add('\n\n').italic(`Current: ${path.basename(session.workingDirectory)}`);
  }
  prompt.add('\n\n👇 ').italic('Enter the path below:');

  await sendForceReplyPrompt(ctx, 'project', prompt.build(), '/home/user/projects/myapp');
}

function getProjectState(sessionKey: string): ProjectBrowserState {
  const root = getProjectRoot();
  const existing = projectBrowserState.get(sessionKey);
  if (existing && existing.root === root) {
    if (!isWithinRoot(root, existing.current)) {
      existing.current = root;
      existing.page = 0;
    }
    // Refresh timestamp on access to keep active sessions alive
    projectBrowserTimestamps.set(sessionKey, Date.now());
    return existing;
  }

  const session = sessionManager.getSession(sessionKey);
  let initial = root;
  if (session && isWithinRoot(root, session.workingDirectory)) {
    initial = session.workingDirectory;
  }

  const state: ProjectBrowserState = {
    root,
    current: path.resolve(initial),
    page: 0,
  };
  projectBrowserState.set(sessionKey, state);
  projectBrowserTimestamps.set(sessionKey, Date.now());
  return state;
}

/**
 * Reset the browser to start at the session's current working directory.
 * Called when the user enters the browser fresh (e.g. via the Favorites
 * screen's "Browse" button), so MCP-driven project switches are reflected.
 * Not called on Up/Refresh/Page/Open — those preserve the user's navigation.
 */
function syncProjectStateToSession(sessionKey: string): void {
  const state = getProjectState(sessionKey);
  const session = sessionManager.getSession(sessionKey);
  if (session && isWithinRoot(state.root, session.workingDirectory)) {
    state.current = session.workingDirectory;
    state.page = 0;
  }
}

export async function handleProject(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  // No args - show favorites screen (falls through to browser if user taps Browse)
  if (!args) {
    await sendFavoritesScreen(ctx, sessionKey, false);
    return;
  }

  let projectPath: string;
  const workspaceRoot = getWorkspaceRoot();

  if (args.startsWith('/') || args.startsWith('~')) {
    // Absolute/home-relative paths are allowed to escape the workspace root —
    // the user has explicitly typed a full path.
    projectPath = args;
    if (projectPath.startsWith('~')) {
      projectPath = path.join(process.env.HOME || '', projectPath.slice(1));
    }
    projectPath = path.resolve(projectPath);
  } else {
    projectPath = path.join(workspaceRoot, args);
  }

  if (!fs.existsSync(projectPath)) {
    await replyFormatted(
      ctx,
      new EntityText()
        .add(`📁 There's no project at `).code(projectPath).add('.\n\nAsk Claude to create it from the project you\'re in, or run ')
        .code(`mkdir ${projectPath}`)
        .add(' and open it with ').code(`/project ${args}`).add('.')
        .build(),
    );
    return;
  }

  if (!fs.statSync(projectPath).isDirectory()) {
    await replyFormatted(ctx, new EntityText().add('❌ Path is not a directory: ').code(projectPath).build());
    return;
  }

  sessionManager.setWorkingDirectory(sessionKey, projectPath);
  clearConversation(sessionKey);
  clearTopic(sessionKey);

  const newConv = sessionManager.getSession(sessionKey)?.conversationId;
  const back = withBackToPrevious(projectOpenedMessage('✅ Project: ', args, sessionKey), sessionKey, newConv);
  await replyFormatted(ctx, back.text, back.options);

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyFormatted(ctx, resumeCommandMessage(s.claudeSessionId));
  }
  void prewarmClaude(ctx, sessionKey);
}
