#!/usr/bin/env node
/**
 * The `telecoder` command (package.json "bin"). Everything past the shebang is
 * in ./cli/: dispatch.ts parses the arguments, ./cli/commands/ has one module
 * per subcommand.
 */

// First, so an old Node gets a message about its version rather than a crash.
import './node-version-check.js';
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
