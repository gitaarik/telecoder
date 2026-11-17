/**
 * Whether a pty gets the Claude Code setup of the account the bot runs as.
 *
 * With it, Claude in Telegram is the Claude of the terminal: ~/.claude, the
 * account's MCP servers and its connectors. Three things have to hold. A bot
 * that is only its owner's gets it without being asked. A bot with guests does
 * not, because a guest would then work with the owner's instructions and with
 * connectors signed in as the owner. And the settings the bot passes keep the
 * terminal driving safe from whatever those user settings say.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const guests = { present: false };
vi.mock('../../src/utils/admins.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/utils/admins.js')>();
	return { ...actual, hasGuestUsers: () => guests.present };
});

const { config } = await import('../../src/config.js');
const { loadsUserSetup, userSetupIsolationArgs, buildSettingsJson } = await import(
	'../../src/claude/pty-spawn-config.js'
);

type Setting = 'auto' | 'on' | 'off';
const original = config.CLAUDE_USER_SETUP;

function configure(setting: Setting, hasGuests: boolean): void {
	(config as { CLAUDE_USER_SETUP: Setting }).CLAUDE_USER_SETUP = setting;
	guests.present = hasGuests;
}

afterEach(() => {
	configure(original, false);
});

describe('loadsUserSetup', () => {
	it('defaults to auto', () => {
		expect(original).toBe('auto');
	});

	it('brings the setup along on a bot with no guests', () => {
		configure('auto', false);
		expect(loadsUserSetup()).toBe(true);
	});

	it('leaves it out once the bot has a guest', () => {
		configure('auto', true);
		expect(loadsUserSetup()).toBe(false);
	});

	it('follows the roster as it changes, so a first guest counts from the next spawn', () => {
		configure('auto', false);
		expect(loadsUserSetup()).toBe(true);
		guests.present = true;
		expect(loadsUserSetup()).toBe(false);
	});

	it('can be forced on for a bot with guests', () => {
		configure('on', true);
		expect(loadsUserSetup()).toBe(true);
	});

	it('can be forced off for a bot without them', () => {
		configure('off', false);
		expect(loadsUserSetup()).toBe(false);
	});
});

describe('userSetupIsolationArgs', () => {
	it('passes no flag when the setup comes along, so claude starts as it does in a terminal', () => {
		configure('auto', false);
		expect(userSetupIsolationArgs()).toEqual([]);
	});

	it('drops the user settings tier and every MCP server but the named ones otherwise', () => {
		configure('auto', true);
		expect(userSetupIsolationArgs()).toEqual([
			'--setting-sources', 'project,local',
			'--strict-mcp-config',
		]);
	});

	it('takes the answer a caller already has, so one spawn cannot disagree with itself', () => {
		configure('auto', true);
		expect(userSetupIsolationArgs(true)).toEqual([]);
		configure('auto', false);
		expect(userSetupIsolationArgs(false)).toContain('--strict-mcp-config');
	});
});

describe('the settings pinned for the terminal driving', () => {
	it.each<[Setting, boolean]>([
		['auto', false],
		['auto', true],
	])('pins the editor to normal mode (CLAUDE_USER_SETUP=%s, guests: %s)', (setting, hasGuests) => {
		configure(setting, hasGuests);
		// A project's settings can say "vim" too, so the pin is not only for
		// the spawns that read the user's.
		expect(JSON.parse(buildSettingsJson(1234)).editorMode).toBe('normal');
	});

	it('switches a custom status line off with an empty command, not with null', () => {
		// `null` is a settings error: claude opens a dialog and skips the whole
		// payload, the hooks with it.
		expect(JSON.parse(buildSettingsJson(1234)).statusLine).toEqual({ type: 'command', command: '' });
	});

	it('keeps the hooks beside the pins, since the permission gate rides in them', () => {
		const settings = JSON.parse(buildSettingsJson(1234));
		expect(Object.keys(settings.hooks).sort()).toEqual([
			'PostToolUse',
			'PostToolUseFailure',
			'PreToolUse',
			'Stop',
		]);
	});
});
