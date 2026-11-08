import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SetupTokenRun,
  describeScreen,
  findOAuthError,
  findOAuthToken,
  findSignInLink,
  findSignInLinkOnScreen,
  looksLikeOAuthToken,
  redactTokens,
  setupTokenEnv,
} from '../../src/claude/setup-token.js';

const TOKEN = `sk-ant-oat01-${'Ab1_-'.repeat(20)}`;

// What claude 2.1.319 sent for the link, cut down: the OSC 8 sequence carries
// the whole URL, while the visible text is wrapped across rows.
const LINK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=QvXg';
const RAW = `\u001b[2G\u001b[38;5;241mBrowser\u001b[10Gdidn't\u001b[39m\r\r\n\r\r\n`
  + `\u001b]8;id=3l8bjr;${LINK}\u0007\u001b[38;5;241m${LINK.slice(0, 60)}\u001b[39m\u001b]8;;\u0007\r\r\n`
  + `\u001b]8;id=3l8bjr;${LINK}\u0007\u001b[38;5;241m${LINK.slice(60)}\u001b[39m\u001b]8;;\u0007\r\r\n`
  + '\u001b[2GPaste\u001b[8Gcode\u001b[13Ghere\u001b[18Gif\u001b[21Gprompted\u001b[30G>\r\r\n';

describe('reading claude setup-token', () => {
  it('takes the whole sign-in link from its OSC 8 sequence', () => {
    expect(findSignInLink(RAW)).toBe(LINK);
  });

  it('takes the newest link when the run started over', () => {
    const fresh = LINK.replace('state=QvXg', 'state=Zz9');
    expect(findSignInLink(`${RAW}\u001b]8;id=9;${fresh}\u001b\\later\u001b]8;;\u001b\\`)).toBe(fresh);
  });

  it('ignores links that are not the sign-in page', () => {
    expect(findSignInLink('\u001b]8;;https://docs.anthropic.com/x\u0007docs\u001b]8;;\u0007')).toBeUndefined();
  });

  it('can read the link off the screen when there is no OSC 8', () => {
    expect(findSignInLinkOnScreen(` Use the url below to sign in\n\n${LINK}\n\n Paste code here if prompted >`)).toBe(LINK);
  });

  it('finds the token on the success screen', () => {
    const screen = [
      ' ✓ Long-lived authentication token created successfully!',
      '',
      ' Your OAuth token (valid for 1 year):',
      '',
      ` ${TOKEN}`,
      '',
      " Store this token securely. You won't be able to see it again.",
    ].join('\n');
    expect(findOAuthToken(screen)).toBe(TOKEN);
  });

  it('reads why a code was refused', () => {
    const screen = " OAuth error: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n\n Press Enter to retry.";
    expect(findOAuthError(screen)).toMatch(/^That code wasn't accepted\. It may be incomplete/);
    expect(findOAuthError(' Paste code here if prompted >')).toBeUndefined();
  });

  it('tells a token apart from a sign-in code', () => {
    expect(looksLikeOAuthToken(TOKEN)).toBe(true);
    expect(looksLikeOAuthToken(`  ${TOKEN}\n`)).toBe(true);
    expect(looksLikeOAuthToken('fj3k2LsdQ#u8sdk2jd')).toBe(false);
    expect(looksLikeOAuthToken(`my token is ${TOKEN}`)).toBe(false);
  });

  it('blanks out anything shaped like a key', () => {
    expect(redactTokens(`set ${TOKEN} and sk-ant-api03-xyz`)).toBe('set sk-ant-… and sk-ant-…');
  });

  it('explains an ending from the rows with words in them, not the logo', () => {
    const screen = ['  ░░░░  ██▒▒██', '.......█ █   █ █......', ' Something went wrong.', ' Try again later.', ''].join('\n');
    expect(describeScreen(screen)).toBe('Something went wrong.\nTry again later.');
  });

  it("runs claude without the bot's credentials or its session markers", () => {
    const env = setupTokenEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'http://localhost:3456',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      CLAUDECODE: '1',
    });
    expect(env.PATH).toBe('/bin');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1');
  });
});

/**
 * A stand-in for `claude setup-token`, driven through a real pty: it draws the
 * link as OSC 8, waits at the prompt, refuses any code but `good-code`, starts
 * over with a new link on Enter, and prints a token for the good one.
 */
const FAKE_CLI = String.raw`
const link = (n) => 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s' + n;
const osc8 = (url) => '\x1b]8;id=1;' + url + '\x07' + url.slice(0, 40) + '\x1b]8;;\x07';
let attempt = 1;
let retry = false;
const show = () => process.stdout.write(
  " Browser didn't open? Use the url below to sign in\r\n\r\n" + osc8(link(attempt)) + '\r\n\r\n Paste code here if prompted > ');
if (process.argv[2] === 'die') {
  process.stdout.write(' Something went wrong talking to the server.\r\n');
  process.exit(3);
}
show();
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.search(/[\r\n]/)) !== -1) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (retry) {
      retry = false;
      attempt += 1;
      process.stdout.write('\x1b[2J\x1b[H');
      show();
    } else if (line === 'good-code') {
      process.stdout.write('\r\n Your OAuth token (valid for 1 year):\r\n\r\n sk-ant-oat01-' + 'A'.repeat(90) + '\r\n\r\n Store this token securely.\r\n');
      setTimeout(() => process.exit(0), 5000);
    } else if (line) {
      process.stdout.write("\r\n OAuth error: That code wasn't accepted. Sign in again to get a new code.\r\n\r\n Press Enter to retry.\r\n");
      retry = true;
    }
  }
});
`;

describe('SetupTokenRun', () => {
  let fake: string;
  const runs: SetupTokenRun[] = [];

  beforeAll(() => {
    fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-setup-token-')), 'fake.cjs');
    fs.writeFileSync(fake, FAKE_CLI);
  });

  afterEach(() => {
    for (const run of runs.splice(0)) run.kill();
  });

  const start = (...args: string[]): SetupTokenRun => {
    const run = new SetupTokenRun({ bin: process.execPath, args: [fake, ...args], env: { ...process.env, TERM: 'xterm-256color' } });
    runs.push(run);
    return run;
  };

  it('hands over the link, starts over after a refused code, and returns the token', async () => {
    const run = start();
    const first = await run.waitForLink(10_000);
    expect(first).toMatch(/state=s1$/);

    const refused = await run.submitCode('not-it', 10_000);
    expect(refused).toEqual({
      kind: 'rejected',
      reason: "That code wasn't accepted. Sign in again to get a new code.",
      link: expect.stringMatching(/state=s2$/),
    });

    const made = await run.submitCode('good-code', 10_000);
    expect(made).toEqual({ kind: 'token', token: `sk-ant-oat01-${'A'.repeat(90)}` });
  }, 30_000);

  it('says how the run ended when it ends before showing a link', async () => {
    const run = start('die');
    await expect(run.waitForLink(10_000)).rejects.toThrow(
      /claude setup-token exited with code 3: Something went wrong talking to the server\./,
    );
  }, 15_000);

  it('stops a wait when it is killed', async () => {
    const run = start();
    await run.waitForLink(10_000);
    const waiting = run.submitCode('good-code', 10_000);
    run.kill();
    await expect(waiting).resolves.toEqual({ kind: 'failed', reason: 'stopped' });
    expect(await run.submitCode('again', 1000)).toEqual({ kind: 'failed', reason: 'stopped' });
  }, 15_000);
});
