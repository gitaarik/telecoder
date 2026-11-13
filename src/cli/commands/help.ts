import { COMMANDS, type CliIo, type CommandResult } from '../dispatch.js';

export function helpText(only?: string): string {
  const names = only && Object.hasOwn(COMMANDS, only) ? [only] : Object.keys(COMMANDS);
  const rows = names.map((name) => {
    const spec = COMMANDS[name];
    return { left: [name, spec.usage].filter(Boolean).join(' '), right: spec.summary };
  });
  const width = Math.max(...rows.map((r) => r.left.length));
  return [
    'TeleCoder: Claude Code from Telegram',
    '',
    'Usage: telecoder <command> [options]',
    '',
    'Commands:',
    ...rows.map((r) => `  ${r.left.padEnd(width)}  ${r.right}`),
    '',
    'Config is read from ~/.telecoder/.env (TELECODER_HOME moves it), or from',
    'next to package.json in a source checkout. Docs: https://telecoder.dev',
  ].join('\n');
}

export async function run(args: string[], io: CliIo): Promise<CommandResult> {
  io.out(helpText(args[0]));
  return 0;
}
