/**
 * Terminal I/O for `telecoder init`, behind an interface the wizard's tests
 * replace with a script of answers.
 *
 * node:readline/promises, no prompt library. The one thing readline doesn't do
 * is hide what is typed, so its output goes through a stream that can be
 * muted: while a secret is read, the echo of each keystroke is dropped.
 *
 * Ctrl+C anywhere — at a prompt or while waiting on Telegram — aborts `signal`,
 * and whatever was waiting rejects with an AbortError.
 */

import { spawnSync } from 'child_process';
import * as readline from 'readline/promises';
import { Writable } from 'stream';

export interface Prompter {
  /** True when there is someone at a terminal to answer. */
  readonly interactive: boolean;
  /** Aborted by Ctrl+C. */
  readonly signal: AbortSignal;
  say(line?: string): void;
  /** Free text. Enter on an empty line returns `def` (or ''). */
  ask(question: string, opts?: { default?: string; signal?: AbortSignal }): Promise<string>;
  /** Hidden input, for tokens and keys. */
  secret(question: string): Promise<string>;
  confirm(question: string, def: boolean): Promise<boolean>;
  /** Pick one of `choices` by its key. */
  choose<K extends string>(question: string, choices: Array<{ key: K; label: string }>, def: K): Promise<K>;
  /** Hand the terminal to another program until it exits. */
  runAttached(cmd: string, args: string[]): number | null;
  close(): void;
}

export class AbortedError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createTerminalPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Prompter {
  const interactive = Boolean(input.isTTY);
  const controller = new AbortController();
  let muted = false;
  const echo = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });

  let rl: readline.Interface | undefined;
  const open = (): readline.Interface => {
    if (rl) return rl;
    rl = readline.createInterface({ input, output: echo, terminal: interactive });
    rl.on('SIGINT', () => controller.abort(new AbortedError()));
    return rl;
  };

  const question = async (text: string, signal?: AbortSignal): Promise<string> => {
    if (controller.signal.aborted) throw new AbortedError();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      return await open().question(text, { signal: combined });
    } catch (error) {
      if (combined.aborted) throw new AbortedError();
      throw error;
    }
  };

  const prompter: Prompter = {
    interactive,
    signal: controller.signal,
    say: (line = '') => { output.write(`${line}\n`); },
    async ask(text, opts = {}) {
      const hint = opts.default ? ` [${opts.default}]` : '';
      const answer = (await question(`${text}${hint} `, opts.signal)).trim();
      return answer || opts.default || '';
    },
    async secret(text) {
      output.write(`${text} (input hidden) `);
      muted = true;
      try {
        return (await question('')).trim();
      } finally {
        muted = false;
        output.write('\n');
      }
    },
    async confirm(text, def) {
      for (;;) {
        const answer = (await question(`${text} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
        if (!answer) return def;
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
      }
    },
    async choose(text, choices, def) {
      output.write(`${text}\n`);
      choices.forEach((c, i) => output.write(`  ${i + 1}) ${c.label}${c.key === def ? '  (default)' : ''}\n`));
      for (;;) {
        const answer = (await question(`Choose 1-${choices.length} [${choices.findIndex((c) => c.key === def) + 1}] `)).trim();
        if (!answer) return def;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].key;
        const byKey = choices.find((c) => c.key === answer.toLowerCase());
        if (byKey) return byKey.key;
      }
    },
    runAttached(cmd, args) {
      // readline holds the terminal in raw mode; give it back for the child.
      rl?.close();
      rl = undefined;
      const result = spawnSync(cmd, args, { stdio: 'inherit' });
      return result.status;
    },
    close() {
      rl?.close();
      rl = undefined;
    },
  };
  return prompter;
}
