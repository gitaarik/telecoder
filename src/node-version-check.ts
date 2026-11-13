/**
 * Refuse to start on a Node.js older than 22.
 *
 * Imported first by every entry point, so it runs before the modules that
 * would otherwise fail on an old runtime with an error that doesn't mention
 * the version at all. It has no imports of its own for the same reason, and
 * sticks to syntax and APIs every Node release still in use understands.
 *
 * Node 20 reached end of life in April 2026; 22 is the oldest line that still
 * gets security fixes, and the one CI runs.
 */

export const MIN_NODE_MAJOR = 22;

/** The message to print for `version` (like "v20.11.1"), or undefined if it is new enough. */
export function nodeVersionProblem(version: string, minMajor: number = MIN_NODE_MAJOR): string | undefined {
  const major = parseInt(version.replace(/^v/, '').split('.')[0], 10);
  if (Number.isFinite(major) && major >= minMajor) return undefined;
  return (
    `TeleCoder needs Node.js ${minMajor} or newer, and this is Node.js ${version}.\n` +
    `Install Node.js ${minMajor} (https://nodejs.org, or e.g. \`nvm install ${minMajor}\`), ` +
    'then run `npm install` again so native modules are rebuilt for it.'
  );
}

const problem = nodeVersionProblem(process.version);
if (problem) {
  console.error(`❌ ${problem}`);
  process.exit(1);
}
