import assert from 'node:assert';
import { describe, it } from 'node:test';

import { formatCommitLine } from '../cli.ts';
import type { CommitWithMeta } from '../github.ts';

function commit(overrides: Partial<CommitWithMeta> = {}): CommitWithMeta {
  return {
    hash: '0e3c3fb919ba3889f8756b2a1530b25cac0e83ec',
    subject: 'Add a thing',
    body: '',
    githubLogin: null,
    prNumber: null,
    ...overrides,
  };
}

describe('formatCommitLine', () => {
  it('abbreviates the sha to seven characters', () => {
    assert.strictEqual(formatCommitLine(commit()), '  0e3c3fb Add a thing');
  });

  it('appends the pull request number when the subject lacks it', () => {
    assert.strictEqual(
      formatCommitLine(commit({ prNumber: 1350 })),
      '  0e3c3fb Add a thing (#1350)',
    );
  });

  it('does not repeat a number the squash subject already carries', () => {
    assert.strictEqual(
      formatCommitLine(commit({ subject: 'Add a thing (#1350)', prNumber: 1350 })),
      '  0e3c3fb Add a thing (#1350)',
    );
  });

  it('still appends when the subject mentions a different number', () => {
    assert.strictEqual(
      formatCommitLine(commit({ subject: 'Follow-up to #1347', prNumber: 1350 })),
      '  0e3c3fb Follow-up to #1347 (#1350)',
    );
  });

  it('prints the two halves of a stack against the same sha', () => {
    // What the fixed script shows where it used to show only the top.
    const lines = [
      commit({ subject: 'Let targets restrict hostnames', prNumber: 1347 }),
      commit({ subject: 'Stop WebRTC talking to the network', prNumber: 1350 }),
    ].map(formatCommitLine);

    assert.deepStrictEqual(lines, [
      '  0e3c3fb Let targets restrict hostnames (#1347)',
      '  0e3c3fb Stop WebRTC talking to the network (#1350)',
    ]);
  });
});
