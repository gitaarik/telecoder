import { describe, it, expect } from 'vitest';
import {
  CLAUDE_NOT_LOGGED_IN_REPLY,
  CLAUDE_ONBOARDING_REPLY,
  ClaudeNotLoggedInError,
  claudeCredentialsLookPresent,
  claudeSetupScreen,
  isClaudeAuthError,
  turnErrorReply,
} from '../../src/claude/claude-auth.js';
import { ClaudeApiError } from '../../src/claude/pty-provider.js';

describe('isClaudeAuthError', () => {
  it.each([
    // What agent.ts throws when the SDK's query ends on the CLI's answer
    // (measured against the bundled CLI with an empty HOME).
    'Claude error: Claude Code returned an error result: Not logged in · Please run /login',
    'Not logged in · Please run /login',
    'Invalid API key · Fix external API key',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    CLAUDE_NOT_LOGGED_IN_REPLY,
  ])('recognises %j', (text) => {
    expect(isClaudeAuthError(text)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'Claude error: Claude Code process exited with code 1',
    'API Error: 529 Overloaded',
    "Claude AI usage limit reached|1731412800",
  ])('leaves %j alone', (text) => {
    expect(isClaudeAuthError(text)).toBe(false);
  });
});

describe('turnErrorReply', () => {
  it('turns an SDK not-logged-in failure into the sign-in instructions', () => {
    const reply = turnErrorReply(new Error('Claude error: Claude Code returned an error result: Not logged in · Please run /login'));
    expect(reply).toContain(CLAUDE_NOT_LOGGED_IN_REPLY);
    expect(reply).toContain('claude setup-token');
    expect(reply).not.toContain('Please run /login');
  });

  it('does the same for a PTY API-error record', () => {
    expect(turnErrorReply(new ClaudeApiError('Not logged in · Please run /login'))).toContain(CLAUDE_NOT_LOGGED_IN_REPLY);
  });

  it('says the CLI is at its first-run screens when the PTY found it there', () => {
    expect(turnErrorReply(new ClaudeNotLoggedInError('onboarding'))).toContain(CLAUDE_ONBOARDING_REPLY);
  });

  it('keeps every other error as it was', () => {
    expect(turnErrorReply(new Error('No active session. Use /project to set working directory.')))
      .toBe('❌ Error: No active session. Use /project to set working directory.');
  });
});

describe('claudeSetupScreen', () => {
  // Screens from the bundled 2.1.280 CLI in a pty with an empty HOME.
  it('spots the theme picker as onboarding', () => {
    expect(claudeSetupScreen(" Let's get started.\n Choose the text style that looks best with your terminal\n ❯ 2. Dark mode ✔")).toBe('onboarding');
  });

  it('spots the login menu and the sign-in prompt as login', () => {
    expect(claudeSetupScreen(' Select login method:\n ❯ 1. Claude account with subscription')).toBe('login');
    expect(claudeSetupScreen(' Paste code here if prompted >')).toBe('login');
  });

  it('ignores an ordinary input box', () => {
    expect(claudeSetupScreen('╭────╮\n│ >  │\n╰────╯\n ⏵⏵ bypass permissions on')).toBeUndefined();
  });
});

describe('claudeCredentialsLookPresent', () => {
  const base = { env: {}, home: '/home/me', platform: 'linux' as NodeJS.Platform, exists: () => false };

  it('says no on Linux with no credentials file and no token', () => {
    expect(claudeCredentialsLookPresent(base)).toBe('no');
  });

  it('says yes for a credentials file, under CLAUDE_CONFIG_DIR too', () => {
    expect(claudeCredentialsLookPresent({ ...base, exists: (f) => f === '/home/me/.claude/.credentials.json' })).toBe('yes');
    expect(claudeCredentialsLookPresent({
      ...base,
      env: { CLAUDE_CONFIG_DIR: '/etc/claude' },
      exists: (f) => f === '/etc/claude/.credentials.json',
    })).toBe('yes');
  });

  it.each(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK'])('says yes for %s', (key) => {
    expect(claudeCredentialsLookPresent({ ...base, env: { [key]: 'x' } })).toBe('yes');
  });

  it("can't tell on macOS, where the login is in the keychain", () => {
    expect(claudeCredentialsLookPresent({ ...base, platform: 'darwin' })).toBe('unknown');
  });
});
