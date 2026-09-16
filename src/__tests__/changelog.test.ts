import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { hasReadmeChangelog, insertChangelogEntry, readmePath } from '../changelog.ts';
import * as tmpfs from '../test-utils/tmpfs.ts';

describe('insertChangelogEntry', () => {
  it('inserts below the heading, above the previous release', () => {
    const readme = ['# Changelog', '', '## 1.0.0', '', '- First release', ''].join('\n');

    const result = insertChangelogEntry(readme, ['## 1.1.0', '', '- Add a thing']);

    assert.strictEqual(
      result,
      ['# Changelog', '', '## 1.1.0', '', '- Add a thing', '', '## 1.0.0', '', '- First release', ''].join('\n'),
    );
  });

  it('keeps everything above the Changelog heading intact', () => {
    const readme = ['# my-package', '', 'Docs go here.', '', '# Changelog', '', '## 1.0.0'].join('\n');

    const result = insertChangelogEntry(readme, ['## 1.1.0']);

    assert.match(result, /^# my-package\n\nDocs go here\.\n\n# Changelog\n\n## 1\.1\.0\n\n## 1\.0\.0$/);
  });

  it('handles a Changelog section with no entries yet', () => {
    const result = insertChangelogEntry('# Changelog\n', ['## 1.0.0', '', '- First']);
    assert.strictEqual(result, '# Changelog\n\n## 1.0.0\n\n- First\n');
  });

  it('matches the heading case-insensitively', () => {
    assert.doesNotThrow(() => insertChangelogEntry('# CHANGELOG\n\n', ['## 1.0.0']));
  });

  it('throws when there is no Changelog section', () => {
    assert.throws(
      () => insertChangelogEntry('# my-package\n\nNo changelog here.\n', ['## 1.0.0']),
      /Could not find "# Changelog" section/,
    );
  });

  it('does not mistake a sub-heading for the section', () => {
    assert.throws(
      () => insertChangelogEntry('# my-package\n\n## Changelog\n', ['## 1.0.0']),
      /Could not find "# Changelog" section/,
    );
  });
});

describe('hasReadmeChangelog', () => {
  afterEach(() => {
    tmpfs.restore();
  });

  it('is false when there is no README at all', () => {
    tmpfs.mock({});
    assert.strictEqual(hasReadmeChangelog(), false);
  });

  it('is false when the README has no Changelog section', () => {
    tmpfs.mock({ 'README.md': '# my-package\n\nDocs.\n' });
    assert.strictEqual(hasReadmeChangelog(), false);
  });

  it('is true when the README has one', () => {
    tmpfs.mock({ 'README.md': '# my-package\n\n# Changelog\n\n## 1.0.0\n' });
    assert.strictEqual(hasReadmeChangelog(), true);
  });

  it('resolves against the current directory each time it is called', () => {
    tmpfs.mock({ 'README.md': '# Changelog\n' });
    const first = readmePath();
    assert.strictEqual(hasReadmeChangelog(), true);
    tmpfs.restore();

    tmpfs.mock({ 'README.md': '# nope\n' });
    assert.notStrictEqual(readmePath(), first);
    assert.strictEqual(hasReadmeChangelog(), false);
  });
});
