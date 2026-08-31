/**
 * Marketplace plugins carried into the agent.
 *
 * The property that matters is that CLAUDE_PLUGINS is the *only* way one
 * arrives: both transports skip ~/.claude/settings.json, where `enabledPlugins`
 * normally lives, so a plugin enabled in the terminal is otherwise absent from
 * a Telegram session with nothing to say why. The other property that matters
 * is that carrying plugins never costs the bot its hooks — the permission gate
 * rides in the same settings payload, and a payload that lost it would fail
 * open.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { config } = await import('../../src/config.js');
const { enabledPluginsSetting, resetPluginWarnings } = await import(
	'../../src/claude/enabled-plugins.js'
);
const { buildSettingsJson } = await import('../../src/claude/pty-spawn-config.js');

const original = config.CLAUDE_PLUGINS;

function setPlugins(...names: string[]): void {
	(config as { CLAUDE_PLUGINS: string[] }).CLAUDE_PLUGINS = names;
}

beforeEach(() => {
	resetPluginWarnings();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	(config as { CLAUDE_PLUGINS: string[] }).CLAUDE_PLUGINS = original;
	vi.restoreAllMocks();
});

describe('enabledPluginsSetting', () => {
	it('is undefined when nothing is configured', () => {
		setPlugins();
		expect(enabledPluginsSetting()).toBeUndefined();
	});

	it('maps each plugin id to enabled', () => {
		setPlugins('frontend-design@claude-plugins-official', 'context-mode@claude-context-mode');
		expect(enabledPluginsSetting()).toEqual({
			'frontend-design@claude-plugins-official': true,
			'context-mode@claude-context-mode': true,
		});
	});

	it('drops a bare plugin name, and says why', () => {
		// Claude Code looks the entry up by its full id, so a bare name matches
		// nothing and looks exactly like a plugin that is not installed.
		setPlugins('frontend-design');
		expect(enabledPluginsSetting()).toBeUndefined();
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('plugin@marketplace'));
	});

	it('keeps the good ids when one is malformed', () => {
		setPlugins('frontend-design', 'github@claude-plugins-official');
		expect(enabledPluginsSetting()).toEqual({ 'github@claude-plugins-official': true });
	});

	it('warns once per bad id however many times it is asked', () => {
		setPlugins('frontend-design');
		enabledPluginsSetting();
		enabledPluginsSetting();
		expect(console.warn).toHaveBeenCalledTimes(1);
	});
});

describe('buildSettingsJson', () => {
	it('omits the key entirely when no plugins are configured', () => {
		setPlugins();
		expect(JSON.parse(buildSettingsJson(4000))).not.toHaveProperty('enabledPlugins');
	});

	it('carries the plugins alongside the hooks, never instead of them', () => {
		setPlugins('frontend-design@claude-plugins-official');
		const settings = JSON.parse(buildSettingsJson(4000));

		expect(settings.enabledPlugins).toEqual({ 'frontend-design@claude-plugins-official': true });
		expect(Object.keys(settings.hooks).sort()).toEqual([
			'PostToolUse',
			'PostToolUseFailure',
			'PreToolUse',
			'Stop',
		]);
	});
});
