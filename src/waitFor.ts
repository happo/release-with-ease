import type { WaitFor } from './args.ts';
import {
  type Commit,
  getCommitRange,
  getLastVersionTag,
  parseCommits,
} from './git.ts';

export type WaitForStatus =
  /** Nothing under its paths since its last release. */
  | { kind: 'released'; tag: string }
  /** Changes under its paths that no release of it includes yet. */
  | { kind: 'unreleased'; tag: string; commits: Array<Commit> }
  /** No release of it to compare with, so nothing can be said. */
  | { kind: 'never-released' };

/**
 * Whether the package `waitFor` names has changes on the mainline since its
 * last release. Its last release is the nearest tag under its prefix that
 * HEAD descends from, found the same way this package's own is.
 */
export function checkWaitFor(waitFor: WaitFor): WaitForStatus {
  const tag = getLastVersionTag(waitFor.tagPrefix);
  if (!tag) return { kind: 'never-released' };
  const commits = parseCommits(getCommitRange(tag, waitFor.paths));
  return commits.length
    ? { kind: 'unreleased', tag, commits }
    : { kind: 'released', tag };
}

/** How many unreleased commits are listed before the rest are summed up. */
const LISTED_COMMITS = 10;

/**
 * What to tell the publisher about one package this one waits for, or null
 * when there is nothing to say. Returned rather than printed, so the caller
 * owns the output and a test can read it.
 */
export function waitForMessage(
  waitFor: WaitFor,
  status: WaitForStatus,
): string | null {
  if (status.kind === 'released') return null;
  const where = waitFor.paths.join(', ');
  if (status.kind === 'never-released') {
    return `ℹ️  No ${waitFor.tagPrefix} release found, so there is no telling whether ${where} has unreleased changes.`;
  }
  const { commits, tag } = status;
  const listed = commits
    .slice(0, LISTED_COMMITS)
    .map((c) => `  ${c.hash.slice(0, 7)} ${c.subject}`);
  const more = commits.length - listed.length;
  return [
    `⚠️  ${where} has ${commits.length} change${commits.length === 1 ? '' : 's'} since ${tag} that ${commits.length === 1 ? 'is' : 'are'} not released yet:`,
    ...listed,
    ...(more > 0 ? [`  ...and ${more} more`] : []),
    `   This release could describe them before they ship. Release ${waitFor.tagPrefix} first, or go ahead if this release does not depend on them.`,
  ].join('\n');
}
