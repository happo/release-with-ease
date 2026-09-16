import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  extractPrNumber,
  fetchGitHubMeta,
  filterStackByPaths,
  isVerifiedChain,
  orderStack,
  type PullRequest,
} from '../github.ts';
import { getCommitRange, parseCommits } from '../git.ts';
import * as fakeGh from '../test-utils/fakeGh.ts';
import { initRepo, mergeTwoDeepStack, type Repo } from '../test-utils/gitRepo.ts';
import * as tmpfs from '../test-utils/tmpfs.ts';

function pr(overrides: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    title: `PR ${overrides.number}`,
    body: '',
    author: { login: 'someone' },
    baseRefName: 'main',
    headRefName: `branch-${overrides.number}`,
    headRefOid: '',
    mergeCommit: null,
    ...overrides,
  };
}

const numbers = (prs: ReadonlyArray<{ number: number }>) => prs.map(p => p.number);

describe('extractPrNumber', () => {
  it('reads a squash-merge subject', () => {
    assert.strictEqual(extractPrNumber('Add a thing (#123)', ''), 123);
  });

  it('reads a merge-commit subject', () => {
    assert.strictEqual(extractPrNumber('Merge pull request #123 from o/branch', ''), 123);
  });

  it('falls back to the body', () => {
    assert.strictEqual(extractPrNumber('Add a thing', 'Add a thing (#123)'), 123);
  });

  it('is null when there is no number to find', () => {
    assert.strictEqual(extractPrNumber('Add a thing', 'No number here'), null);
  });

  it('ignores an issue reference that is not a merge marker', () => {
    assert.strictEqual(extractPrNumber('Fix #123 for real', ''), null);
  });
});

describe('orderStack', () => {
  it('leaves a single pull request alone', () => {
    assert.deepStrictEqual(numbers(orderStack([pr({ number: 7 })])), [7]);
  });

  it('orders a chain bottom-first regardless of the order it arrives in', () => {
    // gh returns newest first, which for a stack is the top of it.
    const bottom = pr({ number: 1, baseRefName: 'main', headRefName: 'a' });
    const middle = pr({ number: 2, baseRefName: 'a', headRefName: 'b' });
    const top = pr({ number: 3, baseRefName: 'b', headRefName: 'c' });

    assert.deepStrictEqual(numbers(orderStack([top, middle, bottom])), [1, 2, 3]);
  });

  it('does not assume PR number matches stack order', () => {
    // A stack can be reordered, or a lower pull request opened later.
    const bottom = pr({ number: 9, baseRefName: 'main', headRefName: 'a' });
    const top = pr({ number: 4, baseRefName: 'a', headRefName: 'b' });

    assert.deepStrictEqual(numbers(orderStack([top, bottom])), [9, 4]);
  });

  it('falls back to PR number when the chain forks', () => {
    const bottom = pr({ number: 1, baseRefName: 'main', headRefName: 'a' });
    const one = pr({ number: 3, baseRefName: 'a', headRefName: 'b' });
    const other = pr({ number: 2, baseRefName: 'a', headRefName: 'c' });

    assert.deepStrictEqual(numbers(orderStack([one, other, bottom])), [1, 2, 3]);
  });

  it('falls back to PR number when there is no bottom', () => {
    const a = pr({ number: 5, baseRefName: 'b', headRefName: 'a' });
    const b = pr({ number: 2, baseRefName: 'a', headRefName: 'b' });

    assert.deepStrictEqual(numbers(orderStack([a, b])), [2, 5]);
  });

  it('falls back to PR number for unrelated pull requests sharing a commit', () => {
    const a = pr({ number: 8, baseRefName: 'main', headRefName: 'a' });
    const b = pr({ number: 3, baseRefName: 'main', headRefName: 'b' });

    assert.deepStrictEqual(numbers(orderStack([a, b])), [3, 8]);
  });
});

describe('against a real merged stack', () => {
  afterEach(() => {
    fakeGh.restore();
    tmpfs.restore();
  });

  function buildStack(): { repo: Repo; stack: ReturnType<typeof mergeTwoDeepStack> } {
    tmpfs.mock({});
    const repo = initRepo();
    repo.git('tag', 'v1.0.0');
    const stack = mergeTwoDeepStack(repo, {
      bottomBranch: 'allowlist',
      topBranch: 'webrtc',
      bottomFiles: { 'src/allowlist.js': 'a', 'src/shared.js': 'shared v1' },
      topFiles: { 'src/webrtc.js': 'w', 'src/shared.js': 'shared v2' },
      mergeMessage: 'Stop WebRTC talking to the network (#2)',
    });
    return { repo, stack };
  }

  function stackPrs(stack: ReturnType<typeof mergeTwoDeepStack>): Array<PullRequest> {
    // Newest first, the order `gh pr list` actually returns.
    return [
      pr({
        number: 2,
        title: 'Stop WebRTC talking to the network',
        baseRefName: 'allowlist',
        headRefName: 'webrtc',
        headRefOid: stack.topHeadSha,
        mergeCommit: { oid: stack.mergeSha },
        author: { login: 'lencioni' },
      }),
      pr({
        number: 1,
        title: 'Let targets restrict which hostnames the browser may reach',
        baseRefName: 'main',
        headRefName: 'allowlist',
        headRefOid: stack.bottomHeadSha,
        mergeCommit: { oid: stack.mergeSha },
        author: { login: 'lencioni' },
      }),
    ];
  }

  describe('isVerifiedChain', () => {
    it('accepts a chain git can confirm', () => {
      const { stack } = buildStack();
      assert.ok(
        isVerifiedChain([
          { headRefOid: stack.bottomHeadSha },
          { headRefOid: stack.topHeadSha },
        ]),
      );
    });

    it('rejects the chain in the wrong order', () => {
      const { stack } = buildStack();
      assert.ok(
        !isVerifiedChain([
          { headRefOid: stack.topHeadSha },
          { headRefOid: stack.bottomHeadSha },
        ]),
      );
    });

    it('rejects a pull request with no known head commit', () => {
      const { stack } = buildStack();
      assert.ok(!isVerifiedChain([{ headRefOid: stack.bottomHeadSha }, { headRefOid: '' }]));
    });

    it('rejects a head commit git has never heard of', () => {
      const { stack } = buildStack();
      assert.ok(
        !isVerifiedChain([
          { headRefOid: stack.bottomHeadSha },
          { headRefOid: '0'.repeat(40) },
        ]),
      );
    });

    it('rejects two branches that merely share an ancestor', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('checkout', '-b', 'one', 'main');
      const oneHead = repo.commit({ 'one.js': '1' }, 'One');
      repo.git('checkout', '-b', 'two', 'main');
      const twoHead = repo.commit({ 'two.js': '2' }, 'Two');

      assert.ok(!isVerifiedChain([{ headRefOid: oneHead }, { headRefOid: twoHead }]));
    });
  });

  describe('filterStackByPaths', () => {
    it('keeps the whole stack when no pathspec is in play', () => {
      const { stack } = buildStack();
      const ordered = orderStack(stackPrs(stack));
      assert.deepStrictEqual(
        numbers(filterStackByPaths(ordered, stack.mergeSha, [])),
        [1, 2],
      );
    });

    it('keeps only the pull request that touched the path', () => {
      const { stack } = buildStack();
      const ordered = orderStack(stackPrs(stack));

      assert.deepStrictEqual(
        numbers(filterStackByPaths(ordered, stack.mergeSha, ['src/allowlist.js'])),
        [1],
      );
      assert.deepStrictEqual(
        numbers(filterStackByPaths(ordered, stack.mergeSha, ['src/webrtc.js'])),
        [2],
      );
    });

    it('keeps both when both touched the path', () => {
      const { stack } = buildStack();
      const ordered = orderStack(stackPrs(stack));
      assert.deepStrictEqual(
        numbers(filterStackByPaths(ordered, stack.mergeSha, ['src/shared.js'])),
        [1, 2],
      );
    });

    it('leaves a stack whole when git cannot verify the chain', () => {
      const { stack } = buildStack();
      // Ordering still succeeds from the branch names, but the head commit is
      // not one git can place, so no range is safe to cut.
      const ordered = orderStack(stackPrs(stack)).map(p =>
        p.number === 1 ? { ...p, headRefOid: '0'.repeat(40) } : p,
      );

      assert.deepStrictEqual(
        numbers(filterStackByPaths(ordered, stack.mergeSha, ['src/webrtc.js'])),
        [1, 2],
      );
    });

    it('leaves two unrelated pull requests sharing a commit whole', () => {
      // Siblings off main rather than a stack: neither builds on the other,
      // so ordering falls back to PR number and no range means anything.
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.git('checkout', '-b', 'one', 'main');
      const oneHead = repo.commit({ 'src/one.js': '1' }, 'One');
      repo.git('checkout', '-b', 'two', 'main');
      const twoHead = repo.commit({ 'src/two.js': '2' }, 'Two');
      repo.git('checkout', 'main');
      repo.git('merge', '--no-ff', 'one', '-m', 'Merge one');
      repo.git('merge', '--no-ff', 'two', '-m', 'Merge two');
      const mergeSha = repo.sha('HEAD');

      const siblings = [
        pr({ number: 1, headRefName: 'one', headRefOid: oneHead, mergeCommit: { oid: mergeSha } }),
        pr({ number: 2, headRefName: 'two', headRefOid: twoHead, mergeCommit: { oid: mergeSha } }),
      ];

      assert.deepStrictEqual(
        numbers(filterStackByPaths(orderStack(siblings), mergeSha, ['src/two.js'])),
        [1, 2],
      );
    });
  });

  describe('fetchGitHubMeta', () => {
    function analyze(paths: ReadonlyArray<string> = []) {
      const commits = parseCommits(getCommitRange('v1.0.0', paths));
      return fetchGitHubMeta(commits, 'v1.0.0', paths);
    }

    it('expands a stack into one entry per pull request, bottom first', () => {
      const { stack } = buildStack();
      fakeGh.install({ nameWithOwner: 'happo/test', prList: stackPrs(stack) });

      const result = analyze();

      assert.deepStrictEqual(
        result.map(c => c.prNumber),
        [1, 2],
      );
      assert.deepStrictEqual(result.map(c => c.subject), [
        'Let targets restrict which hostnames the browser may reach',
        'Stop WebRTC talking to the network',
      ]);
      // Both entries come from the one mainline commit the stack landed as.
      assert.deepStrictEqual(new Set(result.map(c => c.hash)), new Set([stack.mergeSha]));
    });

    it('attributes each entry to its own pull request author', () => {
      const { stack } = buildStack();
      const prs = stackPrs(stack);
      prs[1] = { ...prs[1]!, author: { login: 'trotzig' } };
      fakeGh.install({ nameWithOwner: 'happo/test', prList: prs });

      assert.deepStrictEqual(
        analyze().map(c => c.githubLogin),
        ['trotzig', 'lencioni'],
      );
    });

    it('limits a stack to the pull requests that touched the pathspec', () => {
      const { stack } = buildStack();
      fakeGh.install({ nameWithOwner: 'happo/test', prList: stackPrs(stack) });

      assert.deepStrictEqual(
        analyze(['src/allowlist.js']).map(c => c.prNumber),
        [1],
      );
      assert.deepStrictEqual(
        analyze(['src/webrtc.js']).map(c => c.prNumber),
        [2],
      );
      assert.deepStrictEqual(
        analyze(['src/shared.js']).map(c => c.prNumber),
        [1, 2],
      );
    });

    it('handles an ordinary one-pull-request merge unchanged', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.git('checkout', '-b', 'solo', 'main');
      const head = repo.commit({ 'solo.js': 's' }, 'Solo work');
      repo.git('checkout', 'main');
      repo.git('merge', '--no-ff', 'solo', '-m', 'Merge pull request #5 from o/solo');
      const mergeSha = repo.sha('HEAD');

      fakeGh.install({
        nameWithOwner: 'happo/test',
        prList: [
          pr({
            number: 5,
            title: 'Solo work, described properly',
            headRefName: 'solo',
            headRefOid: head,
            mergeCommit: { oid: mergeSha },
          }),
        ],
      });

      const result = analyze();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]?.prNumber, 5);
      // The pull request's title replaces the generic merge subject.
      assert.strictEqual(result[0]?.subject, 'Solo work, described properly');
    });

    it('falls back to the commit message when gh knows nothing', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.commit({ 'a.js': 'a' }, 'Add a thing (#42)');
      fakeGh.install({ nameWithOwner: 'happo/test' });

      const result = analyze();
      assert.strictEqual(result[0]?.prNumber, 42);
      assert.strictEqual(result[0]?.subject, 'Add a thing (#42)');
    });

    it('falls back to the commit message when gh is not available at all', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.commit({ 'a.js': 'a' }, 'Add a thing (#42)');
      // No nameWithOwner: `gh repo view` exits non-zero, as when unauthenticated.
      fakeGh.install({});

      const result = analyze();
      assert.strictEqual(result[0]?.prNumber, 42);
      assert.strictEqual(result[0]?.githubLogin, null);
    });

    it('survives malformed JSON from gh', () => {
      const { stack } = buildStack();
      fakeGh.install({ nameWithOwner: 'happo/test', prList: '{ not json' });

      const result = analyze();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]?.hash, stack.mergeSha);
    });

    it('uses the compare API for authors of commits with no pull request', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      const sha = repo.commit({ 'a.js': 'a' }, 'Pushed straight to main');
      fakeGh.install({ nameWithOwner: 'happo/test', compare: [[sha, 'lencioni']] });

      assert.strictEqual(analyze()[0]?.githubLogin, 'lencioni');
    });
  });
});
