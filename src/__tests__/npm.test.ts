import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { fetchNpmOtp, isValidOtp } from '../npm.ts';

describe('isValidOtp', () => {
  it('accepts six to eight digits', () => {
    assert.ok(isValidOtp('123456'));
    assert.ok(isValidOtp('1234567'));
    assert.ok(isValidOtp('12345678'));
  });

  it('rejects the wrong length', () => {
    assert.ok(!isValidOtp('12345'));
    assert.ok(!isValidOtp('123456789'));
  });

  it('rejects anything that is not all digits', () => {
    assert.ok(!isValidOtp('12345a'));
    assert.ok(!isValidOtp(''));
    assert.ok(!isValidOtp('Enter your code'));
    assert.ok(!isValidOtp('123 456'));
  });
});

describe('fetchNpmOtp', () => {
  const originalCommand = process.env['NPM_OTP_COMMAND'];
  const originalPath = process.env['PATH'];

  afterEach(() => {
    if (originalCommand === undefined) delete process.env['NPM_OTP_COMMAND'];
    else process.env['NPM_OTP_COMMAND'] = originalCommand;
    process.env['PATH'] = originalPath;
  });

  /**
   * Empties PATH so the 1Password and LastPass probes find nothing. Without
   * this a developer running the suite could be prompted by their own vault.
   */
  function isolateFromPasswordManagers(): void {
    process.env['PATH'] = '';
  }

  it('uses NPM_OTP_COMMAND when it prints a valid code', () => {
    process.env['NPM_OTP_COMMAND'] = '/bin/echo 123456';
    isolateFromPasswordManagers();
    assert.strictEqual(fetchNpmOtp(), '123456');
  });

  it('trims whitespace around the code', () => {
    process.env['NPM_OTP_COMMAND'] = '/bin/echo "  123456  "';
    isolateFromPasswordManagers();
    assert.strictEqual(fetchNpmOtp(), '123456');
  });

  it('falls through when the command prints something that is not a code', () => {
    process.env['NPM_OTP_COMMAND'] = '/bin/echo "not a code"';
    isolateFromPasswordManagers();
    assert.strictEqual(fetchNpmOtp(), null);
  });

  it('falls through when the command fails outright', () => {
    process.env['NPM_OTP_COMMAND'] = '/bin/sh -c "exit 3"';
    isolateFromPasswordManagers();
    assert.strictEqual(fetchNpmOtp(), null);
  });

  it('is null when nothing is configured and no vault CLI is around', () => {
    delete process.env['NPM_OTP_COMMAND'];
    isolateFromPasswordManagers();
    assert.strictEqual(fetchNpmOtp(), null);
  });
});
