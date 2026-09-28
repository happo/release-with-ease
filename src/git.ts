import { run, safeRun } from './exec.ts';

export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

export function fetchOriginTags(): string | null {
  const res = safeRun('git fetch origin --tags');
  if (res.ok) return res.out.trim();
  return null;
}

export function getDefaultBranch(): string | null {
  // Prefer the symbolic ref on origin (set by `git clone` and `git remote set-head`).
  const symRes = safeRun('git symbolic-ref --short refs/remotes/origin/HEAD');
  if (symRes.ok) {
    const ref = symRes.out.trim();
    if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  }

  // Fall back to asking the remote and caching the result locally.
  const setHeadRes = safeRun('git remote set-head origin --auto');
  if (setHeadRes.ok) {
    const retry = safeRun('git symbolic-ref --short refs/remotes/origin/HEAD');
    if (retry.ok) {
      const ref = retry.out.trim();
      if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
    }
  }

  // Last resort: ask GitHub via gh.
  const ghRes = safeRun('gh repo view --json defaultBranchRef -q .defaultBranchRef.name');
  if (ghRes.ok) {
    const name = ghRes.out.trim();
    if (name) return name;
  }

  return null;
}

export function getCurrentBranch(): string | null {
  const res = safeRun('git symbolic-ref --short HEAD');
  if (res.ok) return res.out.trim();
  return null;
}

export function preflightChecks(): { defaultBranch: string } {
  const defaultBranch = getDefaultBranch();
  if (!defaultBranch) {
    throw new Error(
      'Could not determine the default branch. Make sure this repo has an "origin" remote.',
    );
  }

  const currentBranch = getCurrentBranch();
  if (!currentBranch) {
    throw new Error('HEAD is detached. Check out the default branch before releasing.');
  }
  if (currentBranch !== defaultBranch) {
    throw new Error(
      `Releases must be made from the default branch ("${defaultBranch}"), but the current branch is "${currentBranch}". Switch branches and try again.`,
    );
  }

  const statusRes = safeRun('git status --porcelain');
  if (!statusRes.ok) {
    throw new Error('Failed to run `git status`.');
  }
  if (statusRes.out.trim()) {
    throw new Error(
      'Working tree is not clean. Commit, stash, or discard your changes before releasing.',
    );
  }

  // Verify local branch is in sync with origin.
  const localRes = safeRun('git rev-parse HEAD');
  const remoteRes = safeRun(`git rev-parse origin/${defaultBranch}`);
  if (localRes.ok && remoteRes.ok) {
    const local = localRes.out.trim();
    const remote = remoteRes.out.trim();
    if (local !== remote) {
      const aheadRes = safeRun(`git rev-list --count origin/${defaultBranch}..HEAD`);
      const behindRes = safeRun(`git rev-list --count HEAD..origin/${defaultBranch}`);
      const ahead = aheadRes.ok ? parseInt(aheadRes.out.trim(), 10) : 0;
      const behind = behindRes.ok ? parseInt(behindRes.out.trim(), 10) : 0;
      if (behind > 0) {
        throw new Error(
          `Local "${defaultBranch}" is behind origin/${defaultBranch} by ${behind} commit(s). Pull before releasing.`,
        );
      }
      if (ahead > 0) {
        throw new Error(
          `Local "${defaultBranch}" is ahead of origin/${defaultBranch} by ${ahead} commit(s). Push or reset before releasing.`,
        );
      }
    }
  }

  return { defaultBranch };
}

/** The current commit, for restoring local state if a release fails partway through. */
export function getCurrentCommit(): string {
  return run('git rev-parse HEAD').trim();
}

/**
 * What origin currently has for a branch, straight from the remote rather
 * than the local remote-tracking ref. Null means the remote could not be
 * asked (or has no such branch), which is different from "unchanged".
 */
export function getRemoteBranchCommit(branch: string): string | null {
  const res = safeRun(`git ls-remote origin "refs/heads/${branch}"`);
  if (!res.ok) return null;
  const sha = res.out.trim().split(/\s+/)[0];
  return sha || null;
}

/**
 * Discards any local commits made since `ref` and deletes `tag` if it was
 * created, without touching origin. Only meant to run once origin is known
 * not to have the release — `preflightChecks` already guarantees the working
 * tree was clean and in sync with origin at `ref`, so this can only be
 * undoing commits/tags this run made itself. Both steps are always
 * attempted; the result is true only if both worked.
 */
export function rollbackLocalRelease(ref: string, tag: string | null): boolean {
  const tagDeleted = tag ? safeRun(`git tag -d "${tag}"`).ok : true;
  const reset = safeRun(`git reset --hard ${ref}`).ok;
  return tagDeleted && reset;
}

export function getLastVersionTag(): string | null {
  const res = safeRun('git describe --tags --match "v[0-9]*.[0-9]*.[0-9]*" --abbrev=0');
  if (res.ok) return res.out.trim();
  return null;
}

/**
 * Quotes a pathspec for the shell. The git commands below go through
 * `execSync`, so a path containing a space — or a glob the shell would expand
 * before git ever saw it — has to be quoted.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `-- <pathspec>` suffix for the log commands, or nothing at all, which
 * is the whole-repository default. Pathspecs are interpreted relative to the
 * current directory — the package being released — so `.` means "this
 * package" without anyone having to know where the repository root is.
 */
export function pathspecSuffix(paths: ReadonlyArray<string>): string {
  if (!paths.length) return '';
  return ` -- ${paths.map(shellQuote).join(' ')}`;
}

export function getCommitRange(
  lastTag: string | null,
  paths: ReadonlyArray<string> = [],
): string {
  const pathspec = pathspecSuffix(paths);
  // --first-parent walks only the mainline of history: for a PR merged via
  // a merge commit, that means the merge commit itself shows up but the
  // individual commits it brought in (only reachable through the merge's
  // second parent) do not. Direct commits to the default branch, and
  // squash-merged PRs (which are already a single commit), are unaffected.
  // This keeps release notes focused on one entry per PR/commit instead of
  // every intermediate commit a PR happened to accumulate.
  //
  // A pathspec narrows that to the mainline commits that touched the given
  // paths. Under --first-parent, a merge commit is compared against its first
  // parent only, so a PR that changed the path still shows up as its merge
  // commit — the same one entry per PR the range above produces.
  if (lastTag) {
    const res = safeRun(
      `git log --first-parent ${lastTag}..HEAD --pretty=format:%H%x1f%s%x1f%b%x1e${pathspec}`,
    );
    return res.ok ? res.out : '';
  }
  // No tag yet; use last 100 commits
  const res = safeRun(
    `git log --first-parent -n 100 --pretty=format:%H%x1f%s%x1f%b%x1e${pathspec}`,
  );
  return res.ok ? res.out : '';
}

export function parseCommits(raw: string): Array<Commit> {
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(chunk => {
      const [hash, subject, body] = chunk.split('\x1f');
      return { hash: hash ?? '', subject: subject || '', body: body || '' };
    });
}
