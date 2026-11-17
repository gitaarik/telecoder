/**
 * `telecoder doctor` — check that what TeleCoder needs is in place, without
 * starting it.
 *
 * Reads the .env itself (dotenv.parse, not the bot's config module, which
 * exits on the first invalid value) so it can report every problem at once.
 * Nothing here costs money: the Claude login is checked with
 * `claude auth status`, and the Telegram token only goes over the network
 * with --live (a getMe call, through the proxy the bot would use).
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
import { unreachableHint } from '../../utils/bot-token.js';
import { fetchThroughProxy, findProxy } from '../../utils/telegram-proxy.js';
import { describeFetchError } from '../init/telegram.js';
import { MIN_NODE_MAJOR } from '../../node-version-check.js';
import { SERVICE_MANAGER_ENV } from '../../utils/exit-codes.js';

export { MIN_NODE_MAJOR };

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
    return fail('ALLOWED_USER_IDS is not set', '"telecoder init" finds your numeric Telegram id, or get it from @userinfobot.');
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

const SERVICE_LOGIN_NOTE = (envPath: string) =>
  `This runs under the service, which doesn't see your shell's environment: a login kept in ${CLAUDE_CREDENTIAL_VARS.join(', ')} has to be in ${envPath}.`;

/**
 * A login that lives only in the shell's environment works from a terminal,
 * but a service starts without that environment. `envOnly` is what
 * envOnlyLogin found; a variable kept in the .env is fine, the bot loads it.
 */
export function checkLoginSurvivesService(
  envOnly: string[], fileEnv: Record<string, string>, envPath: string,
): CheckResult | null {
  if (!envOnly.length || envOnly.some((key) => fileEnv[key]?.trim())) return null;
  const vars = envOnly.join(' / ');
  return warn(`Claude Code's login comes from ${vars} in this shell's environment, not stored credentials`,
    `When TeleCoder runs as a service (telecoder service install), it starts outside your shell and doesn't have ${vars}, so Claude Code would be logged out.`,
    `Add ${vars} to ${envPath} (readable by you only), or log in with "claude auth login".`);
}

// ── Checks that look at the machine ────────────────────────────

function exec(
  cmd: string, args: string[], timeout = 15_000, env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function onPath(name: string): boolean {
  const resolved = resolveBin(name);
  return path.isAbsolute(resolved);
}

/**
 * The variables in the .env that change how claude logs in. The bot loads
 * them into its own environment, so `claude auth status` has to see them too,
 * or a login kept in the .env reads as none.
 */
const CLAUDE_AUTH_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
];

export function claudeAuthEnv(
  value: (key: string) => string | undefined, base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of CLAUDE_AUTH_VARS) {
    const v = value(key);
    if (v) env[key] = v;
  }
  return env;
}

/** The variables that are a Claude login by themselves, as opposed to stored credentials. */
export const CLAUDE_CREDENTIAL_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** The credential variables set (non-empty) in `env`. */
export function credentialVarsIn(env: NodeJS.ProcessEnv): string[] {
  return CLAUDE_CREDENTIAL_VARS.filter((key) => env[key]?.trim());
}

/**
 * Whether claude is logged in once the credential variables are taken away:
 * true means stored credentials (~/.claude/.credentials.json, or the macOS
 * keychain), which a service finds too. null when it can't tell (an older CLI
 * without `auth status`), in which case the credentials file is the best sign.
 */
export async function hasStoredLogin(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean | null> {
  const bin = path.isAbsolute(executable) || executable.includes('/') ? executable : resolveBin(executable);
  const bare = { ...env };
  for (const key of CLAUDE_CREDENTIAL_VARS) delete bare[key];
  const status = parseAuthStatus((await exec(bin, ['auth', 'status', '--json'], 20_000, bare)).stdout);
  if (status) return status.loggedIn;
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return fs.existsSync(path.join(configDir, '.credentials.json')) ? true : null;
}

/**
 * The credential variables a working login depends on: set in `env`, and
 * claude logged out without them. Empty when the login is stored, or there
 * is none to speak of.
 */
export async function envOnlyLogin(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const vars = credentialVarsIn(env);
  if (!vars.length) return [];
  return (await hasStoredLogin(executable, env)) ? [] : vars;
}

export async function checkClaude(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<CheckResult[]> {
  const bin = path.isAbsolute(executable) || executable.includes('/') ? executable : resolveBin(executable);
  const version = await exec(bin, ['--version'], 15_000, env);
  if (version.code !== 0) {
    return [fail(`Claude Code CLI not found (${executable})`,
      'Install it: curl -fsSL https://claude.ai/install.sh | bash — or set CLAUDE_EXECUTABLE_PATH.')];
  }
  const results = [ok(`Claude Code ${version.stdout.trim().split('\n')[0]}`)];

  const auth = await exec(bin, ['auth', 'status', '--json'], 20_000, env);
  const status = parseAuthStatus(auth.stdout);
  if (status?.loggedIn) {
    results.push(ok(`Claude Code is logged in${status.method ? ` (${status.method})` : ''}`));
  } else if (status) {
    results.push(fail('Claude Code is not logged in',
      'Run "claude" once and log in, or run "claude setup-token" and set CLAUDE_CODE_OAUTH_TOKEN in the .env.'));
  } else if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN
    || fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'))) {
    // An older CLI without `auth status`: credentials on disk are the best sign.
    results.push(ok('Claude Code credentials found'));
  } else {
    results.push(warn("Couldn't confirm the Claude Code login", 'If the bot can\'t answer, run "claude" once and log in.'));
  }
  return results;
}

export async function checkNodePty(): Promise<CheckResult[]> {
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
    return [fail('node-pty failed to load (Claude Code runs in it, so chats need it)',
      redactSecrets(error instanceof Error ? error.message.split('\n')[0] : String(error)),
      ...(missing.length ? [`Missing: ${missing.join(', ')}.`, fix] : ['A build toolchain is present; try reinstalling TeleCoder.']))];
  }
}

/**
 * Ask Telegram who the token belongs to (getMe), through `proxyUrl` when the
 * bot with this token would use a proxy. `apiRoot` is for tests.
 */
export async function checkLive(token: string, proxyUrl?: string, apiRoot = 'https://api.telegram.org'): Promise<CheckResult> {
  // The message of a failed request can carry the URL, and the URL the token;
  // a proxy URL can carry a password.
  const scrub = (text: string) => redactSecrets(text.replaceAll(token, '<token>'));
  const via = proxyUrl ? ` through the proxy ${scrub(proxyUrl)}` : '';
  const unreachable = (reason: string) => warn(`Couldn't reach Telegram${via}`, scrub(reason), unreachableHint(proxyUrl));

  let status: number;
  let text: string;
  try {
    const request = proxyUrl ? fetchThroughProxy(proxyUrl) : fetch;
    const res = await request(`${apiRoot}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    status = res.status;
    text = await res.text();
  } catch (error) {
    return unreachable(describeFetchError(error));
  }

  let body: { ok?: boolean; result?: { username?: string }; description?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // A proxy's own error (a 407, an error page) or a gateway in between.
    return unreachable(`HTTP ${status}, not a Bot API answer`);
  }
  if (body.ok && body.result?.username) return ok(`Telegram knows the token: @${body.result.username}${via ? ` (${via.trim()})` : ''}`);
  return fail('Telegram rejected the token', scrub(body.description ?? `HTTP ${status}`));
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
    results.push(fail(`No config file at ${envPath}`, 'Run "telecoder init" to set one up.'));
  }

  // The environment wins over the file, as it does in the bot.
  const value = (key: string) => process.env[key] ?? fileEnv[key];
  /** Each token to check with --live, and the proxy its bot would reach Telegram through. */
  const tokens: Array<{ token: string; proxyUrl?: string }> = [];

  if (fs.existsSync(instancesPath)) {
    try {
      const warnings: string[] = [];
      const instances = resolveInstances(fs.readFileSync(instancesPath, 'utf-8'), (w) => warnings.push(w));
      results.push(ok(`instances.json: ${instances.length} bot(s) — ${instances.map((i) => i.name).join(', ')}`));
      for (const w of warnings) results.push(warn(w));
      for (const inst of instances) {
        const r = checkToken(inst.token, instancesPath);
        if (r.status !== 'ok') results.push({ ...r, label: `${inst.name}: ${r.label}` });
        // An instance's overrides are its environment, over the launcher's own.
        else tokens.push({ token: inst.token, proxyUrl: findProxy((key) => inst.overrides?.[key] ?? value(key))?.url });
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
    if (r.status === 'ok' && token) tokens.push({ token, proxyUrl: findProxy(value)?.url });
    results.push(checkAllowedUsers(value('ALLOWED_USER_IDS')));
  }

  const claudeBin = value('CLAUDE_EXECUTABLE_PATH') || 'claude';
  const claude = await checkClaude(claudeBin, claudeAuthEnv(value));
  results.push(...claude);
  if (claude[1]?.status === 'ok') {
    const loginWarning = checkLoginSurvivesService(await envOnlyLogin(claudeBin, claudeAuthEnv(value)), fileEnv, envPath);
    if (loginWarning) results.push(loginWarning);
  } else if (claude[1]?.status === 'fail' && process.env[SERVICE_MANAGER_ENV]) {
    claude[1].detail = [...claude[1].detail ?? [], SERVICE_LOGIN_NOTE(envPath)];
  }
  results.push(...await checkNodePty());

  if (live) {
    for (const { token, proxyUrl } of tokens) results.push(await checkLive(token, proxyUrl));
  }
  return results;
}

export function usage(): string[] {
  return [
    'Usage: telecoder doctor [--live]',
    '',
    'Checks Node, the claude CLI and its login, node-pty and your config. Writes nothing.',
    '  --live  also check each bot token with Telegram (through the proxy, when one is set)',
  ];
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
