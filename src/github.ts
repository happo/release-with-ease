import { safeRun } from './exec.ts';
import { pathspecSuffix, type Commit } from './git.ts';

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: { login: string } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergeCommit: { oid: string } | null;
}

export interface CommitWithMeta extends Commit {
  githubLogin: string | null;
  prNumber: number | null;
}

export function extractPrNumber(subject: string, body: string): number | null {
  // "(#123)" suffix — squash-merge style
  const m = subject.match(/\(#(\d+)\)\s*$/);
  if (m?.[1]) return parseInt(m[1], 10);
  // "Merge pull request #123" — merge commit style
  const mm = subject.match(/Merge pull request #(\d+)/);
  if (mm?.[1]) return parseInt(mm[1], 10);
  // Same patterns in body
  const bm = (body || '').match(/\(#(\d+)\)\s*$/m);
  if (bm?.[1]) return parseInt(bm[1], 10);
  return null;
}

export interface OrderedStack<T> {
  /** The order entries are emitted in, bottom of the stack first. */
  prs: Array<T>;
  /** Whether git vouched for that order being a real chain of commits. */
  verified: boolean;
}

/**
 * The bottom-first order a stack's branch names imply, or null when they do
 * not describe one single chain. Each pull request in a stack is based on the
 * branch of the one below it, so the chain can be walked from whichever one
 * is not based on another's branch.
 *
 * Branch names are a claim, not proof — a name can be deleted and reused, and
 * the reused one can still spell out a plausible-looking chain — so what
 * comes back here is a candidate for `isVerifiedChain` to check against git.
 */
export function chainByBranchNames<
  T extends Pick<PullRequest, 'baseRefName' | 'headRefName'>,
>(prs: ReadonlyArray<T>): Array<T> | null {
  const heads = new Set(prs.map(pr => pr.headRefName));
  const bottom = prs.filter(pr => !heads.has(pr.baseRefName));
  if (bottom.length !== 1 || bottom[0] === undefined) return null;

  const ordered: Array<T> = [];
  let current: T | undefined = bottom[0];
  while (current && !ordered.includes(current)) {
    ordered.push(current);
    const head: string = current.headRefName;
    current = prs.find(pr => pr.baseRefName === head);
  }
  return ordered.length === prs.length ? ordered : null;
}

/**
 * Whether git agrees that an ordered stack is the chain its branch names
 * claim: every head commit is part of the merge commit, and each one builds
 * on the head below it.
 *
 * Both halves matter, and for different reasons. Checking each head against
 * the merge commit is what ties a pull request to *this* release: headRefOid
 * is where the branch head is now, which is not necessarily where it was when
 * it merged, and a branch pushed to afterwards would otherwise drag commits
 * that never landed here into the range cut for it. Checking the heads
 * against each other is what makes the ranges between them meaningful.
 *
 * A squashed merge shares no commits with the branches it came from, so it
 * cannot verify and its stack is left whole. That costs a bullet point too
 * many, which beats crediting a pull request with files it never touched.
 */
export function isVerifiedChain(
  orderedPrs: ReadonlyArray<Pick<PullRequest, 'headRefOid'>>,
  mergeSha: string,
): boolean {
  if (orderedPrs.some(pr => !pr.headRefOid)) return false;

  // `--is-ancestor` exits non-zero both when it isn't an ancestor and when
  // the objects aren't here to compare — neither is something we can measure.
  const isAncestor = (a: string, b: string) =>
    safeRun(`git merge-base --is-ancestor ${a} ${b}`).ok;

  for (const pr of orderedPrs) {
    if (!isAncestor(pr.headRefOid, mergeSha)) return false;
  }
  for (let i = 1; i < orderedPrs.length; i += 1) {
    const below = orderedPrs[i - 1]?.headRefOid;
    const above = orderedPrs[i]?.headRefOid;
    if (!below || !above || !isAncestor(below, above)) return false;
  }
  return true;
}

/**
 * The order a stack's entries are emitted in, and whether git vouched for it.
 *
 * An order git will not vouch for falls back to PR number — the order they
 * were opened in — and says so, because the same inference that puts the
 * bullet points in order is the one the ranges are cut along. Getting the
 * order wrong only shuffles bullet points; cutting ranges from a chain that
 * isn't one credits a pull request with another's files. Both come from the
 * same claim, so both wait on the same check.
 */
export function orderStack<
  T extends Pick<PullRequest, 'number' | 'baseRefName' | 'headRefName' | 'headRefOid'>,
>(prs: ReadonlyArray<T>, mergeSha: string): OrderedStack<T> {
  if (prs.length < 2) return { prs: [...prs], verified: false };

  const byNumber = (): OrderedStack<T> => ({
    prs: [...prs].sort((a, b) => a.number - b.number),
    verified: false,
  });

  const chain = chainByBranchNames(prs);
  if (!chain) return byNumber();
  if (!isVerifiedChain(chain, mergeSha)) return byNumber();
  return { prs: chain, verified: true };
}

/**
 * Whether one pull request in a stack touched the pathspec. `git log` has
 * already answered that for the stack as a whole, since the stack landed as a
 * single mainline commit; this asks the same question of the commits that are
 * this pull request's own. Anything git cannot answer counts as touched — an
 * extra bullet point is easier to spot and delete than a missing one.
 */
function prTouchedPaths(
  pr: Pick<PullRequest, 'headRefOid'>,
  baseSha: string,
  paths: ReadonlyArray<string>,
): boolean {
  const res = safeRun(
    `git log --oneline -n 1 ${baseSha}..${pr.headRefOid}${pathspecSuffix(paths)}`,
  );
  if (!res.ok) return true;
  return Boolean(res.out.trim());
}

/**
 * Narrows an ordered stack to the pull requests that touched the pathspec.
 * Each one's base is the head of the one below it, so walking a verified
 * chain in order gives every pull request a range covering only its own
 * commits. A stack git wouldn't vouch for is left whole rather than cut along
 * ranges that don't mean anything.
 */
export function filterStackByPaths<T extends Pick<PullRequest, 'headRefOid'>>(
  stack: OrderedStack<T>,
  mergeSha: string,
  paths: ReadonlyArray<string>,
): Array<T> {
  const orderedPrs = stack.prs;
  if (!paths.length || orderedPrs.length < 2 || !stack.verified) return [...orderedPrs];

  const firstParent = safeRun(`git rev-parse ${mergeSha}^1`);
  if (!firstParent.ok) return [...orderedPrs];
  let baseSha = firstParent.out.trim();

  const kept: Array<T> = [];
  for (const pr of orderedPrs) {
    if (prTouchedPaths(pr, baseSha, paths)) kept.push(pr);
    baseSha = pr.headRefOid;
  }
  // The mainline commit did touch the pathspec, so an unattributed stack is
  // a better answer than no entry at all.
  return kept.length ? kept : [...orderedPrs];
}

export function fetchGitHubMeta(
  commits: ReadonlyArray<Commit>,
  lastTag: string | null,
  paths: ReadonlyArray<string> = [],
): Array<CommitWithMeta> {
  // Without gh there is no repository to ask about, but the commit messages
  // are still here and still say which pull request they came from.
  const repoRes = safeRun('gh repo view --json nameWithOwner -q .nameWithOwner');
  if (!repoRes.ok) {
    return commits.map(c => ({
      ...c,
      githubLogin: null,
      prNumber: extractPrNumber(c.subject, c.body),
    }));
  }
  const [owner, repo] = repoRes.out.trim().split('/');

  // SHA → GitHub login via compare API (best-effort)
  const shaToLogin: Record<string, string> = {};
  if (lastTag) {
    const cmpRes = safeRun(
      `gh api "repos/${owner}/${repo}/compare/${lastTag}...HEAD" --jq '.commits[] | [.sha, (.author.login // "")] | @tsv'`,
    );
    if (cmpRes.ok) {
      for (const line of cmpRes.out.trim().split('\n').filter(Boolean)) {
        const [sha, login] = line.split('\t');
        if (sha && login) shaToLogin[sha] = login;
      }
    }
  }

  // Merge commit SHA → PRs via pr list (best-effort). We key off the actual
  // merge/squash commit SHA on the default branch so this works for both
  // "Create a merge commit" and "Squash and merge" workflows.
  //
  // One SHA can carry several pull requests. GitHub merges a stacked pull
  // request as a single commit on the mainline, and every pull request in
  // the stack reports that one commit as its merge commit — so keying a
  // single PR per SHA would silently drop all but one of them.
  const shaToPrs: Record<string, Array<PullRequest>> = {};
  const prRes = safeRun(
    `gh pr list --state merged --limit 100 --json number,mergeCommit,title,body,author,baseRefName,headRefName,headRefOid`,
  );
  if (prRes.ok) {
    try {
      for (const pr of JSON.parse(prRes.out) as Array<PullRequest>) {
        const oid = pr.mergeCommit?.oid;
        if (!oid) continue;
        (shaToPrs[oid] ??= []).push(pr);
      }
    } catch {
      // Malformed JSON from gh; fall back to per-commit heuristics below.
    }
  }

  return commits.flatMap((c): Array<CommitWithMeta> => {
    const prs = shaToPrs[c.hash];
    if (!prs || !prs.length) {
      return [
        {
          ...c,
          githubLogin: shaToLogin[c.hash] ?? null,
          prNumber: extractPrNumber(c.subject, c.body),
        },
      ];
    }

    // Prefer each PR's own title/description over the raw commit message.
    // For real merge commits this replaces the generic "Merge pull
    // request #N from owner/branch" subject; for both merge and squash
    // commits it also replaces individual/internal commit wording (e.g.
    // fixup commits) with the summary already written for the PR, so we
    // don't duplicate or leak commit-level detail into release notes.
    //
    // A stack contributes one entry per pull request, so the ones below the
    // top of it get described instead of disappearing into their neighbour's
    // merge commit.
    const stack = filterStackByPaths(orderStack(prs, c.hash), c.hash, paths);
    return stack.map(pr => ({
      ...c,
      subject: pr.title || c.subject,
      body: pr.body || c.body,
      githubLogin: pr.author?.login ?? shaToLogin[c.hash] ?? null,
      prNumber: pr.number,
    }));
  });
}
