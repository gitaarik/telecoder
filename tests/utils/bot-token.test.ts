import { describe, it, expect } from 'vitest';
import { GrammyError, HttpError } from 'grammy';
import {
  isWellFormedBotToken,
  describeTokenCheckFailure,
  REJECTED_TOKEN_MESSAGE,
} from '../../src/utils/bot-token.js';

const REAL_SHAPE = '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

describe('isWellFormedBotToken', () => {
  it('accepts what @BotFather hands out', () => {
    expect(isWellFormedBotToken(REAL_SHAPE)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['the .env.example placeholder', 'your_bot_token_here'],
    ['a truncated paste', '1234567890:AAHdqTcvCH1v'],
    ['no bot id', ':AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ'],
    ['surrounding quotes', `"${REAL_SHAPE}"`],
    ['a trailing space', `${REAL_SHAPE} `],
    ['the "bot" prefix from a URL', `bot${REAL_SHAPE}`],
  ])('rejects %s', (_label, token) => {
    expect(isWellFormedBotToken(token)).toBe(false);
  });
});

function apiError(code: number, description: string): GrammyError {
  return new GrammyError(
    `Call to 'getMe' failed! (${code}: ${description})`,
    { ok: false, error_code: code, description },
    'getMe',
    {},
  );
}

describe('describeTokenCheckFailure', () => {
  it.each([401, 404])('calls a %d a rejected token, and fatal', (code) => {
    const failure = describeTokenCheckFailure(apiError(code, code === 401 ? 'Unauthorized' : 'Not Found'));
    expect(failure).toEqual({ message: REJECTED_TOKEN_MESSAGE, fatal: true });
    expect(failure.message).toContain('@BotFather');
  });

  it('names api.telegram.org and TELEGRAM_PROXY_URL on a network failure, without the token', () => {
    const cause = Object.assign(
      new Error(`request to https://api.telegram.org/bot${REAL_SHAPE}/getMe failed, reason: getaddrinfo ENOTFOUND api.telegram.org`),
      { code: 'ENOTFOUND' },
    );
    const failure = describeTokenCheckFailure(new HttpError(`Network request for 'getMe' failed!`, cause));
    expect(failure.fatal).toBe(false);
    expect(failure.message).toContain("Couldn't reach api.telegram.org");
    expect(failure.message).toContain('ENOTFOUND');
    expect(failure.message).toContain('TELEGRAM_PROXY_URL');
    expect(failure.message).not.toContain(REAL_SHAPE);
  });

  it('names the proxy, with its password hidden, when one is set', () => {
    const failure = describeTokenCheckFailure(
      new HttpError('Network request failed', new Error('connect ECONNREFUSED 127.0.0.1:1080')),
      'http://alice:hunter22@127.0.0.1:1080',
    );
    expect(failure.message).toContain('through the proxy');
    expect(failure.message).not.toContain('hunter22');
  });

  it('keeps any token out of an unexpected error', () => {
    const failure = describeTokenCheckFailure(new Error(`boom at /bot${REAL_SHAPE}/getMe`));
    expect(failure.message).not.toContain(REAL_SHAPE);
  });
});
