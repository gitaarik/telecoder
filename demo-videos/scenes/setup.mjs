// Scene 1: from nothing to a first conversation. BotFather, npm install,
// `telecoder init`, the background service, and a first question.
//
// The demo user is put back to a machine without TeleCoder first, and its real
// config is restored afterwards, whatever happens. The bot made on camera is a
// throwaway: it is deleted at the end, so the token shown is dead.
//
// BotFather lets an account create only a handful of bots a day (the sixth
// /newbot in an hour got "try again in 82212 seconds"). So rehearse with
// SETUP_BOT=<username>: an existing bot of the demo account, its token in
// .session/bot-token. That skips BotFather and deletes nothing, and the take is
// not for publishing. Record the real take once the rest is right.
//
// Until the release with this wizard is on npm, set TELECODER_PKG to a package
// file in the demo user's home (say ~/telecoder-main-4f6403e.tgz): the typed
// `npm install -g telecoder` then installs that file.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { openStage, asDemo, inDemo, DEMO_USER, PROMPT } from '../lib/stage.mjs';
import { openTelegram, send, statusLines, waitForStatusLine, onlyChats } from '../lib/telegram.mjs';
import { pointAndClick } from '../lib/cursor.mjs';
const BOTFATHER_ID = '93372553';
import { createBot, deleteBot, hideHistory, openBotPage, turnOff, turnOn, configureOnCamera } from '../lib/botfather.mjs';

const PKG = process.env.TELECODER_PKG ?? '';
const REHEARSAL_BOT = process.env.SETUP_BOT ?? '';
const USERNAMES = ['alex_mealplan_bot', 'alexs_mealplan_bot', 'alex_mealplan_coder_bot', 'mealplan_alex_bot'];
const QUESTION = 'What does this project do?';
const SWITCHES = ['Bot Management Mode', 'Threaded Mode'];
const chatRow = (page, id) => page.locator(`.chatlist-top .chatlist-chat[data-peer-id="${id}"]`).first();
const SYSTEMD = 'export XDG_RUNTIME_DIR=/run/user/$(id -u); U=~/.config/systemd/user/telecoder.service';

const RC = `
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
export CLAUDE_CODE_OAUTH_TOKEN="$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' ~/.telecoder.keep/.env | cut -d= -f2-)"
PS1='${PROMPT}'
TELECODER_PKG='${PKG}'
npm() {
  if [ -n "$TELECODER_PKG" ] && [ "$*" = "install -g telecoder" ]; then command npm install -g "$TELECODER_PKG"
  else command npm "$@"; fi
}
cd ~
`;

/** A machine that has never seen TeleCoder. The real config waits in ~/.telecoder.keep. */
function freshMachine() {
  asDemo(`${SYSTEMD}; systemctl --user disable --now telecoder 2>/dev/null;
    if [ -d ~/.telecoder.keep ]; then rm -rf ~/.telecoder.scrap; [ -d ~/.telecoder ] && mv ~/.telecoder ~/.telecoder.scrap;
    else mv ~/.telecoder ~/.telecoder.keep; fi;
    if [ -f $U ]; then if [ -f $U.keep ]; then rm $U; else mv $U $U.keep; fi; fi;
    systemctl --user daemon-reload;
    npm uninstall -g telecoder >/dev/null 2>&1;
    mkdir -p ~/projects && ln -sfn ~/mealplan ~/projects/mealplan; true`);
  execFileSync('sudo', ['-u', DEMO_USER, '-H', 'bash', '-c', 'cat > ~/.demo-setup-rc'], { input: RC });
}

/** Put the demo user's own bot back, and start it. */
function restoreMachine() {
  asDemo(`${SYSTEMD}; systemctl --user disable --now telecoder 2>/dev/null;
    if [ -d ~/.telecoder.keep ]; then rm -rf ~/.telecoder.scrap; [ -d ~/.telecoder ] && mv ~/.telecoder ~/.telecoder.scrap; mv ~/.telecoder.keep ~/.telecoder; fi;
    [ -f $U.keep ] && mv -f $U.keep $U;
    ${PKG ? `npm install -g ${PKG} >/dev/null 2>&1;` : '[ -x ~/.npm-global/bin/telecoder ] || npm install -g telecoder >/dev/null 2>&1;'}
    systemctl --user daemon-reload; systemctl --user enable --now telecoder 2>&1 | tail -1; true`);
}

// `node scenes/setup.mjs --restore` only puts the demo user's bot back, after a run that died.
if (process.argv.includes('--restore')) { restoreMachine(); process.exit(0); }

let bot; // { username, token } once BotFather has made it
let failure;
inDemo('git reset -q --hard demo-start && git clean -qfdx');
freshMachine();
if (REHEARSAL_BOT) {
  // Off camera: the rehearsal bot starts like a new one, with both switches off.
  const { context, page } = await openTelegram({ chat: 'BotFather', width: 940 });
  await turnOff(page, await openBotPage(page, REHEARSAL_BOT), SWITCHES);
  await context.close();
}
const s = await openStage('setup', {
  app: false,
  wide: true,
  chat: 'BotFather',
  terminal: {
    title: 'alex@home: ~',
    args: ['-u', DEMO_USER, '-H', 'bash', '--rcfile', `/home/${DEMO_USER}/.demo-setup-rc`, '-i'],
  },
});
const pause = (ms) => s.telegram.waitForTimeout(ms);

try {
  await hideHistory(s.telegram);
  await onlyChats(s.telegram, [BOTFATHER_ID]);
  await s.type('clear');
  await pause(1500);
  s.cut(0, s.mark('ready'));

  // ── 1. A bot from BotFather ─────────────────────────────────
  if (REHEARSAL_BOT) {
    bot = { username: REHEARSAL_BOT, token: (await readFile(new URL('../.session/bot-token', import.meta.url), 'utf8')).trim() };
  } else {
    bot = await createBot(s.telegram, { name: 'TeleCoder', usernames: USERNAMES });
    s.mark('bot-created');
    await pause(3000);
  }

  // ── 2. Install ──────────────────────────────────────────────
  await s.type('npm install -g telecoder');
  const typedInstall = s.mark('install');
  await s.waitTerm(/(added|changed) \d+ packages?[^]*\$\s*$/, 600_000);
  s.cut(typedInstall + 2500, s.mark('installed') - 1500);
  await pause(1500);

  // ── 3. The wizard ───────────────────────────────────────────
  await s.type('telecoder init');
  let handled = '';
  let started = false;
  const deadline = Date.now() + 300_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('The wizard did not finish:\n' + (await s.termText()).split('\n').slice(-12).join('\n'));
    await pause(400);
    const text = await s.termText();
    const last = text.split('\n').at(-1);
    const state = `${text.length}:${last}`;
    if (state === handled) continue;
    const answer = async (keys = '', read = 1300) => {
      await pause(read); // long enough to read the question
      if ((await s.termText()) !== text) return; // still printing
      handled = state;
      if (keys) {
        await s.terminal.keyboard.insertText(keys);
        if (keys.length === 1) await pause(600); // the answer is seen before Enter
      }
      await s.terminal.keyboard.press('Enter');
      handled = '';
      await pause(500);
    };
    if (/\(input hidden\)\s*$/.test(last)) {
      await answer(bot.token, 1800);
    } else if (last.trim() === '>' && !started) {
      // The wizard waits for a /start to learn who its owner is.
      started = true;
      await pause(2500);
      await s.telegram.goto(`https://web.telegram.org/k/#@${bot.username}`);
      await pause(3500);
      await send(s.telegram, '/start');
      await onlyChats(s.telegram, [BOTFATHER_ID, bot.token.split(':')[0]]);
    } else if (/^Choose 1-\d+ \[\d+\]\s*$/.test(last) && /How should TeleCoder run Claude Code/.test(text.split('\n').slice(-5).join('\n'))) {
      // PTY: the real Claude Code, which `telecoder watch` shows at the end.
      await answer('2', 2200);
    } else if (/\[(Y\/n|y\/N)\]\s*$/.test(last)) {
      // The default, but typed out, so the viewer sees what was answered.
      await answer(/\[Y\/n\]/.test(last) ? 'y' : 'n');
    } else if (/^Choose 1-\d+ \[\d+\]\s*$/.test(last)) {
      await answer(last.match(/\[(\d+)\]/)[1]);
    } else if (/^Workspace directory:/.test(last)) {
      await answer();
    } else if (/\$\s*$/.test(last) && /telecoder init/.test(text) && /service|Next: run/.test(text.split('telecoder init').at(-1))) {
      break;
    }
  }
  const wizardDone = s.mark('wizard-done');
  await pause(2500);
  // Telegram Web shows a bot's new picture only after a reload. Off camera.
  const botId = bot.token.split(':')[0];
  const offCamera = async () => {
    await s.telegram.reload({ waitUntil: 'domcontentloaded' });
    await pause(4000);
    // BotFather's chat is opened again later: keep what is in it now out of the picture.
    await s.telegram.goto('https://web.telegram.org/k/#@BotFather');
    await onlyChats(s.telegram, [BOTFATHER_ID, botId]);
    await s.telegram.locator('.bubble').filter({ visible: true }).first().waitFor({ timeout: 30000 });
    await pause(2500);
    await hideHistory(s.telegram, { only: 'botfather|' + BOTFATHER_ID });
    // A bot with threads opens on its list of threads, and the chat beside it stays where
    // it was until "All Messages" is clicked. That list can take a while to appear.
    const title = () => s.telegram.locator('.chat-info .peer-title').filter({ visible: true }).first().innerText().catch(() => '');
    for (let attempt = 0; ; attempt++) {
      await s.telegram.goto(`https://web.telegram.org/k/#@${bot.username}`);
      await pause(3000);
      const all = s.telegram.getByText('All Messages', { exact: true }).filter({ visible: true }).first();
      if (await all.isVisible().catch(() => false)) await all.click();
      await pause(3000);
      if (!/BotFather/i.test(await title())) break;
      if (attempt === 5) throw new Error("Still in BotFather's chat, not the bot's");
    }
    await s.telegram.locator('.bubble').filter({ visible: true }).first().waitFor({ timeout: 30000 });
  };
  await pause(1500); // the page goes white on reload: keep that well inside the cut
  await offCamera();
  s.cut(wizardDone + 2500, s.mark('reloaded'));
  await pause(3000);

  // ── 4. Threads and bot management, in BotFather's Mini App ──
  await pointAndClick(s.telegram, chatRow(s.telegram, BOTFATHER_ID));
  await pause(2500);
  await configureOnCamera(s.telegram, bot.username, SWITCHES);
  const tab = s.telegram.locator('button[class*="_BrowserHeaderTabClose_"]').first();
  await tab.hover({ force: true }).catch(() => {});
  await pointAndClick(s.telegram, tab);
  await pause(1500);
  await pointAndClick(s.telegram, chatRow(s.telegram, botId));
  await pause(2000);
  // A bot set up with the wizard reads the new setting when it starts.
  await s.type('telecoder service restart');
  const restarting = s.mark('restart');
  await pause(15000);
  await offCamera(); // and Telegram Web shows a bot's threads only after a reload
  // Claude Code's screen is 120 columns wide: smaller text from here on, so all of it fits.
  await s.type('clear');
  const size = await s.terminal.evaluate(() => window.setFont(12));
  if (Number(size.split('x')[0]) < 120) throw new Error('The terminal pane fits only ' + size);
  await pause(1000);
  s.cut(restarting + 3000, s.mark('threads-on'));
  await pause(2500);

  // ── 5. Watching Claude Code, and a first conversation in its own thread ──
  await s.type('telecoder watch');
  await s.waitTerm(/Waiting for a Claude Code session/, 30_000);
  await pause(2500);
  await send(s.telegram, '/project mealplan');
  await pause(5000);
  const before = await statusLines(s.telegram);
  await send(s.telegram, QUESTION);
  const asked = s.mark('asked');
  // The question arrives in the real Claude Code, on the right.
  await s.waitTerm(/telecoder watch · @/, 60_000);
  await waitForStatusLine(s.telegram, before, 240_000);
  const answered = s.mark('answered');
  if (answered - 4000 > asked + 15000) s.cut(asked + 15000, answered - 4000);
  await pause(6000);

  s.mark('end');
} catch (error) {
  failure = error;
}

const video = await s.finish().catch((e) => { failure ??= e; });
// Off camera: the throwaway bot goes, and the demo user's own bot comes back.
if (bot && !REHEARSAL_BOT) {
  const { context, page } = await openTelegram({ chat: 'BotFather' });
  await deleteBot(page, bot.username).catch((e) => console.error('Could not delete @' + bot.username + ': ' + e.message));
  await context.close();
}
restoreMachine();
if (REHEARSAL_BOT) {
  // Whatever happened on camera, the standing demo bot keeps both switches on.
  const { context, page } = await openTelegram({ chat: 'BotFather', width: 940 });
  await turnOn(page, await openBotPage(page, REHEARSAL_BOT), SWITCHES).catch((e) => console.error('Switches: ' + e.message));
  await context.close();
}
if (failure) {
  console.error('Scene failed: ' + failure.message);
  process.exit(1);
}
console.log(video);
