/**
 * The message a bot prints when its configuration stops it from starting.
 *
 * Kept free of config imports so config.ts can use it before it has a config,
 * and tests can call it directly. What it replaces was Zod's own report, which
 * a first run always hit: with no .env at all, TELEGRAM_BOT_TOKEN fails as
 * `invalid_type` before the schema's friendlier `.min()` message is reached,
 * and the user got a JSON dump naming an "expected string, received undefined"
 * rather than where to get a token.
 *
 * So this says three things in plain words: which .env was read (or that there
 * wasn't one), what is missing or wrong with one line each on how to fix it,
 * and how to make a .env if there is none.
 */

/** One problem with one variable. `message` is a complete sentence. */
export interface ConfigProblem {
  key: string;
  message: string;
}

/** Where the settings were looked for, and what was found there. */
export interface EnvFileInfo {
  path: string;
  status: 'loaded' | 'missing' | 'unreadable';
}

/** How to get each required value, for the keys a fresh install has to fill in. */
export const HOW_TO_GET: Record<string, string> = {
  TELEGRAM_BOT_TOKEN:
    'Create a bot by messaging @BotFather on Telegram (/newbot), and paste the token it gives you.',
  ALLOWED_USER_IDS:
    'Your numeric Telegram user id, like 412345678 (not your @username). Message @userinfobot on ' +
    'Telegram to get it; a TeleCoder bot that is already running also tells you yours when you send it /start.',
};

/** A Zod issue, reduced to the parts this report reads. */
export interface IssueLike {
  path: PropertyKey[];
  code?: string;
  message: string;
}

/**
 * Turn schema issues into one problem per variable, in a sentence each.
 *
 * A variable that is unset or blank is "not set", whatever check caught it —
 * the `invalid_type` an absent key gets and the `.min(1)` an empty one gets are
 * the same mistake. Anything else keeps the schema's own message, which for the
 * id lists and the token is already written for a person (see id-list.ts and
 * bot-token.ts). Only the first issue per variable is kept: a blank value
 * trips every check after `.min(1)` too, and saying so twice helps nobody.
 *
 * Values are never echoed here. One of these variables is the bot token.
 */
export function problemsFromIssues(
  issues: readonly IssueLike[],
  env: Record<string, string | undefined>,
): ConfigProblem[] {
  const seen = new Set<string>();
  const problems: ConfigProblem[] = [];
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '(unknown)');
    if (seen.has(key)) continue;
    seen.add(key);

    const raw = env[key];
    if (raw === undefined || raw.trim() === '') {
      problems.push({ key, message: `${key} is not set.` });
      continue;
    }
    const message = issue.message.startsWith(key) ? issue.message : `${key}: ${issue.message}`;
    problems.push({ key, message: /[.!?]$/.test(message) ? message : `${message}.` });
  }
  return problems;
}

/**
 * The whole report, ready to print.
 *
 * `instanceName` is set for a bot the multi-bot launcher started: its token
 * comes from instances.json rather than .env, and saying so saves a hunt for
 * a TELEGRAM_BOT_TOKEN line that was never meant to be there.
 */
export function formatConfigReport(
  problems: readonly ConfigProblem[],
  envFile: EnvFileInfo,
  options: { instanceName?: string } = {},
): string {
  const lines: string[] = [];
  const who = options.instanceName ? `The bot "${options.instanceName}"` : 'TeleCoder';
  lines.push(`❌ ${who} can't start: its configuration needs fixing.`);
  lines.push('');

  switch (envFile.status) {
    case 'loaded':
      lines.push(`Settings were read from ${envFile.path}`);
      break;
    case 'missing':
      lines.push(`No .env file was found at ${envFile.path}, so only the environment was read.`);
      break;
    case 'unreadable':
      lines.push(`The .env file at ${envFile.path} couldn't be read, so only the environment was read.`);
      break;
  }
  if (options.instanceName) {
    lines.push('It was started by the multi-bot launcher: its token comes from instances.json, and its other settings from there and from .env.');
  }
  lines.push('');

  for (const problem of problems) {
    lines.push(`  • ${problem.message}`);
    const how = HOW_TO_GET[problem.key];
    // The id-list messages already say where to get an id; repeating it under
    // them is noise. A missing value has said nothing yet.
    if (how && !problem.message.includes('@userinfobot') && !problem.message.includes('@BotFather')) {
      lines.push(`    ${how}`);
    }
  }
  lines.push('');

  if (options.instanceName) {
    lines.push(
      'Fix it in instances.json, and the launcher starts the bot again on its own; ' +
      'or fix it in .env, and restart the launcher.'
    );
  } else if (envFile.status === 'loaded') {
    lines.push(`Fix ${problems.length === 1 ? 'it' : 'these'} in ${envFile.path}, then start TeleCoder again.`);
  } else {
    lines.push(
      'To create one, run `telecoder init`, or copy .env.example to .env and fill in the values above. ' +
      'Then start TeleCoder again.'
    );
  }
  return lines.join('\n');
}

/** What dotenv's result says about the file it was pointed at. */
export function envFileStatus(result: { error?: Error }): EnvFileInfo['status'] {
  if (!result.error) return 'loaded';
  return (result.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
}
