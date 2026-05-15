/**
 * Verbosity tier system.
 *
 * Maps a single `quiet | normal | verbose | debug` level (per-chat or env
 * default) onto a set of individual rendering flags. Explicit env vars win
 * over the tier; the per-chat preference wins over the env default.
 */

import { config, explicitFlags } from '../config.js';
import { userPreferences } from '../providers/user-preferences.js';

export type VerbosityLevel = 'quiet' | 'normal' | 'verbose' | 'debug';

export const VERBOSITY_LEVELS: VerbosityLevel[] = ['quiet', 'normal', 'verbose', 'debug'];

export function isValidVerbosityLevel(level: string): level is VerbosityLevel {
  return (VERBOSITY_LEVELS as string[]).includes(level);
}

export interface VerbosityLevelInfo {
  id: VerbosityLevel;
  label: string;
  description: string;
}

export const VERBOSITY_INFO: VerbosityLevelInfo[] = [
  {
    id: 'quiet',
    label: '🔇 Quiet',
    description: 'Answer only. Suppresses completion pings and the usage footer; keeps compaction warnings.',
  },
  {
    id: 'normal',
    label: '💬 Normal',
    description: 'Default. Tool status, todos, background tasks, completion ping.',
  },
  {
    id: 'verbose',
    label: '🔊 Verbose',
    description: 'Adds the per-turn usage footer, untruncated tool inputs, and a consolidated action log that shows tool results and diffs in a single updatable message.',
  },
  {
    id: 'debug',
    label: '🐛 Debug',
    description: 'Verbose mode with extended limits: longer tool result previews (40 lines) and diffs (50 lines) in the consolidated action log. Reserved for upcoming thinking blocks, hook events, and SDK internals.',
  },
];

/**
 * Per-tier rendering flag defaults. Explicit env-var overrides are layered
 * on top in {@link resolveVerbosityFlags}.
 */
export interface VerbosityFlags {
  /** Send the per-turn "🟢 [████░░] 30% · 5k/200k · $0.04" footer. */
  showUsageFooter: boolean;
  /** Send the "⚠️ Context Compacted" and "🔄 New Agent Session" notices. */
  notifyCompaction: boolean;
  /** Render full untruncated tool inputs (paths, commands) in the status bubble. */
  terminalUiVerbose: boolean;
  /** Send the "✅ Done (1m 12s)" ping after long streaming tasks. */
  sendCompletionPing: boolean;
  /** Post a truncated preview of every tool's result (bash output, file content, ...). */
  showToolResults: boolean;
  /** Maximum number of lines to keep when truncating a tool result preview. */
  toolResultMaxLines: number;
  /** Maximum number of characters to keep when truncating a tool result preview. */
  toolResultMaxChars: number;
  /** Render a before/after preview for every Edit/Write call. */
  showDiffs: boolean;
  /** Maximum number of diff lines (per side) to keep before truncating. */
  diffMaxLines: number;
  /** Use consolidated action log instead of separate messages for tool results and diffs. */
  useActionLog: boolean;
}

function defaultsForLevel(level: VerbosityLevel): VerbosityFlags {
  switch (level) {
    case 'quiet':
      return {
        showUsageFooter: false,
        notifyCompaction: true,
        terminalUiVerbose: false,
        sendCompletionPing: false,
        showToolResults: false,
        toolResultMaxLines: 0,
        toolResultMaxChars: 0,
        showDiffs: false,
        diffMaxLines: 0,
        useActionLog: false,
      };
    case 'normal':
      return {
        showUsageFooter: false,
        notifyCompaction: true,
        terminalUiVerbose: false,
        sendCompletionPing: true,
        showToolResults: false,
        toolResultMaxLines: 0,
        toolResultMaxChars: 0,
        showDiffs: false,
        diffMaxLines: 0,
        useActionLog: false,
      };
    case 'verbose':
      return {
        showUsageFooter: true,
        notifyCompaction: true,
        terminalUiVerbose: true,
        sendCompletionPing: true,
        showToolResults: true,
        toolResultMaxLines: 20,
        toolResultMaxChars: 2000,
        showDiffs: true,
        diffMaxLines: 25,
        useActionLog: true,
      };
    case 'debug':
      return {
        showUsageFooter: true,
        notifyCompaction: true,
        terminalUiVerbose: true,
        sendCompletionPing: true,
        showToolResults: true,
        toolResultMaxLines: 40,
        toolResultMaxChars: 4000,
        showDiffs: true,
        diffMaxLines: 50,
        useActionLog: true,
      };
  }
}

/**
 * Resolve the active verbosity level for a chat. Per-chat preference wins
 * over the env-level VERBOSITY_DEFAULT.
 */
export function getVerbosityLevel(chatId: number): VerbosityLevel {
  return userPreferences.getVerbosity(chatId) ?? config.VERBOSITY_DEFAULT;
}

/**
 * Resolve effective rendering flags for a chat. An explicit env override
 * wins over the tier default; an unset env var defers to the tier.
 */
export function resolveVerbosityFlags(chatId: number): VerbosityFlags {
  const tier = defaultsForLevel(getVerbosityLevel(chatId));
  return {
    showUsageFooter: explicitFlags.CONTEXT_SHOW_USAGE ? config.CONTEXT_SHOW_USAGE : tier.showUsageFooter,
    notifyCompaction: explicitFlags.CONTEXT_NOTIFY_COMPACTION ? config.CONTEXT_NOTIFY_COMPACTION : tier.notifyCompaction,
    terminalUiVerbose: explicitFlags.TERMINAL_UI_VERBOSE ? config.TERMINAL_UI_VERBOSE : tier.terminalUiVerbose,
    sendCompletionPing: tier.sendCompletionPing,
    showToolResults: tier.showToolResults,
    toolResultMaxLines: tier.toolResultMaxLines,
    toolResultMaxChars: tier.toolResultMaxChars,
    showDiffs: tier.showDiffs,
    diffMaxLines: tier.diffMaxLines,
    useActionLog: tier.useActionLog,
  };
}
