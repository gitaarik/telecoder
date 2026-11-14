// Fails the build when the command reference and the bot disagree: every
// command src/bot/bot.ts registers or puts in Telegram's menu must be on the
// Commands page, and every row on that page must be a real command.
import { readFileSync } from 'node:fs';

const bot = readFileSync(new URL('../../src/bot/bot.ts', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/content/docs/reference/commands.md', import.meta.url), 'utf8');

const inCode = new Set([
  ...[...bot.matchAll(/\bcmd\('([a-z_]+)'/g)].map((m) => m[1]),
  ...[...bot.matchAll(/\{ command: '([a-z_]+)'/g)].map((m) => m[1]),
]);
const mentioned = new Set([...page.matchAll(/`\/([a-z_]+)/g)].map((m) => m[1]));
const rows = new Set([...page.matchAll(/^\| `\/([a-z_]+)/gm)].map((m) => m[1]));

const undocumented = [...inCode].filter((c) => !mentioned.has(c)).sort();
const unknown = [...rows].filter((c) => !inCode.has(c)).sort();

if (inCode.size < 30) {
  console.error(`check-commands: found only ${inCode.size} commands in bot.ts; has the registration code changed shape?`);
  process.exit(1);
}
for (const c of undocumented) console.error(`check-commands: /${c} is registered in src/bot/bot.ts but not on the Commands page`);
for (const c of unknown) console.error(`check-commands: /${c} is on the Commands page but src/bot/bot.ts doesn't register it`);
if (undocumented.length || unknown.length) process.exit(1);
console.log(`check-commands: all ${inCode.size} commands documented`);
