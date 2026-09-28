import assert from 'node:assert';
import { describe, it } from 'vitest';

import { releaseName } from '../tags.ts';

describe('releaseName', () => {
  it('keeps the v1.2.3 shape it always had by default', () => {
    assert.deepStrictEqual(releaseName('v', '1.2.3'), {
      tag: 'v1.2.3',
      label: '1.2.3',
      title: 'v1.2.3',
    });
  });

  it('names a <name>@ release after its package', () => {
    assert.deepStrictEqual(releaseName('server@', '18.19.0'), {
      tag: 'server@18.19.0',
      label: 'server@18.19.0',
      title: 'server 18.19.0',
    });
  });

  it('handles a scoped package name', () => {
    assert.deepStrictEqual(releaseName('@happo/cli@', '1.0.0'), {
      tag: '@happo/cli@1.0.0',
      label: '@happo/cli@1.0.0',
      title: '@happo/cli 1.0.0',
    });
  });

  it('uses the tag as the title for any other prefix', () => {
    assert.strictEqual(releaseName('server-v', '1.0.0').title, 'server-v1.0.0');
  });

  it('does not make a nameless title from a bare @', () => {
    assert.strictEqual(releaseName('@', '1.0.0').title, '@1.0.0');
  });
});
