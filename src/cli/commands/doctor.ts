/**
 * `telecoder doctor` — check that what TeleCoder needs is in place, without
 * starting it.
 *
 * Reads the .env itself (dotenv.parse, not the bot's config module, which
 * exits on the first invalid value) so it can report every problem at once.
 * Nothing here costs money: the Claude login is checked with
 * `claude auth status`, and the Telegram token only goes over the network
 * with --live (a getMe call).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseEnv } from 'dotenv';
import type { CliIo, CommandResult } from '../dispatch.js';
import { getConfigHomeInfo, configFile } from '../../utils/config-home.js';
import { getInstallMode, getInstalledVersion, PACKAGE_ROOT } from '../../utils/install-mode.js';
import { legacyEnv } from '../../utils/legacy-env.js';
import { parseIdList, PLACEHOLDER_USER_ID } from '../../utils/id-list.js';
import { resolveInstances, InstancesConfigError } from '../../utils/instance-config.js';
import { resolveBin } from '../../utils/resolve-bin.js';
import { redactSecrets } from '../../utils/sanitize.js';

export const MIN_NODE_MAJOR = 22;

export type Status = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  status: Status;
  label: string;
  /** Extra lines under the label: what was found, or what to do about it. */
  detail?: string[];
}

const ok = (label: string, ...detail: string[]): CheckResult => ({ status: 'ok', label, detail });
const warn = (label: string, ...detail: string[]): CheckResult => ({ status: 'warn', label, detail });
const fail = (label: string, ...detail: string[]): CheckResult => ({ status: 'fail', label, detail });

// ── Pure checks (tested directly) ──────────────────────────────

export function checkNodeVersion(version: string = process.versions.node): CheckResult {
  const major = parseInt(version.split('.')[0], 10);
  return major >= MIN_NODE_MAJOR
    ? ok(`Node.js ${version}`)
    : fail(`Node.js ${version} is too old`, `TeleCoder needs Node.js ${MIN_NODE_MAJOR} or newer.`);
}

/** `<bot id>:<secret>`, the shape @BotFather hands out. */
export function tokenLooksValid(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

export function checkToken(token: string | undefined, where: string): CheckResult {
  if (!token) return fail('TELEGRAM_BOT_TOKEN is not set', `Add it to ${where} (get one from @BotFather).`);
  if (!tokenLooksValid(token)) {
    return fail('TELEGRAM_BOT_TOKEN does not look like a bot token',
      'Expected <bot id>:<secret>, e.g. 123456789:AA… — copy it again from @BotFather.');
  }
  return ok(`Bot token for bot ${token.split(':')[0]}`);
}

export function checkAllowedUsers(raw: string | undefined): CheckResult {
  if (!raw?.trim()) {
    return fail('ALLOWED_USER_IDS is not set', 'Put your numeric Telegram id there (get it from @userinfobot).');
  }
  const parsed = parseIdList('ALLOWED_USER_IDS', raw);
  if (!parsed.ok) return fail('ALLOWED_USER_IDS is invalid', parsed.error);
  if (parsed.ids.includes(PLACEHOLDER_USER_ID)) {
    return fail(`ALLOWED_USER_IDS still has the placeholder ${PLACEHOLDER_USER_ID}`,
      'Replace it with your own numeric Telegram id (get it from @userinfobot).');
  }
  return ok(`Allowed users: ${parsed.ids.join(', ')}`);
}

/** What `claude auth status --json` says about being logged in; null when it can't be read. */
export function parseAuthStatus(stdout: string): { loggedIn: boolean; method?: string } | null {
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
    if (typeof parsed.loggedIn !== 'boolean') return null;
    return { loggedIn: parsed.loggedIn, method: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined };
  } catch {
    return null;
  }
}

// ── Checks that look at the machine ────────────────────────────

function exec(cmd: string, args: string[], timeout = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function onPath(name: string): boolean {
  const resolved = resolveBin(name);
  return path.isAbsolute(resolved);
}

async function checkClaude(executable: string): Promise<CheckResult[]> {
  const bin = path.isAbsolute(executable) || executable.includes('/') ? executable : resolveBin(executable);
  const version = await exec(bin, ['--version'], 15_000);
  if (version.code !== 0) {
    return [fail(`Claude Code CLI not found (${executable})`,
      'Install it: npm install -g @anthropic-ai/claude-code — or set CLAUDE_EXECUTABLE_PATH.')];
  }
  const results = [ok(`Claude Code ${version.stdout.trim().split('\n')[0]}`)];

  const auth = await exec(bin, ['auth', 'status', '--json'], 20_000);
  const status = parseAuthStatus(auth.stdout);
  if (status?.loggedIn) {
    results.push(ok(`Claude Code is logged in${status.method ? ` (${status.method})` : ''}`));
  } else if (status) {
    results.push(fail('Claude Code is not logged in', 'Run "claude" once and log in, or set ANTHROPIC_API_KEY.'));
  } else if (process.env.ANTHROPIC_API_KEY || fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'))) {
    // An older CLI without `auth status`: credentials on disk are the best sign.
    results.push(ok('Claude Code credentials found'));
  } else {
    results.push(warn("Couldn't confirm the Claude Code login", 'If the bot can\'t answer, run "claude" once and log in.'));
  }
  return results;
}

async function checkNodePty(): Promise<CheckResult[]> {
  try {
    await import('node-pty');
    return [ok('node-pty loads')];
  } catch (error) {
    const missing = [
      ['a C compiler', ['cc', 'gcc', 'clang']],
      ['a C++ compiler', ['c++', 'g++', 'clang++']],
      ['make', ['make']],
      ['python3', ['python3']],
    ].filter(([, names]) => !(names as string[]).some(onPath)).map(([what]) => what as string);
    const fix = process.platform === 'darwin'
      ? 'Install the Xcode command line tools (xcode-select --install), then reinstall TeleCoder.'
      : 'Install a build toolchain (e.g. apt install build-essential python3), then reinstall TeleCoder.';
    return [fail('node-pty failed to load (the terminal mode needs it)',
      redactSecrets(error instanceof Error ? error.message.split('\n')[0] : String(error)),
      ...(missing.length ? [`Missing: ${missing.join(', ')}.`, fix] : ['A build toolchain is present; try reinstalling TeleCoder.']))];
  }
}

async function checkLive(token: string): Promise<CheckResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json() as { ok?: boolean; result?: { username?: string }; description?: string };
    if (body.ok && body.result?.username) return ok(`Telegram knows the token: @${body.result.username}`);
    return fail('Telegram rejected the token', redactSecrets(body.description ?? `HTTP ${res.status}`));
  } catch (error) {
    // The message of a failed fetch can carry the URL, and the URL the token.
    return warn("Couldn't reach Telegram", redactSecrets(error instanceof Error ? error.message : String(error)).replaceAll(token, '<token>'));
  }
}

// ── The command ────────────────────────────────────────────────

const ICON: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' };

function print(io: CliIo, result: CheckResult): void {
  io.out(`${ICON[result.status]} ${result.label}`);
  for (const line of result.detail ?? []) io.out(`    ${line}`);
}

export async function runChecks(args: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const live = args.includes('--live');

  results.push(checkNodeVersion());
  results.push(ok(`TeleCoder ${getInstalledVersion() ?? '?'} (${getInstallMode()} install at ${PACKAGE_ROOT})`));

  const home = getConfigHomeInfo();
  const why = { override: 'from TELECODER_HOME', 'package-root': 'next to package.json', home: 'default' }[home.source];
  results.push(ok(`Config home: ${home.dir} (${why})`));

  const envPath = legacyEnv('ENV_PATH') || configFile('.env');
  const instancesPath = configFile('instances.json');
  let fileEnv: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    try {
      fileEnv = parseEnv(fs.readFileSync(envPath));
      results.push(ok(`Config file: ${envPath}`));
    } catch (error) {
      results.push(fail(`Can't read ${envPath}`, error instanceof Error ? error.message : String(error)));
    }
  } else if (!fs.existsSync(instancesPath)) {
    results.push(fail(`No config file at ${envPath}`, 'Run "telecoder init" (coming soon), or copy .env.example there and fill it in.'));
  }

  // The environment wins over the file, as it does in the bot.
  const value = (key: string) => process.env[key] ?? fileEnv[key];
  const tokens: string[] = [];

  if (fs.existsSync(instancesPath)) {
    try {
      const warnings: string[] = [];
      const instances = resolveInstances(fs.readFileSync(instancesPath, 'utf-8'), (w) => warnings.push(w));
      results.push(ok(`instances.json: ${instances.length} bot(s) — ${instances.map((i) => i.name).join(', ')}`));
      for (const w of warnings) results.push(warn(w));
      for (const inst of instances) {
        const r = checkToken(inst.token, instancesPath);
        if (r.status !== 'ok') results.push({ ...r, label: `${inst.name}: ${r.label}` });
        else tokens.push(inst.token);
      }
      const users = instances.map((i) => i.overrides?.ALLOWED_USER_IDS ?? value('ALLOWED_USER_IDS'));
      for (const r of new Set(users)) results.push(checkAllowedUsers(r));
    } catch (error) {
      if (!(error instanceof InstancesConfigError)) throw error;
      results.push(fail(`instances.json: ${error.message}`));
    }
  } else {
    const token = value('TELEGRAM_BOT_TOKEN');
    const r = checkToken(token, envPath);
    results.push(r);
    if (r.status === 'ok' && token) tokens.push(token);
    results.push(checkAllowedUsers(value('ALLOWED_USER_IDS')));
  }

  results.push(...await checkClaude(value('CLAUDE_EXECUTABLE_PATH') || 'claude'));
  results.push(...await checkNodePty());

  if (live) {
    for (const token of tokens) results.push(await checkLive(token));
  }
  return results;
}

export async function run(args: string[], io: CliIo): Promise<CommandResult> {
  const results = await runChecks(args);
  for (const r of results) print(io, r);

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  io.out('');
  if (failed) io.out(`${failed} problem(s) to fix before "telecoder start" will work.`);
  else if (warned) io.out(`Ready to start, with ${warned} warning(s).`);
  else io.out('All good. Run "telecoder start".');
  if (!args.includes('--live') && !failed) io.out('(Add --live to check the token with Telegram.)');
  return failed ? 1 : 0;
}
