import assert from 'node:assert';
import fs from 'node:fs';
import { afterEach, describe, it } from 'vitest';

import { writeVersion } from '../packageJson.ts';
import * as tmpfs from '../test-utils/tmpfs.ts';

const read = (name: string) => fs.readFileSync(tmpfs.fullPath(name), 'utf8');

describe('writeVersion', () => {
  afterEach(() => {
    tmpfs.restore();
  });

  it('changes the version and nothing else', () => {
    tmpfs.mock({});
    const before = [
      '{',
      '  "name": "pkg",',
      '  "version": "1.0.0",',
      '  "scripts": {',
      '    "test": "vitest"',
      '  },',
      '  "dependencies": {',
      '    "other": "workspace:*"',
      '  }',
      '}',
      '',
    ].join('\n');
    tmpfs.writeFile('package.json', before);

    assert.deepStrictEqual(writeVersion(tmpfs.getTempDir(), '1.1.0'), ['package.json']);
    assert.strictEqual(read('package.json'), before.replace('"1.0.0"', '"1.1.0"'));
  });

  it('keeps tab indentation', () => {
    tmpfs.mock({});
    tmpfs.writeFile('package.json', '{\n\t"name": "pkg",\n\t"version": "1.0.0"\n}\n');
    writeVersion(tmpfs.getTempDir(), '2.0.0');
    assert.strictEqual(read('package.json'), '{\n\t"name": "pkg",\n\t"version": "2.0.0"\n}\n');
  });

  it('keeps four-space indentation, CRLF line endings and a missing final newline', () => {
    tmpfs.mock({});
    tmpfs.writeFile('package.json', '{\r\n    "name": "pkg",\r\n    "version": "1.0.0"\r\n}');
    writeVersion(tmpfs.getTempDir(), '1.0.1');
    assert.strictEqual(read('package.json'), '{\r\n    "name": "pkg",\r\n    "version": "1.0.1"\r\n}');
  });

  it('adds a version to a package.json on one line without spreading it out', () => {
    tmpfs.mock({});
    tmpfs.writeFile('package.json', '{"name":"pkg","version":"1.0.0"}');
    writeVersion(tmpfs.getTempDir(), '1.0.1');
    assert.strictEqual(read('package.json'), '{"name":"pkg","version":"1.0.1"}');
  });

  it('keeps an npm lockfile in step', () => {
    tmpfs.mock({});
    tmpfs.writeFile('package.json', '{\n  "name": "pkg",\n  "version": "1.0.0"\n}\n');
    tmpfs.writeFile(
      'package-lock.json',
      JSON.stringify(
        {
          name: 'pkg',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': { name: 'pkg', version: '1.0.0' },
            'node_modules/dep': { version: '1.0.0' },
          },
        },
        null,
        2,
      ) + '\n',
    );

    assert.deepStrictEqual(writeVersion(tmpfs.getTempDir(), '1.1.0'), [
      'package.json',
      'package-lock.json',
    ]);
    const lock = JSON.parse(read('package-lock.json'));
    assert.strictEqual(lock.version, '1.1.0');
    assert.strictEqual(lock.packages[''].version, '1.1.0');
    assert.strictEqual(lock.packages['node_modules/dep'].version, '1.0.0');
  });

  it('keeps an old-style shrinkwrap without a packages map in step', () => {
    tmpfs.mock({});
    tmpfs.writeFile('package.json', '{\n  "name": "pkg",\n  "version": "1.0.0"\n}\n');
    tmpfs.writeFile(
      'npm-shrinkwrap.json',
      '{\n  "name": "pkg",\n  "version": "1.0.0",\n  "lockfileVersion": 1\n}\n',
    );

    assert.deepStrictEqual(writeVersion(tmpfs.getTempDir(), '1.0.1'), [
      'package.json',
      'npm-shrinkwrap.json',
    ]);
    assert.strictEqual(
      read('npm-shrinkwrap.json'),
      '{\n  "name": "pkg",\n  "version": "1.0.1",\n  "lockfileVersion": 1\n}\n',
    );
  });
});
