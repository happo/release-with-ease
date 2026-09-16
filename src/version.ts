export type Bump = 'major' | 'minor' | 'patch';

export const BUMPS: ReadonlyArray<Bump> = ['major', 'minor', 'patch'];

export function isBump(value: string): value is Bump {
  return (BUMPS as ReadonlyArray<string>).includes(value);
}

export function bumpVersionString(cur: string, bump: Bump): string {
  const [maj, min, pat] = cur.split('.').map(n => parseInt(n, 10));
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
