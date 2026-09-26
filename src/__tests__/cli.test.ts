import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildEditorContent,
  EDITOR_COMMENT_MARKER,
  formatCommitLine,
  stripEditorComment,
} from '../cli.ts';
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

describe('buildEditorContent', () => {
  const entry = '## 1.2.0\n\n- Add a thing\n';

  it('lists each omitted change with its reason below the entry', () => {
    const content = buildEditorContent(entry, [
      { commit: commit({ subject: 'Bump CI action', prNumber: 7 }), reason: 'CI only' },
      { commit: commit({ subject: 'Retry stalled uploads', prNumber: 8 }), reason: null },
    ]);
    assert.strictEqual(
      content,
      [
        '## 1.2.0',
        '',
        '- Add a thing',
        '',
        EDITOR_COMMENT_MARKER,
        '',
        'These changes are not covered by any bullet point above. Add any that',
        'users should hear about:',
        '',
        '  0e3c3fb Bump CI action (#7)',
        '      CI only',
        '  0e3c3fb Retry stalled uploads (#8)',
        '      (no reason given)',
        '-->',
        '',
      ].join('\n'),
    );
  });

  it('says so when every change is covered', () => {
    assert.match(buildEditorContent(entry, []), /Every change in this release is covered/);
  });
});

describe('stripEditorComment', () => {
  it('round-trips to just the entry', () => {
    const content = buildEditorContent('## 1.2.0\n\n- Add a thing\n', [
      { commit: commit(), reason: 'internal' },
    ]);
    assert.strictEqual(stripEditorComment(content), '## 1.2.0\n\n- Add a thing');
  });

  it('keeps edits made above the marker', () => {
    const content = buildEditorContent('## 1.2.0\n\n- Add a thing\n', [
      { commit: commit(), reason: 'internal' },
    ]).replace('- Add a thing', '- Add a thing\n- Retry stalled uploads');
    assert.strictEqual(
      stripEditorComment(content),
      '## 1.2.0\n\n- Add a thing\n- Retry stalled uploads',
    );
  });

  it('refuses to guess when the marker was deleted but the rest of the context was not', () => {
    const content = buildEditorContent('## 1.2.0\n\n- Add a thing\n', [
      { commit: commit(), reason: 'internal' },
    ]).replace(`${EDITOR_COMMENT_MARKER}\n`, '');
    assert.throws(() => stripEditorComment(content), /list of omitted changes/);
  });

  it('keeps an HTML comment the user wrote themselves', () => {
    assert.strictEqual(
      stripEditorComment('## 1.2.0\n\n- Add a thing\n<!--\nnote to self\n-->\n'),
      '## 1.2.0\n\n- Add a thing\n<!--\nnote to self\n-->',
    );
  });

  it('leaves content without the marker alone, apart from surrounding whitespace', () => {
    assert.strictEqual(stripEditorComment('\n## 1.2.0\n\n- Add a thing\n\n'), '## 1.2.0\n\n- Add a thing');
  });
});
