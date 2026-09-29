export type Bump = 'major' | 'minor' | 'patch';

export const BUMPS: ReadonlyArray<Bump> = ['major', 'minor', 'patch'];

export function isBump(value: string): value is Bump {
  return (BUMPS as ReadonlyArray<string>).includes(value);
}

export function bumpVersionString(cur: string, bump: Bump): string {
  // parseInt rather than Number: it reads the leading digits of a part such
  // as `3-beta` in `1.2.3-beta.1`, where Number would give NaN and reject the
  // version.
  // eslint-disable-next-line unicorn/prefer-number-coercion
  const [maj, min, pat] = cur.split('.').map((n) => parseInt(n, 10));
  if (
    maj === undefined ||
    min === undefined ||
    pat === undefined ||
    Number.isNaN(maj) ||
    Number.isNaN(min) ||
    Number.isNaN(pat)
  ) {
    throw new Error(`Invalid version in package.json: ${cur}`);
  }
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/**
 * Orders two `X.Y.Z` versions by their numbers, ignoring anything after the
 * patch number. Negative when `a` is older, positive when newer, 0 when equal
 * or when either one is not a version at all.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): Array<number> | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return match ? match.slice(1).map(Number) : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
