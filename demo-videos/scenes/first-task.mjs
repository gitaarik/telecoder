// Scene 2: a first task, with one tap to approve the git push.
import { openStage, resetDemo, inDemo, BOT, APP_URL } from '../lib/stage.mjs';
import { pointAndClick } from '../lib/cursor.mjs';
import { hideHistory } from '../lib/botfather.mjs';
import { deleteAllThreads, send, waitForButton, tapButton, waitForReplyDone } from '../lib/telegram.mjs';

const PROMPT = "Add a page that shows this week's meals, one recipe per day, and link it from the home page. Commit it and push.";

resetDemo();
await deleteAllThreads(BOT);
const start = inDemo('git rev-parse HEAD').trim();

const s = await openStage('first-task');
await hideHistory(s.telegram); // leftovers at the chat's top level, from rehearsals of the setup scene
await s.type('cd mealplan && clear');
s.show('app'); // the site as it is, until there is something to see in the terminal
await s.telegram.waitForTimeout(1500);
s.cut(0, s.mark('ready'));

await s.telegram.waitForTimeout(1200);
await send(s.telegram, PROMPT);
const sent = s.mark('sent');

const yes = await waitForButton(s.telegram, /^1\. Yes$/);
const asked = s.mark('asked');
s.cut(sent + 7000, asked - 2500);
await s.telegram.waitForTimeout(3500);
await tapButton(s.telegram, yes);
const tapped = s.mark('tapped');

await waitForReplyDone(s.telegram);
const done = s.mark('done');
s.cut(tapped + 3000, done - 2000);
await s.telegram.waitForTimeout(2500);

// Check the work before showing it: a new commit, and nothing left unpushed.
const head = inDemo('git rev-parse HEAD').trim();
const unpushed = inDemo('git log origin/main..main --oneline').trim();
if (head === start || unpushed) {
  console.error(`Scene failed: ${head === start ? 'no new commit' : 'commit not pushed'}`);
  await s.finish().catch(() => {});
  process.exit(1);
}

s.mark('show');
s.show('terminal');
await s.type('git log --oneline -3 && git status -sb');
await s.app.goto(APP_URL);
await s.app.waitForTimeout(3500);
s.show('app');
await s.app.waitForTimeout(1200);
await pointAndClick(s.app, s.app.getByRole('link', { name: /week/i }).first());
await s.app.waitForTimeout(4500);
s.mark('end');

console.log(await s.finish());
