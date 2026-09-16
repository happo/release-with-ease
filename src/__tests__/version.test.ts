import assert from 'node:assert';
import { describe, it } from 'node:test';

import { bumpVersionString, isBump } from '../version.ts';

describe('bumpVersionString', () => {
  it('bumps major and zeroes the rest', () => {
    assert.strictEqual(bumpVersionString('1.2.3', 'major'), '2.0.0');
  });

  it('bumps minor and zeroes the patch', () => {
    assert.strictEqual(bumpVersionString('1.2.3', 'minor'), '1.3.0');
  });

  it('bumps patch', () => {
    assert.strictEqual(bumpVersionString('1.2.3', 'patch'), '1.2.4');
  });

  it('does not treat the parts as strings', () => {
    assert.strictEqual(bumpVersionString('9.9.9', 'patch'), '9.9.10');
    assert.strictEqual(bumpVersionString('0.0.0', 'major'), '1.0.0');
  });

  it('throws on a version it cannot parse', () => {
    for (const bad of ['1.2', 'v1.2.3', '', 'next', '1.2.x']) {
      assert.throws(
        () => bumpVersionString(bad, 'patch'),
        /Invalid version in package\.json/,
        `expected ${JSON.stringify(bad)} to throw`,
      );
    }
  });

  it('ignores a prerelease suffix rather than corrupting it', () => {
    // Documents today's behaviour: the suffix is dropped, not carried over.
    assert.strictEqual(bumpVersionString('1.2.3-beta.1', 'patch'), '1.2.4');
  });
});

describe('isBump', () => {
  it('accepts the three semver keywords', () => {
    assert.ok(isBump('major'));
    assert.ok(isBump('minor'));
    assert.ok(isBump('patch'));
  });

  it('rejects anything else', () => {
    assert.ok(!isBump('Major'));
    assert.ok(!isBump('y'));
    assert.ok(!isBump(''));
  });
});
