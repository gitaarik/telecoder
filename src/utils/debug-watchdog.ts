#!/usr/bin/env npx tsx
/**
 * Reproduction harness for watchdog-vs-Monitor / backgrounded-task hangs.
 *
 * Goal: prove or disprove whether the AgentWatchdog fires `controller.abort()`
 * during a quiet period after a backgrounded tool call, which the SDK then
 * reports as "Request interrupted by user for tool use".
 *
 * Usage:
 *   npx tsx src/utils/debug-watchdog.ts             # default 20s timeouts, Monitor prompt
 *   SILENCE_MS=10000 npx tsx src/utils/debug-watchdog.ts
 *   PROMPT=bgsleep npx tsx src/utils/debug-watchdog.ts  # background bash + idle wait
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentWatchdog } from '../claude/agent-watchdog.js';
import { formatDuration } from './agent-timer.js';
import { resolveBundledClaudeBin } from './resolve-claude-bin.js';

const SILENCE_MS = parseInt(process.env.SILENCE_MS || '20000', 10);
const STALE_MS = parseInt(process.env.STALE_MS || '20000', 10);
const PROMPT_KEY = process.env.PROMPT || 'monitor';

const PROMPTS: Record<string, string> = {
  // Try to force a Monitor call after a backgrounded bash.
  monitor: `Run \`sleep 45\` as a background bash command with run_in_background:true. Then use the Monitor tool to wait until that background task completes. Do NOT call BashOutput or any other tool while waiting — only Monitor. Once the sleep finishes, briefly report the result.`,
  // Plain backgrounded bash with no follow-up tool calls.
  bgsleep: `Run \`sleep 45\` as a background bash command with run_in_background:true. Then sit idle until it finishes — do not call any tools or write any text until you see the task complete. Then say "done".`,
};

const prompt = PROMPTS[PROMPT_KEY] || PROMPTS.monitor;

console.log('=== Watchdog Repro Harness ===');
console.log(`Silence timeout : ${SILENCE_MS}ms`);
console.log(`Stale timeout   : ${STALE_MS}ms`);
console.log(`Prompt          : ${PROMPT_KEY}`);
console.log(`Prompt text     : ${prompt.substring(0, 100)}...`);
console.log('==============================\n');

const start = Date.now();
const elapsed = () => formatDuration(Date.now() - start);

const controller = new AbortController();
let watchdogFired: string | null = null;

const watchdog = new AgentWatchdog({
  chatId: 'repro',
  warnAfterSeconds: 5,
  logIntervalSeconds: 2,
  silenceTimeoutMs: SILENCE_MS,
  staleToolTimeoutMs: STALE_MS,
  onWarning: (sinceMsg, total) => {
    console.log(`[${elapsed()}] !! WATCHDOG WARNING: ${formatDuration(sinceMsg)} since last meaningful msg (total ${formatDuration(total)})`);
  },
  onSilenceTimeout: () => {
    watchdogFired = 'silence';
    console.log(`[${elapsed()}] !! WATCHDOG SILENCE TIMEOUT — aborting`);
    controller.abort();
  },
  onStaleToolTimeout: () => {
    watchdogFired = 'stale-tool';
    console.log(`[${elapsed()}] !! WATCHDOG STALE-TOOL TIMEOUT — aborting`);
    controller.abort();
  },
});

watchdog.start();

const messageTypeCounts: Record<string, number> = {};
let lastLoggedMs = 0;

try {
  const bundled = resolveBundledClaudeBin();
  const response = query({
    prompt,
    options: {
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
      abortController: controller,
      model: 'claude-opus-4-7',
      ...(bundled ? { pathToClaudeCodeExecutable: bundled } : {}),
    },
  });

  for await (const message of response) {
    watchdog.recordActivity(message.type);
    messageTypeCounts[message.type] = (messageTypeCounts[message.type] || 0) + 1;

    const now = Date.now();
    if (now - lastLoggedMs >= 500 || message.type === 'assistant' || message.type === 'result') {
      const typeLabel = 'subtype' in message ? `${message.type}/${(message as { subtype: string }).subtype}` : message.type;
      console.log(`[${elapsed()}] msg: ${typeLabel}`);
      lastLoggedMs = now;
    }

    if (controller.signal.aborted) {
      console.log(`[${elapsed()}] aborted, breaking loop`);
      break;
    }

    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          console.log(`[${elapsed()}]   → tool: ${block.name}`);
        } else if (block.type === 'text') {
          console.log(`[${elapsed()}]   → text: ${block.text.substring(0, 120).replace(/\n/g, ' ')}`);
        }
      }
    }

    if (message.type === 'result') {
      console.log(`[${elapsed()}] result subtype: ${message.subtype}`);
      // Match production behaviour (agent.ts:942) — stop watchdog on result.
      // Without this, the harness's watchdog keeps running and fires falsely
      // during the post-result silence while backgrounded tasks are armed.
      console.log(`[${elapsed()}]   (stopping watchdog — production-faithful)`);
      watchdog.stop();
    }
  }
} catch (err) {
  console.error(`[${elapsed()}] ERROR:`, err instanceof Error ? err.message : err);
} finally {
  watchdog.stop();
}

console.log('\n=== Summary ===');
console.log(`Total elapsed   : ${elapsed()}`);
console.log(`Watchdog fired  : ${watchdogFired ?? 'no'}`);
console.log(`Message types   :`);
for (const [t, n] of Object.entries(messageTypeCounts)) {
  console.log(`  ${t}: ${n}`);
}
