import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'vitest';

import * as fakeGh from '../test-utils/fakeGh.ts';
import { initRepo } from '../test-utils/gitRepo.ts';
import * as tmpfs from '../test-utils/tmpfs.ts';

/**
 * The whole release, run the way a monorepo runs it: `pnpm release server`
 * from the repository root, which is the CLI started at the root with the
 * package name appended. It runs in a child process, as it would for real,
 * so that the answer to its one prompt can be typed into its stdin; git is
 * real, `gh` is the fake on PATH, and Claude is an HTTP server on localhost.
 */
const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

let server: http.Server | undefined;

afterEach(async () => {
  fakeGh.restore();
  tmpfs.restore();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** Answers every request with `suggestion`, and records what was asked. */
async function fakeClaude(suggestion: unknown): Promise<{ url: string; asked: Array<string> }> {
  const asked: Array<string> = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      asked.push(JSON.parse(body).messages[0].content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Shaped like a real reply: the answer is a text block after a
      // thinking one.
      res.end(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: JSON.stringify(suggestion) },
          ],
        }),
      );
    });
  });
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, asked };
}

function runCli(
  args: Array<string>,
  env: Record<string, string>,
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', MAIN, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          EDITOR: 'true',
          ...env,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('releasing one package of a monorepo from its root', () => {
  it('tags, commits and releases only that package', async () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit(
      {
        'package.json': JSON.stringify({ name: 'root', private: true }, null, 2) + '\n',
        'projects/server/package.json':
          JSON.stringify(
            {
              name: 'server',
              version: '1.0.0',
              private: true,
              'release-with-ease': { paths: ['.'], tagPrefix: 'server@' },
            },
            null,
            2,
          ) + '\n',
        'projects/server/README.md': '# server\n\n# Changelog\n\n## 1.0.0\n\n- First\n',
        'projects/worker/package.json':
          JSON.stringify({ name: 'worker', version: '3.0.0', private: true }, null, 2) + '\n',
      },
      'Add projects',
    );
    // The repository used plain v tags until now.
    repo.git('tag', '-m', '1.0.0', 'v1.0.0');
    repo.commit({ 'projects/server/index.js': 'server' }, 'Teach the server a trick');
    repo.commit({ 'projects/worker/index.js': 'worker' }, 'Teach the worker a trick');
    repo.publish();
    repo.git('push', 'origin', 'v1.0.0');
    repo.git('tag', 'stray-local-tag');
    const before = repo.sha('HEAD');

    fakeGh.install({ releaseUrl: 'https://github.com/o/r/releases/tag/server%401.1.0' });
    const claude = await fakeClaude({
      bump: 'minor',
      reasoning: 'A new trick.',
      notes: ['Teach the server a trick'],
    });

    const result = await runCli(
      ['server'],
      { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url },
      'y\n',
    );
    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);

    // It picked up from the old v tag, and saw only the server's commit.
    assert.match(result.stdout, /No server@ tags yet; starting from v1\.0\.0/);
    assert.strictEqual(claude.asked.length, 1);
    assert.match(claude.asked[0] ?? '', /Teach the server a trick/);
    assert.doesNotMatch(claude.asked[0] ?? '', /worker/);

    // package.json was edited in place, and only the server's files changed.
    const pkg = JSON.parse(
      fs.readFileSync(tmpfs.fullPath('work/projects/server/package.json'), 'utf8'),
    );
    assert.strictEqual(pkg.version, '1.1.0');
    assert.match(
      fs.readFileSync(tmpfs.fullPath('work/projects/server/README.md'), 'utf8'),
      /# Changelog\n\n## 1\.1\.0\n\n- Teach the server a trick\n\n## 1\.0\.0/,
    );
    assert.strictEqual(
      repo.git('log', '--format=%s', `${before}..HEAD`).trim(),
      'server@1.1.0\nUpdate changelog for server@1.1.0',
    );
    assert.deepStrictEqual(
      repo.git('diff', '--name-only', before, 'HEAD').trim().split('\n'),
      ['projects/server/README.md', 'projects/server/package.json'],
    );

    // The tag went out with the branch; nothing else did.
    const remoteTags = repo.git('ls-remote', '--tags', '--refs', 'origin').trim();
    assert.match(remoteTags, /refs\/tags\/server@1\.1\.0$/m);
    assert.doesNotMatch(remoteTags, /v1\.1\.0|stray-local-tag/);
    assert.strictEqual(repo.sha('origin/main'), repo.sha('HEAD'));
    assert.strictEqual(repo.sha('server@1.1.0^{commit}'), repo.sha('HEAD'));

    const releaseArgs = fakeGh.releaseCreateArgs() ?? [];
    assert.deepStrictEqual(releaseArgs.slice(0, 5), [
      'release',
      'create',
      'server@1.1.0',
      '--title',
      'server 1.1.0',
    ]);
  }, 30_000);

  it('keeps v tags for a package that does not configure a prefix', async () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit(
      {
        'package.json':
          JSON.stringify({ name: 'solo', version: '2.7.2', private: true }, null, 2) + '\n',
      },
      'Add package',
    );
    repo.git('tag', '-m', '2.7.2', 'v2.7.2');
    repo.commit({ 'index.js': 'fix' }, 'Fix a bug');
    repo.publish();
    repo.git('push', 'origin', 'v2.7.2');

    fakeGh.install({ releaseUrl: 'https://github.com/o/r/releases/tag/v2.7.3' });
    const claude = await fakeClaude({ bump: 'patch', reasoning: 'A fix.', notes: ['Fix a bug'] });

    const result = await runCli(
      [],
      { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url },
      'y\n',
    );
    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);

    assert.strictEqual(repo.git('log', '-1', '--format=%s').trim(), '2.7.3');
    assert.match(repo.git('ls-remote', '--tags', '--refs', 'origin'), /refs\/tags\/v2\.7\.3$/m);
    assert.deepStrictEqual(fakeGh.releaseCreateArgs()?.slice(0, 5), [
      'release',
      'create',
      'v2.7.3',
      '--title',
      'v2.7.3',
    ]);
  }, 30_000);

  it('stops before anything else when the tags cannot be fetched', async () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit(
      { 'package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', private: true }) },
      'Add package',
    );
    repo.publish();
    repo.git('remote', 'set-url', 'origin', tmpfs.fullPath('nowhere.git'));
    const before = repo.sha('HEAD');

    fakeGh.install({ releaseUrl: 'unused' });
    const claude = await fakeClaude({ bump: 'patch', reasoning: 'A fix.', notes: ['Fix'] });

    const result = await runCli(
      [],
      { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url },
      'y\n',
    );
    assert.strictEqual(result.code, 1);
    assert.match(result.stderr, /Could not fetch tags from origin/);
    assert.strictEqual(claude.asked.length, 0);
    assert.strictEqual(repo.sha('HEAD'), before);
  }, 30_000);

  it('stops before changing anything when the new tag already exists', async () => {
    tmpfs.mock({});
    const repo = initRepo();
    repo.commit(
      {
        'package.json':
          JSON.stringify(
            {
              name: 'pkg',
              version: '1.0.0',
              private: true,
              'release-with-ease': { tagPrefix: 'pkg@' },
            },
            null,
            2,
          ) + '\n',
      },
      'Add package',
    );
    repo.git('tag', 'pkg@1.0.0');
    repo.commit({ 'index.js': 'fix' }, 'Fix a bug');
    // Someone released 1.0.1 without package.json ever saying so.
    repo.git('tag', 'pkg@1.0.1', 'HEAD~1');
    repo.publish();
    repo.git('push', 'origin', '--tags');
    const before = repo.sha('HEAD');

    fakeGh.install({ releaseUrl: 'unused' });
    const claude = await fakeClaude({ bump: 'patch', reasoning: 'A fix.', notes: ['Fix a bug'] });

    const result = await runCli(
      [],
      { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url },
      'y\n',
    );
    assert.strictEqual(result.code, 1);
    assert.match(result.stderr, /The tag pkg@1\.0\.1 already exists/);
    assert.strictEqual(repo.sha('HEAD'), before);
    assert.strictEqual(fakeGh.releaseCreateArgs(), null);
  }, 30_000);
});
