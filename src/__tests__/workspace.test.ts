import assert from 'node:assert';
import fs from 'node:fs';

import { afterEach, describe, it } from 'vitest';

import { UsageError } from '../args.ts';
import { initRepo } from '../test-utils/gitRepo.ts';
import * as tmpfs from '../test-utils/tmpfs.ts';
import { resolvePackageDir } from '../workspace.ts';

const real = (p: string) => fs.realpathSync(p);

describe('resolvePackageDir', () => {
  afterEach(() => {
    tmpfs.restore();
  });

  function monorepo() {
    const repo = initRepo();
    repo.commit(
      {
        'package.json': JSON.stringify({ name: 'root', private: true }),
        'projects/server/package.json': JSON.stringify({ name: 'server' }),
        'projects/happo-package/package.json': JSON.stringify({ name: 'happo' }),
        'projects/merrykat/apps/web/package.json': JSON.stringify({ name: '@merrykat/web' }),
      },
      'Add projects',
    );
    return repo;
  }

  it('finds a package by name, wherever it lives', () => {
    tmpfs.mock({});
    monorepo();
    assert.strictEqual(
      real(resolvePackageDir('happo')),
      real(tmpfs.fullPath('work/projects/happo-package')),
    );
    assert.strictEqual(
      real(resolvePackageDir('@merrykat/web')),
      real(tmpfs.fullPath('work/projects/merrykat/apps/web')),
    );
  });

  it('finds the root package by name', () => {
    tmpfs.mock({});
    monorepo();
    assert.strictEqual(real(resolvePackageDir('root')), real(tmpfs.fullPath('work')));
  });

  it('finds a package by name from inside another one', () => {
    tmpfs.mock({});
    monorepo();
    process.chdir(tmpfs.fullPath('work/projects/server'));
    assert.strictEqual(
      real(resolvePackageDir('happo')),
      real(tmpfs.fullPath('work/projects/happo-package')),
    );
  });

  it('takes a directory as well as a name', () => {
    tmpfs.mock({});
    monorepo();
    assert.strictEqual(
      real(resolvePackageDir('projects/server')),
      real(tmpfs.fullPath('work/projects/server')),
    );
  });

  it('prefers a directory over a package of the same name', () => {
    tmpfs.mock({});
    const repo = monorepo();
    repo.commit({ 'server/package.json': JSON.stringify({ name: 'not-server' }) }, 'Confuse');
    assert.strictEqual(real(resolvePackageDir('server')), real(tmpfs.fullPath('work/server')));
  });

  it('ignores package.json files git does not track', () => {
    tmpfs.mock({});
    monorepo();
    tmpfs.writeFile('work/node_modules/stray/package.json', JSON.stringify({ name: 'stray' }));
    assert.throws(() => resolvePackageDir('stray'), /No package named "stray"/);
  });

  it('lists the packages it did find when the name matches none', () => {
    tmpfs.mock({});
    monorepo();
    assert.throws(
      () => resolvePackageDir('nope'),
      (err: Error) =>
        err instanceof UsageError &&
        /Packages found: @merrykat\/web, happo, root, server/.test(err.message),
    );
  });

  it('refuses a name two packages share', () => {
    tmpfs.mock({});
    const repo = monorepo();
    repo.commit(
      { 'fixtures/server/package.json': JSON.stringify({ name: 'server' }) },
      'Add a fixture',
    );
    assert.throws(
      () => resolvePackageDir('server'),
      /More than one package is named "server": fixtures\/server, projects\/server/,
    );
  });

  it('skips a package.json that does not parse', () => {
    tmpfs.mock({});
    const repo = monorepo();
    repo.commit({ 'broken/package.json': '{ not json' }, 'Add a broken manifest');
    assert.strictEqual(
      real(resolvePackageDir('happo')),
      real(tmpfs.fullPath('work/projects/happo-package')),
    );
  });

  it('explains itself outside a git repository', () => {
    tmpfs.mock({});
    assert.throws(() => resolvePackageDir('server'), /not a git repository/);
  });
});
