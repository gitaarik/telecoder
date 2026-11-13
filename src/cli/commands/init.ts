/**
 * `telecoder init` — set up a bot interactively, or from flags in a script.
 *
 * The wizard itself is ../init/flow.ts; this module parses the flags and hands
 * it the real terminal, the real Telegram and the real config location (the
 * same .env `telecoder start` and the bot read: TELECODER_ENV_PATH if set,
 * else <config home>/.env).
 */

import * as os from 'os';
import type { CliIo, CommandResult } from '../dispatch.js';
import { getConfigHomeInfo, configFile } from '../../utils/config-home.js';
import { isCheckout } from '../../utils/install-mode.js';
import { legacyEnv } from '../../utils/legacy-env.js';
import { checkClaude, checkNodePty, checkNodeVersion } from './doctor.js';
import { runInit, type InitOptions } from '../init/flow.js';
import { createTerminalPrompter } from '../init/prompter.js';
import { createTelegramClient, DEFAULT_API_ROOT } from '../init/telegram.js';

const USAGE = [
  'Usage: telecoder init [options]',
  '',
  'Asks for everything it needs when run in a terminal. For scripts:',
  '  --token-env VAR      read the bot token from environment variable VAR',
  '                       (never pass the token itself: arguments show up in ps)',
  '  --owner-id ID        your numeric Telegram user id',
  '  --workspace DIR      the folder your projects are in (default: ~/projects or ~)',
  '  --transport sdk|pty  how Claude Code runs (default: sdk)',
  '  --groq-key-env VAR   turn voice transcription on, with the Groq key in VAR',
  '  --telegraph          publish long replies to Telegraph (public pages)',
  '  --no-test-message    don\'t have the bot message you at the end',
  '  --yes                ask nothing: take defaults, replace an existing .env',
  '                       (backed up first), remove a webhook if one is set',
];

export type ParsedInitArgs = { ok: true; opts: InitOptions } | { ok: false; error: string };

export function parseInitArgs(args: string[]): ParsedInitArgs {
  const opts: InitOptions = {};
  const valued: Record<string, (v: string) => string | void> = {
    '--token-env': (v) => { opts.tokenEnv = v; },
    '--owner-id': (v) => { opts.ownerId = v; },
    '--workspace': (v) => { opts.workspace = v; },
    '--groq-key-env': (v) => { opts.groqKeyEnv = v; },
    '--transport': (v) => {
      if (v !== 'sdk' && v !== 'pty') return '--transport takes sdk or pty.';
      opts.transport = v;
    },
  };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].includes('=') ? args[i].split(/=(.*)/s, 2) : [args[i], undefined];
    if (flag === '--yes' || flag === '-y') opts.yes = true;
    else if (flag === '--telegraph') opts.telegraph = true;
    else if (flag === '--no-telegraph') opts.telegraph = false;
    else if (flag === '--no-test-message') opts.noTestMessage = true;
    else if (flag === '--token' || flag === '--groq-key') {
      return { ok: false, error: `${flag} isn't accepted: arguments show up in ps. Put it in an environment variable and pass ${flag}-env VAR.` };
    } else if (Object.hasOwn(valued, flag)) {
      const value = inline ?? args[++i];
      if (value === undefined || value === '') return { ok: false, error: `${flag} needs a value.` };
      const problem = valued[flag](value);
      if (problem) return { ok: false, error: problem };
    } else {
      return { ok: false, error: `Unknown option: ${args[i]}` };
    }
  }
  return { ok: true, opts };
}

export async function run(args: string[], io: CliIo): Promise<CommandResult> {
  const parsed = parseInitArgs(args);
  if (!parsed.ok) {
    io.err(parsed.error);
    for (const line of USAGE) io.err(line);
    return 2;
  }

  const claudeBin = process.env.CLAUDE_EXECUTABLE_PATH || 'claude';
  const envPath = legacyEnv('ENV_PATH') || configFile('.env');
  // Test-only: point the wizard at a fake Telegram. See init/telegram.ts.
  const apiRoot = process.env.TELECODER_TELEGRAM_API_ROOT || DEFAULT_API_ROOT;

  const prompter = createTerminalPrompter();
  try {
    return await runInit(parsed.opts, {
      prompter,
      makeClient: (token) => createTelegramClient(token, { apiRoot }),
      preflight: async () => ({
        node: checkNodeVersion(),
        claude: await checkClaude(claudeBin),
        nodePty: await checkNodePty(),
      }),
      envPath,
      // Tighten only ~/.telecoder itself: a checkout's root or a TELECODER_HOME
      // may be a directory other things live in (a new one is made 0700 anyway).
      ownDir: envPath === configFile('.env') && getConfigHomeInfo().source === 'home',
      env: process.env,
      homedir: os.homedir(),
      claudeBin,
      isCheckout: isCheckout(),
    });
  } finally {
    prompter.close();
  }
}
