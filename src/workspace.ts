import fs from 'node:fs';
import path from 'node:path';

import { UsageError } from './args.ts';
import { safeRun } from './exec.ts';
import { shellQuote } from './git.ts';

/**
 * The directory of the package to release, given either its directory or its
 * `name`. This is what lets a repository with several packages release any of
 * them from its root — `pnpm release server` runs the root's `release` script
 * with `server` appended — without the script having to know the layout.
 *
 * Names are looked up among the `package.json` files git tracks, which covers
 * any workspace tool's layout and leaves `node_modules` out without trying.
 */
export function resolvePackageDir(
  nameOrDir: string,
  cwd: string = process.cwd(),
): string {
  const asDir = path.resolve(cwd, nameOrDir);
  if (fs.existsSync(path.join(asDir, 'package.json'))) return asDir;

  // --show-cdup rather than --show-toplevel: the latter is the resolved real
  // path, which differs from a cwd reached through a symlink, and the caller
  // compares the result against its cwd.
  const rootRes = safeRun('git rev-parse --show-cdup', { cwd });
  if (!rootRes.ok) {
    throw new UsageError(
      `There is no package.json in "${nameOrDir}", and this is not a git repository to look for a package named "${nameOrDir}" in.`,
    );
  }
  const root = path.resolve(cwd, rootRes.out.trim());

  const listRes = safeRun(
    `git ls-files -z -- ${shellQuote(':(glob)**/package.json')}`,
    {
      cwd: root,
    },
  );
  const manifests = listRes.ok ? listRes.out.split('\0').filter(Boolean) : [];

  const names: Array<string> = [];
  const matches: Array<string> = [];
  for (const manifest of manifests) {
    let name: unknown;
    try {
      name = (
        JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8')) as {
          name?: unknown;
        }
      ).name;
    } catch {
      continue;
    }
    if (typeof name !== 'string') continue;
    names.push(name);
    if (name === nameOrDir) matches.push(path.dirname(manifest));
  }

  if (matches.length === 1 && matches[0] !== undefined) {
    return path.join(root, matches[0]);
  }
  if (matches.length > 1) {
    throw new UsageError(
      `More than one package is named "${nameOrDir}": ${matches.join(', ')}. Pass the directory instead.`,
    );
  }
  // The names are strings, so the default code-unit order is the one wanted.
  // eslint-disable-next-line unicorn/require-array-sort-compare
  const found = [...new Set(names)].toSorted().join(', ');
  throw new UsageError(
    `No package named "${nameOrDir}" in this repository${
      names.length ? `. Packages found: ${found}` : ''
    }.`,
  );
}
