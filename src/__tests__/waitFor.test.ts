import assert from 'node:assert';

import { afterEach, describe, it } from 'vitest';

import { initRepo } from '../test-utils/gitRepo.ts';
import * as tmpfs from '../test-utils/tmpfs.ts';
import { checkWaitFor, waitForMessage } from '../waitFor.ts';

const SERVER = { paths: ['projects/server'], tagPrefix: 'server@' };

describe('checkWaitFor', () => {
  afterEach(() => {
    tmpfs.restore();
  });

  it('is released when nothing under its paths changed since its tag', () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit({ 'projects/server/index.js': 'v1' }, 'Add the server');
    repo.git('tag', 'server@1.0.0');
    repo.commit({ 'projects/docs/index.md': 'docs' }, 'Write the docs');

    assert.deepStrictEqual(checkWaitFor(SERVER), {
      kind: 'released',
      tag: 'server@1.0.0',
    });
  });

  it('lists the mainline commits under its paths since its tag', () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit({ 'projects/server/index.js': 'v1' }, 'Add the server');
    repo.git('tag', 'server@1.0.0');
    repo.commit({ 'projects/server/index.js': 'v2' }, 'Teach the server');
    repo.commit({ 'projects/docs/index.md': 'docs' }, 'Write the docs');

    const status = checkWaitFor(SERVER);
    assert.strictEqual(status.kind, 'unreleased');
    assert.strictEqual(
      status.kind === 'unreleased' && status.tag,
      'server@1.0.0',
    );
    assert.deepStrictEqual(
      status.kind === 'unreleased' && status.commits.map((c) => c.subject),
      ['Teach the server'],
    );
  });

  it('takes the paths relative to the current directory', () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit(
      { 'projects/server/index.js': 'v1', 'projects/docs/index.md': 'a' },
      'Add both',
    );
    repo.git('tag', 'server@1.0.0');
    repo.commit({ 'projects/server/index.js': 'v2' }, 'Teach the server');
    process.chdir(tmpfs.fullPath('work/projects/docs'));

    const status = checkWaitFor({ paths: ['../server'], tagPrefix: 'server@' });
    assert.strictEqual(status.kind, 'unreleased');
  });

  it('cannot tell without a release to compare with', () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit({ 'projects/server/index.js': 'v1' }, 'Add the server');
    repo.git('tag', 'v1.0.0');

    assert.deepStrictEqual(checkWaitFor(SERVER), { kind: 'never-released' });
  });
});

describe('waitForMessage', () => {
  it('says nothing when everything is released', () => {
    assert.strictEqual(
      waitForMessage(SERVER, { kind: 'released', tag: 'server@1.0.0' }),
      null,
    );
  });

  it('says it cannot tell when there is no release', () => {
    assert.match(
      waitForMessage(SERVER, { kind: 'never-released' }) ?? '',
      /No server@ release found, so there is no telling whether projects\/server has unreleased changes/,
    );
  });

  it('lists the unreleased commits and what to do about them', () => {
    const message =
      waitForMessage(SERVER, {
        kind: 'unreleased',
        tag: 'server@1.0.0',
        commits: [
          { hash: 'abcdef1234567', subject: 'Teach the server', body: '' },
        ],
      }) ?? '';
    assert.match(
      message,
      /projects\/server has 1 change since server@1\.0\.0 that is not released yet:\n {2}abcdef1 Teach the server\n/,
    );
    assert.match(message, /Release server@ first/);
  });

  it('sums up a long list', () => {
    const commits = Array.from({ length: 12 }, (_, i) => ({
      hash: `${i}`.padStart(7, '0'),
      subject: `Change ${i}`,
      body: '',
    }));
    const message =
      waitForMessage(SERVER, {
        kind: 'unreleased',
        tag: 'server@1.0.0',
        commits,
      }) ?? '';
    assert.match(message, /has 12 changes since server@1\.0\.0 that are not/);
    assert.match(message, /Change 9\n {2}\.\.\.and 2 more\n/);
    assert.doesNotMatch(message, /Change 10/);
  });
});
