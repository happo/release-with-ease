import assert from 'node:assert';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import {
  askClaudeForRelease,
  buildSystemPrompt,
  buildUserContent,
  parseReleaseSuggestion,
} from '../claude.ts';
import type { CommitWithMeta } from '../github.ts';

function commit(overrides: Partial<CommitWithMeta> = {}): CommitWithMeta {
  return {
    hash: 'abc1234',
    subject: 'Add a thing',
    body: '',
    githubLogin: null,
    prNumber: null,
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('asks for attribution only for public packages', () => {
    assert.match(buildSystemPrompt(true), /\[by @login in #123\]/);
    assert.doesNotMatch(buildSystemPrompt(false), /\[by @login in #123\]/);
  });

  it('always asks for bare JSON with the three fields', () => {
    for (const isPublic of [true, false]) {
      const prompt = buildSystemPrompt(isPublic);
      assert.match(prompt, /"bump"/);
      assert.match(prompt, /"reasoning"/);
      assert.match(prompt, /"notes"/);
    }
  });
});

describe('buildUserContent', () => {
  it('lists a bare commit with no metadata', () => {
    assert.strictEqual(buildUserContent([commit()]), '- Add a thing\n');
  });

  it('includes author and pull request when both are known', () => {
    const line = buildUserContent([commit({ githubLogin: 'lencioni', prNumber: 42 })]);
    assert.match(line, /- Add a thing \[by @lencioni in #42\]/);
  });

  it('includes just the author when there is no pull request', () => {
    assert.match(buildUserContent([commit({ githubLogin: 'lencioni' })]), /\[by @lencioni\]/);
  });

  it('includes just the pull request when there is no author', () => {
    assert.match(buildUserContent([commit({ prNumber: 42 })]), /\[in #42\]/);
  });

  it('truncates a long body so one description cannot crowd out the rest', () => {
    const content = buildUserContent([commit({ body: 'x'.repeat(900) })]);
    assert.ok(content.includes('…'));
    assert.ok(content.length < 700, `expected truncation, got ${content.length} chars`);
  });

  it('leaves a short body intact', () => {
    assert.match(buildUserContent([commit({ body: 'Short body.' })]), /Short body\.$/);
  });

  it('keeps one entry per commit', () => {
    const content = buildUserContent([
      commit({ subject: 'One', prNumber: 1 }),
      commit({ subject: 'Two', prNumber: 2 }),
    ]);
    assert.match(content, /- One \[in #1\]/);
    assert.match(content, /- Two \[in #2\]/);
  });
});

describe('parseReleaseSuggestion', () => {
  const valid = JSON.stringify({
    bump: 'minor',
    reasoning: 'Adds a feature.',
    notes: ['Add a thing', 'Fix another'],
  });

  it('parses bare JSON', () => {
    assert.deepStrictEqual(parseReleaseSuggestion(valid), {
      bump: 'minor',
      reasoning: 'Adds a feature.',
      notes: ['- Add a thing', '- Fix another'],
    });
  });

  it('strips a ```json fence', () => {
    assert.strictEqual(parseReleaseSuggestion('```json\n' + valid + '\n```').bump, 'minor');
  });

  it('strips a bare ``` fence', () => {
    assert.strictEqual(parseReleaseSuggestion('```\n' + valid + '\n```').bump, 'minor');
  });

  it('tolerates surrounding whitespace', () => {
    assert.strictEqual(parseReleaseSuggestion(`\n  ${valid}  \n`).bump, 'minor');
  });

  it('rejects a bump that is not a semver keyword', () => {
    assert.throws(
      () => parseReleaseSuggestion(JSON.stringify({ bump: 'huge', reasoning: 'r', notes: [] })),
      /Invalid bump value/,
    );
  });

  it('rejects a missing reasoning', () => {
    assert.throws(
      () => parseReleaseSuggestion(JSON.stringify({ bump: 'patch', notes: [] })),
      /Missing reasoning/,
    );
  });

  it('rejects notes that are not an array', () => {
    assert.throws(
      () => parseReleaseSuggestion(JSON.stringify({ bump: 'patch', reasoning: 'r', notes: 'nope' })),
      /Missing or invalid notes/,
    );
  });

  it('rejects unparseable output', () => {
    assert.throws(() => parseReleaseSuggestion('I think you should bump minor.'), SyntaxError);
  });
});

describe('askClaudeForRelease', () => {
  const env = { ...process.env };
  let server: http.Server | undefined;

  afterEach(async () => {
    process.env['ANTHROPIC_API_KEY'] = env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_BASE_URL'] = env['ANTHROPIC_BASE_URL'];
    if (server) {
      await new Promise<void>(resolve => server?.close(() => resolve()));
      server = undefined;
    }
  });

  /**
   * A real HTTP server standing in for the API: the request headers, the JSON
   * body and the response handling all stay real, and `claude.ts` needs no
   * seam it would not otherwise have — `ANTHROPIC_BASE_URL` is the same knob
   * the Anthropic SDKs expose.
   */
  async function serve(
    handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
  ): Promise<void> {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => handler(req, body, res));
    });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${port}`;
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
  }

  const reply = (text: unknown) => JSON.stringify({ content: [{ text }] });

  it('is null without an API key, rather than calling anything', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    assert.strictEqual(await askClaudeForRelease([commit()]), null);
  });

  it('sends the key and version headers and returns the suggestion', async () => {
    let seen: http.IncomingMessage | undefined;
    await serve((req, _body, res) => {
      seen = req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(reply(JSON.stringify({ bump: 'patch', reasoning: 'Small fix.', notes: ['Fix it'] })));
    });

    const result = await askClaudeForRelease([commit()]);

    assert.strictEqual(seen?.headers['x-api-key'], 'test-key');
    assert.strictEqual(seen?.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(seen?.url, '/v1/messages');
    assert.deepStrictEqual(result, {
      bump: 'patch',
      reasoning: 'Small fix.',
      notes: ['- Fix it'],
    });
  });

  it('sends the commits as the user message', async () => {
    let payload: { system?: string; messages?: Array<{ content?: string }> } = {};
    await serve((_req, body, res) => {
      payload = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(reply(JSON.stringify({ bump: 'minor', reasoning: 'r', notes: ['n'] })));
    });

    await askClaudeForRelease([commit({ subject: 'Add a thing', prNumber: 42 })], true);

    assert.match(payload.messages?.[0]?.content ?? '', /- Add a thing \[in #42\]/);
    assert.match(payload.system ?? '', /\[by @login in #123\]/);
  });

  it('throws with the status when the API refuses', async () => {
    await serve((_req, _body, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":"rate limited"}');
    });

    await assert.rejects(
      () => askClaudeForRelease([commit()]),
      /Failed to determine version bump:.*429/,
    );
  });

  it('surfaces a response that is not the JSON we asked for', async () => {
    await serve((_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(reply('Sure! I think this is a minor bump.'));
    });

    await assert.rejects(() => askClaudeForRelease([commit()]), SyntaxError);
  });
});
