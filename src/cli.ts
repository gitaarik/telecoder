#!/usr/bin/env node
/**
 * The `telecoder` command (package.json "bin"). Everything past the shebang is
 * in ./cli/: dispatch.ts parses the arguments, ./cli/commands/ has one module
 * per subcommand.
 */

import { dispatch } from './cli/dispatch.js';

dispatch(process.argv.slice(2)).then(
  (code) => {
    // No code: the command handed the process to the bot, which exits itself.
    if (typeof code === 'number') process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
