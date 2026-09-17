import { isBump, type Bump } from './version.ts';
import type { CommitWithMeta } from './github.ts';

export interface ReleaseSuggestion {
  bump: Bump;
  reasoning: string;
  notes: Array<string>;
}

const BASE_PROMPT =
  'You are a release assistant. Given recent git commits, decide one of: major, minor, or patch following semver. Consider conventional commits, breaking changes, and scope. Also generate concise release notes for a public changelog. Respond with JSON containing "bump" (major/minor/patch), "reasoning" (brief explanation for version bump), and "notes" (array of 3-8 short bullet points of the most important user-facing changes). Use present tense for release notes (e.g. "Add script" not "Added script" or "Adds script"). Do not wrap the JSON in ```json or anything else.';

const PUBLIC_EXTRA =
  ' Each commit may carry metadata in brackets like [by @login in #123]. When present, append that attribution verbatim at the end of the corresponding bullet point.';

export function buildSystemPrompt(isPublicPackage: boolean): string {
  return isPublicPackage ? BASE_PROMPT + PUBLIC_EXTRA : BASE_PROMPT;
}

/**
 * The commit list as Claude sees it. Bodies are truncated because a pull
 * request description can run to several screens and only its opening is
 * ever about what changed.
 */
export function buildUserContent(commits: ReadonlyArray<CommitWithMeta>): string {
  return commits
    .map(c => {
      const body = c.body ? c.body.trim() : '';
      const truncatedBody = body.length > 500 ? body.slice(0, 500) + '…' : body;
      const meta: Array<string> = [];
      if (c.githubLogin) meta.push(`by @${c.githubLogin}`);
      if (c.prNumber) meta.push(`in #${c.prNumber}`);
      const metaStr = meta.length ? ` [${meta.join(' ')}]` : '';
      return `- ${c.subject}${metaStr}\n${truncatedBody}`;
    })
    .join('\n');
}

/**
 * Pulls the suggestion out of a model response. Claude is asked for bare
 * JSON and usually obliges, but a stray code fence is common enough to be
 * worth stripping rather than failing over.
 */
export function parseReleaseSuggestion(raw: string): ReleaseSuggestion {
  const content = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '');

  const parsed = JSON.parse(content) as Partial<ReleaseSuggestion>;
  if (!parsed.bump || !isBump(parsed.bump)) {
    throw new Error('Invalid bump value in Claude response');
  }
  if (!parsed.reasoning) {
    throw new Error('Missing reasoning in Claude response');
  }
  if (!parsed.notes || !Array.isArray(parsed.notes)) {
    throw new Error('Missing or invalid notes array in Claude response');
  }

  return {
    bump: parsed.bump,
    reasoning: parsed.reasoning,
    notes: parsed.notes.map(note => `- ${note}`),
  };
}

// Statuses worth retrying: rate limiting, transient server errors, and the
// "overloaded_error" 529 Anthropic returns when capacity is tight.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Seconds or an HTTP-date, per the Retry-After spec. Anthropic (and most
 * APIs that 429/529) send the former, but both are handled since either is
 * legal.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Exponential backoff with jitter, capped at maxDelayMs. A server-provided
 * Retry-After takes priority over the computed delay when present, since it
 * reflects the server's own view of when capacity will free up.
 */
function backoffDelayMs(attempt: number, retryAfterMs: number | null, opts: Required<RetryOptions>): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, opts.maxDelayMs);
  const exp = opts.baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * opts.baseDelayMs;
  return Math.min(exp + jitter, opts.maxDelayMs);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const opts: Required<RetryOptions> = {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Network-level failure (DNS, connection reset, timeout, ...): retry
      // the same as a retryable status, since it's just as transient.
      lastError = err;
      if (attempt === opts.maxRetries) throw err;
      await opts.sleep(backoffDelayMs(attempt, null, opts));
      continue;
    }

    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt === opts.maxRetries) {
      return res;
    }

    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    console.error(
      `Claude API request failed with ${res.status} ${res.statusText}; retrying (attempt ${
        attempt + 1
      }/${opts.maxRetries})...`,
    );
    await opts.sleep(backoffDelayMs(attempt, retryAfterMs, opts));
  }
  // Unreachable: the loop above always returns or throws.
  throw lastError instanceof Error ? lastError : new Error('Failed to reach Claude API');
}

export async function askClaudeForRelease(
  commits: ReadonlyArray<CommitWithMeta>,
  isPublicPackage = false,
  retryOptions: RetryOptions = {},
): Promise<ReleaseSuggestion | null> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;

  const baseUrl = process.env['ANTHROPIC_BASE_URL'] || 'https://api.anthropic.com';

  const res = await fetchWithRetry(
    `${baseUrl}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        temperature: 0.2,
        system: buildSystemPrompt(isPublicPackage),
        messages: [{ role: 'user', content: buildUserContent(commits) }],
      }),
    },
    retryOptions,
  );
  if (!res.ok) {
    console.error(await res.text());
    throw new Error(
      `Failed to determine version bump: ${res.statusText} ${res.status}`,
    );
  }
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return parseReleaseSuggestion(data.content?.[0]?.text || '');
}
