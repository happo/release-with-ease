import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildEditorContent, formatCommitLine, stripEditorComments } from '../cli.ts';
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

  it('lists each omitted change with its reason, one comment per line', () => {
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
        '<!-- Lines like this one are discarded when the editor closes. -->',
        '<!-- Not covered by any bullet point above; add any that users should hear about: -->',
        '<!--   0e3c3fb Bump CI action (#7): CI only -->',
        '<!--   0e3c3fb Retry stalled uploads (#8): (no reason given) -->',
        '',
      ].join('\n'),
    );
  });

  it('says so when every change is covered', () => {
    assert.match(
      buildEditorContent(entry, []),
      /^<!-- Every change in this release is covered by a bullet point above\. -->$/m,
    );
  });
});

describe('stripEditorComments', () => {
  const omitted = [
    { commit: commit({ subject: 'Bump CI action', prNumber: 7 }), reason: 'CI only' },
    { commit: commit({ subject: 'Retry stalled uploads', prNumber: 8 }), reason: null },
  ];

  it('round-trips to just the entry', () => {
    const content = buildEditorContent('## 1.2.0\n\n- Add a thing\n', omitted);
    assert.strictEqual(stripEditorComments(content), '## 1.2.0\n\n- Add a thing');
  });

  it('keeps a change promoted into the notes and drops the comments around it', () => {
    const lines = buildEditorContent('## 1.2.0\n\n- Add a thing\n', omitted).split('\n');
    // Turn the last omitted change into a bullet point in place, the way
    // someone would in the editor.
    const idx = lines.findIndex(line => line.includes('Retry stalled uploads'));
    lines[idx] = '- Retry stalled uploads';
    assert.strictEqual(
      stripEditorComments(lines.join('\n')),
      '## 1.2.0\n\n- Add a thing\n\n- Retry stalled uploads',
    );
  });

  it('drops the remaining comments when some of them were deleted', () => {
    const content = buildEditorContent('## 1.2.0\n\n- Add a thing\n', omitted)
      .split('\n')
      .filter(line => !line.includes('discarded when the editor closes'))
      .join('\n');
    assert.strictEqual(stripEditorComments(content), '## 1.2.0\n\n- Add a thing');
  });

  it('keeps a comment that spans several lines', () => {
    assert.strictEqual(
      stripEditorComments('## 1.2.0\n\n- Add a thing\n<!--\nnote to self\n-->\n'),
      '## 1.2.0\n\n- Add a thing\n<!--\nnote to self\n-->',
    );
  });

  it('leaves content without comments alone, apart from surrounding whitespace', () => {
    assert.strictEqual(
      stripEditorComments('\n## 1.2.0\n\n- Add a thing\n\n'),
      '## 1.2.0\n\n- Add a thing',
    );
  });
});
