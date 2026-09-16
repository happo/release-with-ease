import fs from 'node:fs';
import { safeRun } from './exec.ts';

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean | string;
  'release-with-ease'?: { paths?: string | Array<string>; path?: string | Array<string> };
}

export interface ParsedArgs {
  dryRun: boolean;
  paths: Array<string>;
}

export class UsageError extends Error {}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const dryRun = argv.includes('--dry-run');
  const paths: Array<string> = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--path' || arg === '--pathspec') {
      const value = argv[i + 1];
      // A missing value would otherwise swallow the next flag, or nothing at
      // all, and release the whole repository as if no path was ever asked for.
      if (!value || value.startsWith('-')) {
        throw new UsageError(`${arg} needs a value, e.g. ${arg} packages/cli`);
      }
      paths.push(value);
      i += 1;
    } else if (/^--path(spec)?=/.test(arg)) {
      const value = arg.slice(arg.indexOf('=') + 1);
      if (!value) {
        throw new UsageError(`${arg} needs a value, e.g. --path=packages/cli`);
      }
      paths.push(value);
    }
  }

  return { dryRun, paths };
}

/**
 * `"release-with-ease": { "paths": [...] }` in the package.json being
 * released, used when no --path flag was passed. A package in a monorepo
 * wants the same pathspec on every release, and forgetting the flag fails
 * silently — release notes covering the whole repository read as perfectly
 * plausible — so it belongs in the manifest rather than in whatever the
 * publisher remembers to type.
 */
export function configuredPaths(pkg: PackageJson): Array<string> {
  const config = pkg['release-with-ease'];
  const raw = config?.paths ?? config?.path;
  if (raw === undefined || raw === null) return [];

  const list = (Array.isArray(raw) ? raw : [raw]).map(entry =>
    typeof entry === 'string' ? entry.trim() : entry,
  );
  if (!list.length || list.some(entry => typeof entry !== 'string' || !entry)) {
    throw new UsageError(
      '"release-with-ease".paths in package.json must be a path, or an array of paths.',
    );
  }
  return list as Array<string>;
}

function realpath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * A package released from a subdirectory is a package in a monorepo, and one
 * almost never wants its release notes written from the whole repository's
 * history. Nothing about that outcome looks wrong once it has happened, so
 * say it up front rather than leaving it to be spotted in the editor.
 *
 * Returns the warning rather than printing it, so the caller owns the output
 * and a test can read it.
 */
export function unscopedSubdirectoryWarning(
  paths: ReadonlyArray<string>,
  pkg: PackageJson,
): string | null {
  if (paths.length) return null;
  const rootRes = safeRun('git rev-parse --show-toplevel');
  if (!rootRes.ok) return null;
  const root = realpath(rootRes.out.trim());
  if (!root || root === realpath(process.cwd())) return null;

  return (
    `\nℹ️  ${pkg.name || 'This package'} lives in a subdirectory, but commits are being analyzed from the whole repository.\n` +
    '   Pass --path . (or add "release-with-ease": { "paths": ["."] } to package.json) to limit them to this package.'
  );
}
