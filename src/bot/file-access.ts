/**
 * Which files may be sent out of the machine, by `/file` from chat and by
 * claude's send-file tool.
 *
 * It used to accept any path under WORKSPACE_DIR, which defaults to $HOME.
 * On a shared bot that let any guest fetch `~/.claude/.credentials.json` or
 * `~/.ssh/id_rsa`. Two rules now:
 *
 * - The scope guard's credential/bot-state denylist applies to everyone,
 *   admins included. An admin who wants their own SSH key has a shell; a chat
 *   command that sends one is only ever a mistake or someone else's request.
 * - Guests are confined to the chat's project directory. Admins keep the
 *   whole workspace, since they already choose which project a chat is in.
 *
 * Containment is judged on the real path, so a symlink in the project that
 * points at `~/.ssh` is followed before anything is decided. The denylist is
 * checked on both the typed path and the real one.
 */

import type { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSensitivePath } from '../claude/scope-guard.js';
import { config } from '../config.js';
import { isAdmin } from '../utils/admins.js';
import { getWorkspaceRoot } from '../utils/workspace-guard.js';
import { EntityText } from '../telegram/entities.js';
import { replyFormatted } from '../telegram/send.js';

export type ShareableRefusal = 'sensitive' | 'outside-root' | 'not-found' | 'directory';

export type ShareablePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: ShareableRefusal };

/** Expand `~`, then resolve against `cwd` unless already absolute. */
function toAbsolute(raw: string, cwd: string): string {
  let value = raw.trim();
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Decide whether `raw` names a file that may leave the machine.
 *
 * Containment is checked before existence, so someone confined to a project
 * can't use the answers to probe what exists outside it.
 */
export function resolveShareablePath(raw: string, opts: { cwd: string; root: string }): ShareablePathResult {
  const lexical = toAbsolute(raw, opts.cwd);
  if (isSensitivePath(lexical)) return { ok: false, reason: 'sensitive' };

  let real: string | undefined;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    real = undefined;
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(opts.root);
  } catch {
    return { ok: false, reason: 'outside-root' };
  }

  if (!within(realRoot, real ?? lexical)) return { ok: false, reason: 'outside-root' };
  if (real === undefined) return { ok: false, reason: 'not-found' };
  if (isSensitivePath(real)) return { ok: false, reason: 'sensitive' };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (stat.isDirectory()) return { ok: false, reason: 'directory' };

  return { ok: true, path: real };
}

/**
 * The root a user's paths are confined to: the whole workspace for an admin,
 * the chat's project for anyone else.
 */
export function shareRootFor(userId: number | undefined, projectDir: string): string {
  return isAdmin(userId) ? getWorkspaceRoot() : projectDir;
}

/**
 * Where claude's send-file tool may read from: the share root of the user whose
 * message the turn answers (see {@link shareRootFor}), and failing that /tmp,
 * where claude drops files it made to send. A self-started turn has no user and
 * is held to the project. A refusal names the root the caller is confined to,
 * so claude can tell the user why.
 */
export function resolveSendablePath(
  raw: string,
  cwd: string,
  userId: number | undefined,
): { ok: true; path: string } | { ok: false; reason: ShareableRefusal; root: string } {
  const root = shareRootFor(userId, cwd);
  const inRoot = resolveShareablePath(raw, { cwd, root });
  if (inRoot.ok) return inRoot;
  if (inRoot.reason !== 'outside-root') return { ...inRoot, root };
  const inTmp = resolveShareablePath(raw, { cwd, root: '/tmp' });
  return inTmp.ok ? inTmp : { ...inTmp, root };
}

/** What the tool tells claude for each refusal. */
export function sendableRefusalMessage(reason: ShareableRefusal, raw: string, root: string): string {
  const shown = path.basename(raw.trim()) || raw.trim();
  switch (reason) {
    case 'sensitive':
      return `Error: ${shown} is a credential or bot-state path (SSH, cloud and Claude credentials, .env files and the like). Such files are never sent. Access denied.`;
    case 'outside-root':
      return `Error: File path must be within ${root} or /tmp. Access denied.`;
    case 'not-found':
      return `Error: File not found: ${shown}`;
    case 'directory':
      return `Error: Path is a directory, not a file: ${shown}`;
  }
}

/**
 * Resolve a path typed in chat against the session's project, reporting any
 * refusal to the chat. Returns the real path to send, or null.
 */
export async function resolveShareableFile(
  ctx: Context,
  projectDir: string,
  raw: string,
): Promise<string | null> {
  const root = shareRootFor(ctx.from?.id, projectDir);
  const result = resolveShareablePath(raw, { cwd: projectDir, root });
  if (result.ok) return result.path;

  const shown = raw.trim();
  switch (result.reason) {
    case 'sensitive':
      console.log(`[file-access] REFUSED credential path for user:${ctx.from?.id ?? 'unknown'}`);
      await replyFormatted(ctx, new EntityText()
        .add('🔒 ').code(shown)
        .add(' is a credential or bot-state path (SSH, cloud and Claude credentials, .env files and the like), and those are never sent from chat.')
        .build());
      break;
    case 'outside-root':
      await replyFormatted(ctx, isAdmin(ctx.from?.id)
        ? new EntityText().add('❌ File path must be within workspace root: ').code(root).build()
        : new EntityText().add("❌ You can only get files from this chat's project: ").code(root).build());
      break;
    case 'not-found':
      await replyFormatted(ctx, new EntityText().add('❌ File not found: ').code(shown).build());
      break;
    case 'directory':
      await replyFormatted(ctx, new EntityText().add("❌ That's a directory, not a file: ").code(shown).build());
      break;
  }
  return null;
}
