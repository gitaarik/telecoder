/**
 * Options for a one-shot Haiku side-call: the topic summarizer, the charter
 * judge.
 *
 * `settingSources: []` keeps out plugins, MCP and hooks, but not the rest of
 * what a `claude` process picks up from where it runs. Started in the bot's
 * own folder, Haiku also read the default system prompt with that folder's
 * git status, and the auto-memory kept for it. That's TeleCoder's, whatever
 * project the message was about: a thread about launching SJS got named
 * "TeleCoder launch" after the launch plan in TeleCoder's memory.
 *
 * So the call runs in an empty folder, with its own system prompt in place of
 * the default one and auto-memory off. All it knows is what it's handed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Options, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { resolveBundledClaudeBin } from '../utils/resolve-claude-bin.js';

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const EMPTY_CWD = path.join(os.tmpdir(), 'telecoder-side-call');

function executableOption(): Pick<Options, 'pathToClaudeCodeExecutable'> {
  if (!config.CLAUDE_USE_BUNDLED_EXECUTABLE) {
    return { pathToClaudeCodeExecutable: config.CLAUDE_EXECUTABLE_PATH };
  }
  const bundled = resolveBundledClaudeBin();
  return bundled ? { pathToClaudeCodeExecutable: bundled } : {};
}

export function sideCallOptions(systemPrompt: string, abortController: AbortController): Options {
  fs.mkdirSync(EMPTY_CWD, { recursive: true });
  return {
    model: HAIKU_MODEL,
    systemPrompt,
    cwd: EMPTY_CWD,
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } as Record<string, string>,
    settingSources: [] as SettingSource[],
    allowedTools: [],
    // A throwaway one-shot: saving it would leave a session file per message.
    persistSession: false,
    abortController,
    includePartialMessages: false,
    ...executableOption(),
  };
}
