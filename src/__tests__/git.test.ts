import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import {
  getCommitRange,
  getCurrentBranch,
  getDefaultBranch,
  getLastVersionTag,
  parseCommits,
  pathspecSuffix,
  preflightChecks,
  shellQuote,
} from '../git.ts';
import { initRepo, mergeTwoDeepStack } from '../test-utils/gitRepo.ts';
import * as tmpfs from '../test-utils/tmpfs.ts';

const subjects = (raw: string) => parseCommits(raw).map(c => c.subject);

describe('shellQuote', () => {
  it('wraps a plain path', () => {
    assert.strictEqual(shellQuote('packages/cli'), "'packages/cli'");
  });

  it('survives a path with a space', () => {
    assert.strictEqual(shellQuote('my packages/cli'), "'my packages/cli'");
  });

  // The point of quoting is what the shell does with the result, so round-trip
  // it through a real one rather than asserting on the escaping by eye.
  const echoed = (value: string) =>
    execSync(`printf %s ${shellQuote(value)}`, { encoding: 'utf8', shell: '/bin/sh' });

  it('escapes an embedded single quote so the shell cannot break out', () => {
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
    assert.strictEqual(echoed("it's"), "it's");
  });

  it('keeps a glob from being expanded by the shell', () => {
    assert.strictEqual(echoed('packages/*'), 'packages/*');
  });

  it('does not let a path run a second command', () => {
    assert.strictEqual(echoed("'; echo pwned; '"), "'; echo pwned; '");
  });

  it('passes a path with a space through as one word', () => {
    assert.strictEqual(echoed('my packages/cli'), 'my packages/cli');
  });
});

describe('pathspecSuffix', () => {
  it('is empty for no paths, so the whole repository is the default', () => {
    assert.strictEqual(pathspecSuffix([]), '');
  });

  it('builds a -- suffix for one path', () => {
    assert.strictEqual(pathspecSuffix(['packages/cli']), " -- 'packages/cli'");
  });

  it('joins several paths', () => {
    assert.strictEqual(
      pathspecSuffix(['packages/cli', 'packages/shared']),
      " -- 'packages/cli' 'packages/shared'",
    );
  });
});

describe('parseCommits', () => {
  it('is empty for empty input', () => {
    assert.deepStrictEqual(parseCommits(''), []);
  });

  it('splits records and fields on the separators git was told to use', () => {
    const raw = 'abc\x1fSubject one\x1fBody one\x1e\ndef\x1fSubject two\x1f\x1e';
    assert.deepStrictEqual(parseCommits(raw), [
      { hash: 'abc', subject: 'Subject one', body: 'Body one' },
      { hash: 'def', subject: 'Subject two', body: '' },
    ]);
  });

  it('keeps a multi-line body in one record', () => {
    const parsed = parseCommits('abc\x1fSubject\x1fline one\nline two\x1e');
    assert.strictEqual(parsed[0]?.body, 'line one\nline two');
  });
});

describe('against a real repository', () => {
  afterEach(() => {
    tmpfs.restore();
  });

  describe('getCurrentBranch / getDefaultBranch', () => {
    it('reports the checked-out branch', () => {
      tmpfs.mock({});
      const repo = initRepo();
      assert.strictEqual(getCurrentBranch(), 'main');

      repo.git('checkout', '-b', 'some-feature');
      assert.strictEqual(getCurrentBranch(), 'some-feature');
    });

    it('is null on a detached HEAD', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('checkout', '--detach', 'HEAD');
      assert.strictEqual(getCurrentBranch(), null);
    });

    it('reads the default branch from origin/HEAD', () => {
      tmpfs.mock({});
      initRepo();
      assert.strictEqual(getDefaultBranch(), 'main');
    });
  });

  describe('getLastVersionTag', () => {
    it('is null before anything is tagged', () => {
      tmpfs.mock({});
      initRepo();
      assert.strictEqual(getLastVersionTag(), null);
    });

    it('finds the most recent v-prefixed tag', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.commit({ 'a.txt': 'a' }, 'Add a');
      repo.git('tag', 'v1.1.0');
      repo.commit({ 'b.txt': 'b' }, 'Add b');

      assert.strictEqual(getLastVersionTag(), 'v1.1.0');
    });

    it('ignores tags that are not versions', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.commit({ 'a.txt': 'a' }, 'Add a');
      repo.git('tag', 'nightly');

      assert.strictEqual(getLastVersionTag(), 'v1.0.0');
    });
  });

  describe('preflightChecks', () => {
    it('passes on a clean default branch in sync with origin', () => {
      tmpfs.mock({});
      initRepo();
      assert.deepStrictEqual(preflightChecks(), { defaultBranch: 'main' });
    });

    it('refuses to release from a feature branch', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('checkout', '-b', 'some-feature');
      assert.throws(preflightChecks, /must be made from the default branch \("main"\)/);
    });

    it('refuses a detached HEAD', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('checkout', '--detach', 'HEAD');
      assert.throws(preflightChecks, /HEAD is detached/);
    });

    it('refuses a dirty working tree', () => {
      tmpfs.mock({});
      initRepo();
      tmpfs.writeFile('work/uncommitted.txt', 'wip');
      assert.throws(preflightChecks, /Working tree is not clean/);
    });

    it('refuses when the branch is ahead of origin', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.commit({ 'a.txt': 'a' }, 'Unpushed work');
      assert.throws(preflightChecks, /ahead of origin\/main by 1 commit/);
    });

    it('refuses when the branch is behind origin', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.commit({ 'a.txt': 'a' }, 'Pushed work');
      repo.publish();
      repo.git('reset', '--hard', 'HEAD~1');
      repo.git('fetch', 'origin');
      assert.throws(preflightChecks, /behind origin\/main by 1 commit/);
    });
  });

  describe('getCommitRange', () => {
    it('lists commits since the tag, newest first, excluding the tag itself', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.commit({ 'a.txt': 'a' }, 'Add a');
      repo.commit({ 'b.txt': 'b' }, 'Add b');

      assert.deepStrictEqual(subjects(getCommitRange('v1.0.0')), ['Add b', 'Add a']);
    });

    it('is empty when nothing landed since the tag', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');

      assert.deepStrictEqual(subjects(getCommitRange('v1.0.0')), []);
    });

    it('falls back to recent history when there is no tag yet', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.commit({ 'a.txt': 'a' }, 'Add a');

      assert.deepStrictEqual(subjects(getCommitRange(null)), ['Add a', 'Initial commit']);
    });

    it('collapses a merged branch to its merge commit, not its commits', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.git('checkout', '-b', 'feature');
      repo.commit({ 'a.txt': 'a' }, 'Internal step one');
      repo.commit({ 'a.txt': 'aa' }, 'Internal step two');
      repo.git('checkout', 'main');
      repo.git('merge', '--no-ff', 'feature', '-m', 'Add the feature (#1)');

      assert.deepStrictEqual(subjects(getCommitRange('v1.0.0')), ['Add the feature (#1)']);
    });

    it('narrows to the commits that touched a pathspec', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.commit({ 'packages/cli/index.js': 'cli' }, 'Change the cli');
      repo.commit({ 'packages/web/index.js': 'web' }, 'Change the web app');

      assert.deepStrictEqual(subjects(getCommitRange('v1.0.0', ['packages/cli'])), [
        'Change the cli',
      ]);
      assert.deepStrictEqual(subjects(getCommitRange('v1.0.0', ['packages/web'])), [
        'Change the web app',
      ]);
      assert.deepStrictEqual(subjects(getCommitRange('v1.0.0', ['packages/none'])), []);
    });

    it('still shows a merge commit when the merged work touched the pathspec', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      mergeTwoDeepStack(repo, {
        bottomFiles: { 'packages/cli/a.js': 'a' },
        topFiles: { 'packages/cli/b.js': 'b' },
        mergeMessage: 'Land the stack (#2)',
      });

      assert.deepStrictEqual(subjects(getCommitRange('v1.0.0', ['packages/cli'])), [
        'Land the stack (#2)',
      ]);
    });

    it('accepts a pathspec containing a space', () => {
      tmpfs.mock({});
      const repo = initRepo();
      repo.git('tag', 'v1.0.0');
      repo.commit({ 'my packages/a.js': 'a' }, 'Change the spaced package');
      repo.commit({ 'other/b.js': 'b' }, 'Change something else');

      assert.deepStrictEqual(subjects(getCommitRange('v1.0.0', ['my packages'])), [
        'Change the spaced package',
      ]);
    });
  });
});
