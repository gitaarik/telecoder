/**
 * Whether the build this process loaded is the latest one, for /version.
 *
 * Same code or not comes from comparing hashes (scripts/source-hash.mjs), never
 * from commits. Git only describes a difference once there is one, and says how
 * this checkout stands against the branch it tracks.
 *
 * Any of it can fail to run: no git, no source beside the build, no network.
 * Those are results of their own, so a check that never happened can't pass for
 * a clean one.
 */

import { execFile } from 'child_process';
import type { BuildInfo } from './build-info.js';

const LOCAL_TIMEOUT_MS = 5_000;
/** ssh to GitHub takes about 1.5s, and past this nobody is still waiting on the reply. */
const REMOTE_TIMEOUT_MS = 8_000;

export type CodeCheck =
  /** No stamp to go on: under tsx, or a build that skipped it. */
  | { kind: 'unstamped' }
  /** The comparison couldn't be made: no hash in the stamp, or no source here. */
  | { kind: 'unknown' }
  | { kind: 'current' }
  /** The current code has been built, but this process is on an earlier build. */
  | { kind: 'not-loaded' }
  /** The code has moved past every build. `commits` is null when they can't be counted. */
  | { kind: 'changed'; commits: number | null; uncommitted: boolean };

export type RemoteCheck =
  /** Nothing to compare with: not on a branch, or one that tracks nothing. */
  | { kind: 'untracked' }
  | { kind: 'unreachable'; remote: string; ref: string }
  | { kind: 'same'; ref: string }
  | { kind: 'ahead'; ref: string; commits: number }
  | { kind: 'behind'; ref: string }
  | { kind: 'diverged'; ref: string };

/** What git answers, or null when it fails, for whatever reason. */
function git(
  root: string,
  args: string[],
  { timeout = LOCAL_TIMEOUT_MS, env }: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout, env }, (error, stdout) => {
      if (error) {
        // Not the message: git's stderr can carry a remote's URL, credentials included.
        console.debug(`[Version] git ${args[0]} failed (${error.code ?? error.signal})`);
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** The module that holds the hash. Found at run time because dist/ may have no scripts/ beside it. */
async function loadSourceHash(): Promise<{ hashSource(root: string): string; SOURCE_PATHS: string[] } | null> {
  try {
    return await import(new URL('../../scripts/source-hash.mjs', import.meta.url).href);
  } catch {
    return null;
  }
}

/** How many commits since `build` touch `paths`, or null when that count wouldn't mean anything. */
async function commitsSince(root: string, build: BuildInfo, paths: string[]): Promise<number | null> {
  // A build with uncommitted changes in it already holds some of what came next.
  if (!build.commit || build.dirty) return null;
  // Rewritten history or another branch: everything since the fork would count as new.
  if (await git(root, ['merge-base', '--is-ancestor', build.commit, 'HEAD']) === null) return null;
  const count = await git(root, ['rev-list', '--count', `${build.commit}..HEAD`, '--', ...paths]);
  return count === null ? null : Number(count);
}

/** Compare `running`, the build this process loaded, with the code in `root`. `latest` is the last build on disk. */
export async function checkCode(
  running: BuildInfo | null,
  latest: BuildInfo | null,
  root: string,
): Promise<CodeCheck> {
  if (!running) return { kind: 'unstamped' };

  const source = await loadSourceHash();
  if (!source || !running.sourceHash) return { kind: 'unknown' };

  let current: string;
  try {
    current = source.hashSource(root);
  } catch {
    return { kind: 'unknown' };
  }

  if (running.sourceHash === current) return { kind: 'current' };
  if (latest?.sourceHash === current) return { kind: 'not-loaded' };

  const [commits, changes] = await Promise.all([
    commitsSince(root, running, source.SOURCE_PATHS),
    git(root, ['--no-optional-locks', 'status', '--porcelain', '--', ...source.SOURCE_PATHS]),
  ]);
  return { kind: 'changed', commits, uncommitted: Boolean(changes) };
}

/** The current branch's upstream, or null on a detached HEAD or with none configured. */
async function trackedBranch(root: string): Promise<{ remote: string; remoteRef: string; ref: string } | null> {
  const branch = await git(root, ['symbolic-ref', '-q', 'HEAD']);
  if (!branch) return null;
  const upstream = await git(root, [
    'for-each-ref', '--format=%(upstream:remotename) %(upstream:remoteref) %(upstream:short)', branch,
  ]);
  const [remote, remoteRef, ref] = upstream?.split(' ') ?? [];
  return remote && remoteRef && ref ? { remote, remoteRef, ref } : null;
}

/** An environment where asking for a passphrase or a host key fails instead of waiting for an answer. */
async function promptFreeEnv(root: string): Promise<NodeJS.ProcessEnv> {
  const ssh = process.env.GIT_SSH_COMMAND || await git(root, ['config', '--get', 'core.sshCommand']) || 'ssh';
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes -o ConnectTimeout=5`,
  };
}

/**
 * How the checkout in `root` stands against the branch it tracks.
 *
 * ls-remote and not fetch: this writes nothing to a checkout that sessions may
 * be working in. So the remote's latest commit may be one this checkout has
 * never seen, which is enough to say it's behind but not by how much.
 */
export async function checkRemote(root: string, timeout = REMOTE_TIMEOUT_MS): Promise<RemoteCheck> {
  const tracked = await trackedBranch(root);
  if (!tracked) return { kind: 'untracked' };
  const { remote, remoteRef, ref } = tracked;

  const env = await promptFreeEnv(root);
  const listing = await git(root, ['ls-remote', '--', remote, remoteRef], { timeout, env });
  if (listing === null) return { kind: 'unreachable', remote, ref };

  const tip = listing.split('\n').map((line) => line.split('\t')).find(([, name]) => name === remoteRef)?.[0];
  if (!tip) return { kind: 'untracked' };

  const head = await git(root, ['rev-parse', 'HEAD']);
  if (tip === head) return { kind: 'same', ref };
  if (await git(root, ['cat-file', '-e', `${tip}^{commit}`]) === null) return { kind: 'behind', ref };

  const base = await git(root, ['merge-base', tip, 'HEAD']);
  if (base === head) return { kind: 'behind', ref };
  if (base !== tip) return { kind: 'diverged', ref };
  return { kind: 'ahead', ref, commits: Number(await git(root, ['rev-list', '--count', `${tip}..HEAD`])) };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function describeCodeCheck(check: CodeCheck): string {
  switch (check.kind) {
    case 'unstamped':
      return "❓ No build stamp, so there's nothing to compare: this is running from source, or from a build that skipped it.";
    case 'unknown':
      return "❓ Couldn't compare this build with the code here, so it may or may not be the latest.";
    case 'current':
      return '✅ This is the current code.';
    case 'not-loaded':
      return '⚠️ A newer build is on disk but not loaded. /restartbot picks it up.';
    case 'changed': {
      const { commits, uncommitted } = check;
      const parts = [
        ...(commits ? [plural(commits, 'newer commit')] : []),
        ...(uncommitted ? ['uncommitted changes'] : []),
      ];
      if (parts.length === 0) return '⚠️ The code here has changed since this build. /rebuildbot picks it up.';
      const them = commits === 1 && !uncommitted ? 'it' : 'them';
      return `⚠️ The code here has ${parts.join(' and ')}. /rebuildbot picks ${them} up.`;
    }
  }
}

/** Null when there's nothing to say: a checkout that tracks nothing can't be behind anything. */
export function describeRemoteCheck(check: RemoteCheck): string | null {
  switch (check.kind) {
    case 'untracked':
      return null;
    case 'unreachable':
      return `❓ Couldn't reach ${check.remote}, so ${check.ref} wasn't checked.`;
    case 'same':
      return `✅ ${check.ref} has nothing newer.`;
    case 'ahead':
      return `⬆️ This checkout is ${plural(check.commits, 'commit')} ahead of ${check.ref}.`;
    case 'behind':
      return `⚠️ ${check.ref} has commits this checkout doesn't. git pull, then /rebuildbot.`;
    case 'diverged':
      return `⚠️ This checkout and ${check.ref} have diverged.`;
  }
}
