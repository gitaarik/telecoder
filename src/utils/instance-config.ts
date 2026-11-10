/**
 * Shared parsing helpers for `instances.json`. Used by both the launcher
 * (resolving instances to spawn, and again whenever the file changes) and
 * worker-side enumeration (listing sibling bots for /fork). The two have
 * different output shapes so they each parse independently — only the tiny
 * utility functions are shared between them.
 */

/** Strip full-line `//` comments so we can JSON.parse a commented config. */
export function stripJsonComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

function padNumber(n: number, total: number): string {
  const digits = String(total).length;
  return String(n).padStart(digits, '0');
}

/** Substitute `{n}` / `{N}` placeholders in a name template. */
export function expandName(template: string, index: number, total: number): string {
  return template.replace(/\{n\}/g, String(index)).replace(/\{N\}/g, padNumber(index, total));
}

// ---------------------------------------------------------------------------
// Resolving the launcher's instances
// ---------------------------------------------------------------------------

/** One bot the launcher runs: a config entry with its name template expanded. */
export interface ResolvedInstance {
  name: string;
  token: string;
  overrides?: Record<string, string>;
}

interface InstanceEntry {
  name: string;
  token?: string;    // single bot
  tokens?: string[]; // list = auto-template with sequential numbering
  overrides?: Record<string, string>;
}

interface InstancesConfig {
  defaults?: Record<string, string>;
  instances?: InstanceEntry[];
}

/** An instances.json the launcher can't run as it stands. */
export class InstancesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstancesConfigError';
  }
}

/** The bot id a token starts with (`<id>:<secret>`), or '' for a malformed one. */
export function botIdOf(token: string): string {
  return /^(\d+):\S+$/.exec(token)?.[1] ?? '';
}

/**
 * The bots an instances.json describes, in file order.
 *
 * Throws InstancesConfigError when it isn't JSON, lists no usable bot, or names
 * two bots the same or lists one bot twice. The launcher keys each worker by
 * name, so two bots sharing one would take each other's place, and one token
 * polled by two workers gets every poll after the first refused.
 *
 * An entry without a token, or with one that has no bot id, is skipped and
 * reported through `onWarning`; the rest still run.
 */
export function resolveInstances(text: string, onWarning: (message: string) => void = () => {}): ResolvedInstance[] {
  let parsed: InstancesConfig;
  try {
    parsed = JSON.parse(stripJsonComments(text)) as InstancesConfig;
  } catch (err) {
    throw new InstancesConfigError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const defaults = parsed.defaults ?? {};
  const resolved: ResolvedInstance[] = [];
  const add = (name: string, token: string, overrides: Record<string, string>): void => {
    if (!botIdOf(token)) {
      onWarning(`Skipping instance "${name}": its token isn't in the <bot id>:<secret> form`);
      return;
    }
    resolved.push({ name, token, overrides });
  };

  for (const entry of parsed.instances ?? []) {
    const overrides = { ...defaults, ...entry.overrides };
    if (entry.tokens?.length) {
      // List of tokens → auto-template: expand name with {n}/{N}
      const total = entry.tokens.length;
      entry.tokens.forEach((token, i) => add(expandName(entry.name, i + 1, total), token, overrides));
    } else if (entry.token) {
      add(entry.name, entry.token, overrides);
    } else {
      onWarning(`Skipping instance "${entry.name}": no token or tokens provided`);
    }
  }

  if (resolved.length === 0) {
    throw new InstancesConfigError('no bots to run — add instances with a token or tokens');
  }

  const names = new Set<string>();
  const ids = new Set<string>();
  for (const inst of resolved) {
    const id = botIdOf(inst.token);
    if (names.has(inst.name)) throw new InstancesConfigError(`two bots are named "${inst.name}"`);
    if (ids.has(id)) throw new InstancesConfigError(`bot ${id} is listed twice`);
    names.add(inst.name);
    ids.add(id);
  }
  return resolved;
}

/** What changed between the bots running and the bots an edited file lists. */
export interface InstancesDiff {
  /** Bots the file lists that aren't running. */
  added: ResolvedInstance[];
  /** Running bots the file no longer lists. */
  removed: ResolvedInstance[];
  /** The same bot with another token, name or setting: as running, and as listed now. */
  changed: Array<{ from: ResolvedInstance; to: ResolvedInstance }>;
}

/**
 * Compare two resolved instance lists by bot id. A bot is the same bot under a
 * new token, which is what a revoked or replaced token gives you, so a token
 * change reads as a change to that bot rather than one bot leaving and another
 * arriving.
 */
export function diffInstances(current: readonly ResolvedInstance[], next: readonly ResolvedInstance[]): InstancesDiff {
  const before = new Map(current.map((inst) => [botIdOf(inst.token), inst]));
  const after = new Map(next.map((inst) => [botIdOf(inst.token), inst]));

  const added = next.filter((inst) => !before.has(botIdOf(inst.token)));
  const removed = current.filter((inst) => !after.has(botIdOf(inst.token)));
  const changed: InstancesDiff['changed'] = [];
  for (const [id, to] of after) {
    const from = before.get(id);
    if (from && !sameInstance(from, to)) changed.push({ from, to });
  }
  return { added, removed, changed };
}

function sameInstance(a: ResolvedInstance, b: ResolvedInstance): boolean {
  if (a.name !== b.name || a.token !== b.token) return false;
  const ao = a.overrides ?? {};
  const bo = b.overrides ?? {};
  const keys = Object.keys(ao);
  return keys.length === Object.keys(bo).length && keys.every((k) => ao[k] === bo[k]);
}
