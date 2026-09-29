import fs from 'node:fs';

import { safeRun } from './exec.ts';
import { shellQuote } from './git.ts';
import { DEFAULT_TAG_PREFIX } from './tags.ts';

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean | string;
  'release-with-ease'?: {
    paths?: string | Array<string>;
    path?: string | Array<string>;
    tagPrefix?: string;
    waitFor?: Array<{ paths?: string | Array<string>; tagPrefix?: string }>;
  };
}

export interface ParsedArgs {
  dryRun: boolean;
  paths: Array<string>;
  /** The package to release, by name or directory, when not the current one. */
  packageName: string | null;
}

export class UsageError extends Error {}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const dryRun = argv.includes('--dry-run');
  const paths: Array<string> = [];
  let packageName: string | null = null;

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
    } else if (!arg.startsWith('-')) {
      if (packageName !== null) {
        throw new UsageError(
          `Only one package can be released at a time, but both "${packageName}" and "${arg}" were given.`,
        );
      }
      packageName = arg;
    }
  }

  return { dryRun, paths, packageName };
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
  return pathList(raw, '"release-with-ease".paths');
}

function pathList(raw: unknown, where: string): Array<string> {
  const list = (Array.isArray(raw) ? raw : [raw]).map((entry: unknown) =>
    typeof entry === 'string' ? entry.trim() : entry,
  );
  if (
    !list.length ||
    list.some((entry) => typeof entry !== 'string' || !entry)
  ) {
    throw new UsageError(
      `${where} in package.json must be a path, or an array of paths.`,
    );
  }
  return list as Array<string>;
}

/**
 * `"release-with-ease": { "tagPrefix": "<name>@" }` in the package.json being
 * released, or `v` when nothing is configured. The prefix is used both to
 * find the last release and to name the next one, so it has to make a valid
 * tag once a version is appended, and cannot hold the glob characters
 * `git describe --match` would read as a pattern — git's own ref-name rules
 * already rule those out.
 */
export function configuredTagPrefix(pkg: PackageJson): string {
  const raw = pkg['release-with-ease']?.tagPrefix;
  if (raw === undefined || raw === null) return DEFAULT_TAG_PREFIX;
  return tagPrefix(raw, '"release-with-ease".tagPrefix');
}

function tagPrefix(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || !raw) {
    throw new UsageError(
      `${where} in package.json must be a non-empty string, e.g. "my-package@".`,
    );
  }
  // A leading dash would make the tag read as an option to `git tag` and
  // `gh release create`, which only fail after the changelog is committed.
  if (
    raw.startsWith('-') ||
    !safeRun(`git check-ref-format ${shellQuote(`refs/tags/${raw}1.0.0`)}`).ok
  ) {
    throw new UsageError(
      `${where} in package.json is "${raw}", which does not make a valid git tag.`,
    );
  }
  return raw;
}

/** Another package in the repository whose releases this one waits for. */
export interface WaitFor {
  /** Its pathspecs, relative to this package like `paths`. */
  paths: Array<string>;
  /** The prefix its release tags carry. */
  tagPrefix: string;
}

/**
 * `"release-with-ease": { "waitFor": [{ "paths": [...], "tagPrefix": "..." }] }`
 * in the package.json being released: packages this one should not be
 * released ahead of. Documentation is the case it is for — docs that describe
 * a server change should not go out before the server does — so a release is
 * held for confirmation while any of them has changes since its last release.
 */
export function configuredWaitFor(pkg: PackageJson): Array<WaitFor> {
  const raw: unknown = pkg['release-with-ease']?.waitFor;
  if (raw === undefined || raw === null) return [];
  const where = '"release-with-ease".waitFor';
  if (!Array.isArray(raw)) {
    throw new UsageError(
      `${where} in package.json must be an array of { "paths", "tagPrefix" } objects.`,
    );
  }
  return raw.map((entry: unknown, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new UsageError(
        `${where}[${i}] in package.json must be an object with "paths" and "tagPrefix".`,
      );
    }
    const { paths, tagPrefix: prefix } = entry as Record<string, unknown>;
    return {
      paths: pathList(paths, `${where}[${i}].paths`),
      tagPrefix: tagPrefix(prefix, `${where}[${i}].tagPrefix`),
    };
  });
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
