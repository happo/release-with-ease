import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  configuredPaths,
  parseArgs,
  UsageError,
  unscopedSubdirectoryWarning,
} from '../args.ts';
import { initRepo } from '../test-utils/gitRepo.ts';
import * as tmpfs from '../test-utils/tmpfs.ts';

describe('parseArgs', () => {
  it('defaults to a whole-repository release', () => {
    assert.deepStrictEqual(parseArgs([]), { dryRun: false, paths: [] });
  });

  it('recognizes --dry-run', () => {
    assert.strictEqual(parseArgs(['--dry-run']).dryRun, true);
  });

  it('takes a path as a separate argument', () => {
    assert.deepStrictEqual(parseArgs(['--path', 'packages/cli']).paths, ['packages/cli']);
  });

  it('takes a path with =', () => {
    assert.deepStrictEqual(parseArgs(['--path=packages/cli']).paths, ['packages/cli']);
  });

  it('accepts --pathspec as a synonym', () => {
    assert.deepStrictEqual(parseArgs(['--pathspec', 'a']).paths, ['a']);
    assert.deepStrictEqual(parseArgs(['--pathspec=b']).paths, ['b']);
  });

  it('collects repeated paths in order', () => {
    assert.deepStrictEqual(
      parseArgs(['--path', 'a', '--path=b', '--pathspec', 'c']).paths,
      ['a', 'b', 'c'],
    );
  });

  it('combines a path with --dry-run in either order', () => {
    assert.deepStrictEqual(parseArgs(['--dry-run', '--path', 'a']), {
      dryRun: true,
      paths: ['a'],
    });
    assert.deepStrictEqual(parseArgs(['--path', 'a', '--dry-run']), {
      dryRun: true,
      paths: ['a'],
    });
  });

  it('does not let --path swallow the next flag', () => {
    // Silently releasing the whole repository is the outcome worth refusing.
    assert.throws(() => parseArgs(['--path', '--dry-run']), UsageError);
  });

  it('refuses --path with nothing after it', () => {
    assert.throws(() => parseArgs(['--path']), /--path needs a value/);
  });

  it('refuses an empty --path=', () => {
    assert.throws(() => parseArgs(['--path=']), /--path= needs a value/);
  });

  it('does not treat a path that looks like a value as a flag', () => {
    assert.deepStrictEqual(parseArgs(['--path', './packages/cli']).paths, [
      './packages/cli',
    ]);
  });
});

describe('configuredPaths', () => {
  it('is empty when nothing is configured', () => {
    assert.deepStrictEqual(configuredPaths({}), []);
    assert.deepStrictEqual(configuredPaths({ 'release-with-ease': {} }), []);
  });

  it('accepts a single path string', () => {
    assert.deepStrictEqual(configuredPaths({ 'release-with-ease': { paths: '.' } }), ['.']);
  });

  it('accepts an array', () => {
    assert.deepStrictEqual(
      configuredPaths({ 'release-with-ease': { paths: ['a', 'b'] } }),
      ['a', 'b'],
    );
  });

  it('accepts the singular "path" key', () => {
    assert.deepStrictEqual(configuredPaths({ 'release-with-ease': { path: 'a' } }), ['a']);
  });

  it('prefers "paths" when both are given', () => {
    assert.deepStrictEqual(
      configuredPaths({ 'release-with-ease': { paths: 'a', path: 'b' } }),
      ['a'],
    );
  });

  it('trims surrounding whitespace', () => {
    assert.deepStrictEqual(configuredPaths({ 'release-with-ease': { paths: '  a  ' } }), [
      'a',
    ]);
  });

  it('refuses an empty array', () => {
    assert.throws(
      () => configuredPaths({ 'release-with-ease': { paths: [] } }),
      /must be a path, or an array of paths/,
    );
  });

  it('refuses a blank entry rather than releasing everything', () => {
    assert.throws(() => configuredPaths({ 'release-with-ease': { paths: ['a', '  '] } }), UsageError);
  });

  it('refuses a non-string entry', () => {
    assert.throws(
      () => configuredPaths({ 'release-with-ease': { paths: [42] } } as never),
      UsageError,
    );
  });
});

describe('unscopedSubdirectoryWarning', () => {
  afterEach(() => {
    tmpfs.restore();
  });

  it('says nothing when paths are already set', () => {
    tmpfs.mock({});
    initRepo();
    assert.strictEqual(unscopedSubdirectoryWarning(['.'], { name: 'pkg' }), null);
  });

  it('says nothing at the repository root', () => {
    tmpfs.mock({});
    initRepo();
    assert.strictEqual(unscopedSubdirectoryWarning([], { name: 'pkg' }), null);
  });

  it('says nothing outside a git repository', () => {
    tmpfs.mock({});
    assert.strictEqual(unscopedSubdirectoryWarning([], { name: 'pkg' }), null);
  });

  it('warns when releasing a package from a subdirectory with no paths', () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit({ 'packages/cli/package.json': '{}' }, 'Add a package');
    process.chdir(tmpfs.fullPath('work/packages/cli'));

    const warning = unscopedSubdirectoryWarning([], { name: 'my-cli' });
    assert.match(warning ?? '', /my-cli lives in a subdirectory/);
    assert.match(warning ?? '', /Pass --path \./);
  });

  it('falls back to a generic name when the package has none', () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit({ 'packages/cli/package.json': '{}' }, 'Add a package');
    process.chdir(tmpfs.fullPath('work/packages/cli'));

    assert.match(unscopedSubdirectoryWarning([], {}) ?? '', /This package lives in a subdirectory/);
  });
});
