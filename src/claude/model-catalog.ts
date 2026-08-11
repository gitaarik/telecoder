/**
 * The `--model` aliases Claude Code accepts, shared by every provider that
 * ultimately spawns the CLI.
 *
 * Both PTY and SDK mode hand the alias to a `claude` binary (`--model <alias>`),
 * so the list belongs to the CLI, not to us — mirror `claude --help` here when
 * upstream adds one. Aliases outside the CLI's own set are treated as literal
 * API model names, which means a wrong entry fails at request time rather than
 * at spawn.
 */

import type { ModelInfo } from '../providers/types.js';
import { getClaudeVersion, isAtLeast } from '../utils/claude-version.js';

export const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'fable', label: 'fable', description: 'Most capable — hardest, longest-running tasks' },
  { id: 'opus', label: 'opus', description: 'Most capable of the Opus tier (default)' },
  { id: 'sonnet', label: 'sonnet', description: 'Balanced' },
  { id: 'haiku', label: 'haiku', description: 'Fast & light' },
  { id: 'opusplan', label: 'opusplan', description: 'Opus while planning, Sonnet otherwise' },
  { id: 'best', label: 'best', description: 'Tracks whichever model is currently top-tier' },
  { id: 'fable[1m]', label: 'fable[1m]', description: 'fable with a 1M-token context window' },
  { id: 'opus[1m]', label: 'opus[1m]', description: 'opus with a 1M-token context window' },
  { id: 'sonnet[1m]', label: 'sonnet[1m]', description: 'sonnet with a 1M-token context window' },
];

/**
 * Oldest release verified to expose the `fable` aliases. Deliberately
 * conservative: 2.1.140 (shipped inside claude-agent-sdk 0.2.140) knows only
 * sonnet/opus/haiku/best/opusplan and the two [1m] variants, 2.1.220 knows
 * fable, and the exact release in between wasn't worth bisecting. Erring high
 * hides a working alias; erring low breaks the user's next turn.
 */
export const FABLE_MIN_CLI_VERSION = [2, 1, 220] as const;

const FABLE_ALIASES = new Set(['fable', 'fable[1m]']);

/**
 * Shape check for a model string typed by hand rather than picked from the
 * catalog — full IDs (`claude-opus-4-8`), dated Vertex snapshots
 * (`claude-opus-4-5@20251101`), Bedrock ARNs and CCR's `vendor/model` and
 * `vendor,model` forms all need to pass through untouched.
 *
 * This is a safety check, not a validity check: whether the ID exists is the
 * CLI's and the API's business. What it does guarantee is that the value can't
 * be mistaken for something other than a model name — leading `-` would make
 * `--model <value>` swallow it as a flag, and whitespace would split the argv
 * entry.
 */
const PASSTHROUGH_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/@,:[\]-]{0,99}$/;

export function isPassthroughModelId(value: string): boolean {
  return PASSTHROUGH_MODEL_RE.test(value);
}

/** Split out so it can be unit-tested without spawning a binary. */
export function filterModelsForVersion(
  models: ModelInfo[],
  supportsFable: boolean,
): ModelInfo[] {
  if (supportsFable) return models;
  return models.filter((m) => !FABLE_ALIASES.has(m.id));
}

/**
 * The aliases `bin` can actually serve. A failed probe is treated as "too old"
 * so an unreadable binary costs the user a menu entry rather than a turn.
 */
export async function getModelsForBinary(bin: string): Promise<ModelInfo[]> {
  const version = await getClaudeVersion(bin);
  return filterModelsForVersion(CLAUDE_MODELS, isAtLeast(version, FABLE_MIN_CLI_VERSION));
}
