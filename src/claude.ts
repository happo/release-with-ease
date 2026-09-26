import { isBump, type Bump } from './version.ts';
import type { CommitWithMeta } from './github.ts';

export interface OmittedChange {
  commit: CommitWithMeta;
  /** Claude's reason for leaving it out, or null when it didn't give one. */
  reason: string | null;
}

export interface ReleaseSuggestion {
  bump: Bump;
  reasoning: string;
  notes: Array<string>;
  /**
   * Every change no bullet point claims to describe. Worked out here from
   * the ids each note cites rather than taken on Claude's word, so a change
   * it drops without saying so still shows up.
   */
  omitted: Array<OmittedChange>;
}

const BASE_PROMPT = `You are a release assistant. You are given the changes going into a release, each wrapped in a <change id="N"> tag. Decide one of: major, minor, or patch following semver. Consider conventional commits, breaking changes, and scope.

Also write release notes for a public changelog, read by the people who use this software. Follow these rules:
- Cover every user-facing change: anything a user could notice, however small. That includes new features, bug fixes, security fixes, performance and reliability improvements, behavior changes, deprecations and removals. When unsure whether a change is user-facing, include it.
- Leave out changes no user could notice: tests and test fixtures, flaky-test fixes, CI, internal refactors, internal logging, metrics and monitoring, dependency bumps with no effect on behavior, and development tooling.
- There is no target length. Write one bullet point per user-facing change, so a release with one change gets exactly one bullet point. Combine changes into one bullet point only when they are really the same change. Never split one change into several bullet points; describe only its user-facing effect.
- Sort the bullet points by their impact on users, most impactful first: security fixes and breaking changes, then fixes for bugs that cause failures or wrong results, then new features, then smaller fixes and improvements, then cosmetic changes.
- Keep each bullet point to one short sentence in present tense (e.g. "Add script" not "Added script" or "Adds script").

Respond with JSON containing:
- "bump": "major", "minor" or "patch"
- "reasoning": a brief explanation for the version bump
- "notes": an array of objects, one per bullet point, each with "text" (the bullet point, without a leading dash) and "changes" (the ids of the changes it describes)
- "omitted": an array of objects, one for every change left out of the notes, each with "change" (its id) and "reason" (why it was left out, in a few words)

Every change id must appear in either "notes" or "omitted". Do not wrap the JSON in \`\`\`json or anything else.`;

const PUBLIC_EXTRA =
  '\n\nEach change may carry metadata in brackets like [by @login in #123]. When present, append that attribution verbatim at the end of the corresponding bullet point.';

export function buildSystemPrompt(isPublicPackage: boolean): string {
  return isPublicPackage ? BASE_PROMPT + PUBLIC_EXTRA : BASE_PROMPT;
}

// Enough of a pull request description to get past a "Why" section and into
// what changed, without letting one essay crowd out the rest of the release.
const MAX_BODY_LENGTH = 2000;

/**
 * Keeps a subject or description from opening or closing a change tag of its
 * own, which would hand the text after it to the wrong id.
 */
function escapeChangeTags(text: string): string {
  return text.replace(/<(\/?)change\b/gi, '&lt;$1change');
}

/**
 * The change list as Claude sees it. Each change is tagged with an id — its
 * position in the list, counting from 1 — for the notes to cite, and the tag
 * keeps a description's own headings and lists from running into the next
 * change.
 */
export function buildUserContent(commits: ReadonlyArray<CommitWithMeta>): string {
  return commits
    .map((c, i) => {
      const body = c.body ? c.body.trim() : '';
      const truncatedBody =
        body.length > MAX_BODY_LENGTH ? body.slice(0, MAX_BODY_LENGTH) + '…' : body;
      const meta: Array<string> = [];
      if (c.githubLogin) meta.push(`by @${c.githubLogin}`);
      if (c.prNumber) meta.push(`in #${c.prNumber}`);
      const metaStr = meta.length ? ` [${meta.join(' ')}]` : '';
      const lines = [`<change id="${i + 1}">`, `${escapeChangeTags(c.subject)}${metaStr}`];
      if (truncatedBody) lines.push(escapeChangeTags(truncatedBody));
      lines.push('</change>');
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * A change id as Claude wrote it. The ids reach it as `id="1"`, so they come
 * back as strings about as often as numbers.
 */
function changeId(value: unknown): number | null {
  const id = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
}

interface RawNote {
  text?: unknown;
  changes?: unknown;
}

interface RawOmitted {
  change?: unknown;
  reason?: unknown;
}

/**
 * Pulls the suggestion out of a model response. Claude is asked for bare
 * JSON and usually obliges, but a stray code fence is common enough to be
 * worth stripping rather than failing over.
 *
 * A note given as a bare string is kept but cites nothing, so the changes it
 * covers get listed as omitted. That list is a prompt to double-check, so
 * over-reporting there is the safe direction to be wrong in.
 */
export function parseReleaseSuggestion(
  raw: string,
  commits: ReadonlyArray<CommitWithMeta>,
): ReleaseSuggestion {
  const content = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '');

  const parsed = JSON.parse(content) as {
    bump?: unknown;
    reasoning?: unknown;
    notes?: unknown;
    omitted?: unknown;
  };
  if (typeof parsed.bump !== 'string' || !isBump(parsed.bump)) {
    throw new Error('Invalid bump value in Claude response');
  }
  if (!parsed.reasoning || typeof parsed.reasoning !== 'string') {
    throw new Error('Missing reasoning in Claude response');
  }
  if (!parsed.notes || !Array.isArray(parsed.notes)) {
    throw new Error('Missing or invalid notes array in Claude response');
  }

  const covered = new Set<number>();
  const notes = (parsed.notes as Array<unknown>).map(note => {
    if (typeof note === 'string') return `- ${note}`;
    const { text, changes } = (note ?? {}) as RawNote;
    if (typeof text !== 'string') {
      throw new Error('Invalid note in Claude response');
    }
    if (Array.isArray(changes)) {
      for (const value of changes) {
        const id = changeId(value);
        if (id !== null) covered.add(id);
      }
    }
    return `- ${text}`;
  });

  const reasons = new Map<number, string>();
  if (Array.isArray(parsed.omitted)) {
    for (const entry of parsed.omitted as Array<RawOmitted | null>) {
      const id = changeId(entry?.change);
      if (id !== null && typeof entry?.reason === 'string') reasons.set(id, entry.reason);
    }
  }

  const omitted = commits.flatMap((commit, i): Array<OmittedChange> => {
    const id = i + 1;
    if (covered.has(id)) return [];
    return [{ commit, reason: reasons.get(id) ?? null }];
  });

  return {
    bump: parsed.bump,
    reasoning: parsed.reasoning,
    notes,
    omitted,
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
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
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
    maxRetries: Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES),
    baseDelayMs: Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS),
    maxDelayMs: Math.max(0, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS),
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
    await res.body?.cancel();
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
        // Sonnet rather than Haiku: deciding what a user could notice and how
        // much it matters to them is judgment Haiku got wrong run to run.
        model: 'claude-sonnet-5',
        // Low effort keeps the call about as fast as Haiku was: at the default,
        // Sonnet 5 spends longer thinking than it does writing the notes, and
        // the notes come out no better for it.
        output_config: { effort: 'low' },
        // Any thinking it does still counts against this, on top of complete
        // notes for a busy release.
        max_tokens: 16000,
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
  const data = (await res.json()) as {
    stop_reason?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  // A cut-off or declined answer would otherwise surface as a JSON syntax
  // error, which says nothing about what went wrong.
  if (data.stop_reason === 'max_tokens' || data.stop_reason === 'refusal') {
    throw new Error(`Claude did not finish the release notes (stop reason: ${data.stop_reason})`);
  }
  // The answer follows a thinking block, so it is not the first one.
  const text = data.content?.find(block => block.type === 'text')?.text;
  return parseReleaseSuggestion(text || '', commits);
}
