import { run, safeRun } from './exec.ts';
import { DEFAULT_TAG_PREFIX, type ReleaseName } from './tags.ts';

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
  const ghRes = safeRun(
    'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
  );
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
    throw new Error(
      'HEAD is detached. Check out the default branch before releasing.',
    );
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
      const aheadRes = safeRun(
        `git rev-list --count origin/${defaultBranch}..HEAD`,
      );
      const behindRes = safeRun(
        `git rev-list --count HEAD..origin/${defaultBranch}`,
      );
      const ahead = aheadRes.ok ? Number(aheadRes.out.trim()) : 0;
      const behind = behindRes.ok ? Number(behindRes.out.trim()) : 0;
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

export function getLastVersionTag(
  prefix: string = DEFAULT_TAG_PREFIX,
): string | null {
  const pattern = shellQuote(`${prefix}[0-9]*.[0-9]*.[0-9]*`);
  const res = safeRun(`git describe --tags --match ${pattern} --abbrev=0`);
  if (res.ok) return res.out.trim();
  return null;
}

export function tagExists(tag: string): boolean {
  return safeRun(
    `git rev-parse --quiet --verify ${shellQuote(`refs/tags/${tag}`)}`,
  ).ok;
}

export interface LastRelease {
  tag: string | null;
  /**
   * Whether the tag was found under the default `v` prefix rather than the
   * configured one, which is what happens on the first release after a
   * package switches to a prefix of its own.
   */
  fromDefaultPrefix: boolean;
}

/**
 * The tag of the last release, under the configured prefix. A package that
 * has just moved to a prefix of its own has no tags under it yet, and falling
 * back to "the last 100 commits" would write its first prefixed release notes
 * from far too much history — so in that case the `v` tag for the current
 * version in package.json stands in for the prefixed one. Only that exact tag: a nearer `v`
 * tag could just as well belong to another package in the same repository.
 * And only if HEAD descends from it, since a tag on a branch that never
 * merged would make `<tag>..HEAD` the whole mainline.
 */
export function getLastReleaseTag(
  prefix: string,
  currentVersion: string | undefined,
): LastRelease {
  const tag = getLastVersionTag(prefix);
  if (tag || prefix === DEFAULT_TAG_PREFIX || !currentVersion) {
    return { tag, fromDefaultPrefix: false };
  }
  const legacy = `${DEFAULT_TAG_PREFIX}${currentVersion}`;
  if (
    tagExists(legacy) &&
    safeRun(`git merge-base --is-ancestor ${shellQuote(legacy)} HEAD`).ok
  ) {
    return { tag: legacy, fromDefaultPrefix: true };
  }
  return { tag: null, fromDefaultPrefix: false };
}

/**
 * Commits the given files — the package's own, relative to the current
 * directory — and tags that commit. Nothing else is staged: the preflight
 * checks refused a dirty working tree, so the commit holds exactly what the
 * release changed.
 */
export function commitAndTagRelease(
  release: ReleaseName,
  files: ReadonlyArray<string>,
): void {
  run(`git add -- ${files.map(shellQuote).join(' ')}`);
  run(`git commit -m ${shellQuote(release.label)}`);
  run(`git tag -m ${shellQuote(release.label)} ${shellQuote(release.tag)}`);
}

/**
 * Pushes the branch and the one tag this release made. Not `--tags`: in a
 * repository several packages release from, whatever other tags happen to be
 * lying around locally have no business going out with this one.
 */
export function pushRelease(branch: string, release: ReleaseName): void {
  run(
    `git push origin ${shellQuote(branch)} ${shellQuote(`refs/tags/${release.tag}`)}`,
  );
}

/**
 * Quotes a pathspec for the shell. The git commands below go through
 * `execSync`, so a path containing a space — or a glob the shell would expand
 * before git ever saw it — has to be quoted.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
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
      `git log --first-parent ${shellQuote(`${lastTag}..HEAD`)} --pretty=format:%H%x1f%s%x1f%b%x1e${pathspec}`,
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
    .split('\u{1E}')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, subject, body] = chunk.split('\u{1F}', 3);
      return { hash: hash ?? '', subject: subject || '', body: body || '' };
    });
}
