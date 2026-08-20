/**
 * Extra MCP servers merged into the spawn config.
 *
 * The spawn passes `--strict-mcp-config`, so this file is the ONLY way another
 * server reaches the bot's agent — a `claude mcp add` entry is stored and then
 * discarded at spawn, which looks exactly like a broken server until you read
 * the flags. What matters here is that the opt-in works, that a bad file cannot
 * stop the bot starting, and that nothing can displace the bot's own tools.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { config } = await import('../../src/config.js');
const { buildMcpConfigJson } = await import('../../src/claude/pty-spawn-config.js');

const original = config.EXTRA_MCP_CONFIG;
let dir: string;

function servers(json: string): Record<string, unknown> {
	return JSON.parse(json).mcpServers;
}

function write(name: string, contents: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, contents);
	return file;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-mcp-'));
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	(config as { EXTRA_MCP_CONFIG?: string }).EXTRA_MCP_CONFIG = original;
	fs.rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('buildMcpConfigJson', () => {
	it('carries only our own server when nothing extra is configured', () => {
		(config as { EXTRA_MCP_CONFIG?: string }).EXTRA_MCP_CONFIG = undefined;
		expect(Object.keys(servers(buildMcpConfigJson({})))).toEqual(['claudegram-tools']);
	});

	it('merges the servers the file names', () => {
		(config as { EXTRA_MCP_CONFIG?: string }).EXTRA_MCP_CONFIG = write(
			'extra.json',
			JSON.stringify({
				mcpServers: { 'sjs-dev': { type: 'http', url: 'https://example.test/api/mcp' } },
			}),
		);

		const merged = servers(buildMcpConfigJson({}));
		expect(Object.keys(merged).sort()).toEqual(['claudegram-tools', 'sjs-dev']);
		expect(merged['sjs-dev']).toEqual({ type: 'http', url: 'https://example.test/api/mcp' });
	});

	it('never lets an extra config displace our own tools', () => {
		// The one server whose absence has no visible failure mode: the bot simply
		// stops being able to answer, with nothing in the transcript to say why.
		(config as { EXTRA_MCP_CONFIG?: string }).EXTRA_MCP_CONFIG = write(
			'clash.json',
			JSON.stringify({ mcpServers: { 'claudegram-tools': { command: 'not-ours' } } }),
		);

		expect(servers(buildMcpConfigJson({}))['claudegram-tools']).toMatchObject({ command: 'node' });
	});

	it('starts anyway when the file is missing', () => {
		(config as { EXTRA_MCP_CONFIG?: string }).EXTRA_MCP_CONFIG = path.join(dir, 'absent.json');
		expect(Object.keys(servers(buildMcpConfigJson({})))).toEqual(['claudegram-tools']);
	});

	it('starts anyway when the file is not JSON, or is the wrong shape', () => {
		(config as { EXTRA_MCP_CONFIG?: string }).EXTRA_MCP_CONFIG = write('bad.json', '{ nope');
		expect(Object.keys(servers(buildMcpConfigJson({})))).toEqual(['claudegram-tools']);

		(config as { EXTRA_MCP_CONFIG?: string }).EXTRA_MCP_CONFIG = write(
			'shape.json',
			JSON.stringify({ mcpServers: [] }),
		);
		expect(Object.keys(servers(buildMcpConfigJson({})))).toEqual(['claudegram-tools']);
	});
});
