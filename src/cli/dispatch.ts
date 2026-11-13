/**
 * `telecoder <command>` — argument parsing and the command table.
 *
 * Each command lives in its own module under ./commands/ and is imported only
 * when it runs, so `telecoder --version` never loads the bot (whose config
 * module reads and validates the .env as it is imported).
 *
 * A command resolves with an exit code, or with nothing when it has handed the
 * process over to something long-running (`start`), which then owns the exit.
 *
 * Adding a command: write ./commands/<name>.ts exporting `run(args, io)`, and
 * add an entry below.
 */

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const defaultIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export type CommandResult = number | void;

export interface CommandModule {
  run(args: string[], io: CliIo): Promise<CommandResult>;
}

export interface CommandSpec {
  /** One line for `telecoder help`. */
  summary: string;
  /** Shown after the name in the help listing, e.g. `[--live]`. */
  usage?: string;
  load: () => Promise<CommandModule>;
}

export const COMMANDS: Record<string, CommandSpec> = {
  start: {
    summary: 'Run the bot; all of instances.json when it exists',
    usage: '[--single|--multi]',
    load: () => import('./commands/start.js'),
  },
  doctor: {
    summary: 'Check that everything TeleCoder needs is in place',
    usage: '[--live]',
    load: () => import('./commands/doctor.js'),
  },
  init: {
    summary: 'Set up a bot step by step: token, owner, workspace; writes the .env',
    usage: '[options]',
    load: () => import('./commands/init.js'),
  },
  service: {
    summary: 'Run it in the background: systemd (Linux) or launchd (macOS)',
    usage: 'install|status|logs|restart|uninstall',
    load: () => import('./commands/service.js'),
  },
  help: {
    summary: 'Show this help',
    load: () => import('./commands/help.js'),
  },
  version: {
    summary: 'Print the installed version',
    load: () => import('./commands/version.js'),
  },
};

/** Flags that stand in for a command when given first. */
const ALIASES: Record<string, string> = {
  '--version': 'version',
  '-v': 'version',
  '-V': 'version',
  '--help': 'help',
  '-h': 'help',
};

export type Parsed =
  | { kind: 'command'; name: string; args: string[] }
  | { kind: 'unknown'; name: string };

export function parseArgs(argv: string[], commands: Record<string, CommandSpec> = COMMANDS): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: 'command', name: 'help', args: [] };
  const name = ALIASES[first] ?? first;
  if (!Object.hasOwn(commands, name)) return { kind: 'unknown', name: first };
  // `telecoder start --help` is help about start, not a start.
  if (name !== 'help' && (rest.includes('--help') || rest.includes('-h'))) {
    return { kind: 'command', name: 'help', args: [name] };
  }
  return { kind: 'command', name, args: rest };
}

export async function dispatch(
  argv: string[],
  { commands = COMMANDS, io = defaultIo }: { commands?: Record<string, CommandSpec>; io?: CliIo } = {},
): Promise<CommandResult> {
  const parsed = parseArgs(argv, commands);
  if (parsed.kind === 'unknown') {
    io.err(`Unknown command: ${parsed.name}`);
    io.err('Run "telecoder help" to see the commands.');
    return 2;
  }
  const mod = await commands[parsed.name].load();
  return mod.run(parsed.args, io);
}
