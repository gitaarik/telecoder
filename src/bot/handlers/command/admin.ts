/**
 * Bot lifecycle commands: /update, /botstatus, /version, /restartbot, /rebuildbot.
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
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { replyFormatted, replyParts } from '../../../telegram/send.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { botctlExists, PROJECT_ROOT, BOTCTL_PATH } from './shared.js';
import { handleContinue, handleClear } from './session.js';
import { handleResume } from './resume.js';
import {
  requestRestart,
  requestRestartAll,
  requestRestartAllWhenIdle,
  controlIdleRestart,
  requestSiblingRestart,
  launcherIsStale,
} from '../../../worker-restart.js';
import {
  isSystemdService,
  getSystemdUnit,
  getRestartBehaviour,
  willRestartOnRequestedExit,
  manualRestartCommand,
  RESTART_EXIT_CODE,
  type SystemdUnit,
} from '../../../utils/systemd.js';
import { launcherRestartHint } from '../../../utils/stale-launcher.js';
import { getServiceManager } from '../../../utils/exit-codes.js';
import { describeRunningBuild, getLatestBuild, getRunningBuild } from '../../../utils/build-info.js';
import { checkCode, checkRemote, describeCodeCheck, describeRemoteCheck } from '../../../utils/version-check.js';
import { isCheckout, detectPackageRunner, getInstalledVersion } from '../../../utils/install-mode.js';
import {
  compareInstalled,
  describeNpmCheck,
  getLatestVersion,
  installLatestGlobally,
  updateCommand,
} from '../../../utils/npm-version.js';

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
  // An npm install updates itself too; a checkout updates with git pull and
  // /rebuildbot, so there /update stays about Claude Code alone.
  if (!isCheckout()) {
    await offerPackageUpdate(ctx);
    return;
  }
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
  if (data === 'update:telecoder') {
    await updateTeleCoder(ctx);
    return;
  }
  if (data !== 'update:confirm') return;

  const chatId = ctx.chat?.id;
  const ack = await ctx.reply('⬆️ Updating Claude Code…');

  try {
    const raw = await runClaudeUpdate();
    const body = raw || 'Update finished — no output.';
    await replyParts(ctx, new EntityText().bold('⬆️ Claude Code Update').newline(2).pre(body).build());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const b = new EntityText().add('❌ Update failed:').newline(2).pre(message);
    if (/not found|enoent/i.test(message)) {
      b.newline(2)
        .add('The ')
        .code('claude')
        .add(' executable could not be found on PATH. Check ')
        .code('CLAUDE_EXECUTABLE_PATH')
        .add('.');
    } else if (/npm|installed via/i.test(message)) {
      b.newline(2).add('This install may be managed by npm — update it there instead.');
    }
    await replyParts(ctx, b.build());
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

/** The /update menu of a package install: TeleCoder itself, or Claude Code. */
async function offerPackageUpdate(ctx: Context): Promise<void> {
  const [claudeVersion, latest] = await Promise.all([getClaudeVersion(), getLatestVersion()]);
  const check = compareInstalled(getInstalledVersion(), latest);
  const runner = detectPackageRunner();

  const lines = [
    '⬆️ What should be updated?',
    '',
    `TeleCoder: ${describeNpmCheck(check, runner)}`,
    `Claude Code: ${claudeVersion ? `currently ${claudeVersion}` : 'version unknown'}`,
  ];
  // Only a global install can replace itself: npx and a local install are
  // updated from wherever they were started.
  const telecoderButton = runner === 'global'
    ? [{ text: '⬆️ TeleCoder', callback_data: 'update:telecoder' }]
    : [];
  await ctx.reply(lines.join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [...telecoderButton, { text: '⬆️ Claude Code', callback_data: 'update:confirm' }],
        [{ text: '❌ Cancel', callback_data: 'update:cancel' }],
      ],
    },
  });
}

/** `npm install -g telecoder@latest`, then say how to start running it. */
async function updateTeleCoder(ctx: Context): Promise<void> {
  const runner = detectPackageRunner();
  if (runner !== 'global') {
    await replyFormatted(
      ctx,
      new EntityText()
        .add('This TeleCoder was not installed with ')
        .code('npm install -g')
        .add(", so it can't replace itself. Update it with ")
        .code(updateCommand(runner))
        .add(' and restart it.')
        .build(),
    );
    return;
  }

  const chatId = ctx.chat?.id;
  const ack = await ctx.reply('⬆️ Updating TeleCoder…');
  try {
    const raw = await installLatestGlobally();
    // Read back from disk: npm replaced the package directory this runs from.
    const installed = getInstalledVersion();
    const b = new EntityText().bold('⬆️ TeleCoder Update').newline(2);
    if (raw) b.pre(raw.slice(-1500)).newline(2);
    b.add(installed ? `v${installed} is installed. ` : 'Installed. ')
      .add('It runs from the next restart: /restartbot.');
    await replyParts(ctx, b.build());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const b = new EntityText().add('❌ Update failed:').newline(2).pre(message.slice(-1500));
    if (/EACCES|permission denied/i.test(message)) {
      b.newline(2)
        .add("npm can't write to its global directory as this user. Run ")
        .code(updateCommand('global'))
        .add(' yourself (with the rights it needs), then /restartbot.');
    }
    await replyParts(ctx, b.build());
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
  const model = keyInfo ? getModel(keyInfo.sessionKey) : 'opus';
  const streaming = config.STREAMING_MODE || 'streaming';
  const pid = process.pid;
  const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1);

  // The uptime above is this worker's, and a worker that restarted an hour ago
  // says nothing about the process it restarted inside.
  const warning = await staleLauncherWarning();
  const build = describeRunningBuild();

  const msg = new EntityText().add('🟢 ').bold(`${config.BOT_NAME} is running`).newline(2);
  /** A `Label: value` line; every one but the last ends in a newline. */
  const field = (label: string, value: string) => msg.bold(`${label}:`).add(` ${value}`);
  field('Mode', mode).newline();
  if (build) field('Version', build).newline();
  field('Uptime', uptimeStr).newline();
  field('PID', String(pid)).newline();
  field('Memory', `${memMB} MB`).newline();
  field('Model', model).newline();
  field('Streaming', streaming);
  if (warning) msg.newline(2).add(warning);

  await replyFormatted(ctx, msg.build());
}

export async function handleVersion(ctx: Context): Promise<void> {
  if (!isCheckout()) {
    await handlePackageVersion(ctx);
    return;
  }
  const [code, remote, warning] = await Promise.all([
    checkCode(getRunningBuild(), getLatestBuild(), PROJECT_ROOT),
    checkRemote(PROJECT_ROOT),
    // A worker's stamp only speaks for that worker, not the launcher it runs in.
    staleLauncherWarning(),
  ]);

  const build = describeRunningBuild();
  const answer = [build && `Running: ${build}`, describeCodeCheck(code), describeRemoteCheck(remote)]
    .filter(Boolean)
    .join('\n');

  // Plain text: a commit subject goes out exactly as written.
  await ctx.reply(warning ? `${answer}\n\n${warning}` : answer);
}

/** /version for a package install: the installed version against npm's latest. */
async function handlePackageVersion(ctx: Context): Promise<void> {
  const installed = getInstalledVersion();
  const [latest, warning] = await Promise.all([getLatestVersion(), staleLauncherWarning()]);
  const answer = [
    `Running: TeleCoder v${installed ?? '?'}`,
    describeNpmCheck(compareInstalled(installed, latest), detectPackageRunner()),
  ].join('\n');
  await ctx.reply(warning ? `${answer}\n\n${warning}` : answer);
}

/**
 * How this process gets replaced when it stops: by systemd, by the botctl
 * script starting a successor (a checkout), or by whatever supervises a
 * package install bringing it back after it exits.
 */
type RestartPlan =
  | { kind: 'systemd'; unit: SystemdUnit }
  | { kind: 'botctl' }
  | { kind: 'exit' };

/**
 * Work out how to restart, without doing anything yet.
 *
 * Separate from executing it so a restart is never *announced* before it is
 * known to be possible. Announcing one that then fails is how the bot ends up
 * silently dead with a "restarting..." message as its last word.
 *
 * Returns an error message when there is no way to come back, in which case
 * the bot keeps running.
 */
async function planRestart(): Promise<{ plan: RestartPlan } | { error: EntityMessage }> {
  if (isSystemdService()) {
    // botctl is not an option here: it would be reaped with us (see
    // utils/systemd.ts). Exiting and letting systemd restart us is, but only
    // if the unit is set up to.
    const unit = getSystemdUnit();
    if (!unit) {
      return {
        error: new EntityText()
          .add('Running under systemd, but the unit name could not be read from ')
          .code('/proc/self/cgroup')
          .add('.')
          .newline(2)
          .add('Restart it by hand: ')
          .code('systemctl --user restart telecoder')
          .build(),
      };
    }

    const behaviour = await getRestartBehaviour(unit);
    if (behaviour === null) {
      return {
        error: new EntityText()
          .add('Running as ')
          .bold(unit.name)
          .add(', but ')
          .code('systemctl show')
          .add(' did not answer, so there is no way to confirm the bot would come back.')
          .newline(2)
          .add('Restart it by hand: ')
          .code(manualRestartCommand(unit))
          .build(),
      };
    }
    if (!willRestartOnRequestedExit(behaviour)) {
      return {
        error: new EntityText()
          .bold(unit.name)
          .add(' has ')
          .code(`Restart=${behaviour.policy}`)
          .add(', so systemd would not start the bot again.')
          .newline(2)
          .add('Set ')
          .code('Restart=always')
          .add(' in the unit, or restart by hand: ')
          .code(manualRestartCommand(unit))
          .build(),
      };
    }

    return { plan: { kind: 'systemd', unit } };
  }

  // A checkout under the launchd agent `telecoder service install
  // --from-checkout` writes takes this path too: botctl would start a second
  // copy beside the one launchd is about to bring back.
  if (!isCheckout() || getServiceManager() === 'launchd') {
    // A package install has no botctl. It expects a supervisor (a systemd or
    // launchd unit with Restart=always, pm2, ...) that starts it again when it
    // exits — and in a terminal there is none, so there it says so instead.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return {
        error: new EntityText()
          .add('This bot is running in a terminal, so nothing would start it again after it exits.')
          .newline(2)
          .add('Stop it there and run ')
          .code('telecoder start')
          .add(' again, or run it as a service so restarts work from chat.')
          .build(),
      };
    }
    return { plan: { kind: 'exit' } };
  }

  if (!botctlExists()) {
    return {
      error: new EntityText()
        .add('Bot control script not found.')
        .newline(2)
        .add('Expected at ')
        .code('scripts/telecoder-botctl.sh')
        .add('.')
        .build(),
    };
  }
  return { plan: { kind: 'botctl' } };
}

/**
 * Act on a plan from `planRestart`. The systemd path does not come back — the
 * process is on its way out by the time this returns.
 */
function executeRestart(plan: RestartPlan): void {
  if (plan.kind === 'exit') {
    // Same as the systemd path below: the exit is the restart, non-zero so a
    // supervisor that only restarts on failure acts on it too.
    console.log('[Restart] Exiting for the service manager to start the bot again');
    process.exitCode = RESTART_EXIT_CODE;
    process.kill(process.pid, 'SIGTERM');
    return;
  }
  if (plan.kind === 'systemd') {
    // The exit *is* the restart. Non-zero so both Restart=always and
    // Restart=on-failure act on it; SIGTERM rather than process.exit so the
    // normal graceful shutdown still runs.
    console.log(`[Restart] Exiting for systemd to restart ${plan.unit.name}`);
    process.exitCode = RESTART_EXIT_CODE;
    process.kill(process.pid, 'SIGTERM');
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
    console.error('[BotCtl] Failed to restart:', sanitizeError(error));
  }
}

type RestartScope = 'one' | 'all';

async function performRestart(ctx: Context, scope: RestartScope): Promise<void> {
  // Multi-instance mode (worker thread) — restart via launcher, not shell script
  if (!isMainThread) {
    // A restart can't make the launcher stale — only a build does that — but
    // it is the moment someone concludes everything is running current code.
    const warning = await staleLauncherWarning();
    const note = warning ? `\n\n${warning}` : '';

    if (scope === 'all') {
      if (config.AUTO_RESTORE_SESSION) {
        await ctx.reply(`🔁 Restarting all bot instances.\n\n⏳ Sessions will be restored automatically.${note}`);
      } else {
        await ctx.reply(`🔁 Restarting all bot instances.\n\n⏳ Please wait ~10 seconds.${note}`);
        await sendRestoreButtons(ctx);
      }
      // Marker writing for sibling bots happens in the launcher — it has the
      // tokens to derive each bot's marker path. We can't write them here.
      requestRestartAll(config.AUTO_RESTORE_SESSION);
      return;
    }

    if (config.AUTO_RESTORE_SESSION) {
      await ctx.reply(`🔁 Restarting this bot instance.\n\n⏳ Session will be restored automatically.${note}`);
      writeReloadMarker();
    } else {
      await ctx.reply(`🔁 Restarting this bot instance.\n\n⏳ Other bots will not be affected. Please wait ~10 seconds.${note}`);
      await sendRestoreButtons(ctx);
    }

    requestRestart();
    return;
  }

  // Single-instance mode — systemd restarts us, or botctl starts a successor
  const planned = await planRestart();
  if ('error' in planned) {
    await replyFormatted(ctx, new EntityText().add('❌ Cannot restart.').newline(2).append(planned.error).build());
    return;
  }

  if (config.AUTO_RESTORE_SESSION) {
    await ctx.reply('🔁 Restarting bot.\n\n⏳ Session will be restored automatically.');
    writeReloadMarker();
  } else {
    await replyFormatted(
      ctx,
      new EntityText()
        .add('🔁 Restarting bot.')
        .newline(2)
        .add('⏳ Please wait at least ')
        .bold('10-15 seconds')
        .add(' before checking status or resuming.')
        .build(),
    );
    await sendRestoreButtons(ctx);
  }

  executeRestart(planned.plan);
}

export async function handleRestartBot(ctx: Context): Promise<void> {
  const args = ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim();

  // Cross-bot restart: /restartbot <name> — direct, no menu
  if (args && !isMainThread && args.toLowerCase() !== 'all' && args.toLowerCase() !== 'one' && args.toLowerCase() !== 'this') {
    const result = await requestSiblingRestart(args, config.AUTO_RESTORE_SESSION);
    if (result.success) {
      await replyFormatted(
        ctx,
        new EntityText()
          .add('🔁 Restarting ')
          .bold(result.name ?? args)
          .add('... it should be back in ~10 seconds.')
          .build(),
      );
    } else {
      await replyFormatted(
        ctx,
        new EntityText()
          .add('❌ Could not restart ')
          .bold(args)
          .add(`: ${result.reason ?? 'unknown error'}`)
          .build(),
      );
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


type RebuildScope = 'one' | 'all' | 'idle';

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

/**
 * Said wherever someone is about to believe their code is now current: the
 * launcher is running what it loaded at startup, and neither a rebuild nor a
 * restart of the instances reaches it.
 *
 * Note what this does not claim — that the build in hand is the one that
 * changed the launcher. The fingerprint only knows the launcher differs from
 * the copy this process started with, which stays true for every later build
 * until someone restarts it.
 *
 * Empty whenever the launcher is current or can't be asked. Plain text, which
 * callers append as it is.
 */
async function staleLauncherWarning(): Promise<string> {
  if (!await launcherIsStale()) return '';
  return `⚠️ The launcher is still running the code it started with — a build since then replaced it `
    + `on disk, and restarting instances can't reload it. To pick that up, ${launcherRestartHint()}; `
    + `that drops every live session.`;
}

async function performRebuild(ctx: Context, scope: RebuildScope): Promise<void> {
  // Only a launcher can wait on other instances; checked before building, so
  // the answer isn't a build nobody restarts onto.
  if (scope === 'idle' && isMainThread) {
    await ctx.reply('⚠️ "When idle" restarts the instances of a multi-instance setup — this bot runs on its own. Use /rebuildbot to rebuild and restart it now.');
    return;
  }

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
    // Asked before the restart is requested: this worker is about to exit, and
    // a second message sent into that gap may never make it out.
    const warning = await staleLauncherWarning();
    const note = warning ? `\n\n${warning}` : '';
    if (scope === 'idle') {
      await restartAllWhenIdle(ctx, warning);
      return;
    }
    if (scope === 'all') {
      await ctx.reply(`✅ Build succeeded. Restarting all instances...${note}`);
      requestRestartAll(config.AUTO_RESTORE_SESSION);
    } else {
      if (config.AUTO_RESTORE_SESSION) writeReloadMarker();
      await ctx.reply(`✅ Build succeeded. Restarting this instance...${note}`);
      if (!config.AUTO_RESTORE_SESSION) await sendRestoreButtons(ctx);
      requestRestart();
    }
    return;
  }

  // Single-instance mode (scope is moot — only one process). Planned before
  // the build is reported, so a bot that cannot restart says so while it is
  // still alive to say it.
  const planned = await planRestart();
  if ('error' in planned) {
    await replyFormatted(
      ctx,
      new EntityText()
        .add('✅ Build succeeded, but the bot cannot restart itself.')
        .newline(2)
        .append(planned.error)
        .build(),
    );
    return;
  }

  if (config.AUTO_RESTORE_SESSION) writeReloadMarker();

  await ctx.reply('✅ Build succeeded. Restarting...');
  if (!config.AUTO_RESTORE_SESSION) await sendRestoreButtons(ctx);

  executeRestart(planned.plan);
}

/**
 * Hand the restart to the launcher, to make as each instance runs out of work.
 * The message posted here is the one the launcher keeps up to date.
 */
async function restartAllWhenIdle(ctx: Context, warning: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const status = await ctx.reply('✅ Build succeeded. Restarting each instance once it has nothing left to finish...');

  const names = await requestRestartAllWhenIdle({
    autoResume: config.AUTO_RESTORE_SESSION,
    chatId,
    messageId: status.message_id,
    note: warning || undefined,
  });
  if (names !== null) return;

  // The launcher that never answers is the one that predates the request —
  // which the stale check usually says outright.
  const text = '✅ Build succeeded, but the launcher did not take the restart — it is running code from '
    + `before "when idle" existed, so nothing is restarting. To pick it up, ${launcherRestartHint()}; that drops `
    + 'every live session. /rebuildbot all restarts the instances now instead.';
  try {
    await ctx.api.editMessageText(chatId, status.message_id, text);
  } catch {
    await ctx.reply(text);
  }
}

/**
 * /rebuildbot needs the source to build, which only a checkout has. Says so,
 * and returns true, when this isn't one.
 */
async function refuseRebuildOutsideCheckout(ctx: Context): Promise<boolean> {
  if (isCheckout()) return false;
  await ctx.reply(
    '⚠️ /rebuildbot rebuilds a source checkout of TeleCoder, and this one was installed from npm — there is no source here to build. '
    + 'Use /update to install a newer release, and /restartbot to restart.',
  );
  return true;
}

export async function handleRebuild(ctx: Context): Promise<void> {
  if (await refuseRebuildOutsideCheckout(ctx)) return;
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
  if (args?.toLowerCase() === 'idle' || args?.toLowerCase() === 'all idle') {
    await performRebuild(ctx, 'idle');
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
        [{ text: '⏳ All instances, each once it is idle', callback_data: 'rebuild:idle' }],
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

  if (await refuseRebuildOutsideCheckout(ctx)) return;

  if (data === 'rebuild:all') {
    await performRebuild(ctx, 'all');
    return;
  }

  if (data === 'rebuild:one') {
    await performRebuild(ctx, 'one');
    return;
  }

  if (data === 'rebuild:idle') {
    await performRebuild(ctx, 'idle');
    return;
  }

  // The buttons on the "when idle" status message. The launcher redraws that
  // message itself, buttons and all, so a tap only needs an answer when there
  // was nothing left to act on.
  if (data === 'rebuild:idle_force' || data === 'rebuild:idle_cancel') {
    const found = await controlIdleRestart(data === 'rebuild:idle_force' ? 'force' : 'cancel');
    if (!found) await ctx.reply('Nothing is waiting to restart any more.');
    return;
  }
}

export async function handleRestartCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data === 'restart:continue') {
    await ctx.answerCallbackQuery();
    await handleContinue(ctx);
  } else if (data === 'restart:resume') {
    await ctx.answerCallbackQuery();
    await handleResume(ctx);
  } else {
    await ctx.answerCallbackQuery();
  }
}

/**
 * Taps on a "Continue where you left off, or start fresh?" prompt. Startup
 * doesn't ask any more — a restart just carries on — but the prompts it already
 * posted still sit in chats with live buttons.
 */
export async function handleStartupCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  // Remove the inline keyboard so the buttons can't be tapped twice.
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — message may have been edited or deleted
  }

  if (data === 'startup:continue') {
    await handleContinue(ctx);
    return;
  }

  if (data === 'startup:fresh') {
    // Startup has put the old conversation back by now, so leaving it alone no
    // longer starts anything fresh — clear it the way /clear does.
    await handleClear(ctx);
    return;
  }
}
